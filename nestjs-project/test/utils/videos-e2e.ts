import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import * as argon2 from 'argon2';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { ChannelsService } from '../../src/channels/channels.service';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import { User } from '../../src/users/entities/user.entity';

export const SAMPLE_VIDEO_PATH = join(
  __dirname,
  '..',
  'fixtures',
  'sample.mp4',
);
export const NOT_A_VIDEO_PATH = join(
  __dirname,
  '..',
  'fixtures',
  'not-a-video.mp4',
);

/**
 * Boots the full app like main.ts does. The e2e suite runs inside the
 * nestjs-api container, so presigned URLs must be signed for the in-network
 * storage host (phase-03-videos/TD-11 Revision 2026-11-22).
 */
export async function createVideosE2eApp(): Promise<INestApplication<App>> {
  process.env.S3_PUBLIC_ENDPOINT = 'http://minio:9000';

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();
  return app;
}

export interface AuthenticatedUser {
  userId: string;
  channelId: string;
  accessToken: string;
}

let userCounter = 0;

/** Creates a confirmed user with its channel and logs in through POST /auth/login. */
export async function createAuthenticatedUser(
  app: INestApplication<App>,
): Promise<AuthenticatedUser> {
  const dataSource = app.get(DataSource);
  const email = `videos_e2e_${Date.now()}_${++userCounter}@example.com`;
  const password = 'password123';

  const user = await dataSource.getRepository(User).save(
    dataSource.getRepository(User).create({
      email,
      password: await argon2.hash(password),
      is_confirmed: true,
    }),
  );
  const channel = await app.get(ChannelsService).createChannel(user.id, email);

  app.get<ThrottlerStorageService>(ThrottlerStorage).storage.clear();
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);

  return {
    userId: user.id,
    channelId: channel.id,
    accessToken: (res.body as { access_token: string }).access_token,
  };
}

export interface InitiatedVideo {
  id: string;
  slug: string;
  upload: { partSize: number; partCount: number };
}

export async function initiateVideo(
  app: INestApplication<App>,
  token: string,
  body: Record<string, unknown>,
): Promise<InitiatedVideo> {
  const res = await request(app.getHttpServer())
    .post('/videos')
    .set('Authorization', `Bearer ${token}`)
    .send(body)
    .expect(201);
  return res.body as InitiatedVideo;
}

export async function signParts(
  app: INestApplication<App>,
  token: string,
  videoId: string,
  partNumbers: number[],
): Promise<{ partNumber: number; url: string }[]> {
  const res = await request(app.getHttpServer())
    .post(`/videos/${videoId}/upload/parts`)
    .set('Authorization', `Bearer ${token}`)
    .send({ partNumbers })
    .expect(200);
  return (res.body as { parts: { partNumber: number; url: string }[] }).parts;
}

/** PUTs bytes straight to the storage through a presigned URL (never through the API). */
export async function putToPresignedUrl(
  url: string,
  body: Buffer,
): Promise<Response> {
  return fetch(url, { method: 'PUT', body: new Uint8Array(body) });
}

/** Initiates a single-part upload of a local file and sends its bytes to the storage. */
export async function uploadFile(
  app: INestApplication<App>,
  token: string,
  filePath: string,
  fileName: string,
): Promise<InitiatedVideo> {
  const bytes = readFileSync(filePath);
  const video = await initiateVideo(app, token, {
    fileName,
    sizeBytes: bytes.length,
    contentType: 'video/mp4',
  });
  const [part] = await signParts(app, token, video.id, [1]);
  const response = await putToPresignedUrl(part.url, bytes);
  if (response.status !== 200) {
    throw new Error(`Part upload failed with status ${response.status}`);
  }
  return video;
}

export async function waitForStatus(
  app: INestApplication<App>,
  token: string,
  videoId: string,
  expected: string,
  timeoutMs = 30000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const res = await request(app.getHttpServer())
      .get(`/videos/${videoId}`)
      .set('Authorization', `Bearer ${token}`);
    last = res.body as Record<string, unknown>;
    if (last.status === expected) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Video ${videoId} did not reach status ${expected}; last: ${JSON.stringify(last)}`,
  );
}
