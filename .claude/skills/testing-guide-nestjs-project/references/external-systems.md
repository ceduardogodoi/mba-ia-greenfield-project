> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External System Strategies

How each external system is handled in tests. These strategies were confirmed with the team.

---

## PostgreSQL — Real (Docker)

**Strategy:** Real database via the Docker `db` service (already in `compose.yaml`).

**Connection config for tests:**
```typescript
{
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'streamtube',
  password: process.env.DB_PASSWORD ?? 'streamtube',
  database: process.env.DB_DATABASE ?? 'streamtube',
  synchronize: true, // auto-create tables in test setup
}
```

**Test isolation:**
- Use `dataSource.query('DELETE FROM "table_name"')` to clean tables between tests
- Do NOT use `repository.delete({})` — throws `Empty criteria(s) are not allowed`
- Alternative: `repository.clear()` (truncates the table)
- For complex foreign key chains, delete in reverse dependency order or use `TRUNCATE ... CASCADE`
- Use `beforeEach` for cleanup to ensure each test starts with a clean state

**Entity setup:**
- Use `synchronize: true` in test DataSource to auto-create tables from entities
- For integration tests, import only the entities needed by the test — not all entities
- For E2E tests, import `AppModule` which includes all entities via their domain modules

---

## Object Storage — Real S3-compatible (MinIO in Docker)

**Strategy:** Real S3-compatible storage via the Compose `minio` service (bucket provisioned by the one-shot `storage-init` service). S3 in production. Decided in `phase-03-videos/TD-03` and `TD-14` (this replaced the earlier local-filesystem guidance — validation IC-1 of phase 03).

**Access:** always through `StorageService` (`src/storage/storage.service.ts`, AWS SDK v3). It keeps two clients: `S3_ENDPOINT` (`http://minio:9000`) for server-side calls and `S3_PUBLIC_ENDPOINT` only to sign URLs handed to clients.

**Presigned URLs in tests:** SigV4 signatures cover the Host header, and tests run inside the `nestjs-api` container, so set `S3_PUBLIC_ENDPOINT=http://minio:9000` **before** compiling the module (the dev `.env` value `http://localhost:9000` is for a browser on the host):

```typescript
beforeAll(async () => {
  process.env.S3_PUBLIC_ENDPOINT = 'http://minio:9000';
  module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      StorageModule,
    ],
  }).compile();
});
```

For e2e, `test/utils/videos-e2e.ts → createVideosE2eApp()` already does this.

**What to assert:** upload bytes straight to presigned part URLs with `fetch(url, { method: 'PUT', body })`, then assert through the storage (`listParts`, `headObject`) or by fetching presigned GET URLs (`Range` → `206`, `Content-Disposition`).

**Test data:** use unique keys (`test/<uuid>/...` for storage-only specs, real `videos/<uuid>/...` keys for module specs). There is no delete operation in the phase 03 storage contract, so test objects are not removed.

---

## Message Queue — Real Redis + BullMQ (Docker)

**Strategy:** Real Redis (Compose `redis` service) with BullMQ (`phase-03-videos/TD-01`). Queue `video-processing`, job `process-video` (`src/queue/video-processing.queue.ts`).

**Producer tests (integration):** register `BullModule.forRoot` with an **isolated key prefix** so the Compose `video-worker` (default prefix) never consumes test jobs, then read the job back by its deterministic id:

```typescript
BullModule.forRoot({
  connection: { host: process.env.REDIS_HOST ?? 'redis', port: Number(process.env.REDIS_PORT ?? 6379) },
  prefix: 'streamtube-test',
}),
// ...
const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
const job = await queue.getJob(videoId); // jobId = videoId
await job?.remove();
```

**Consumer tests:** unit-test `VideoProcessingProcessor` with mocked repository/storage/media; integration-test it **in-process** by calling `process(job)` directly with real DB + MinIO + FFmpeg (no queue involved). Fake jobs only need `{ id, data, attemptsMade, opts: { attempts } }`.

**Black-box e2e:** e2e specs that complete an upload rely on the running Compose `video-worker` service to move the video to `ready`/`failed` and poll `GET /videos/{id}` (`waitForStatus` in `test/utils/videos-e2e.ts`). Keep `docker compose up -d` running (all services) before `npm run test:e2e`.

**Jest + `@nestjs/bullmq@12`:** the package (and `@nestjs/bull-shared`) is ESM-only; both Jest configs transpile it via a dedicated ts-jest `transform` entry plus a `transformIgnorePatterns` exception. Keep those entries when touching Jest config.

---

## Email — Mailpit (Real SMTP Capture)

**Strategy:** Mailpit — a local SMTP server that captures all emails for inspection via its API. No emails are actually delivered.

**Setup:**
- Add Mailpit to `compose.yaml`:
```yaml
mailpit:
  image: axllent/mailpit
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI / API
```

**NestJS configuration:**
```typescript
// In mail module or config
{
  transport: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
  },
}
```

**Integration test:**
```typescript
describe('MailService (integration)', () => {
  beforeEach(async () => {
    // Clear all captured emails via Mailpit API
    await fetch('http://localhost:8025/api/v1/messages', { method: 'DELETE' });
  });

  it('should send confirmation email', async () => {
    await mailService.sendConfirmation('user@test.com', 'token-123');

    // Query Mailpit API for captured emails
    const response = await fetch('http://localhost:8025/api/v1/messages');
    const data = await response.json();

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].To[0].Address).toBe('user@test.com');
    expect(data.messages[0].Subject).toContain('confirm');
  });
});
```

**Key points:**
- Mailpit captures ALL emails — no mocking, no side effects
- Use Mailpit's REST API (`http://localhost:8025/api/v1/messages`) to inspect sent emails
- Clear captured emails in `beforeEach` to ensure test isolation
- Web UI at `http://localhost:8025` for manual debugging
- Tests the full SMTP transport path — if the SMTP config is wrong, the test fails
