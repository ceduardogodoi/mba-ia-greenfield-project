---
libs:
  "bullmq":
    version: "^6.7.8"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-11-22T00:00:00Z"
  "@nestjs/bullmq":
    version: "^12.0.2"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-11-22T00:00:00Z"
  "ioredis":
    version: "^5.11.1"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-11-22T14:10:00Z"
  "@aws-sdk/client-s3":
    version: "^3.1175.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-22T00:00:00Z"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1175.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-22T00:00:00Z"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-22T14:09:22Z"
---

# Library References — phase-03-videos

Distilled from Context7 for the surfaces the decided TDs use. Versions are the latest published on npm at resolve time; compatibility with the installed stack (`@nestjs/core@11.1.16`, Node 25 in `Dockerfile.dev`) was checked: `@nestjs/bullmq@12` peer-depends on `bullmq ^3 || ^4 || ^5 || ^6` and `@nestjs/common|core ^10 || ^11 || ^12`.

### bullmq

_Used by: `phase-03-videos/TD-01`, `TD-07`, `TD-13`._

- **Deterministic job id (idempotent enqueue):** `queue.add(name, data, { jobId })` — a job whose id already exists in the queue is ignored. Ids must be unique per queue; avoid `:` and digit-only strings (a UUID is fine). Jobs removed by `removeOnComplete`/`removeOnFail` are no longer considered duplicates.
- **Retries:** `{ attempts: 3, backoff: { type: 'exponential', delay: 1000 } }` → retries after `2^(attempt-1) * delay` ms. Can be set per job or as queue `defaultJobOptions`.
- **Final failure detection:** a failure is final (job moved to `failed`, no retry) when `job.attemptsMade + 1 >= job.opts.attempts`, or when the thrown error is an `UnrecoverableError` (`import { UnrecoverableError } from 'bullmq'`). Inside `process()`, checking `job.attemptsMade + 1 >= (job.opts.attempts ?? 1)` before rethrowing identifies the last attempt.
- **Connections:** Workers require ioredis `maxRetriesPerRequest: null` (BullMQ sets it by default for Workers when given plain connection options; passing `{ host, port }` is the recommended form).
- **`prefix`** (QueueOptions/WorkerOptions): namespaces all Redis keys of a queue — usable to isolate test queues from the Compose worker if needed.
- **Shutdown:** `queue.close()` / `worker.close()` close connections gracefully (Nest closes them on `app.close()` through `@nestjs/bullmq`).

### @nestjs/bullmq

_Used by: `phase-03-videos/TD-01`, `TD-08`._

- **Module format (Revision 2026-11-22):** v12 (and its dependency `@nestjs/bull-shared@12`) is published as ESM-only (`"type": "module"`). Node 25 can `require()` it at runtime, but ts-jest (CommonJS) cannot; both Jest configs add a `transform` entry for `node_modules/@nestjs/(bullmq|bull-shared)/*.js` (ts-jest, `allowJs`, `isolatedModules`) plus a matching `transformIgnorePatterns` exception.

- **Root config (async, ConfigService/registerAs-friendly):**
  ```ts
  BullModule.forRootAsync({
    inject: [queueConfig.KEY],
    useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
      connection: { host: cfg.host, port: cfg.port },
    }),
  });
  ```
- **Queue registration:** `BullModule.registerQueue({ name: 'video-processing', defaultJobOptions: {...} })` — DI token `getQueueToken('video-processing')` = `'BullQueue_video-processing'`; inject with `@InjectQueue('video-processing') private readonly queue: Queue`.
- **Consumer:** class decorated `@Processor('video-processing', { concurrency })` extending `WorkerHost`, implementing `async process(job: Job): Promise<any>`; throwing fails the job and triggers retry per job options. Worker events via `@OnWorkerEvent('failed')` etc. (bound to the Worker; the `worker` getter is only available after `onModuleInit`).
- Processors are discovered only in the Nest context that registers them — registering the `@Processor` provider only in the worker's module keeps the API process from consuming jobs (TD-08).

### ioredis

_Used by: `phase-03-videos/TD-01` (Revision 2026-11-22)._

- `bullmq@6` declares `ioredis` (and `redis`) as **optional** peer dependencies; the default `RedisConnection` builds an `ioredis` client from `connection: { host, port }`, so `ioredis` must be installed explicitly — without it the connection is never created and `Queue.close()` fails on an undefined client. Alternatives (node-redis via `createNodeRedisClient`, `RedisConnection.clientFactory`) are not used.

### @aws-sdk/client-s3

_Used by: `phase-03-videos/TD-02`, `TD-04`, `TD-05`, `TD-06`, `TD-07`, `TD-09`._

- **S3-compatible endpoint:** `new S3Client({ region, endpoint: 'http://minio:9000', forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } })`. `forcePathStyle: true` puts the bucket in the path (required for MinIO).
- **Checksums:** recent v3 versions default `requestChecksumCalculation`/`responseChecksumValidation` to `WHEN_SUPPORTED`, which auto-adds CRC32 checksums (and aws-chunked encoding for streams). Set both to `'WHEN_REQUIRED'` on the client so presigned `UploadPart` URLs carry no checksum header the browser cannot produce, and S3-compatible servers are not sent trailers.
- **Multipart commands:** `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `UploadId`; `ListPartsCommand({ Bucket, Key, UploadId, PartNumberMarker })` (paginated, `IsTruncated`/`NextPartNumberMarker`, max 1000 per page) → `Parts[{ PartNumber, ETag, Size }]`; `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ ETag, PartNumber }] } })` — parts ascending by PartNumber (1..10,000); `AbortMultipartUploadCommand({ Bucket, Key, UploadId })`.
- **Objects:** `HeadObjectCommand` → `ContentLength`; `PutObjectCommand({ Bucket, Key, Body, ContentType })` (thumbnail upload; Buffer body); `GetObjectCommand`.
- **Browser uploads:** the `ETag` header of each `UploadPart` response must be readable by the client (CORS `ExposeHeaders: ETag`).

### @aws-sdk/s3-request-presigner

_Used by: `phase-03-videos/TD-05`, `TD-06`, `TD-09`, `TD-11`._

- `getSignedUrl(client, command, { expiresIn })` — `expiresIn` in seconds (default 900). Works for any command: `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })`, `GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="…"' })`.
- The presigner signs with `X-Amz-Content-Sha256: UNSIGNED-PAYLOAD` and treats `content-type` as unsignable — the part body is not hashed into the signature.
- **The signature covers the host:** URLs must be signed by a client configured with the endpoint the *caller* will use. A second `S3Client` configured with `S3_PUBLIC_ENDPOINT` (e.g. `http://localhost:9000` for the host browser) produces client-facing URLs, while the internal client (`http://minio:9000`) is used for server-side calls (TD-11).
