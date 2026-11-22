import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  FindOneOptions,
  FindOptionsWhere,
  QueryFailedError,
  Repository,
  UpdateResult,
} from 'typeorm';
import { VIDEO_PROCESSING_QUEUE } from '../queue/video-processing.queue';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import {
  ChannelNotFoundException,
  InvalidPartNumberException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotDraftException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import type { PresignGetOptions, UploadedPart } from '../storage/storage.types';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

type Mocked<T, K extends keyof T> = {
  [P in K]: T[P] extends (...args: infer A) => infer R
    ? jest.Mock<R, A>
    : never;
};

function uniqueSlugViolation(): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error('duplicate'));
  Object.assign(err, {
    code: '23505',
    detail: 'Key (slug)=(abc) already exists.',
  });
  return err;
}

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: Mocked<
    Repository<Video>,
    'create' | 'save' | 'findOne' | 'update'
  >;
  let queue: { add: jest.Mock<Promise<unknown>, [string, unknown, unknown]> };
  let channelsService: Mocked<ChannelsService, 'findByUserId'>;
  let storageService: Mocked<
    StorageService,
    | 'createMultipartUpload'
    | 'presignUploadPart'
    | 'listParts'
    | 'completeMultipartUpload'
    | 'presignGet'
  >;

  const channel = { id: 'channel-1' } as Channel;
  const dto = {
    fileName: 'aula.mp4',
    sizeBytes: 150000000,
    contentType: 'video/mp4',
  };

  beforeEach(async () => {
    videoRepository = {
      create: jest.fn((fields) => fields as Video),
      save: jest.fn((video) => Promise.resolve(video as Video)),
      findOne: jest.fn<Promise<Video | null>, [FindOneOptions<Video>]>(),
      update: jest
        .fn<Promise<UpdateResult>, [FindOptionsWhere<Video>, Partial<Video>]>()
        .mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] }),
    };
    queue = {
      add: jest
        .fn<Promise<unknown>, [string, unknown, unknown]>()
        .mockResolvedValue({}),
    };
    channelsService = {
      findByUserId: jest
        .fn<Promise<Channel | null>, [string]>()
        .mockResolvedValue(channel),
    };
    storageService = {
      createMultipartUpload: jest
        .fn<Promise<string>, [string, string]>()
        .mockResolvedValue('upload-1'),
      presignUploadPart: jest
        .fn<Promise<string>, [string, string, number, number]>()
        .mockImplementation((_k, _u, partNumber) =>
          Promise.resolve(`https://storage/part-${partNumber}`),
        ),
      listParts: jest.fn<Promise<UploadedPart[]>, [string, string]>(),
      completeMultipartUpload: jest
        .fn<Promise<void>, [string, string, UploadedPart[]]>()
        .mockResolvedValue(undefined),
      presignGet: jest
        .fn<Promise<string>, [string, PresignGetOptions]>()
        .mockResolvedValue('http://minio:9000/signed-get'),
    };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: queue },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  describe('initiateUpload', () => {
    it('should throw CHANNEL_NOT_FOUND when the user has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(service.initiateUpload('user-1', dto)).rejects.toThrow(
        ChannelNotFoundException,
      );
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should open the multipart upload under the video original key and save a draft', async () => {
      const result = await service.initiateUpload('user-1', dto);

      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        `videos/${result.id}/original`,
        'video/mp4',
      );
      expect(videoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: result.id,
          channel_id: 'channel-1',
          status: VideoStatus.DRAFT,
          upload_id: 'upload-1',
          size_bytes: 150000000,
        }),
      );
      expect(result.upload).toEqual({ partSize: 67108864, partCount: 3 });
    });

    it('should default the title to the file name without extension', async () => {
      const result = await service.initiateUpload('user-1', dto);

      expect(result.title).toBe('aula');
    });

    it('should keep a provided title', async () => {
      const result = await service.initiateUpload('user-1', {
        ...dto,
        title: 'Custom',
      });

      expect(result.title).toBe('Custom');
    });

    it('should regenerate the slug after a unique violation on slug', async () => {
      videoRepository.save
        .mockRejectedValueOnce(uniqueSlugViolation())
        .mockImplementationOnce((video) => Promise.resolve(video as Video));

      const result = await service.initiateUpload('user-1', dto);

      expect(videoRepository.save).toHaveBeenCalledTimes(2);
      const firstSlug = (videoRepository.create.mock.calls[0][0] as Video).slug;
      expect(result.slug).not.toBe(firstSlug);
    });

    it('should give up after 5 slug collisions', async () => {
      videoRepository.save.mockRejectedValue(uniqueSlugViolation());

      await expect(
        service.initiateUpload('user-1', dto),
      ).rejects.toBeInstanceOf(QueryFailedError);
      expect(videoRepository.save).toHaveBeenCalledTimes(5);
    });

    it('should not retry on errors other than a slug violation', async () => {
      videoRepository.save.mockRejectedValue(new Error('db down'));

      await expect(service.initiateUpload('user-1', dto)).rejects.toThrow(
        'db down',
      );
      expect(videoRepository.save).toHaveBeenCalledTimes(1);
    });
  });

  function draftVideo(overrides: Partial<Video> = {}): Video {
    return {
      id: 'video-1',
      channel_id: 'channel-1',
      size_bytes: 67108864 + 10,
      status: VideoStatus.DRAFT,
      storage_key: 'videos/video-1/original',
      upload_id: 'upload-1',
      ...overrides,
    } as Video;
  }

  describe('signUploadParts', () => {
    it('should only look the video up inside the caller channel', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());

      await service.signUploadParts('user-1', 'video-1', [1]);

      expect(videoRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'video-1', channel_id: 'channel-1' },
      });
    });

    it('should throw VIDEO_NOT_FOUND for a video of another channel', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.signUploadParts('user-1', 'video-1', [1]),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('should throw VIDEO_NOT_FOUND when the caller has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(
        service.signUploadParts('user-1', 'video-1', [1]),
      ).rejects.toThrow(VideoNotFoundException);
      expect(videoRepository.findOne).not.toHaveBeenCalled();
    });

    it('should throw VIDEO_NOT_DRAFT once the upload left draft', async () => {
      videoRepository.findOne.mockResolvedValue(
        draftVideo({ status: VideoStatus.PROCESSING, upload_id: null }),
      );

      await expect(
        service.signUploadParts('user-1', 'video-1', [1]),
      ).rejects.toThrow(VideoNotDraftException);
    });

    it('should throw INVALID_PART_NUMBER above the part count', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());

      await expect(
        service.signUploadParts('user-1', 'video-1', [1, 3]),
      ).rejects.toThrow(InvalidPartNumberException);
      expect(storageService.presignUploadPart).not.toHaveBeenCalled();
    });

    it('should sign each part for 3600 s and report expiresAt one hour ahead', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());
      const before = Date.now();

      const result = await service.signUploadParts('user-1', 'video-1', [1, 2]);

      expect(result.parts).toEqual([
        { partNumber: 1, url: 'https://storage/part-1' },
        { partNumber: 2, url: 'https://storage/part-2' },
      ]);
      expect(storageService.presignUploadPart).toHaveBeenCalledWith(
        'videos/video-1/original',
        'upload-1',
        1,
        3600,
      );
      const expiresAt = new Date(result.expiresAt).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
    });
  });

  describe('listUploadedParts', () => {
    it('should report the part policy and the stored parts', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());
      storageService.listParts.mockResolvedValue([
        { partNumber: 1, sizeBytes: 67108864, etag: '"e1"' },
      ]);

      await expect(
        service.listUploadedParts('user-1', 'video-1'),
      ).resolves.toEqual({
        partSize: 67108864,
        partCount: 2,
        uploadedParts: [{ partNumber: 1, sizeBytes: 67108864, etag: '"e1"' }],
      });
    });

    it('should throw VIDEO_NOT_DRAFT once the upload left draft', async () => {
      videoRepository.findOne.mockResolvedValue(
        draftVideo({ status: VideoStatus.READY, upload_id: null }),
      );

      await expect(
        service.listUploadedParts('user-1', 'video-1'),
      ).rejects.toThrow(VideoNotDraftException);
    });
  });

  describe('completeUpload', () => {
    const allParts: UploadedPart[] = [
      { partNumber: 1, sizeBytes: 67108864, etag: '"e1"' },
      { partNumber: 2, sizeBytes: 10, etag: '"e2"' },
    ];

    beforeEach(() => {
      videoRepository.findOne.mockResolvedValue(draftVideo());
      storageService.listParts.mockResolvedValue(allParts);
    });

    it('should complete the multipart upload, move to processing and enqueue the job', async () => {
      const result = await service.completeUpload('user-1', 'video-1');

      expect(result).toEqual({ id: 'video-1', status: VideoStatus.PROCESSING });
      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original',
        'upload-1',
        allParts,
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1', status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING, upload_id: null },
      );
      expect(queue.add).toHaveBeenCalledWith(
        'process-video',
        { videoId: 'video-1' },
        expect.objectContaining({
          jobId: 'video-1',
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        }),
      );
    });

    it('should throw UPLOAD_INCOMPLETE when a part is missing', async () => {
      storageService.listParts.mockResolvedValue([allParts[0]]);

      await expect(service.completeUpload('user-1', 'video-1')).rejects.toThrow(
        UploadIncompleteException,
      );
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('should throw UPLOAD_SIZE_MISMATCH when stored bytes differ from the declared size', async () => {
      storageService.listParts.mockResolvedValue([
        allParts[0],
        { ...allParts[1], sizeBytes: 11 },
      ]);

      await expect(service.completeUpload('user-1', 'video-1')).rejects.toThrow(
        UploadSizeMismatchException,
      );
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('should throw VIDEO_NOT_DRAFT for an already completed video', async () => {
      videoRepository.findOne.mockResolvedValue(
        draftVideo({ status: VideoStatus.PROCESSING, upload_id: null }),
      );

      await expect(service.completeUpload('user-1', 'video-1')).rejects.toThrow(
        VideoNotDraftException,
      );
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('should throw VIDEO_NOT_DRAFT when a concurrent completion already moved the row', async () => {
      videoRepository.update.mockResolvedValueOnce({
        affected: 0,
        raw: [],
        generatedMaps: [],
      });

      await expect(service.completeUpload('user-1', 'video-1')).rejects.toThrow(
        VideoNotDraftException,
      );
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('should mark the video failed and rethrow when enqueueing fails', async () => {
      queue.add.mockRejectedValue(new Error('redis down'));

      await expect(service.completeUpload('user-1', 'video-1')).rejects.toThrow(
        'redis down',
      );
      expect(videoRepository.update).toHaveBeenLastCalledWith(
        { id: 'video-1' },
        {
          status: VideoStatus.FAILED,
          failure_reason: 'Failed to enqueue processing job: redis down',
        },
      );
    });
  });

  describe('getOwnedVideo', () => {
    const timestamps = {
      created_at: new Date('2026-11-22T10:00:00Z'),
      updated_at: new Date('2026-11-22T10:05:00Z'),
    };

    it('should return a null thumbnailUrl while there is no thumbnail', async () => {
      videoRepository.findOne.mockResolvedValue(
        draftVideo({ thumbnail_key: null, ...timestamps }),
      );

      const result = await service.getOwnedVideo('user-1', 'video-1');

      expect(result.thumbnailUrl).toBeNull();
      expect(storageService.presignGet).not.toHaveBeenCalled();
      expect(result.createdAt).toBe('2026-11-22T10:00:00.000Z');
    });

    it('should sign a public thumbnail URL valid for one hour once the thumbnail exists', async () => {
      videoRepository.findOne.mockResolvedValue(
        draftVideo({
          status: VideoStatus.READY,
          thumbnail_key: 'videos/video-1/thumbnail.jpg',
          duration_seconds: 2,
          ...timestamps,
        }),
      );

      const result = await service.getOwnedVideo('user-1', 'video-1');

      expect(storageService.presignGet).toHaveBeenCalledWith(
        'videos/video-1/thumbnail.jpg',
        { audience: 'public', expiresInSeconds: 3600 },
      );
      expect(result.thumbnailUrl).toBe('http://minio:9000/signed-get');
      expect(result.durationSeconds).toBe(2);
    });

    it('should throw VIDEO_NOT_FOUND for a video of another channel', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(service.getOwnedVideo('user-1', 'video-1')).rejects.toThrow(
        VideoNotFoundException,
      );
    });
  });

  describe('getPlaybackUrl', () => {
    const slug = 'AbCdEfGhIjK';
    const readyVideo = (overrides: Partial<Video> = {}) =>
      draftVideo({
        slug,
        status: VideoStatus.READY,
        upload_id: null,
        content_type: 'video/mp4',
        original_filename: 'aula final.mp4',
        ...overrides,
      });

    it('should report VIDEO_NOT_FOUND for a malformed slug without querying', async () => {
      await expect(
        service.getPlaybackUrl('user-1', 'bad', 'stream'),
      ).rejects.toThrow(VideoNotFoundException);
      expect(videoRepository.findOne).not.toHaveBeenCalled();
    });

    it('should look the slug up only inside the caller channel', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.getPlaybackUrl('user-1', slug, 'stream'),
      ).rejects.toThrow(VideoNotFoundException);
      expect(videoRepository.findOne).toHaveBeenCalledWith({
        where: { slug, channel_id: 'channel-1' },
      });
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
      'should throw VIDEO_NOT_READY while the video is %s',
      async (status) => {
        videoRepository.findOne.mockResolvedValue(readyVideo({ status }));

        await expect(
          service.getPlaybackUrl('user-1', slug, 'stream'),
        ).rejects.toThrow(VideoNotReadyException);
      },
    );

    it('should sign an inline public URL for streaming', async () => {
      videoRepository.findOne.mockResolvedValue(readyVideo());

      await service.getPlaybackUrl('user-1', slug, 'stream');

      expect(storageService.presignGet).toHaveBeenCalledWith(
        'videos/video-1/original',
        {
          audience: 'public',
          expiresInSeconds: 3600,
          contentType: 'video/mp4',
          contentDisposition: undefined,
        },
      );
    });

    it('should sign an attachment URL with the original file name for download', async () => {
      videoRepository.findOne.mockResolvedValue(
        readyVideo({ original_filename: 'aula "final" ç.mp4' }),
      );

      await service.getPlaybackUrl('user-1', slug, 'download');

      expect(storageService.presignGet).toHaveBeenCalledWith(
        'videos/video-1/original',
        expect.objectContaining({
          contentDisposition: 'attachment; filename="aula _final_ _.mp4"',
        }),
      );
    });
  });
});
