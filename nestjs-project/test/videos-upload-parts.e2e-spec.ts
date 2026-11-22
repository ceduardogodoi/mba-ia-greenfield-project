import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  AuthenticatedUser,
  createAuthenticatedUser,
  createVideosE2eApp,
  InitiatedVideo,
  initiateVideo,
  putToPresignedUrl,
} from './utils/videos-e2e';

const PART_SIZE = 67108864;

interface SignBody {
  parts: { partNumber: number; url: string }[];
  expiresAt: string;
}

interface ListBody {
  partSize: number;
  partCount: number;
  uploadedParts: { partNumber: number; sizeBytes: number; etag: string }[];
}

describe('videos-upload-parts', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let owner: AuthenticatedUser;
  let video: InitiatedVideo;

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
    video = await initiateVideo(app, owner.accessToken, {
      fileName: 'aula.mp4',
      sizeBytes: PART_SIZE + 10,
      contentType: 'video/mp4',
    });
  });

  function sign(partNumbers: number[], token = owner.accessToken) {
    return request(app.getHttpServer())
      .post(`/videos/${video.id}/upload/parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partNumbers });
  }

  function list(token = owner.accessToken) {
    return request(app.getHttpServer())
      .get(`/videos/${video.id}/upload/parts`)
      .set('Authorization', `Bearer ${token}`);
  }

  // 1. POST/GET /videos/{id}/upload/parts
  test('signs-requested-parts', async () => {
    const before = Date.now();
    const res = await sign([1, 2]).expect(200);
    const body = res.body as SignBody;

    expect(body.parts.map((p) => p.partNumber)).toEqual([1, 2]);
    for (const part of body.parts) {
      expect(new URL(part.url).host).toBe('minio:9000');
    }
    const expiresAt = new Date(body.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3500 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(before + 3700 * 1000);
  });

  test('uploads-part-directly-and-lists-it', async () => {
    const [part] = ((await sign([1]).expect(200)).body as SignBody).parts;
    const response = await putToPresignedUrl(
      part.url,
      Buffer.alloc(PART_SIZE, 1),
    );
    expect(response.status).toBe(200);
    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();

    const body = (await list().expect(200)).body as ListBody;
    expect(body.partSize).toBe(PART_SIZE);
    expect(body.partCount).toBe(2);
    expect(body.uploadedParts).toEqual([
      { partNumber: 1, sizeBytes: PART_SIZE, etag },
    ]);
  });

  test('rejects-part-number-above-part-count', async () => {
    const res = await sign([3]).expect(400);
    expect((res.body as { error: string }).error).toBe('INVALID_PART_NUMBER');
  });

  test('hides-video-from-other-users', async () => {
    const stranger = await createAuthenticatedUser(app);

    const signRes = await sign([1], stranger.accessToken).expect(404);
    expect((signRes.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
    const listRes = await list(stranger.accessToken).expect(404);
    expect((listRes.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
  });

  test('rejects-after-upload-completed', async () => {
    await dataSource
      .getRepository(Video)
      .update({ id: video.id }, { status: VideoStatus.PROCESSING });

    const signRes = await sign([1]).expect(409);
    expect((signRes.body as { error: string }).error).toBe('VIDEO_NOT_DRAFT');
    const listRes = await list().expect(409);
    expect((listRes.body as { error: string }).error).toBe('VIDEO_NOT_DRAFT');
  });
});
