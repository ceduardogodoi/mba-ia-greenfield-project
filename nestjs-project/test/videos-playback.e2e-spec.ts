import { readFileSync } from 'fs';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  AuthenticatedUser,
  createAuthenticatedUser,
  createVideosE2eApp,
  InitiatedVideo,
  initiateVideo,
  SAMPLE_VIDEO_PATH,
  uploadFile,
  waitForStatus,
} from './utils/videos-e2e';

/**
 * The video is taken to `ready` by the Compose `video-worker` service
 * (full pipeline, TD-14 option C) before stream/download are exercised.
 */
describe('videos-playback', () => {
  let app: INestApplication<App>;
  let owner: AuthenticatedUser;
  let video: InitiatedVideo;
  const sampleSize = readFileSync(SAMPLE_VIDEO_PATH).length;

  beforeAll(async () => {
    app = await createVideosE2eApp();
    await cleanAllTables(app.get(DataSource));
    owner = await createAuthenticatedUser(app);
    video = await uploadFile(
      app,
      owner.accessToken,
      SAMPLE_VIDEO_PATH,
      'sample.mp4',
    );
    await request(app.getHttpServer())
      .post(`/videos/${video.id}/upload/complete`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(202);
    await waitForStatus(app, owner.accessToken, video.id, 'ready');
  });

  afterAll(async () => {
    await app.close();
  });

  function get(path: string, token?: string) {
    const req = request(app.getHttpServer()).get(path);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  // 1. GET /videos/{slug}/stream and /download
  test('redirects-stream-to-storage', async () => {
    const res = await get(
      `/videos/${video.slug}/stream`,
      owner.accessToken,
    ).expect(302);

    const location = new URL(res.headers.location);
    expect(location.host).toBe('minio:9000');
    expect(location.pathname).toContain(`videos/${video.id}/original`);
  });

  test('storage-serves-range-request', async () => {
    const res = await get(
      `/videos/${video.slug}/stream`,
      owner.accessToken,
    ).expect(302);

    const response = await fetch(res.headers.location, {
      headers: { Range: 'bytes=0-1023' },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toMatch(/^bytes 0-1023\//);
    expect((await response.arrayBuffer()).byteLength).toBe(1024);
  });

  test('redirects-download-as-attachment', async () => {
    const res = await get(
      `/videos/${video.slug}/download`,
      owner.accessToken,
    ).expect(302);

    const response = await fetch(res.headers.location);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="sample.mp4"',
    );
    expect((await response.arrayBuffer()).byteLength).toBe(sampleSize);
  });

  test('rejects-video-not-ready', async () => {
    const draft = await initiateVideo(app, owner.accessToken, {
      fileName: 'pending.mp4',
      sizeBytes: 1000,
      contentType: 'video/mp4',
    });

    const res = await get(
      `/videos/${draft.slug}/stream`,
      owner.accessToken,
    ).expect(409);
    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_READY');
  });

  test('hides-unknown-or-foreign-videos', async () => {
    const unknown = await get(
      '/videos/AAAAAAAAAAA/stream',
      owner.accessToken,
    ).expect(404);
    expect((unknown.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');

    const stranger = await createAuthenticatedUser(app);
    const foreign = await get(
      `/videos/${video.slug}/stream`,
      stranger.accessToken,
    ).expect(404);
    expect((foreign.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');

    await get(`/videos/${video.slug}/stream`).expect(401);
  });
});
