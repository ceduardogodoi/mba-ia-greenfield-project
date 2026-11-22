import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  AuthenticatedUser,
  createAuthenticatedUser,
  createVideosE2eApp,
  InitiatedVideo,
  initiateVideo,
  putToPresignedUrl,
  signParts,
} from './utils/videos-e2e';

const PART_SIZE = 67108864;
const BUFFER = Buffer.alloc(1024, 5);

describe('videos-upload-complete', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let owner: AuthenticatedUser;

  beforeAll(async () => {
    app = await createVideosE2eApp();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    owner = await createAuthenticatedUser(app);
  });

  async function uploadBuffer(
    declaredSize = BUFFER.length,
  ): Promise<InitiatedVideo> {
    const video = await initiateVideo(app, owner.accessToken, {
      fileName: 'aula.mp4',
      sizeBytes: declaredSize,
      contentType: 'video/mp4',
    });
    const [part] = await signParts(app, owner.accessToken, video.id, [1]);
    expect((await putToPresignedUrl(part.url, BUFFER)).status).toBe(200);
    return video;
  }

  function complete(videoId: string, token = owner.accessToken) {
    return request(app.getHttpServer())
      .post(`/videos/${videoId}/upload/complete`)
      .set('Authorization', `Bearer ${token}`);
  }

  function errorOf(res: request.Response): string {
    return (res.body as { error: string }).error;
  }

  // 1. POST /videos/{id}/upload/complete
  test('completes-upload-and-leaves-draft', async () => {
    const video = await uploadBuffer();

    const res = await complete(video.id).expect(202);
    expect(res.body).toEqual({ id: video.id, status: 'processing' });

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(row.upload_id).toBeNull();
    expect(row.status).not.toBe(VideoStatus.DRAFT);
    await expect(
      app.get(StorageService).headObject(row.storage_key),
    ).resolves.toEqual({ contentLength: BUFFER.length });
  });

  test('rejects-missing-parts', async () => {
    const video = await initiateVideo(app, owner.accessToken, {
      fileName: 'aula.mp4',
      sizeBytes: PART_SIZE + 10,
      contentType: 'video/mp4',
    });
    const [part] = await signParts(app, owner.accessToken, video.id, [1]);
    expect(
      (await putToPresignedUrl(part.url, Buffer.alloc(PART_SIZE, 1))).status,
    ).toBe(200);

    const res = await complete(video.id).expect(400);
    expect(errorOf(res)).toBe('UPLOAD_INCOMPLETE');
    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.DRAFT);
  });

  test('rejects-size-mismatch', async () => {
    const video = await uploadBuffer(BUFFER.length + 1);

    const res = await complete(video.id).expect(400);
    expect(errorOf(res)).toBe('UPLOAD_SIZE_MISMATCH');
    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.DRAFT);
  });

  test('rejects-second-completion', async () => {
    const video = await uploadBuffer();
    await complete(video.id).expect(202);

    const res = await complete(video.id).expect(409);
    expect(errorOf(res)).toBe('VIDEO_NOT_DRAFT');
  });

  test('hides-video-from-other-users', async () => {
    const video = await uploadBuffer();
    const stranger = await createAuthenticatedUser(app);

    const res = await complete(video.id, stranger.accessToken).expect(404);
    expect(errorOf(res)).toBe('VIDEO_NOT_FOUND');
  });
});
