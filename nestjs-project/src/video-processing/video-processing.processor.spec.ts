import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { FindOneOptions, FindOptionsWhere, UpdateResult } from 'typeorm';
import { MediaProcessError, NoVideoStreamError } from '../media/media.errors';
import type { MediaProbeResult } from '../media/media-probe.parser';
import { MediaService } from '../media/media.service';
import type { ProcessVideoJobData } from '../queue/video-processing.queue';
import { StorageService } from '../storage/storage.service';
import type { PresignGetOptions } from '../storage/storage.types';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VideoProcessingProcessor } from './video-processing.processor';

const probeResult: MediaProbeResult = {
  durationSeconds: 20,
  metadata: {
    formatName: 'mp4',
    bitRate: 1000,
    sizeBytes: 2000,
    video: { codec: 'h264', width: 320, height: 240, fps: 25 },
    audio: null,
  },
};

function job(attemptsMade = 0, attempts = 3): Job<ProcessVideoJobData> {
  return {
    id: 'video-1',
    data: { videoId: 'video-1' },
    attemptsMade,
    opts: { attempts },
  } as Job<ProcessVideoJobData>;
}

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  let repository: {
    findOne: jest.Mock<Promise<Video | null>, [FindOneOptions<Video>]>;
    update: jest.Mock<
      Promise<UpdateResult>,
      [FindOptionsWhere<Video>, Partial<Video>]
    >;
  };
  let storage: {
    presignGet: jest.Mock<Promise<string>, [string, PresignGetOptions]>;
    putObject: jest.Mock<Promise<void>, [string, Buffer, string]>;
  };
  let media: {
    probe: jest.Mock<Promise<MediaProbeResult>, [string]>;
    extractThumbnail: jest.Mock<Promise<Buffer>, [string, number]>;
  };

  beforeEach(async () => {
    repository = {
      findOne: jest
        .fn<Promise<Video | null>, [FindOneOptions<Video>]>()
        .mockResolvedValue({
          id: 'video-1',
          status: VideoStatus.PROCESSING,
          storage_key: 'videos/video-1/original',
        } as Video),
      update: jest
        .fn<Promise<UpdateResult>, [FindOptionsWhere<Video>, Partial<Video>]>()
        .mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] }),
    };
    storage = {
      presignGet: jest
        .fn<Promise<string>, [string, PresignGetOptions]>()
        .mockResolvedValue('http://minio:9000/signed'),
      putObject: jest
        .fn<Promise<void>, [string, Buffer, string]>()
        .mockResolvedValue(undefined),
    };
    media = {
      probe: jest
        .fn<Promise<MediaProbeResult>, [string]>()
        .mockResolvedValue(probeResult),
      extractThumbnail: jest
        .fn<Promise<Buffer>, [string, number]>()
        .mockResolvedValue(Buffer.from([0xff, 0xd8])),
    };

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: StorageService, useValue: storage },
        { provide: MediaService, useValue: media },
      ],
    }).compile();
    processor = module.get(VideoProcessingProcessor);
  });

  it('should mark the video ready with duration, metadata and thumbnail taken at 10%', async () => {
    await processor.process(job());

    expect(storage.presignGet).toHaveBeenCalledWith('videos/video-1/original', {
      audience: 'internal',
      expiresInSeconds: 3600,
    });
    expect(media.extractThumbnail).toHaveBeenCalledWith(
      'http://minio:9000/signed',
      2,
    );
    expect(storage.putObject).toHaveBeenCalledWith(
      'videos/video-1/thumbnail.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );
    expect(repository.update).toHaveBeenCalledWith(
      { id: 'video-1', status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        duration_seconds: 20,
        metadata: probeResult.metadata,
        thumbnail_key: 'videos/video-1/thumbnail.jpg',
      },
    );
  });

  it('should be a no-op when the video is no longer processing', async () => {
    repository.findOne.mockResolvedValue({
      id: 'video-1',
      status: VideoStatus.READY,
    } as Video);

    await processor.process(job());

    expect(media.probe).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('should be a no-op when the video no longer exists', async () => {
    repository.findOne.mockResolvedValue(null);

    await expect(processor.process(job())).resolves.toBeUndefined();
    expect(media.probe).not.toHaveBeenCalled();
  });

  it('should rethrow without changing the status on an intermediate attempt', async () => {
    storage.putObject.mockRejectedValue(new Error('storage unavailable'));

    await expect(processor.process(job(0))).rejects.toThrow(
      'storage unavailable',
    );
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('should mark the video failed on the last attempt and rethrow', async () => {
    storage.putObject.mockRejectedValue(new Error('storage unavailable'));

    await expect(processor.process(job(2))).rejects.toThrow(
      'storage unavailable',
    );
    expect(repository.update).toHaveBeenCalledWith(
      { id: 'video-1', status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, failure_reason: 'storage unavailable' },
    );
  });

  it('should fail immediately with UnrecoverableError when there is no video stream', async () => {
    media.probe.mockRejectedValue(new NoVideoStreamError());

    await expect(processor.process(job(0))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(repository.update).toHaveBeenCalledWith(
      { id: 'video-1', status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.FAILED,
        failure_reason: 'No video stream found in the uploaded file',
      },
    );
  });

  it('should fail immediately for unreadable media', async () => {
    media.probe.mockRejectedValue(
      new MediaProcessError(
        'ffprobe',
        1,
        'Invalid data found when processing input',
      ),
    );

    await expect(processor.process(job(0))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(repository.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: VideoStatus.FAILED }),
    );
  });

  it('should retry when FFmpeg could not reach the storage', async () => {
    const networkError = new MediaProcessError(
      'ffprobe',
      1,
      'Connection refused',
    );
    media.probe.mockRejectedValue(networkError);

    await expect(processor.process(job(0))).rejects.toBe(networkError);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('should never persist the presigned input URL in failure_reason', async () => {
    media.probe.mockRejectedValue(
      new MediaProcessError(
        'ffprobe',
        1,
        'http://minio:9000/b/k?X-Amz-Signature=secret: Invalid data found',
      ),
    );

    await expect(processor.process(job(0))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    const [, fields] = repository.update.mock.calls[0];
    expect(fields.failure_reason).not.toContain('X-Amz-Signature');
    expect(fields.failure_reason).toContain('<input-url>');
  });
});
