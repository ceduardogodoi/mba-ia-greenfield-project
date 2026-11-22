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
} from './utils/videos-e2e';

interface InitiateBody {
  id: string;
  slug: string;
  title: string;
  status: string;
  upload: { partSize: number; partCount: number };
}

describe('videos-create', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let owner: AuthenticatedUser;

  const validBody = {
    fileName: 'aula.mp4',
    sizeBytes: 150000000,
    contentType: 'video/mp4',
  };

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

  function post(body: Record<string, unknown>, token?: string) {
    const req = request(app.getHttpServer()).post('/videos').send(body);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  // 1. POST /videos
  test('creates-draft-video-with-upload-policy', async () => {
    const res = await post(validBody, owner.accessToken).expect(201);
    const body = res.body as InitiateBody;

    expect(body.status).toBe('draft');
    expect(body.title).toBe('aula');
    expect(body.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(body.upload).toEqual({ partSize: 67108864, partCount: 3 });

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: body.id });
    expect(row.status).toBe(VideoStatus.DRAFT);
    expect(row.channel_id).toBe(owner.channelId);
    expect(row.storage_key).toBe(`videos/${body.id}/original`);
    expect(row.upload_id).not.toBeNull();
  });

  test('uses-provided-title', async () => {
    const res = await post(
      { ...validBody, title: 'Minha aula de NestJS' },
      owner.accessToken,
    ).expect(201);
    const body = res.body as InitiateBody;

    expect(body.title).toBe('Minha aula de NestJS');
    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: body.id });
    expect(row.title).toBe('Minha aula de NestJS');
  });

  test('rejects-invalid-body', async () => {
    const tooBig = await post(
      { ...validBody, sizeBytes: 10737418241 },
      owner.accessToken,
    ).expect(400);
    expect((tooBig.body as { error: string }).error).toBe('VALIDATION_ERROR');

    const notVideo = await post(
      { ...validBody, contentType: 'application/pdf' },
      owner.accessToken,
    ).expect(400);
    expect((notVideo.body as { error: string }).error).toBe('VALIDATION_ERROR');

    await expect(dataSource.getRepository(Video).count()).resolves.toBe(0);
  });

  test('requires-authentication', async () => {
    await post(validBody).expect(401);
  });

  test('generates-distinct-slugs', async () => {
    const first = (await post(validBody, owner.accessToken).expect(201))
      .body as InitiateBody;
    const second = (await post(validBody, owner.accessToken).expect(201))
      .body as InitiateBody;

    expect(first.slug).not.toBe(second.slug);
    expect(first.id).not.toBe(second.id);
  });
});
