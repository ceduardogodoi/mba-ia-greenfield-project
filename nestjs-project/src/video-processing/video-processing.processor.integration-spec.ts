import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { MediaModule } from '../media/media.module';
import type { ProcessVideoJobData } from '../queue/video-processing.queue';
import { originalKey } from '../storage/storage-keys';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VideoProcessingProcessor } from './video-processing.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');

/**
 * Runs the processor in-process against real DB, MinIO and FFmpeg
 * (phase-03-videos/TD-14 option C). `process()` is called directly, so no queue
 * is involved and the Compose video-worker never sees these videos.
 */
describe('VideoProcessingProcessor (integration — DB + MinIO + FFmpeg)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let processor: VideoProcessingProcessor;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let counter = 0;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        MediaModule,
      ],
      providers: [VideoProcessingProcessor, ChannelsService],
    }).compile();
    dataSource = module.get(DataSource);
    processor = module.get(VideoProcessingProcessor);
    storage = module.get(StorageService);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function processingVideoWith(fixture: string): Promise<Video> {
    const n = ++counter;
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `processor_int_${n}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await module
      .get(ChannelsService)
      .createChannel(user.id, `processor_int_${n}@example.com`);
    const bytes = readFileSync(join(FIXTURES, fixture));
    const id = randomUUID();
    await storage.putObject(originalKey(id), bytes, 'video/mp4');
    return videoRepository.save(
      videoRepository.create({
        id,
        channel_id: channel.id,
        slug: `s${String(n).padStart(10, '0')}`,
        title: 'sample',
        original_filename: fixture,
        content_type: 'video/mp4',
        size_bytes: bytes.length,
        status: VideoStatus.PROCESSING,
        storage_key: originalKey(id),
        upload_id: null,
      }),
    );
  }

  function jobFor(video: Video, attemptsMade = 0): Job<ProcessVideoJobData> {
    return {
      id: video.id,
      data: { videoId: video.id },
      attemptsMade,
      opts: { attempts: 3 },
    } as Job<ProcessVideoJobData>;
  }

  it('should process a valid video to ready with metadata and a stored JPEG thumbnail', async () => {
    const video = await processingVideoWith('sample.mp4');

    await processor.process(jobFor(video));

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.READY);
    expect(row.duration_seconds).toBeGreaterThanOrEqual(1.9);
    expect(row.duration_seconds).toBeLessThanOrEqual(2.1);
    expect(row.metadata?.video).toEqual(
      expect.objectContaining({ codec: 'h264', width: 320, height: 240 }),
    );
    expect(row.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);

    const url = await storage.presignGet(row.thumbnail_key!, {
      audience: 'internal',
      expiresInSeconds: 60,
    });
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
  });

  it('should mark a non-media upload failed on the first attempt, without retry', async () => {
    const video = await processingVideoWith('not-a-video.mp4');

    await expect(processor.process(jobFor(video))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.FAILED);
    expect(row.failure_reason).toEqual(expect.stringContaining('ffprobe'));
    expect(row.failure_reason).not.toMatch(/X-Amz-Signature|https?:\/\//);
  });

  it('should not touch a video that is already ready (idempotent redelivery)', async () => {
    const video = await processingVideoWith('sample.mp4');
    await processor.process(jobFor(video));
    const first = await videoRepository.findOneByOrFail({ id: video.id });

    await processor.process(jobFor(video));

    const second = await videoRepository.findOneByOrFail({ id: video.id });
    expect(second.updated_at).toEqual(first.updated_at);
  });
});
