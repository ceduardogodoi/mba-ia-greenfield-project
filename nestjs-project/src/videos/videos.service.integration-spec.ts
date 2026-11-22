import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
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
});
