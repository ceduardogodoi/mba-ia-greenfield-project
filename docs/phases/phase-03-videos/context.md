---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-21T12:12:22Z"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-22T14:09:22Z"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-21T12:12:22Z"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-21T12:12:22Z"
  docs/phases/phase-02-auth/context.md: "2026-11-21T12:12:22Z"
  docs/phases/phase-02-auth-frontend/context.md: "2026-11-21T12:12:22Z"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-21T12:12:22Z"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._
**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.
**Affected subprojects:** _The phase does not name any subproject paths. Do not infer them from this source._
**Deferred subprojects:** _None._
**Sequencing notes:** "> Depende de: Fase 01, Fase 02"

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta — "Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha."
- **Phase 04:** Gerenciamento de Vídeos e Canal (Depende de: Fase 02, Fase 03) — "Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública."

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Message Queue Technology | decided | A (BullMQ + Redis) | bullmq, @nestjs/bullmq, ioredis |
| └─ Last revision: 2026-11-22 — `ioredis` explicit; `@nestjs/bullmq@12` ESM transpiled in Jest | | | | | | |
| phase-03-videos/TD-02 | phase | Backend | S3 Client Library | decided | A (AWS SDK v3) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-03 | phase | Repo-wide | Local S3-Compatible Storage Image and Provisioning | decided | A (pinned `pgsty/minio` + one-shot `storage-init` with `pgsty/mc`) | — |
| phase-03-videos/TD-04 | phase | Backend | Bucket and Object Key Layout | decided | A (single bucket, `videos/{videoId}/original` + `videos/{videoId}/thumbnail.jpg`) | — |
| phase-03-videos/TD-05 | phase | Backend | Upload Strategy for Files up to 10GB | decided | A (direct-to-storage S3 multipart, presigned part URLs) | — |
| phase-03-videos/TD-06 | phase | Backend | Upload Limits and Part Policy | decided | A (10 GiB max, MIME allow-list, 64 MiB parts, 1h part URLs, size verified on complete) | — |
| phase-03-videos/TD-07 | phase | Backend | Upload Completion and Processing Trigger | decided | A (`POST /videos/{id}/upload/complete` → ListParts + CompleteMultipartUpload → enqueue `jobId = videoId`) | — |
| phase-03-videos/TD-08 | phase | Repo-wide | Video Worker Runtime | decided | A (same codebase, standalone Nest app context, `video-worker` Compose service) | — |
| phase-03-videos/TD-09 | phase | Backend | Media Processing — FFmpeg Invocation, Input Access and Thu… | decided | A (spawn ffprobe/ffmpeg with arg arrays, presigned GET input, JPEG thumbnail at 10%) | — |
| phase-03-videos/TD-10 | phase | Backend | Unique Video URL Identifier | decided | A (11-char base64url slug from `randomBytes(8)` + UNIQUE index + bounded retry) | — |
| phase-03-videos/TD-11 | phase | Backend | Streaming and Download Delivery | decided | A (302 to short-lived presigned GET, `attachment` for download, `S3_PUBLIC_ENDPOINT`) | — |
| └─ Last revision: 2026-11-22 — `S3_PUBLIC_ENDPOINT` environment-specific (e2e uses `http://minio:9000`) | | | | | | |
| phase-03-videos/TD-12 | phase | Backend | Access Policy for Stream and Download in Phase 03 | decided | A (owner-only until Fases 04/05) | — |
| phase-03-videos/TD-13 | phase | Backend | Video Status Lifecycle and Failure Handling | decided | A (`draft → processing → ready \| failed`, 3 attempts exp. backoff, `failure_reason` on final failure) | — |
| phase-03-videos/TD-14 | phase | Backend | Testing Strategy for the Async Pipeline (storage + queue +… | decided | C (hybrid: in-process processor integration specs + black-box e2e via `video-worker`) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02, phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-14 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-08, phase-03-videos/TD-14 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-05, phase-03-videos/TD-06 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-13 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-07, phase-03-videos/TD-08, phase-03-videos/TD-09, phase-03-videos/TD-13, phase-03-videos/TD-14 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-08, phase-03-videos/TD-09, phase-03-videos/TD-13, phase-03-videos/TD-14 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-10 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-11, phase-03-videos/TD-12 |
| Download do vídeo pelo usuário | phase-03-videos/TD-11, phase-03-videos/TD-12 |

## Decisions Detail

_(current-phase TDs only — from decisions-detail-reader)_

### phase-03-videos/TD-01

**Recommendation:** it is the only option whose built-in semantics (attempts + exponential backoff, deterministic `jobId`, final-failure hook) map one-to-one to the status lifecycle in TD-13 without hand-built retry infrastructure, and `@nestjs/bullmq` gives the same DI/module ergonomics the codebase already uses. Redis runs as `redis:7.4-alpine` in Compose (service name `redis`), configured via `REDIS_HOST`/`REDIS_PORT`.
**Libraries:** bullmq, @nestjs/bullmq, ioredis
**Revisions:**
- 2026-11-22 — `ioredis@^5.11.1` added (optional peer of `bullmq@6`, used by its default connection); `@nestjs/bullmq@12` is ESM-only and is transpiled by the Jest configs. Rationale: found in SI-03.7; option A unchanged.

### phase-03-videos/TD-02

**Recommendation:** it is the only option that exposes presigned per-part multipart URLs, and it is the production SDK for the S3 target, so local and prod share one code path.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-03

**Recommendation:** it preserves the project's MinIO choice with identical S3 semantics at no build cost; pinning an exact release tag mitigates provenance drift, and production uses AWS S3 anyway. Provisioning is done by a one-shot Compose service (`storage-init`, `pgsty/mc`) that idempotently creates the bucket after `minio` is healthy — the application never creates buckets (in production the bucket is provisioned by infrastructure, not app code). Service names: `minio` (S3 API `:9000`, console `:9001`), `storage-init`.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** no requirement in this phase needs per-type bucket policies, and a stable UUID-based prefix keeps API, worker and DB in sync with the least provisioning; Option B can be adopted later without data migration of originals.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** it is the only option that both keeps the API out of the data path ("sem impacto na performance") and gives resumability natively, with no extra service; the cost (client-side chunking) lands in a frontend phase that is out of scope here.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** short-lived, on-demand URLs plus server-side size verification are what make "até 10GB" an enforced limit rather than a client promise, while keeping resume possible after URL expiry.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** it keeps the trigger inside the API's authorization and transaction boundary and is identical on MinIO and S3; abandoned drafts are a known limitation to be handled by cleanup in a later phase.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** process isolation as required by the architecture, with zero code duplication; adding `ffmpeg` to the shared dev image is a one-line Dockerfile change.
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** streaming input via presigned URL avoids scratch disk proportional to file size, and direct spawning avoids a deprecated dependency; persisted metadata = `durationSeconds` + a JSON `metadata` (container format, bitrate, size, video codec/width/height/fps, audio codec).
**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** shortest dependency-free path that is non-enumerable, with the DB UNIQUE constraint as the conflict guarantee.
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** progressive streaming via presigned Range-capable URLs satisfies both capabilities with no bandwidth through the API, consistent with the architecture; HLS can be added in a later phase without changing the endpoints' contract.
**Libraries:** —
**Revisions:**
- 2026-11-22 — `S3_PUBLIC_ENDPOINT` is environment-specific: dev `.env` uses `http://localhost:9000` (browser on the host), the e2e suite (inside `nestjs-api`) sets `S3_PUBLIC_ENDPOINT=http://minio:9000` before booting the app. Rationale: SigV4 presigned URLs cover the Host header; resolves validation IC-2.

### phase-03-videos/TD-12

**Recommendation:** it avoids publishing content before the publication/visibility rules of Fases 04/05 exist and keeps the later change additive.
**Libraries:** —

### phase-03-videos/TD-13

**Recommendation:** it is the minimal lifecycle that satisfies the phase, gives deterministic retry/failure semantics on top of BullMQ (TD-01), and leaves publication modeling to Fase 04.
**Libraries:** —

### phase-03-videos/TD-14

**Recommendation:** it satisfies "não mocke o que dá para testar de verdade" at every layer and proves the Compose worker, while keeping failure-path tests deterministic.
**Libraries:** —

## Inherited Decisions Detail

_(inherited TDs from prior phases — from phases-reader — plus the correlator-confirmed doc `openapi-docs-nestjs`; dedupe applied)_

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.
**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.
**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Custom BFF cookie-based session (`next/headers` + small helper) — the strict-BFF model nominates the Route Handler as the only NestJS caller; the backend is the auth authority. _(frontend-only; summarized — full prose in `docs/phases/phase-02-auth-frontend/context.md`)_
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** `iron-session` encrypted single cookie carrying access + refresh + minimal user fingerprint. _(frontend-only; summarized)_
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** Transparent BFF refresh on upstream 401 with per-request single-flight. _(frontend-only; summarized)_
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** `react-hook-form` + `@hookform/resolvers/zod`. _(frontend-only; summarized)_
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Route Handler POST + client `fetch` as the single mutation surface. _(frontend-only; summarized)_
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Server-rendered session + React Context Provider in RSC layout. _(frontend-only; summarized)_
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** RSC processes email-link tokens server-side; Client form for reset's input step. _(frontend-only; summarized)_
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** `@nestjs/swagger` — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** Ambos (Runtime UI + `openapi.json` exportado) — o custo marginal é um npm script e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Swagger UI apenas em dev/staging via env flag — o `openapi.json` commitado cumpre o papel de spec consultável fora da UI.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, ... })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function. _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options. _(from phase 01)_

## Inherited Deferred Capabilities

_(from phases-reader — informational-only; plan-validate does NOT fire issues based on unaddressed entries)_

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped; FE confirmation flow picked up by a future phase. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — reset-password destination screen absent from Figma. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | umbrella bullet deferred until the confirmation and reset-password screens land. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

_(from `testing-guide-nestjs-project` § 3 Feature Implementation Checklist and `references/external-systems.md`)_

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit (mock repo) + Integration (DB contract) |
| Service with DB only (no branching) | Integration (DB contract) |
| Service with configured lib | Unit with real lib + test config |
| Service with side-effect dep (email, storage) | Integration with real capture service or local adapter |
| Module with configured imports (incl. `BullModule.registerQueue()`) | Unit: compilation test |
| Controller | E2E only — no unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard | E2E (+ Unit if complex internal logic) |
| Exception Filter | Unit + E2E |
| Queue consumer / processor (`artifacts/future-types.md`) | Unit (business logic, mocked deps) + Integration (real DB/storage) |

**External systems (from `references/external-systems.md`):** PostgreSQL — real (Docker `db`). Message Queue — real broker in Docker; dedicated test queues or clean queues between tests; publisher tests assert the enqueued job, consumer tests submit a job and assert the outcome. **Object Storage — Local Filesystem adapter in development and tests, S3 in production** (`StorageService` abstraction with a local driver). Email — Mailpit.
