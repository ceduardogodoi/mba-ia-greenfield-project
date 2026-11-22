import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  AuthenticatedUser,
  createAuthenticatedUser,
  createVideosE2eApp,
  initiateVideo,
  NOT_A_VIDEO_PATH,
  SAMPLE_VIDEO_PATH,
  uploadFile,
  waitForStatus,
} from './utils/videos-e2e';

interface VideoBody {
  status: string;
  durationSeconds: number | null;
  metadata: {
    video: { codec: string; width: number; height: number } | null;
  } | null;
  thumbnailUrl: string | null;
  failureReason: string | null;
}

/**
 * The ready/failed scenarios go through the real pipeline: the Compose
 * `video-worker` service consumes the job enqueued by the API (TD-14 option C).
 */
describe('videos-get', () => {
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

  function getVideo(id: string, token = owner.accessToken) {
    return request(app.getHttpServer())
      .get(`/videos/${id}`)
      .set('Authorization', `Bearer ${token}`);
  }

  async function uploadAndComplete(path: string, fileName: string) {
    const video = await uploadFile(app, owner.accessToken, path, fileName);
    await request(app.getHttpServer())
      .post(`/videos/${video.id}/upload/complete`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(202);
    return video;
  }

  // 1. GET /videos/{id}
  test('returns-draft-video', async () => {
    const video = await initiateVideo(app, owner.accessToken, {
      fileName: 'aula.mp4',
      sizeBytes: 1000,
      contentType: 'video/mp4',
    });

    const body = (await getVideo(video.id).expect(200)).body as VideoBody;

    expect(body).toMatchObject({
      status: 'draft',
      durationSeconds: null,
      metadata: null,
      thumbnailUrl: null,
      failureReason: null,
    });
  });

  test('returns-ready-video-with-thumbnail', async () => {
    const video = await uploadAndComplete(SAMPLE_VIDEO_PATH, 'sample.mp4');

    const body = (await waitForStatus(
      app,
      owner.accessToken,
      video.id,
      'ready',
    )) as unknown as VideoBody;

    expect(body.durationSeconds).toBeGreaterThanOrEqual(1.9);
    expect(body.durationSeconds).toBeLessThanOrEqual(2.1);
    expect(body.metadata?.video).toMatchObject({
      codec: 'h264',
      width: 320,
      height: 240,
    });
    const thumbnail = await fetch(body.thumbnailUrl!);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
  });

  test('returns-failed-video-with-reason', async () => {
    const video = await uploadAndComplete(NOT_A_VIDEO_PATH, 'not-a-video.mp4');

    const body = (await waitForStatus(
      app,
      owner.accessToken,
      video.id,
      'failed',
    )) as unknown as VideoBody;

    expect(body.failureReason).toEqual(expect.any(String));
    expect(body.thumbnailUrl).toBeNull();
  });

  test('validates-id-and-ownership', async () => {
    await getVideo('not-a-uuid').expect(400);

    const video = await initiateVideo(app, owner.accessToken, {
      fileName: 'aula.mp4',
      sizeBytes: 1000,
      contentType: 'video/mp4',
    });
    const stranger = await createAuthenticatedUser(app);
    const res = await getVideo(video.id, stranger.accessToken).expect(404);
    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
  });
});
