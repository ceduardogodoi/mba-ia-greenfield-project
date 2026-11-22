import { randomUUID } from 'crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const TEN_GIB = 10 * 1024 * 1024 * 1024;

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_entity_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `video_channel_${n}`,
        nickname: `video_channel_${n}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channelId: string, slug: string): Video {
    const id = randomUUID();
    return videoRepository.create({
      id,
      channel_id: channelId,
      slug,
      title: 'aula',
      original_filename: 'aula.mp4',
      content_type: 'video/mp4',
      size_bytes: TEN_GIB,
      storage_key: `videos/${id}/original`,
      upload_id: 'upload-id',
    });
  }

  it('should default status to draft and keep nullable processing fields empty', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      buildVideo(channel.id, 'AAAAAAAAAAA'),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.thumbnail_key).toBeNull();
    expect(found.duration_seconds).toBeNull();
    expect(found.metadata).toBeNull();
    expect(found.failure_reason).toBeNull();
  });

  it('should read size_bytes back as a number, including 10 GiB', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      buildVideo(channel.id, 'BBBBBBBBBBB'),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.size_bytes).toBe(TEN_GIB);
  });

  it('should reject two videos with the same slug', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel.id, 'CCCCCCCCCCC'));

    await expect(
      videoRepository.save(buildVideo(channel.id, 'CCCCCCCCCCC')),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('should reject a video whose channel does not exist', async () => {
    await expect(
      videoRepository.save(buildVideo(randomUUID(), 'DDDDDDDDDDD')),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('should delete the videos of a channel when the channel is deleted', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel.id, 'EEEEEEEEEEE'));

    await channelRepository.delete({ id: channel.id });

    await expect(
      videoRepository.countBy({ channel_id: channel.id }),
    ).resolves.toBe(0);
  });

  it('should persist metadata as jsonb', async () => {
    const channel = await createChannel();
    const video = buildVideo(channel.id, 'FFFFFFFFFFF');
    video.metadata = {
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      bitRate: 1000,
      sizeBytes: 2048,
      video: { codec: 'h264', width: 320, height: 240, fps: 25 },
      audio: { codec: 'aac' },
    };
    const saved = await videoRepository.save(video);

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.metadata).toEqual(video.metadata);
  });
});
