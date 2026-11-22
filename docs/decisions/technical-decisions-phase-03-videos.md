---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-21
scope_description: "Backend + infra for video upload and processing: message queue, object storage usage (client, local image, key layout), direct-to-storage 10GB upload, upload limits, processing trigger, video worker runtime, FFmpeg metadata/thumbnail extraction, unique public identifier, streaming/download delivery and access, status lifecycle with failure handling, and testing of the async pipeline."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — receives the new `videos` module (upload orchestration, stream/download endpoints), the `videos` table/migration, the S3 storage integration, the queue producer, the video worker entrypoint, and the new Compose services (object storage, queue broker, worker).
- `next-frontend/` — no open decision in this document: the phase's capabilities are API/infra capabilities and the video UI (upload screen, player, download button) is explicitly out of scope for this phase (Fase 05 owns the player page and download button). The upload protocol (TD-05/TD-06/TD-07) and the delivery contract (TD-11) are written as HTTP contracts so a future frontend phase can consume them without reopening them.

**Inherited constraints (not reopened):** NestJS 11 + TypeORM 0.3 + PostgreSQL 17 (Fase 01); `@nestjs/config` namespaced `registerAs` + Joi env validation (phase-01/TD-01..TD-04); custom JWT guard, global and opt-out via `@Public()` (phase-02-auth/TD-02); `DomainException` + global filter error envelope (phase-02-auth/TD-07); class-validator DTOs (phase-02-auth/TD-06); `@nestjs/throttler` (phase-02-auth/TD-08); `@nestjs/swagger` + CLI plugin with exported `openapi.json` (openapi-docs-nestjs/TD-01..TD-03). Object storage is **S3-compatible** by project definition (architecture diagram: "Object Storage — S3 or MinIO") — only *how* to use it is decided here.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves the queue as "TBD". The API must publish a processing job when an upload completes, and a separate Video Worker must consume it with retries. The queue must run as a real Compose service and be exercised by tests.

**Options:**

### Option A: BullMQ on Redis (`bullmq` + `@nestjs/bullmq`)
- Redis-backed job queue with first-class NestJS integration (`BullModule.forRootAsync`, `registerQueue`, `@InjectQueue`, `@Processor` + `WorkerHost`). Jobs carry attempts/backoff, deterministic `jobId` dedup, concurrency and stalled-job recovery.
- **Pros:** Official Nest package (`@nestjs/bullmq@12` peer-supports Nest 11 and `bullmq@6`). Retries with exponential backoff, `UnrecoverableError`, final-failure detection and idempotent `jobId` are built in — exactly the failure semantics TD-13 needs. Redis is a single small container.
- **Cons:** Adds Redis as a new stateful dependency. Job semantics are BullMQ-specific (not a portable protocol like AMQP). Redis must be configured with persistence if jobs must survive a broker restart.

### Option B: RabbitMQ (AMQP) via `@nestjs/microservices` / `amqplib`
- Standard message broker; the API publishes a message to an exchange/queue, the worker consumes with manual acks. Retries via dead-letter exchanges + TTL queues.
- **Pros:** Protocol-level standard (AMQP 0-9-1), language-agnostic consumers, rich routing, management UI.
- **Cons:** Retry with backoff must be hand-built (DLX + TTL queues). Nest's microservices transport is request/event oriented, not a job queue (no attempts/progress/job state). Heavier container and more moving parts for one job type.

### Option C: pg-boss (PostgreSQL-backed queue)
- Job queue stored in PostgreSQL tables using `SKIP LOCKED`. No new infrastructure.
- **Pros:** Zero new containers; transactional enqueue with the same DB (outbox-like guarantees).
- **Cons:** No official Nest integration. Puts polling load on the primary DB that already serves the app. Does not add a distinct "Message Queue" container, which the architecture diagram and the phase deliverables expect.

### Option D: AWS SQS emulated locally (ElasticMQ / LocalStack)
- Use SQS API in production, an emulator in Compose.
- **Pros:** Mirrors a managed AWS production setup, symmetric with S3.
- **Cons:** Emulator fidelity gaps; retries are visibility-timeout based (coarse); LocalStack community edition now requires an account/token; no Nest integration.

**Recommendation:** **Option A (BullMQ + Redis)** — it is the only option whose built-in semantics (attempts + exponential backoff, deterministic `jobId`, final-failure hook) map one-to-one to the status lifecycle in TD-13 without hand-built retry infrastructure, and `@nestjs/bullmq` gives the same DI/module ergonomics the codebase already uses. Redis runs as `redis:7.4-alpine` in Compose (service name `redis`), configured via `REDIS_HOST`/`REDIS_PORT`.

**Decision:** A (BullMQ + Redis)
**Libraries:** bullmq, @nestjs/bullmq, ioredis
**Revisions:**
- 2026-11-22 — `ioredis@^5.11.1` added explicitly: `bullmq@6` turned the Redis client into an optional peer dependency (`ioredis`/`redis`), and its default connection factory uses `ioredis`. `@nestjs/bullmq@12` (and `@nestjs/bull-shared@12`) ship ESM-only; the CommonJS project keeps v12 and the Jest configs (`package.json` jest + `test/jest-e2e.json`) transpile those two packages with ts-jest (`allowJs`). Rationale: found during SI-03.7 implementation; option A unchanged, user chose to keep v12 over downgrading to the CommonJS v11.

---

## TD-02: S3 Client Library

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Both the API (multipart orchestration, presigned URLs) and the worker (read the original, write the thumbnail) talk to S3-compatible storage. The client must work against the local S3-compatible server in dev/test and unchanged against AWS S3 in production.

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- Modular official SDK; `S3Client` with custom `endpoint` + `forcePathStyle: true` for local S3-compatible servers; `getSignedUrl()` presigns any command (`UploadPartCommand`, `GetObjectCommand`).
- **Pros:** The production target is S3, so the same code runs there. Typed commands for every multipart operation (`CreateMultipartUpload`, `UploadPart`, `ListParts`, `CompleteMultipartUpload`, `AbortMultipartUpload`, `HeadObject`). Presigning is first-class.
- **Cons:** Verbose command style. Recent versions add default request checksums that some S3-compatible servers/presigned flows need disabled (`requestChecksumCalculation: 'WHEN_REQUIRED'`).

### Option B: MinIO JavaScript SDK (`minio`)
- MinIO's own S3 client (`presignedPutObject`, `presignedGetObject`, `putObject`).
- **Pros:** Simpler API surface for basic object operations.
- **Cons:** No public API to presign individual multipart parts (multipart is handled internally), which blocks TD-05's direct multipart upload. Ties the codebase to the vendor whose distribution model just changed (see TD-03).

**Recommendation:** **Option A (AWS SDK v3)** — it is the only option that exposes presigned per-part multipart URLs, and it is the production SDK for the S3 target, so local and prod share one code path.

**Decision:** A (AWS SDK v3 — `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-03: Local S3-Compatible Storage Image and Provisioning

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The project points to MinIO locally. In October 2025 MinIO stopped publishing community container images: `minio/minio` no longer exists on Docker Hub and `quay.io/minio/minio` requires auth (verified on 2026-11-21 — `docker pull minio/minio` → "repository does not exist"). The Compose stack still needs a real S3-compatible service, plus a bucket created before the API/worker use it.

**Options:**

### Option A: Community-maintained MinIO fork image (`pgsty/minio`, pinned release tag)
- Community rebuild of the MinIO server from source (AGPLv3, multi-arch), actively released (e.g., `RELEASE.2026-08-04T00-00-00Z`), with a matching `pgsty/mc` client image. Same binary/API/console as MinIO.
- **Pros:** Keeps "MinIO locally" as the project defines; same S3 API surface and admin client; pinned tag for reproducibility.
- **Cons:** Not an official MinIO Inc. distribution — provenance must be trusted/pinned; future maintenance depends on the community.

### Option B: Frozen legacy image (`bitnamilegacy/minio`)
- Last Bitnami-packaged MinIO images, no longer updated.
- **Pros:** Known packager, works today.
- **Cons:** Unmaintained (no security fixes), Bitnami-specific env conventions.

### Option C: Build MinIO from source in the repo (Dockerfile with `go build`)
- Own Dockerfile compiling a pinned MinIO commit.
- **Pros:** Full provenance control.
- **Cons:** Slow first build, Go toolchain in the dev loop, maintenance burden for a dev-only dependency.

### Option D: Another S3-compatible server (RustFS / SeaweedFS)
- Drop-in S3 API servers with official images.
- **Pros:** Officially maintained images.
- **Cons:** Deviates from the project's stated MinIO choice; multipart/presign compatibility must be re-verified.

**Recommendation:** **Option A (`pgsty/minio` pinned)** — it preserves the project's MinIO choice with identical S3 semantics at no build cost; pinning an exact release tag mitigates provenance drift, and production uses AWS S3 anyway. Provisioning is done by a one-shot Compose service (`storage-init`, `pgsty/mc`) that idempotently creates the bucket after `minio` is healthy — the application never creates buckets (in production the bucket is provisioned by infrastructure, not app code). Service names: `minio` (S3 API `:9000`, console `:9001`), `storage-init`.

**Decision:** A (`pgsty/minio` pinned release tag + one-shot `storage-init` service with `pgsty/mc`)

---

## TD-04: Bucket and Object Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The API writes the original (via presigned multipart), the worker reads it and writes the thumbnail, and delivery endpoints presign reads. Key layout is a contract shared by API, worker and DB columns (`storage_key`, `thumbnail_key`). Depends on TD-03.

**Options:**

### Option A: Single bucket, per-video prefix keyed by internal UUID
- One bucket (`S3_BUCKET`, default `streamtube-videos`); keys `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg`.
- **Pros:** One bucket to provision/configure; all artifacts of a video share a prefix (easy cleanup/deletion later); internal UUID keys never change even if the public slug or title changes; no user input in keys (no path-injection).
- **Cons:** Cannot apply different bucket-level policies to thumbnails vs originals (prefix-level lifecycle rules still possible).

### Option B: Separate buckets for originals and thumbnails
- `videos` and `thumbnails` buckets with `{videoId}` keys.
- **Pros:** Different bucket policies (e.g., public-read thumbnails) and lifecycle per artifact type.
- **Cons:** Two buckets to provision in every environment; public-read policy is not needed in this phase (TD-11 uses presigned reads).

### Option C: Staging + processed buckets
- Uploads land in a staging bucket; the worker copies to a final bucket.
- **Pros:** Clear separation of unverified uploads.
- **Cons:** Server-side copy of up to 10GB per video doubles I/O and storage transiently, for no requirement in this phase.

**Recommendation:** **Option A** — no requirement in this phase needs per-type bucket policies, and a stable UUID-based prefix keeps API, worker and DB in sync with the least provisioning; Option B can be adopted later without data migration of originals.

**Decision:** A (Single bucket, `videos/{videoId}/original` + `videos/{videoId}/thumbnail.jpg`)

---

## TD-05: Upload Strategy for Files up to 10GB

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Passing 10GB through the API process would tie up API workers, memory and bandwidth for the duration of the upload. The project plan's "Pontos de Atenção" also require that the upload "permita retomar em caso de falha de conexão". The protocol is an HTTP contract a future frontend will implement. Depends on TD-02.

**Options:**

### Option A: Direct-to-storage S3 multipart upload with presigned part URLs
- API creates the video row + `CreateMultipartUpload`, then hands out presigned `UploadPart` URLs; the client `PUT`s each part directly to storage; API lists the stored parts and completes the upload.
- **Pros:** Zero video bytes through the API (only small JSON calls). Resumable: parts already stored are discoverable via `ListParts`, so the client re-sends only missing parts. Parallel parts speed up large uploads. Native to S3 (works unchanged in production).
- **Cons:** Client must implement chunking and retry. Storage must be reachable from the client (public endpoint) and expose `ETag` via CORS for browsers.

### Option B: tus resumable upload protocol (`@tus/server` / `tusd`)
- Dedicated tus server receives chunks (PATCH with offsets) and writes to S3 via its S3 store.
- **Pros:** Standard resumable protocol with mature client libs (`tus-js-client`).
- **Cons:** Bytes still flow through a server we run (either the API — defeats the purpose — or an extra `tusd` service with its own auth hooks). Adds another service and a second auth integration.

### Option C: Streaming multipart/form-data through the API to S3
- API pipes the request stream (busboy) into an S3 multipart `Upload` without buffering to disk.
- **Pros:** Simplest client (single form POST).
- **Cons:** API holds a connection and bandwidth for the full 10GB transfer; not resumable (a dropped connection restarts from zero); request timeouts/proxies limit very long uploads.

**Recommendation:** **Option A (presigned S3 multipart)** — it is the only option that both keeps the API out of the data path ("sem impacto na performance") and gives resumability natively, with no extra service; the cost (client-side chunking) lands in a frontend phase that is out of scope here.

**Decision:** A (Direct-to-storage S3 multipart upload with presigned part URLs)

---

## TD-06: Upload Limits and Part Policy

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** With TD-05/A the API never sees the bytes, so limits must be enforced by contract: declared size at initiation, part sizing, URL lifetime, and verification of the actual stored size. S3 constraints: parts 5 MiB–5 GiB (except the last), at most 10,000 parts. Depends on TD-05.

**Options:**

### Option A: Server-defined fixed part size + on-demand part URL signing + size verification on complete
- Client declares `fileName`, `sizeBytes` (≤ 10 GiB = 10,737,418,240 bytes) and `contentType` (allow-list: `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`). API fixes `partSize` = 64 MiB and returns `partCount = ceil(sizeBytes/partSize)` (≤ 160). Part URLs are signed on demand for requested part numbers with a 1-hour TTL. On complete, API checks the stored object size equals the declared size (and ≤ 10 GiB); otherwise aborts.
- **Pros:** Client cannot pick abusive part sizes; expired URLs are simply re-requested (long/slow uploads and resumes work); real size is enforced server-side even though the API never sees the bytes.
- **Cons:** One extra endpoint (sign parts) vs returning all URLs at once.

### Option B: All part URLs returned at initiation with a long TTL
- Init response contains every presigned part URL (≤ 160) valid for e.g. 24h.
- **Pros:** One fewer endpoint.
- **Cons:** Long-lived bearer URLs; uploads/resumes that exceed the TTL cannot continue without restarting.

### Option C: Client-chosen part size
- Client sends its part size; API validates S3 bounds.
- **Pros:** Client can tune for its network.
- **Cons:** Larger validation surface; no benefit for this phase.

**Recommendation:** **Option A** — short-lived, on-demand URLs plus server-side size verification are what make "até 10GB" an enforced limit rather than a client promise, while keeping resume possible after URL expiry.

**Decision:** A (10 GiB max declared size, MIME allow-list, fixed 64 MiB parts, on-demand 1h part URLs, size verified on complete)

---

## TD-07: Upload Completion and Processing Trigger

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Processing must start automatically once the upload finishes. With direct-to-storage uploads (TD-05/A), something must tell the system the upload is done. Depends on TD-01, TD-05.

**Options:**

### Option A: Explicit "complete upload" API call → API completes multipart and enqueues the job
- Client calls `POST /videos/{id}/upload/complete`; API runs `ListParts` server-side (does not trust client ETags), `CompleteMultipartUpload`, verifies size (TD-06), sets status `processing` and enqueues the job with `jobId = videoId`.
- **Pros:** Portable (same on S3 and MinIO); status change and enqueue happen in one place with ownership checks; deterministic `jobId` makes double-submits idempotent.
- **Cons:** If the client never calls complete, the video stays `draft` (incomplete multipart parts linger until aborted/cleaned).

### Option B: Storage event notifications (bucket notification → queue/webhook)
- Storage emits `ObjectCreated:CompleteMultipartUpload` to Redis/webhook; a consumer enqueues processing.
- **Pros:** No client step after the last part.
- **Cons:** The client still must call `CompleteMultipartUpload` (needs credentials or another presigned URL). Notification configuration differs between MinIO and S3 (SNS/SQS/EventBridge), breaking local/prod parity; harder to test.

**Recommendation:** **Option A** — it keeps the trigger inside the API's authorization and transaction boundary and is identical on MinIO and S3; abandoned drafts are a known limitation to be handled by cleanup in a later phase.

**Decision:** A (Explicit `POST /videos/{id}/upload/complete` → server-side ListParts + CompleteMultipartUpload → enqueue with `jobId = videoId`)

---

## TD-08: Video Worker Runtime

**Scope:** Repo-wide

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The architecture defines a separate "Video Worker (FFmpeg)" container. It needs DB access (TypeORM entity), storage access (TD-02) and the queue (TD-01). Where its code lives and how it is started affects Compose, the Docker image (FFmpeg) and test setup. Depends on TD-01.

**Options:**

### Option A: Same codebase, separate Nest standalone entrypoint, separate Compose service
- `nestjs-project/src/worker.ts` boots `NestFactory.createApplicationContext(WorkerModule)` (no HTTP server) registering the BullMQ processor; Compose adds `video-worker` using the same dev image (with `ffmpeg` installed) and a dedicated start script.
- **Pros:** Reuses entity, config, storage and repository code with no duplication; process isolation (FFmpeg CPU load never hits the API event loop); scales independently; matches the diagram.
- **Cons:** The image is shared, so the API container also carries FFmpeg (also useful for tests, see TD-14).

### Option B: Processor inside the API process
- Register the `@Processor` in the API's `AppModule`.
- **Pros:** No extra service.
- **Cons:** FFmpeg-heavy work competes with request handling — contradicts "sem impacto na performance" and the architecture diagram.

### Option C: Separate subproject (`video-worker/`)
- Independent Node project with its own `package.json`.
- **Pros:** Strong isolation, independent dependencies.
- **Cons:** Duplicates entity/config/storage code or requires a shared package (monorepo tooling not in place); a new subproject for one job type.

**Recommendation:** **Option A** — process isolation as required by the architecture, with zero code duplication; adding `ffmpeg` to the shared dev image is a one-line Dockerfile change.

**Decision:** A (Same codebase, standalone Nest application context entrypoint, dedicated `video-worker` Compose service)

---

## TD-09: Media Processing — FFmpeg Invocation, Input Access and Thumbnail Policy

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must extract duration/metadata and produce a thumbnail from a frame of a file up to 10GB. How FFmpeg is called and how it reads the input decide disk usage and robustness. Depends on TD-08.

**Options:**

### Option A: Spawn `ffprobe`/`ffmpeg` binaries directly, reading the original through a presigned GET URL
- `child_process.spawn` with argument arrays (no shell): `ffprobe -v error -print_format json -show_format -show_streams <url>` for metadata; `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale=1280:-2 -f image2 -c:v mjpeg pipe:1` for the thumbnail at `t = 10% of duration` (capped to a valid position), uploaded as JPEG. FFmpeg's HTTP input uses range requests, so only needed bytes are read.
- **Pros:** No 10GB local download/temp disk; no wrapper dependency; JSON output parsed into a typed metadata object; argument arrays avoid shell injection.
- **Cons:** Thin typed wrapper to maintain; must handle process exit codes/stderr and timeouts.

### Option B: `fluent-ffmpeg` wrapper
- Popular fluent API over the binaries.
- **Pros:** Convenient API, many examples.
- **Cons:** Package is deprecated on npm and its repository archived — adopting it now is new tech debt.

### Option C: Download the original to local temp storage, then process
- Worker streams the object to disk, runs FFmpeg on the local file.
- **Pros:** Fast random access for FFmpeg.
- **Cons:** Requires up to 10GB scratch disk per concurrent job and full transfer before any work starts.

**Recommendation:** **Option A** — streaming input via presigned URL avoids scratch disk proportional to file size, and direct spawning avoids a deprecated dependency; persisted metadata = `durationSeconds` + a JSON `metadata` (container format, bitrate, size, video codec/width/height/fps, audio codec).

**Decision:** A (Spawn `ffprobe`/`ffmpeg` with argument arrays, input via presigned GET URL, JPEG thumbnail at 10% of duration)

---

## TD-10: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique identifier for its URL that never collides ("Pontos de Atenção: URL curta e única"). It must be generated at pre-registration (TD-07 flow) and is independent of the internal UUID primary key.

**Options:**

### Option A: Random 11-char base64url slug from `crypto.randomBytes` + UNIQUE constraint + retry
- 8 random bytes → 11 base64url chars (64 bits of entropy). Column has a UNIQUE index; on unique violation, regenerate and retry (bounded).
- **Pros:** No dependency; short, YouTube-like; non-enumerable (does not leak volume/order); DB constraint is the ultimate guarantee of "sem conflito".
- **Cons:** Needs retry logic for the (astronomically rare) collision.

### Option B: `nanoid`
- Library generating URL-safe random ids of configurable length.
- **Pros:** Well-known API.
- **Cons:** Extra dependency for a few lines of `crypto`; latest versions are ESM-only (project is CommonJS).

### Option C: Expose the UUID
- Use the primary key in URLs.
- **Pros:** Zero extra column/logic.
- **Cons:** 36 chars — not "curta"; couples public URLs to the internal key.

### Option D: Sqids/Hashids over a sequential integer
- Encode an auto-increment id into a short string.
- **Pros:** Very short, collision-free by construction.
- **Cons:** Reversible/enumerable (leaks ordering/volume), requires an extra sequence column, extra dependency.

**Recommendation:** **Option A** — shortest dependency-free path that is non-enumerable, with the DB UNIQUE constraint as the conflict guarantee.

**Decision:** A (11-char base64url slug from `crypto.randomBytes(8)` + UNIQUE index + bounded retry)

---

## TD-11: Streaming and Download Delivery

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file (HTTP Range / `206 Partial Content`), and the user must be able to download the file. The architecture diagram already states "Frontend → Object Storage: Streams". Depends on TD-02, TD-04.

**Options:**

### Option A: API authorizes and redirects (`302`) to a short-lived presigned GET URL
- `GET /videos/{slug}/stream` → `302 Location: <presigned GetObject, inline>`; `GET /videos/{slug}/download` → `302` to a presigned URL with `ResponseContentDisposition: attachment; filename="..."`. Storage serves `Range` → `206` natively. URLs are signed against a client-reachable endpoint (`S3_PUBLIC_ENDPOINT`), separate from the internal endpoint (`S3_ENDPOINT=http://minio:9000`).
- **Pros:** Video bytes never pass through the API; Range/206, seeking and resumable downloads come from the storage for free; matches the architecture diagram; works with `<video src>` and download links.
- **Cons:** Presigned URLs are bearer tokens until expiry (short TTL mitigates); requires a second, public-facing endpoint configuration.

### Option B: API proxies the bytes, honoring `Range` → `206`
- API reads `Range`, calls `GetObject` with that range and pipes the body with `Content-Range`.
- **Pros:** Storage never exposed to clients; full control of headers.
- **Cons:** All playback/download bandwidth flows through the API — the performance problem TD-05 avoided for uploads reappears for reads.

### Option C: HLS/DASH adaptive streaming (transcode to segments)
- Worker transcodes to HLS renditions; clients stream playlists.
- **Pros:** Adaptive bitrate, best playback UX.
- **Cons:** Transcoding cost/time and storage multiplication; not required by the phase (Range-based progressive streaming satisfies "sem necessidade de download completo").

**Recommendation:** **Option A** — progressive streaming via presigned Range-capable URLs satisfies both capabilities with no bandwidth through the API, consistent with the architecture; HLS can be added in a later phase without changing the endpoints' contract.

**Decision:** A (`302` redirect to short-lived presigned GET; download with `attachment` disposition; `S3_PUBLIC_ENDPOINT` for client-facing URLs)
**Libraries:** —
**Revisions:**
- 2026-11-22 — `S3_PUBLIC_ENDPOINT` is environment-specific: dev `.env` uses `http://localhost:9000` (consumer is a browser on the host, outside the Compose network), while the e2e suite (running inside the `nestjs-api` container) sets `S3_PUBLIC_ENDPOINT=http://minio:9000` before booting the app so presigned URLs are signed for the in-network host. Rationale: SigV4 presigned URLs cover the Host header; resolves `phase-03-videos` validation IC-2 (conflict with TD-14's in-container e2e).

---

## TD-12: Access Policy for Stream and Download in Phase 03

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Publication (rascunho → publicação), visibility (público/unlisted) and anonymous viewing belong to Fases 04 and 05. Phase 03 must decide who may stream/download a `ready` video before those rules exist. Depends on TD-11, TD-13.

**Options:**

### Option A: Owner-only until publication/visibility exist
- Stream/download require JWT and that the video belongs to the caller's channel; status must be `ready`. Fases 04/05 widen access when publication/visibility rules exist.
- **Pros:** No unpublished content is exposed before a publication concept exists; the guard default (JWT global) already enforces it; widening later is additive.
- **Cons:** Anonymous playback is not demonstrable in this phase.

### Option B: Public for any `ready` video
- `@Public()` endpoints; anyone with the slug can stream/download.
- **Pros:** Demonstrates anonymous playback early.
- **Cons:** Exposes videos that are still drafts in the publication sense, which Fase 04 would then have to retract (breaking change).

**Recommendation:** **Option A** — it avoids publishing content before the publication/visibility rules of Fases 04/05 exist and keeps the later change additive.

**Decision:** A (Owner-only until Fases 04/05 introduce publication/visibility/anonymous access)

---

## TD-13: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The video row is created as a draft when the upload starts and must reflect processing progress and failures in the DB. Retries and terminal failure must be well defined. Depends on TD-01, TD-07.

**Options:**

### Option A: Single `status` enum `draft → processing → ready | failed`, retries with backoff, terminal failure recorded
- `draft` at initiation; `processing` when the upload is completed and the job enqueued; worker sets `ready` with duration/metadata/thumbnail key; jobs run with `attempts: 3`, exponential backoff; only when retries are exhausted (or on an `UnrecoverableError`, e.g. ffprobe finds no video stream) the worker sets `failed` + `failure_reason`. Transitions are guarded (e.g., complete only from `draft`; worker updates only from `processing`), making redelivery idempotent.
- **Pros:** Matches the expected cycle "rascunho → processando → pronto/erro"; transient errors (storage hiccup) self-heal; terminal failures are visible in the DB with a reason.
- **Cons:** `draft` here means "not yet uploaded/processed"; Fase 04's publication flow will need its own field/states rather than reusing this enum.

### Option B: Finer-grained states (`uploading`, `uploaded`, `processing`, `ready`, `failed`)
- Separate states for upload in progress vs upload done/queued.
- **Pros:** More precise observability.
- **Cons:** More transitions to guard with no consumer needing the distinction in this phase; diverges from the expected cycle.

### Option C: Two axes now (processing status + publication status)
- Add both `processing_status` and `publication_status` in this phase.
- **Pros:** Anticipates Fase 04.
- **Cons:** Decides Fase 04's model prematurely (scope creep).

**Recommendation:** **Option A** — it is the minimal lifecycle that satisfies the phase, gives deterministic retry/failure semantics on top of BullMQ (TD-01), and leaves publication modeling to Fase 04.

**Decision:** A (`draft → processing → ready | failed`, 3 attempts with exponential backoff, `failed` + `failure_reason` only on final failure)

---

## TD-14: Testing Strategy for the Async Pipeline (storage + queue + worker)

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The project's testing policy requires real dependencies for integration/e2e (no mocking what Compose can run). The pipeline spans API → MinIO → Redis → worker → DB. The integration/e2e suites share the dev database (`streamtube`) with the Compose services, so the Compose `video-worker` would also see jobs enqueued by tests. Depends on TD-01, TD-08.

**Options:**

### Option A: In-process worker in tests, isolated queue prefix
- Integration and e2e suites boot the processor in the Jest process against real Redis/MinIO/FFmpeg, using a test-only BullMQ prefix so the Compose worker never consumes test jobs.
- **Pros:** Deterministic; no dependency on a running worker container; covers processor logic with real dependencies.
- **Cons:** The Compose `video-worker` service itself is never exercised by automated tests.

### Option B: Black-box e2e through the Compose worker
- e2e uploads a real fixture via presigned URLs, completes, and polls the DB until the Compose `video-worker` marks it `ready`.
- **Pros:** Exercises the real deployed topology end to end.
- **Cons:** Requires the worker container running current code; processor edge cases (failure paths) are hard to trigger black-box.

### Option C: Hybrid — processor integration-specs in-process + one black-box e2e through the Compose worker
- `*.integration-spec.ts` cover the processor/FFmpeg/storage adapters in-process with real deps (including failure → `failed`); the e2e suite drives the full HTTP flow (init → presigned part PUT → complete → Compose worker → `ready` → stream `302` → storage `206`) against the running Compose stack, using a small committed video fixture.
- **Pros:** Real infra everywhere; failure paths tested deterministically; the Compose worker is proven by the e2e.
- **Cons:** e2e requires the full stack up (`docker compose up -d`), like it already requires `db`/`mailpit`; e2e uses polling with a bounded timeout.

**Recommendation:** **Option C (hybrid)** — it satisfies "não mocke o que dá para testar de verdade" at every layer and proves the Compose worker, while keeping failure-path tests deterministic.

**Decision:** C (Hybrid — in-process processor integration-specs with real deps + black-box e2e through the Compose `video-worker`)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | BullMQ + Redis | A (BullMQ + Redis) |
| TD-02 | Backend | S3 Client Library | AWS SDK v3 (client-s3 + presigner) | A (AWS SDK v3) |
| TD-03 | Repo-wide | Local S3-Compatible Storage Image and Provisioning | `pgsty/minio` pinned + `storage-init` (mc) | A (`pgsty/minio` + `storage-init`) |
| TD-04 | Backend | Bucket and Object Key Layout | Single bucket, `videos/{videoId}/…` | A (Single bucket) |
| TD-05 | Backend | Upload Strategy for Files up to 10GB | Presigned S3 multipart, direct to storage | A (Presigned S3 multipart) |
| TD-06 | Backend | Upload Limits and Part Policy | 10 GiB max, 64 MiB parts, on-demand 1h URLs, size check | A (64 MiB parts, on-demand URLs) |
| TD-07 | Backend | Upload Completion and Processing Trigger | Explicit complete endpoint → enqueue | A (Complete endpoint → enqueue) |
| TD-08 | Repo-wide | Video Worker Runtime | Same codebase, standalone entrypoint, own service | A (Standalone entrypoint + service) |
| TD-09 | Backend | Media Processing (FFmpeg) | Spawn ffprobe/ffmpeg over presigned URL | A (Spawn ffprobe/ffmpeg over URL) |
| TD-10 | Backend | Unique Video URL Identifier | 11-char base64url random + UNIQUE + retry | A (11-char base64url) |
| TD-11 | Backend | Streaming and Download Delivery | 302 → presigned GET (Range/206 by storage) | A (302 → presigned GET) |
| TD-12 | Backend | Access Policy for Stream/Download | Owner-only until Fases 04/05 | A (Owner-only) |
| TD-13 | Backend | Video Status Lifecycle and Failure Handling | draft → processing → ready/failed, 3 attempts | A (draft → processing → ready/failed) |
| TD-14 | Backend | Testing Strategy for the Async Pipeline | Hybrid (in-process integration + Compose e2e) | C (Hybrid) |
