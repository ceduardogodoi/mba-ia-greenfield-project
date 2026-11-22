import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { VideoNotDraftException } from '../common/exceptions/domain.exception';
import { VIDEO_PROCESSING_QUEUE } from '../queue/video-processing.queue';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration — DB + MinIO)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videos: VideosService;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let counter = 0;

  beforeAll(async () => {
    process.env.S3_PUBLIC_ENDPOINT = 'http://minio:9000';
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        // Isolated key prefix: the Compose video-worker (default prefix) never sees test jobs.
        BullModule.forRoot({
          connection: {
            host: process.env.REDIS_HOST ?? 'redis',
            port: Number(process.env.REDIS_PORT ?? 6379),
          },
          prefix: 'streamtube-test',
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();
    dataSource = module.get(DataSource);
    videos = module.get(VideosService);
    storage = module.get(StorageService);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createOwner(): Promise<{ userId: string; channelId: string }> {
    const n = ++counter;
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `videos_int_${n}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await module
      .get(ChannelsService)
      .createChannel(user.id, `videos_int_${n}@example.com`);
    return { userId: user.id, channelId: channel.id };
  }

  describe('initiateUpload', () => {
    it('should persist a draft in the owner channel and open the multipart upload in the bucket', async () => {
      const owner = await createOwner();

      const result = await videos.initiateUpload(owner.userId, {
        fileName: 'aula.mp4',
        sizeBytes: 150000000,
        contentType: 'video/mp4',
      });

      const row = await videoRepository.findOneByOrFail({ id: result.id });
      expect(row.status).toBe(VideoStatus.DRAFT);
      expect(row.channel_id).toBe(owner.channelId);
      expect(row.storage_key).toBe(`videos/${result.id}/original`);
      expect(row.upload_id).toEqual(expect.any(String));
      await expect(
        storage.listParts(row.storage_key, row.upload_id!),
      ).resolves.toEqual([]);
    });
  });

  describe('signUploadParts / listUploadedParts', () => {
    it('should store a part PUT to a signed URL and report it as uploaded', async () => {
      const owner = await createOwner();
      const { id } = await videos.initiateUpload(owner.userId, {
        fileName: 'aula.mp4',
        sizeBytes: 5 * 1024 * 1024 + 10,
        contentType: 'video/mp4',
      });
      const body = Buffer.alloc(5 * 1024 * 1024, 3);

      const { parts } = await videos.signUploadParts(owner.userId, id, [1]);
      const response = await fetch(parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(body),
      });
      expect(response.status).toBe(200);

      const progress = await videos.listUploadedParts(owner.userId, id);
      expect(progress.partCount).toBe(1);
      expect(progress.uploadedParts).toEqual([
        {
          partNumber: 1,
          sizeBytes: body.length,
          etag: response.headers.get('etag'),
        },
      ]);
    });
  });

  describe('completeUpload', () => {
    it('should complete the stored object, move to processing and enqueue process-video with jobId = videoId', async () => {
      const owner = await createOwner();
      const body = Buffer.alloc(1024, 9);
      const { id } = await videos.initiateUpload(owner.userId, {
        fileName: 'aula.mp4',
        sizeBytes: body.length,
        contentType: 'video/mp4',
      });
      const { parts } = await videos.signUploadParts(owner.userId, id, [1]);
      await fetch(parts[0].url, { method: 'PUT', body: new Uint8Array(body) });

      const result = await videos.completeUpload(owner.userId, id);

      expect(result).toEqual({ id, status: VideoStatus.PROCESSING });
      const row = await videoRepository.findOneByOrFail({ id });
      expect(row.status).toBe(VideoStatus.PROCESSING);
      expect(row.upload_id).toBeNull();
      await expect(storage.headObject(row.storage_key)).resolves.toEqual({
        contentLength: body.length,
      });

      const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
      const job = await queue.getJob(id);
      expect(job?.name).toBe('process-video');
      expect(job?.data).toEqual({ videoId: id });
      await job?.remove();

      await expect(videos.completeUpload(owner.userId, id)).rejects.toThrow(
        VideoNotDraftException,
      );
    });
  });

  describe('getPlaybackUrl', () => {
    async function readyVideo(owner: { userId: string; channelId: string }) {
      const bytes = Buffer.alloc(4096, 4);
      const { id, slug } = await videos.initiateUpload(owner.userId, {
        fileName: 'aula.mp4',
        sizeBytes: bytes.length,
        contentType: 'video/mp4',
      });
      const row = await videoRepository.findOneByOrFail({ id });
      await storage.putObject(row.storage_key, bytes, 'video/mp4');
      await videoRepository.update(
        { id },
        { status: VideoStatus.READY, upload_id: null },
      );
      return { slug, bytes };
    }

    it('should return a stream URL whose storage answers Range with 206', async () => {
      const owner = await createOwner();
      const { slug } = await readyVideo(owner);

      const url = await videos.getPlaybackUrl(owner.userId, slug, 'stream');
      const response = await fetch(url, {
        headers: { Range: 'bytes=0-1023' },
      });

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 0-1023/4096');
      expect((await response.arrayBuffer()).byteLength).toBe(1024);
    });

    it('should return a download URL served as attachment with the original name', async () => {
      const owner = await createOwner();
      const { slug, bytes } = await readyVideo(owner);

      const url = await videos.getPlaybackUrl(owner.userId, slug, 'download');
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toBe(
        'attachment; filename="aula.mp4"',
      );
      expect((await response.arrayBuffer()).byteLength).toBe(bytes.length);
    });
  });
});
