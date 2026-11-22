import { randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const FIVE_MIB = 5 * 1024 * 1024;

describe('StorageService (integration — MinIO)', () => {
  let module: TestingModule;
  let storage: StorageService;
  let previousPublicEndpoint: string | undefined;

  beforeAll(async () => {
    // Tests run inside the nestjs-api container: client-facing URLs must be
    // signed for the in-network host (phase-03-videos/TD-11 Revision 2026-11-22).
    previousPublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
    process.env.S3_PUBLIC_ENDPOINT = 'http://minio:9000';

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    await module.close();
    process.env.S3_PUBLIC_ENDPOINT = previousPublicEndpoint;
  });

  function testKey(): string {
    return `test/${randomUUID()}/original`;
  }

  async function putPart(url: string, body: Buffer): Promise<Response> {
    return fetch(url, { method: 'PUT', body: new Uint8Array(body) });
  }

  async function uploadInTwoParts(
    key: string,
  ): Promise<{ uploadId: string; part1: Buffer; part2: Buffer }> {
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const part1 = Buffer.alloc(FIVE_MIB, 1);
    const part2 = Buffer.from('tail-bytes');
    for (const [partNumber, body] of [
      [1, part1],
      [2, part2],
    ] as const) {
      const url = await storage.presignUploadPart(
        key,
        uploadId,
        partNumber,
        60,
      );
      const response = await putPart(url, body);
      expect(response.status).toBe(200);
    }
    return { uploadId, part1, part2 };
  }

  it('should complete a multipart upload sent directly to presigned part URLs', async () => {
    const key = testKey();
    const { uploadId, part1, part2 } = await uploadInTwoParts(key);

    const parts = await storage.listParts(key, uploadId);
    await storage.completeMultipartUpload(key, uploadId, parts);

    const head = await storage.headObject(key);
    expect(head.contentLength).toBe(part1.length + part2.length);
  });

  it('should list exactly the parts already uploaded, in order, with size and ETag', async () => {
    const key = testKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const url = await storage.presignUploadPart(key, uploadId, 1, 60);
    const response = await putPart(url, Buffer.alloc(FIVE_MIB, 2));

    const parts = await storage.listParts(key, uploadId);

    expect(parts).toEqual([
      {
        partNumber: 1,
        sizeBytes: FIVE_MIB,
        etag: response.headers.get('etag'),
      },
    ]);
  });

  it('should serve Range requests with 206 through a presigned GET URL', async () => {
    const key = testKey();
    await storage.putObject(key, Buffer.alloc(1000, 7), 'video/mp4');

    const url = await storage.presignGet(key, {
      audience: 'public',
      expiresInSeconds: 60,
    });
    const response = await fetch(url, { headers: { Range: 'bytes=0-99' } });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-99/1000');
    expect((await response.arrayBuffer()).byteLength).toBe(100);
  });

  it('should return Content-Disposition attachment when requested', async () => {
    const key = testKey();
    await storage.putObject(key, Buffer.from('content'), 'video/mp4');

    const url = await storage.presignGet(key, {
      audience: 'public',
      expiresInSeconds: 60,
      contentDisposition: 'attachment; filename="aula.mp4"',
    });
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="aula.mp4"',
    );
  });

  it('should sign public URLs for S3_PUBLIC_ENDPOINT and internal ones for S3_ENDPOINT', async () => {
    process.env.S3_PUBLIC_ENDPOINT = 'http://public.example:9000';
    const isolated = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    const service = isolated.get(StorageService);

    const publicUrl = await service.presignGet('any', {
      audience: 'public',
      expiresInSeconds: 60,
    });
    const internalUrl = await service.presignGet('any', {
      audience: 'internal',
      expiresInSeconds: 60,
    });

    expect(new URL(publicUrl).host).toBe('public.example:9000');
    expect(new URL(internalUrl).host).toBe('minio:9000');
    await isolated.close();
    process.env.S3_PUBLIC_ENDPOINT = 'http://minio:9000';
  });
});
