# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis (BullMQ queue):** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO (object storage):** `docker compose exec minio curl -fsS http://localhost:9000/minio/health/live` (self-probe inside its own container) — expect exit code 0; `docker compose ps -a storage-init` must show `Exited (0)` (bucket provisioned)
- **Video worker:** `docker compose logs video-worker` — expect `Video worker started — consuming the video-processing queue`

`docker compose up -d` also starts the `video-worker` service, which runs the queue consumer (`npm run start:worker:dev`). It has no HTTP server; the "never start the API server" rule above still applies to `nestjs-api`.

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP capture, ports `1025` (SMTP) / `8025` (UI)
- `redis` — Redis 7.4 for the BullMQ queue, port `6379`
- `minio` — S3-compatible object storage (`pgsty/minio`, pinned), S3 API port `9000`, console port `9001`
- `storage-init` — one-shot `pgsty/mc` job that creates the `S3_BUCKET` bucket (idempotent) and exits `0`
- `video-worker` — same image as `nestjs-api`, runs the video processing worker (`src/worker.ts`)

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run start:worker:dev                 # Video worker with hot-reload (what the video-worker service runs)
npm run start:worker:prod                # Run compiled worker (dist/worker)
npm run openapi:export                   # Regenerate openapi.json

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

The video e2e suites need the **whole** Compose stack up (`db`, `redis`, `minio`, `storage-init`, `video-worker`): uploads go to MinIO through presigned URLs and the `ready`/`failed` scenarios are processed by the running `video-worker` service.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

- **ESM-only `@nestjs/bullmq@12`:** both Jest configs carry a dedicated `transform` entry (ts-jest with `allowJs`) for `node_modules/@nestjs/(bullmq|bull-shared)/*.js` plus a matching `transformIgnorePatterns` exception. Without them any suite that imports `AppModule` fails with `SyntaxError: Unexpected token 'export'`.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.

## Videos

Phase 03 (upload and processing). Decisions in `../docs/decisions/technical-decisions-phase-03-videos.md`; plan, Technical Specifications and progress in `../docs/phases/phase-03-videos/`; e2e test plans in `specs/videos-*.plan.md`.

### Modules

| Path | Responsibility |
|------|----------------|
| `src/videos/` | `VideosModule` — `Video` entity, `VideosController`, `VideosService` (pre-registration, part signing/listing, upload completion + enqueue, owner view, stream/download URLs), DTOs, upload policy (`upload-policy.ts`), slug generation (`video-slug.util.ts`) |
| `src/storage/` | `StorageModule` / `StorageService` — the only access to the S3-compatible storage (AWS SDK v3): multipart, objects, presigned URLs; key layout in `storage-keys.ts` (`videos/{videoId}/original`, `videos/{videoId}/thumbnail.jpg`) |
| `src/media/` | `MediaModule` / `MediaService` — spawns `ffprobe`/`ffmpeg` (argument arrays, input read from a presigned URL); parser in `media-probe.parser.ts`; errors in `media.errors.ts` (presigned URLs are redacted from messages) |
| `src/queue/` | Queue contract (`video-processing.queue.ts`: queue `video-processing`, job `process-video`, payload `{ videoId }`, 3 attempts, exponential backoff) and the shared BullMQ root options |
| `src/video-processing/` | `WorkerModule` + `VideoProcessingProcessor` — the queue consumer; registered only in the worker context, so the API never consumes jobs |
| `src/worker.ts` | Worker entrypoint — `NestFactory.createApplicationContext(WorkerModule)`, no HTTP server |
| `src/database/typeorm-options.factory.ts` | TypeORM options shared by `AppModule` and `WorkerModule` |
| `src/database/migrations/1795355458036-CreateVideos.ts` | `videos` table, `videos_status_enum`, unique `slug`, FK `channel_id → channels.id` (cascade) |

### Endpoints (all authenticated, owner-scoped)

| Method & path | Result |
|---------------|--------|
| `POST /videos` | `201` — creates the video as `draft` and opens the multipart upload; returns `{ id, slug, title, status, upload: { partSize, partCount } }` |
| `POST /videos/{id}/upload/parts` | `200` — presigned `PUT` URLs (1 h) for the requested part numbers |
| `GET /videos/{id}/upload/parts` | `200` — parts already stored (resume an interrupted upload) |
| `POST /videos/{id}/upload/complete` | `202` — completes the multipart upload server-side, sets `processing`, enqueues `process-video` |
| `GET /videos/{id}` | `200` — status, duration, metadata, failure reason, presigned thumbnail URL |
| `GET /videos/{slug}/stream` | `302` — presigned URL of the original; the storage answers `Range` with `206` |
| `GET /videos/{slug}/download` | `302` — presigned URL served as `attachment; filename="<original name>"` |

Videos of other channels are reported as `404 VIDEO_NOT_FOUND`. Domain errors (`CHANNEL_NOT_FOUND`, `VIDEO_NOT_FOUND`, `VIDEO_NOT_DRAFT`, `INVALID_PART_NUMBER`, `UPLOAD_INCOMPLETE`, `UPLOAD_SIZE_MISMATCH`, `VIDEO_NOT_READY`) are in `src/common/exceptions/domain.exception.ts`.

### Rules that are easy to break

- **Video bytes never go through the API.** Upload limits are enforced by contract: declared size ≤ 10 GiB (`MAX_VIDEO_SIZE_BYTES`), MIME allow-list, fixed 64 MiB parts, and on completion the stored parts must cover `1..partCount` and sum to the declared size.
- **Status lifecycle:** `draft → processing → ready | failed` (`VideoStatus`). Transitions are conditional updates (`WHERE status = ...`); the worker ignores videos that are missing or not `processing`, so redelivered jobs are no-ops. `failed` is written only on the last attempt or for unreadable media (`UnrecoverableError`); storage connection errors are retried.
- **Two storage endpoints:** `S3_ENDPOINT` (`http://minio:9000`) for server-side calls; `S3_PUBLIC_ENDPOINT` only to sign URLs given to clients. SigV4 signs the Host, so the dev `.env` uses `http://localhost:9000` (browser on the host — the consumer is outside the Compose network) while tests running in the container set `S3_PUBLIC_ENDPOINT=http://minio:9000` before compiling the module (`test/utils/videos-e2e.ts` does it for e2e).
- **Env vars:** `REDIS_HOST`, `REDIS_PORT`, `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` (both required), `S3_BUCKET` — validated in `src/config/env.validation.ts`, read by `src/config/storage.config.ts` and `src/config/queue.config.ts`. `compose.yaml` interpolates the S3 credentials and bucket for `minio` and `storage-init`.
- **`ioredis` is a direct dependency:** `bullmq@6` declares the Redis client as an optional peer and builds an `ioredis` client by default.
- **Queue tests:** producer integration specs use `BullModule.forRoot({ ..., prefix: 'streamtube-test' })` so the Compose worker never consumes their jobs; the processor is integration-tested in-process by calling `process(job)` directly.
- **Fixtures:** `test/fixtures/sample.mp4` (2 s, 320x240, H.264 + AAC) and `test/fixtures/not-a-video.mp4`.

