---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-22T12:19:31Z"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-22T12:19:31Z"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-22T12:19:20Z"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o armazenamento de vídeos e thumbnails em object storage S3-compatível, a fila de processamento em segundo plano com um worker de vídeo, o upload de arquivos de até 10GB direto ao storage sem impacto na API, o pré-cadastro do vídeo como rascunho ao iniciar o upload, o processamento automático (duração, metadados e thumbnail), a URL única por vídeo e a entrega por streaming e download — tudo subindo via Docker Compose.

---

## Step Implementations

### SI-03.1 — Infra: dependências, configuração e serviços de storage/fila no Compose

**Description:** Instala as libs decididas, adiciona FFmpeg à imagem de desenvolvimento, cria os namespaces de configuração `storage` e `queue` e sobe Redis, MinIO e o provisionamento do bucket no Compose — a fundação de infraestrutura de todos os SIs seguintes.

**Technical actions:**

1. Instalar em `nestjs-project` (dentro do container): `bullmq@^6.7.8`, `@nestjs/bullmq@^12.0.2`, `@aws-sdk/client-s3@^3.1175.0`, `@aws-sdk/s3-request-presigner@^3.1175.0` (per `phase-03-videos/TD-01`, `TD-02`; versões em `library-refs.md`)
2. Estender `nestjs-project/Dockerfile.dev` com `ffmpeg` no `apt install` (fornece `ffmpeg` e `ffprobe` para API, worker e testes) e reconstruir a imagem (validation DG-1; per `phase-03-videos/TD-08`, `TD-09`)
3. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` lendo `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`; e `src/config/queue.config.ts` — `registerAs('queue', ...)` lendo `REDIS_HOST`, `REDIS_PORT`; registrar ambos no `load` do `ConfigModule.forRoot` em `AppModule` (per `phase-01-configuracao-base/TD-03`)
4. Estender `src/config/env.validation.ts` (Joi) com as variáveis da tabela "Environment variables introduced" de `### API Contracts` (`S3_ACCESS_KEY`, `S3_SECRET_KEY` obrigatórias; demais com default) e atualizar `.env.example` e `.env` com os valores de dev (`S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT=http://localhost:9000`, `REDIS_HOST=redis`) (per `phase-01-configuracao-base/TD-02`, `phase-03-videos/TD-11` Revision 2026-11-22)
5. Adicionar a `nestjs-project/compose.yaml`: `redis` (`redis:7.4-alpine`, healthcheck `redis-cli ping`), `minio` (`pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, `server /data --console-address ":9001"`, portas `9000`/`9001`, credenciais de `S3_ACCESS_KEY`/`S3_SECRET_KEY`, volume nomeado, healthcheck), `storage-init` (`pgsty/mc` pinado — `mc alias set` + `mc mb --ignore-existing` do `S3_BUCKET`, one-shot); `nestjs-api` passa a depender de `redis` (healthy), `minio` (healthy) e `storage-init` (`service_completed_successfully`) (per `phase-03-videos/TD-01`, `TD-03`, `TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` (novas chaves) | Integration: chaves obrigatórias rejeitadas quando ausentes, defaults aplicados | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` em `nestjs-project/` deixa `redis` e `minio` com status `healthy` e `storage-init` finalizado com código 0
- Após o `storage-init`, o bucket `streamtube-videos` existe no MinIO (`mc ls` / `HeadBucket` retorna sucesso) e uma segunda execução do `storage-init` também termina com código 0
- `docker compose exec nestjs-api ffprobe -version` e `ffmpeg -version` executam com sucesso
- A aplicação não inicia quando `S3_ACCESS_KEY` ou `S3_SECRET_KEY` estão ausentes (erro de validação Joi no bootstrap)
- A suíte existente (unit + integration + e2e) continua verde com a nova infraestrutura

---

### SI-03.2 — Busca do canal do usuário em `ChannelsService`

**Description:** Expõe, no módulo dono da entidade `Channel`, a busca do canal pelo usuário autenticado, pré-requisito para vincular vídeos ao canal (validation DG-2).

**Technical actions:**

1. Adicionar `ChannelsService.findByUserId(userId: string): Promise<Channel | null>` em `src/channels/channels.service.ts` — consulta por `user_id` via `Repository<Channel>` (o `ChannelsModule` passa a registrar `TypeOrmModule.forFeature([Channel])` se ainda não registra)
2. Garantir que `ChannelsModule` exporta `ChannelsService` para consumo pelo `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário; `null` para usuário sem canal | `src/channels/channels.service.integration-spec.ts` |
| `ChannelsModule` | Unit: compilação do módulo com o novo provider/export | `src/channels/channels.module.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Para um usuário cadastrado, `findByUserId` retorna exatamente o canal criado no cadastro (mesmo `id` e `nickname`)
- Para um `userId` sem canal, `findByUserId` retorna `null` sem lançar erro

---

### SI-03.3 — Entidade `Video` e migration `CreateVideos`

**Description:** Cria a tabela `videos` ligada ao canal, com o ciclo de status, chaves de storage, duração, metadados e o identificador da URL única, conforme `### Data Model`.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com os campos, tipos e constraints de `### Data Model → Video` (enum `VideoStatus` `draft|processing|ready|failed` com default `draft`, `slug` unique varchar(11), `size_bytes` bigint com transformer para `number`, `metadata` jsonb, `@ManyToOne(() => Channel)` + `@JoinColumn({ name: 'channel_id' })` com `onDelete: 'CASCADE'` e `@Index` em `channel_id`) (per `phase-03-videos/TD-04`, `TD-10`, `TD-13`)
2. Adicionar o lado inverso `@OneToMany(() => Video, (video) => video.channel) videos` em `src/channels/entities/channel.entity.ts`
3. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e registrá-lo em `AppModule`
4. Gerar `src/database/migrations/<timestamp>-CreateVideos.ts` via `npm run migration:generate` (enum `videos_status_enum`, tabela, índice único em `slug`, índice em `channel_id`, FK com `ON DELETE CASCADE`; `down()` reverte incluindo o tipo enum) e executá-la
5. Estender `src/database/migrations.integration-spec.ts` (nova migration, `videos` em `MANAGED_TABLES`, `videos_status_enum` em `MANAGED_ENUM_TYPES`) e `cleanAllTables` em `src/test/create-test-data-source.ts` (apagar `videos` antes de `channels`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: default `status = draft`, unique em `slug`, FK para canal, cascade ao remover canal, `size_bytes` lido como `number` | `src/videos/entities/video.entity.integration-spec.ts` |
| Migrations | Integration: aplica todas (inclui `videos`) e reverte a última removendo tabela e enum | `src/database/migrations.integration-spec.ts` |
| `VideosModule` | Unit: compilação do módulo | `src/videos/videos.module.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com a FK `channel_id → channels.id` e o tipo `videos_status_enum`
- Inserir um vídeo sem `status` explícito persiste `status = 'draft'`
- Inserir dois vídeos com o mesmo `slug` falha com violação de unicidade
- Remover um canal remove em cascata os vídeos dele
- `npm run migration:revert` da última migration remove a tabela `videos` e o tipo `videos_status_enum`, e reaplicar volta ao estado anterior

---

### SI-03.4 — Serviço de object storage S3 (`StorageModule`)

**Description:** Encapsula todo o acesso ao object storage S3-compatível (multipart, objetos e URLs pré-assinadas) num módulo próprio, reutilizado pela API e pelo worker.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` e `src/storage/storage.service.ts` — dois `S3Client` a partir de `storageConfig`: interno (`S3_ENDPOINT`) para chamadas server-side e público (`S3_PUBLIC_ENDPOINT`) só para assinar URLs entregues a clientes; ambos com `forcePathStyle: true`, `requestChecksumCalculation`/`responseChecksumValidation` = `'WHEN_REQUIRED'` (per `phase-03-videos/TD-02`, `TD-11` Revision 2026-11-22; `library-refs.md → @aws-sdk/client-s3`)
2. Implementar a superfície multipart: `createMultipartUpload(key, contentType)` → `uploadId`; `presignUploadPart(key, uploadId, partNumber, expiresInSeconds)` (cliente público); `listParts(key, uploadId)` paginando `PartNumberMarker` → `{ partNumber, sizeBytes, etag }[]`; `completeMultipartUpload(key, uploadId, parts)` com partes em ordem crescente (per `phase-03-videos/TD-05`, `TD-06`)
3. Implementar a superfície de objetos: `putObject(key, body: Buffer, contentType)`, `headObject(key)` → `{ contentLength }`, `presignGet(key, { audience: 'internal' | 'public', expiresInSeconds, contentDisposition?, contentType? })` (per `phase-03-videos/TD-09`, `TD-11`)
4. Criar `src/storage/storage-keys.ts` — `originalKey(videoId) = videos/{videoId}/original`, `thumbnailKey(videoId) = videos/{videoId}/thumbnail.jpg` (per `phase-03-videos/TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real, `S3_PUBLIC_ENDPOINT=http://minio:9000`): multipart completo via `PUT` nas URLs pré-assinadas, `listParts`, `complete`, `headObject`, `putObject`, `presignGet` com `Range` → `206`, `contentDisposition` → `Content-Disposition: attachment` | `src/storage/storage.service.integration-spec.ts` |
| `storage-keys` | Unit: formato das chaves | `src/storage/storage-keys.spec.ts` |
| `StorageModule` | Unit: compilação do módulo | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — config `storage`, SDK instalado e MinIO/bucket no Compose

**Acceptance criteria:**

- Um arquivo enviado em 2 partes por `PUT` direto nas URLs de `presignUploadPart` (sem passar pela aplicação) fica disponível após `completeMultipartUpload`, com `ContentLength` igual à soma das partes
- `listParts` de um upload em andamento retorna exatamente as partes já enviadas, com número, tamanho e ETag
- `GET` numa URL de `presignGet` com `Range: bytes=0-99` retorna `206` e 100 bytes
- `presignGet` com `contentDisposition` produz resposta com `Content-Disposition: attachment; filename="..."`
- URLs de audiência `public` têm o host de `S3_PUBLIC_ENDPOINT`; as de audiência `internal`, o host de `S3_ENDPOINT`

---

### SI-03.5 — Endpoint POST /videos (pré-cadastro como rascunho + início do upload)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-create.plan.md`
**Authorization:** Authenticated (cria no canal do próprio usuário)

**Description:** Ao iniciar o upload, pré-cadastra o vídeo como `draft` com URL única e abre o multipart upload no storage, devolvendo a política de partes — sem nenhum byte de vídeo passando pela API.

**Technical actions:**

1. Adicionar a `src/common/exceptions/domain.exception.ts` as exceções do `### Error Catalog` desta fase: `ChannelNotFoundException` (`CHANNEL_NOT_FOUND`, 404), `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `VideoNotDraftException` (`VIDEO_NOT_DRAFT`, 409), `InvalidPartNumberException` (`INVALID_PART_NUMBER`, 400), `UploadIncompleteException` (`UPLOAD_INCOMPLETE`, 400), `UploadSizeMismatchException` (`UPLOAD_SIZE_MISMATCH`, 400), `VideoNotReadyException` (`VIDEO_NOT_READY`, 409) (per `phase-02-auth/TD-07`)
2. Criar `src/videos/video-slug.util.ts` — `generateVideoSlug()` = `crypto.randomBytes(8).toString('base64url')` (11 chars), e `src/videos/upload-policy.ts` — `PART_SIZE_BYTES = 67108864`, `MAX_VIDEO_SIZE_BYTES = 10737418240`, `ALLOWED_VIDEO_CONTENT_TYPES`, `partCount(sizeBytes)`, `defaultTitle(fileName)` (nome sem extensão) (per `phase-03-videos/TD-06`, `TD-10`; validation AMB-2)
3. Criar `src/videos/dto/initiate-upload.dto.ts` (`fileName`, `sizeBytes`, `contentType`, `title?` conforme `#### Validation Rules — videos`) e `VideosService.initiateUpload(userId, dto)` em `src/videos/videos.service.ts`: resolve o canal via `ChannelsService.findByUserId` (`CHANNEL_NOT_FOUND`), gera `id` (`crypto.randomUUID()`), chama `StorageService.createMultipartUpload(originalKey(id), contentType)` e salva a linha `draft` com `storage_key`/`upload_id`, regenerando o `slug` em violação de unicidade (até 5 tentativas) (per `phase-03-videos/TD-05`, `TD-10`, `TD-13`)
4. Criar `src/videos/videos.controller.ts` — `@ApiTags('videos') @Controller('videos')`, `@Post()` `@HttpCode(201)` retornando `{ id, slug, title, status, upload: { partSize, partCount } }` conforme `### API Contracts → POST /videos`, com `@ApiBearerAuth('access-token')`, `@ApiOperation` e `@ApiResponse` (201/400/401/404 via `ApiErrorEnvelope`)
5. Registrar no `VideosModule`: imports `ChannelsModule`, `StorageModule`; controller `VideosController`; provider `VideosService`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generateVideoSlug` / `upload-policy` | Unit: 11 chars base64url; `partCount` (1 byte, exato múltiplo, 10 GiB → 160); `defaultTitle` | `src/videos/upload-policy.spec.ts` |
| `VideosService.initiateUpload` | Unit (repo/storage/channels mockados): `CHANNEL_NOT_FOUND`, título default, retry de slug em violação de unicidade e erro após 5 tentativas | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration (DB + MinIO reais): linha `draft` persistida no canal com `upload_id`; multipart aberto no bucket | `src/videos/videos.service.integration-spec.ts` |
| `VideosModule` | Unit: compilação com `ChannelsModule` e `StorageModule` | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.2 — `findByUserId`; SI-03.3 — entidade/tabela; SI-03.4 — `StorageService`

**Acceptance criteria:**

- `POST /videos` com `{ fileName: "aula.mp4", sizeBytes: 150000000, contentType: "video/mp4" }` retorna `201` com `status: "draft"`, `title: "aula"`, `slug` de 11 caracteres `[A-Za-z0-9_-]` e `upload: { partSize: 67108864, partCount: 3 }`
- Após o `201`, existe uma linha em `videos` com `status = 'draft'`, `channel_id` do canal do usuário, `storage_key = videos/{id}/original` e `upload_id` não nulo
- `POST /videos` com `title` informado persiste esse título em vez do derivado do arquivo
- `POST /videos` com `sizeBytes: 10737418241` ou `contentType: "application/pdf"` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem `Authorization` retorna `401`
- Dois pré-cadastros consecutivos geram `slug`s distintos

---

### SI-03.6 — Endpoints de partes do upload (assinatura sob demanda e listagem para retomada)

**Route:** POST /videos/{id}/upload/parts, GET /videos/{id}/upload/parts
**Test Specs:** see `nestjs-project/specs/videos-upload-parts.plan.md`
**Authorization:** Owner

**Description:** Permite ao dono obter URLs pré-assinadas de curta duração para enviar cada parte direto ao storage e listar as partes já armazenadas, viabilizando uploads paralelos e a retomada após falha de conexão.

**Technical actions:**

1. Adicionar a `VideosService` o helper `findOwnedDraft(userId, id)` — carrega o vídeo do canal do usuário (`VIDEO_NOT_FOUND` se inexistente ou de outro canal) e exige `status = draft` (`VIDEO_NOT_DRAFT`) (per `phase-03-videos/TD-12`, `TD-13`)
2. Implementar `VideosService.signUploadParts(userId, id, partNumbers)` — rejeita número > `partCount(size_bytes)` com `INVALID_PART_NUMBER`; retorna `{ parts: [{ partNumber, url }], expiresAt }` com `StorageService.presignUploadPart(..., 3600)` (per `phase-03-videos/TD-06`)
3. Implementar `VideosService.listUploadedParts(userId, id)` — `{ partSize, partCount, uploadedParts }` a partir de `StorageService.listParts` (per `phase-03-videos/TD-05`)
4. Criar `src/videos/dto/sign-upload-parts.dto.ts` (`partNumbers`: 1..100 inteiros únicos ≥ 1) e os handlers `@Post(':id/upload/parts')` (`@HttpCode(200)`) e `@Get(':id/upload/parts')` com `ParseUUIDPipe` e decorators OpenAPI (200/400/401/404/409)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.signUploadParts` / `listUploadedParts` | Unit: `VIDEO_NOT_FOUND` para vídeo de outro canal, `VIDEO_NOT_DRAFT`, `INVALID_PART_NUMBER`, `expiresAt` = agora + 3600 s | `src/videos/videos.service.spec.ts` |
| `VideosService.signUploadParts` / `listUploadedParts` | Integration (DB + MinIO reais): `PUT` numa URL assinada armazena a parte e `listUploadedParts` a reporta | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 — vídeo `draft` com multipart aberto e `VideosController`

**Acceptance criteria:**

- `POST /videos/{id}/upload/parts` com `{ partNumbers: [1, 2] }` retorna `200` com duas URLs e `expiresAt` cerca de 1 hora à frente
- Um `PUT` do conteúdo da parte direto numa URL retornada responde `200` com header `ETag`, sem tráfego pela API
- `GET /videos/{id}/upload/parts` após enviar a parte 1 retorna `uploadedParts` contendo apenas `{ partNumber: 1, sizeBytes, etag }`
- `POST /videos/{id}/upload/parts` com número de parte maior que `partCount` retorna `400` com `INVALID_PART_NUMBER`
- As duas rotas, chamadas por outro usuário autenticado, retornam `404` com `VIDEO_NOT_FOUND`
- As duas rotas, para um vídeo cujo upload já foi concluído, retornam `409` com `VIDEO_NOT_DRAFT`

---

### SI-03.7 — Endpoint POST /videos/{id}/upload/complete (conclusão do upload e enfileiramento)

**Route:** POST /videos/{id}/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner

**Description:** Conclui o multipart upload no servidor, valida que o arquivo armazenado bate com o declarado, move o vídeo para `processing` e publica o job de processamento na fila — o gatilho do processamento automático.

**Technical actions:**

1. Criar `src/queue/video-processing.queue.ts` — constantes `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'`, tipo `ProcessVideoJobData = { videoId: string }` e `PROCESS_VIDEO_JOB_OPTIONS` (`attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: true`, `removeOnFail: false`) conforme `### Events/Messages` (per `phase-03-videos/TD-01`, `TD-13`)
2. Registrar `BullModule.forRootAsync` (conexão de `queueConfig`) em `AppModule` e `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })` no `VideosModule` (per `phase-03-videos/TD-01`; `library-refs.md → @nestjs/bullmq`)
3. Implementar `VideosService.completeUpload(userId, id)`: `findOwnedDraft`; `StorageService.listParts`; exige partes `1..partCount` (`UPLOAD_INCOMPLETE`) e soma de tamanhos = `size_bytes` (`UPLOAD_SIZE_MISMATCH`); `completeMultipartUpload`; persiste `status = processing` e `upload_id = null`; enfileira `queue.add(PROCESS_VIDEO_JOB, { videoId }, { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: videoId })`; se o enfileiramento falhar, persiste `status = failed` com `failure_reason` e relança (per `phase-03-videos/TD-07`, `TD-13`)
4. Adicionar o handler `@Post(':id/upload/complete')` `@HttpCode(202)` retornando `{ id, status: 'processing' }` com decorators OpenAPI (202/400/401/404/409)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit (storage/queue mockados): `UPLOAD_INCOMPLETE`, `UPLOAD_SIZE_MISMATCH`, `VIDEO_NOT_DRAFT`, job com `jobId = videoId` e payload `{ videoId }`, falha no enqueue → `failed` + rethrow | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration (DB + MinIO + Redis reais, `BullModule.forRoot` com `prefix` exclusivo de teste para o worker do Compose não consumir): objeto final existe com o tamanho declarado, linha `processing` com `upload_id` nulo, job presente na fila com `jobId = videoId`; segunda conclusão → `VIDEO_NOT_DRAFT` | `src/videos/videos.service.integration-spec.ts` |
| `VideosModule` | Unit: compilação com `BullModule.registerQueue` | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.6 — partes enviadas via URLs assinadas

**Acceptance criteria:**

- `POST /videos/{id}/upload/complete` com todas as partes enviadas retorna `202` com `{ id, status: "processing" }`
- Após o `202`, a linha do vídeo tem `status = 'processing'` e `upload_id` nulo, o objeto `videos/{id}/original` existe com tamanho igual a `sizeBytes`, e há um job `process-video` com `jobId` igual ao `id` do vídeo e payload `{ videoId }`
- `POST /videos/{id}/upload/complete` com alguma parte faltando retorna `400` com `UPLOAD_INCOMPLETE` e o vídeo permanece `draft`
- `POST /videos/{id}/upload/complete` quando as partes somam tamanho diferente do declarado retorna `400` com `UPLOAD_SIZE_MISMATCH` e o vídeo permanece `draft`
- Repetir `POST /videos/{id}/upload/complete` após o sucesso retorna `409` com `VIDEO_NOT_DRAFT` e não enfileira um segundo job
- Outro usuário autenticado recebe `404` com `VIDEO_NOT_FOUND`

---

### SI-03.8 — Serviço de mídia com FFmpeg (metadados e thumbnail)

**Description:** Isola a invocação de `ffprobe`/`ffmpeg` num serviço tipado que lê o vídeo por URL (sem baixar o arquivo inteiro), extrai duração/metadados e gera o JPEG do thumbnail.

**Technical actions:**

1. Criar `src/media/media.service.ts` — `probe(url): Promise<MediaProbeResult>` executa `ffprobe -v error -print_format json -show_format -show_streams <url>` via `child_process.spawn` com array de argumentos (sem shell) e timeout; `extractThumbnail(url, atSeconds): Promise<Buffer>` executa `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale=1280:-2 -f image2 -c:v mjpeg pipe:1` coletando o stdout (per `phase-03-videos/TD-09`)
2. Criar `src/media/media-probe.parser.ts` — converte o JSON do ffprobe em `{ durationSeconds, metadata: { formatName, bitRate, sizeBytes, video: { codec, width, height, fps } | null, audio: { codec } | null } }` (formato de `### Data Model → metadata`); sem stream de vídeo → `NoVideoStreamError` (per `phase-03-videos/TD-09`)
3. Criar `src/media/media.errors.ts` (`MediaProcessError` com exit code + final do stderr, `NoVideoStreamError`) e `src/media/media.module.ts` exportando `MediaService`
4. Gerar e versionar `test/fixtures/sample.mp4` (≈2 s, 320x240, H.264 + AAC, via `ffmpeg -f lavfi testsrc`/`sine`) e `test/fixtures/not-a-video.mp4` (bytes arbitrários) para os testes de processamento

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `media-probe.parser` | Unit: JSON com vídeo+áudio, só vídeo, sem stream de vídeo (`NoVideoStreamError`), `r_frame_rate` fracionário → fps | `src/media/media-probe.parser.spec.ts` |
| `MediaService` | Integration (FFmpeg real sobre `test/fixtures/sample.mp4`): duração ≈ 2 s, codec `h264`, 320x240; thumbnail é JPEG válido (assinatura `FF D8`); `not-a-video.mp4` → `MediaProcessError` | `src/media/media.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — FFmpeg na imagem

**Acceptance criteria:**

- `probe` sobre o fixture de 2 s retorna `durationSeconds` entre 1.9 e 2.1, `metadata.video` com `codec: "h264"`, `width: 320`, `height: 240` e `metadata.audio.codec: "aac"`
- `extractThumbnail` sobre o fixture retorna um buffer JPEG não vazio com largura ≤ 1280
- `probe` sobre um arquivo que não é mídia falha com `MediaProcessError` contendo o código de saída do ffprobe
- `probe` sobre mídia sem stream de vídeo falha com `NoVideoStreamError`

---

### SI-03.9 — Worker de vídeo: processor, entrypoint standalone e serviço `video-worker`

**Description:** Entrega o consumidor da fila num processo separado da API que processa automaticamente cada vídeo enviado (duração, metadados, thumbnail) e registra o resultado — `ready` ou `failed` — no banco, subindo como serviço próprio no Compose.

**Technical actions:**

1. Criar `src/video-processing/video-processing.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` estendendo `WorkerHost`; `process(job)` segue os passos 1–5 de `### Events/Messages` (guard `status = processing`, `presignGet` interno, `MediaService.probe`, thumbnail em `duration × 0.1`, `putObject(thumbnailKey(id), jpeg, 'image/jpeg')`, update para `ready` com `duration_seconds`, `metadata`, `thumbnail_key`); `NoVideoStreamError`/`MediaProcessError` de mídia ilegível viram `UnrecoverableError` (per `phase-03-videos/TD-09`, `TD-13`; `library-refs.md → bullmq`)
2. No mesmo processor, tratar falha terminal: quando `job.attemptsMade + 1 >= job.opts.attempts` ou o erro é `UnrecoverableError`, persistir `status = failed` e `failure_reason` antes de relançar; nas tentativas intermediárias apenas relançar (per `phase-03-videos/TD-13`)
3. Criar `src/video-processing/worker.module.ts` (`ConfigModule` global, `TypeOrmModule.forRootAsync` igual ao da API, `TypeOrmModule.forFeature([Video])`, `BullModule.forRootAsync` + `registerQueue`, `StorageModule`, `MediaModule`, provider do processor) e `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()` (sem servidor HTTP) (per `phase-03-videos/TD-08`)
4. Adicionar scripts `start:worker` (`nest start --entryFile worker`), `start:worker:dev` (`nest start --watch --entryFile worker`) e `start:worker:prod` (`node dist/worker`) ao `package.json`
5. Adicionar o serviço `video-worker` ao `compose.yaml` — mesmo `build`/volume do `nestjs-api`, `command: npm run start:worker:dev`, `depends_on` `db` (healthy), `redis` (healthy), `minio` (healthy), `storage-init` (completed) (per `phase-03-videos/TD-08`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProcessor` | Unit (repo/storage/media mockados): vídeo fora de `processing` → no-op; tentativa intermediária → relança sem alterar status; última tentativa → `failed` + `failure_reason`; `NoVideoStreamError` → `failed` na 1ª tentativa | `src/video-processing/video-processing.processor.spec.ts` |
| `VideoProcessingProcessor` | Integration in-process (DB + MinIO + FFmpeg reais, `process(job)` chamado direto): fixture válido → `ready` com duração, metadados e thumbnail no bucket; fixture inválido → `failed` com `failure_reason` | `src/video-processing/video-processing.processor.integration-spec.ts` |
| `WorkerModule` | Unit: compilação do módulo do worker | `src/video-processing/worker.module.spec.ts` |

**Dependencies:** SI-03.7 — fila e contrato do job; SI-03.8 — `MediaService`

**Acceptance criteria:**

- `docker compose up -d` sobe o serviço `video-worker`, que permanece em execução e registra no log a conexão à fila `video-processing`
- Um vídeo `processing` cujo original é um MP4 válido termina com `status = 'ready'`, `duration_seconds` preenchido, `metadata` com codec/resolução e `thumbnail_key = videos/{id}/thumbnail.jpg`, e o objeto do thumbnail existe no bucket com `Content-Type: image/jpeg`
- Um vídeo `processing` cujo original não é mídia termina com `status = 'failed'` e `failure_reason` não vazio, sem novas tentativas
- Uma falha transitória (ex.: storage indisponível) na 1ª tentativa mantém o vídeo em `processing` e o job é reexecutado; apenas após a 3ª tentativa o vídeo vai para `failed`
- Reentregar o job de um vídeo já `ready` não altera a linha nem regrava o thumbnail
- A API (`nestjs-api`) não consome jobs da fila — o processor só existe no contexto do `WorkerModule`

---

### SI-03.10 — Endpoint GET /videos/{id} (status, metadados e thumbnail para o dono)

**Route:** GET /videos/{id}
**Test Specs:** see `nestjs-project/specs/videos-get.plan.md`
**Authorization:** Owner

**Description:** Expõe ao dono o estado do ciclo de vida e o resultado do processamento do vídeo, incluindo uma URL temporária do thumbnail gerado (validation AMB-3).

**Technical actions:**

1. Implementar `VideosService.getOwnedVideo(userId, id)` — carrega o vídeo do canal do usuário (`VIDEO_NOT_FOUND`) e monta a resposta de `### API Contracts → GET /videos/{id}`, com `thumbnailUrl` = `StorageService.presignGet(thumbnail_key, { audience: 'public', expiresInSeconds: 3600 })` quando houver thumbnail, senão `null` (per `phase-03-videos/TD-11`, `TD-12`)
2. Criar `src/videos/dto/video-response.dto.ts` (classe documentada para o OpenAPI com os campos camelCase do contrato) e o handler `@Get(':id')` com `ParseUUIDPipe` e decorators OpenAPI (200/400/401/404)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getOwnedVideo` | Unit: `thumbnailUrl` nulo sem thumbnail e assinado com thumbnail; `VIDEO_NOT_FOUND` para vídeo de outro canal | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.5 — `VideosController`/`VideosService`; SI-03.4 — `presignGet`

**Acceptance criteria:**

- `GET /videos/{id}` de um vídeo recém pré-cadastrado retorna `200` com `status: "draft"`, `durationSeconds: null`, `metadata: null` e `thumbnailUrl: null`
- `GET /videos/{id}` de um vídeo `ready` retorna `durationSeconds`, `metadata` e `thumbnailUrl` cujo `GET` responde `200` com `Content-Type: image/jpeg`
- `GET /videos/{id}` de um vídeo `failed` retorna `failureReason` não nulo
- `GET /videos/{id}` com `id` que não é UUID retorna `400`; com UUID de vídeo de outro usuário retorna `404` com `VIDEO_NOT_FOUND`

---

### SI-03.11 — Endpoints GET /videos/{slug}/stream e GET /videos/{slug}/download

**Route:** GET /videos/{slug}/stream, GET /videos/{slug}/download
**Test Specs:** see `nestjs-project/specs/videos-playback.plan.md`
**Authorization:** Owner (`ready` only)

**Description:** Entrega o vídeo pela URL única: reprodução progressiva sem download completo (o storage atende `Range` com `206`) e download do arquivo original como anexo, sem tráfego de bytes pela API.

**Technical actions:**

1. Implementar `VideosService.getPlaybackUrl(userId, slug, mode: 'stream' | 'download')` — `slug` fora de `^[A-Za-z0-9_-]{11}$`, inexistente ou de outro canal → `VIDEO_NOT_FOUND`; `status != ready` → `VIDEO_NOT_READY`; retorna `presignGet(storage_key, { audience: 'public', expiresInSeconds: 3600, contentType })`, acrescentando `contentDisposition: attachment; filename="<original_filename>"` no modo `download` (per `phase-03-videos/TD-10`, `TD-11`, `TD-12`)
2. Adicionar os handlers `@Get(':slug/stream')` e `@Get(':slug/download')` respondendo `302` com `Location` = URL retornada (redirect do Express, sem lógica de negócio no controller), com decorators OpenAPI (302/401/404/409)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getPlaybackUrl` | Unit: slug malformado/inexistente/de outro canal → `VIDEO_NOT_FOUND`; `draft`/`processing`/`failed` → `VIDEO_NOT_READY`; `download` inclui `contentDisposition` e `stream` não | `src/videos/videos.service.spec.ts` |
| `VideosService.getPlaybackUrl` | Integration (DB + MinIO reais): URL de stream responde `206` a `Range: bytes=0-1023`; URL de download traz `Content-Disposition: attachment` com o nome original | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 — `VideosController`/`VideosService`; SI-03.4 — `presignGet`

**Acceptance criteria:**

- `GET /videos/{slug}/stream` de um vídeo `ready` do próprio usuário retorna `302` com `Location` apontando para o object storage
- `GET` na `Location` do stream com `Range: bytes=0-1023` retorna `206 Partial Content` com `Content-Range` e 1024 bytes
- `GET /videos/{slug}/download` retorna `302` cuja `Location` responde com `Content-Disposition: attachment; filename="<nome original>"` e o arquivo completo
- `GET /videos/{slug}/stream` de um vídeo em `processing` retorna `409` com `VIDEO_NOT_READY`
- `GET /videos/{slug}/stream` com slug inexistente, ou de vídeo de outro usuário, retorna `404` com `VIDEO_NOT_FOUND`; sem `Authorization` retorna `401`

---

### SI-03.12 — Documentação: OpenAPI, testing guide, diagrama e CLAUDE.md da fase de vídeos

**Description:** Alinha a documentação consumida por pessoas, pelo frontend e pela IA ao estado real do código da fase: contrato OpenAPI exportado, estratégia de storage nos testes, fila definida na arquitetura e a seção de vídeos nos CLAUDE.md.

**Technical actions:**

1. Regenerar `nestjs-project/openapi.json` via `npm run openapi:export` com os endpoints de vídeos (per `openapi-docs-nestjs/TD-02`)
2. Atualizar a seção "Object Storage" de `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` para storage S3-compatível real do Compose (MinIO) em testes, e a seção "Message Queue" para BullMQ/Redis com prefixo de fila isolado em testes de produtor (validation IC-1; per `phase-03-videos/TD-14`)
3. Atualizar `docs/diagrams/software-arch.mermaid` — `ContainerQueue` de "TBD" para "BullMQ (Redis)" e a relação `api → storage` para pré-assinatura de upload (per `phase-03-videos/TD-01`, `TD-05`)
4. Atualizar `CLAUDE.md` (raiz) e `nestjs-project/CLAUDE.md` com a seção de vídeos: módulos `videos/`, `storage/`, `media/`, `queue/`, `video-processing/`; endpoints; serviços `redis`, `minio`, `storage-init`, `video-worker` e seus comandos de verificação; variáveis `S3_*`/`REDIS_*` (incluindo o `S3_PUBLIC_ENDPOINT` por ambiente); fila `video-processing` e ciclo de status — citando apenas arquivos e comportamentos existentes

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `openapi.json` exportado | Integration: o export contém os 7 paths de vídeos com `bearer` e o envelope de erro | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.9 — worker no Compose; SI-03.10 — `GET /videos/{id}`; SI-03.11 — stream/download

**Acceptance criteria:**

- `nestjs-project/openapi.json` contém `POST /videos`, `POST`/`GET /videos/{id}/upload/parts`, `POST /videos/{id}/upload/complete`, `GET /videos/{id}`, `GET /videos/{slug}/stream` e `GET /videos/{slug}/download`
- Todo arquivo, comando, serviço do Compose e variável de ambiente citado nas seções novas dos `CLAUDE.md` existe no repositório
- O diagrama de arquitetura não contém mais "TBD" para a fila

---

## Technical Specifications

### Data Model

#### Video (table `videos`) — SI-03.3

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK — generated by the service (`crypto.randomUUID()`) before the row is saved, because the storage key is derived from it (per `phase-03-videos/TD-04`) |
| channel_id | uuid | FK → `channels.id` ON DELETE CASCADE, not null, indexed |
| slug | varchar(11) | unique, not null — 11-char base64url from `crypto.randomBytes(8)` (per `phase-03-videos/TD-10`) |
| title | varchar(255) | not null — request `title` or original file name without extension (validation AMB-2) |
| original_filename | varchar(255) | not null |
| content_type | varchar(100) | not null — one of the MIME allow-list (per `phase-03-videos/TD-06`) |
| size_bytes | bigint | not null — declared size, ≤ 10,737,418,240 (10 GiB) (per `phase-03-videos/TD-06`); mapped to `number` via a column transformer |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` (per `phase-03-videos/TD-13`) |
| storage_key | varchar(255) | not null — `videos/{id}/original` (per `phase-03-videos/TD-04`) |
| upload_id | varchar(1024) | nullable — S3 multipart `UploadId` while `draft`; set to null once the multipart upload is completed (per `phase-03-videos/TD-05`) |
| thumbnail_key | varchar(255) | nullable — `videos/{id}/thumbnail.jpg`, set by the worker (per `phase-03-videos/TD-04`, `TD-09`) |
| duration_seconds | double precision | nullable — set by the worker from `ffprobe` `format.duration` (per `phase-03-videos/TD-09`) |
| metadata | jsonb | nullable — `{ formatName, bitRate, sizeBytes, video: { codec, width, height, fps } \| null, audio: { codec } \| null }` (per `phase-03-videos/TD-09`) |
| failure_reason | text | nullable — set only on terminal failure (per `phase-03-videos/TD-13`) |
| created_at | timestamptz | `@CreateDateColumn` |
| updated_at | timestamptz | `@UpdateDateColumn` |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel` (`@ManyToOne` + `@JoinColumn({ name: 'channel_id' })`, inverse `@OneToMany` on `Channel.videos`).
**Indexes:** unique on `slug`; non-unique on `channel_id`.
**Migration:** `src/database/migrations/<timestamp>-CreateVideos.ts`, generated via the TypeORM CLI (`npm run migration:generate`), creating `videos_status_enum`, the table, the unique index on `slug`, the index on `channel_id` and the FK; `down()` drops them in reverse order including the enum type.

**Status transitions (per `phase-03-videos/TD-13`, validation AMB-1):**

| From | To | Actor | Guard |
|------|----|-------|-------|
| — | `draft` | API — `POST /videos` | row created together with the multipart upload |
| `draft` | `processing` | API — `POST /videos/{id}/upload/complete` | all parts present and their sizes sum to `size_bytes`; job enqueued |
| `processing` | `ready` | Worker | ffprobe + thumbnail succeeded |
| `processing` | `failed` | Worker | last attempt failed, or `UnrecoverableError` (no video stream / unreadable media) |

`draft` here is the processing-lifecycle state of a video whose upload has not been completed; the publication state (rascunho → publicação) is a separate concept owned by Fase 04.

### API Contracts

All endpoints below are authenticated (global JWT guard, `Authorization: Bearer <access_token>`) and owner-scoped: the caller's channel is resolved from the JWT `sub` via `ChannelsService.findByUserId()` (validation DG-2) and a video that does not belong to it is reported as `VIDEO_NOT_FOUND` (existence is not leaked). `{id}` is the video UUID (management/upload surface); `{slug}` is the unique public identifier (per `phase-03-videos/TD-10`) used by the delivery URLs.

#### POST /videos (SI-03.5)

Pre-registers the video as `draft` and starts the S3 multipart upload (per `phase-03-videos/TD-05`, `TD-06`, `TD-13`). No video bytes are sent to the API.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- fileName: string, required — 1..255 characters
- sizeBytes: integer, required — 1..10737418240 (10 GiB)
- contentType: string, required — one of `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`
- title: string, optional — 1..255 characters; when absent, defaults to `fileName` without its extension

**Response 201:**
- id: string (uuid)
- slug: string (11 chars)
- title: string
- status: `"draft"`
- upload: object
  - partSize: integer — 67108864 (64 MiB)
  - partCount: integer — `ceil(sizeBytes / partSize)` (≤ 160)

**Error responses:**
- 400 validation error: body fails schema validation (missing field, size > 10 GiB, MIME outside the allow-list)
- 401 unauthorized: missing/invalid access token
- 404 CHANNEL_NOT_FOUND: the authenticated user has no channel

---

#### POST /videos/{id}/upload/parts (SI-03.6)

Signs `UploadPart` URLs on demand for the requested part numbers (per `phase-03-videos/TD-06`). The client `PUT`s each part's bytes directly to the returned URL and reads the `ETag` response header.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- partNumbers: integer[], required — 1..100 unique items, each ≥ 1

**Response 200:**
- parts: array of `{ partNumber: integer, url: string }` — presigned `PUT` URLs signed for `S3_PUBLIC_ENDPOINT`
- expiresAt: string (ISO-8601) — now + 3600 s

**Error responses:**
- 400 INVALID_PART_NUMBER: a part number is greater than the video's `partCount`
- 400 validation error: body fails schema validation
- 401 unauthorized
- 404 VIDEO_NOT_FOUND: unknown id or video owned by another channel
- 409 VIDEO_NOT_DRAFT: the video is not in `draft` status (upload already completed)

---

#### GET /videos/{id}/upload/parts (SI-03.6)

Lists the parts already stored for the pending multipart upload, so an interrupted upload can resume by re-sending only missing parts (per `phase-03-videos/TD-05`).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- partSize: integer
- partCount: integer
- uploadedParts: array of `{ partNumber: integer, sizeBytes: integer, etag: string }` ordered by `partNumber`

**Error responses:**
- 401 unauthorized
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_DRAFT

---

#### POST /videos/{id}/upload/complete (SI-03.7)

Completes the multipart upload server-side and triggers processing (per `phase-03-videos/TD-07`, `TD-13`). The API lists the stored parts itself (client ETags are not trusted), requires every part `1..partCount` to be present with sizes summing to `size_bytes`, runs `CompleteMultipartUpload`, sets `status = processing`, clears `upload_id` and enqueues `process-video` with `jobId = videoId`.

**Request headers:**
- Authorization: Bearer <access_token>

**Request body:** none

**Response 202:**
- id: string (uuid)
- status: `"processing"`

**Error responses:**
- 400 UPLOAD_INCOMPLETE: one or more parts `1..partCount` are missing
- 400 UPLOAD_SIZE_MISMATCH: the stored parts' total size differs from the declared `sizeBytes`
- 401 unauthorized
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_DRAFT: already completed (processing/ready/failed)

---

#### GET /videos/{id} (SI-03.10)

Owner view of a video's lifecycle and processing result (validation AMB-3).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- id: string (uuid)
- slug: string
- title: string
- status: `"draft" | "processing" | "ready" | "failed"`
- originalFilename: string
- contentType: string
- sizeBytes: integer
- durationSeconds: number | null
- metadata: object | null — shape per Data Model `metadata`
- failureReason: string | null
- thumbnailUrl: string | null — presigned `GET` (TTL 3600 s, signed for `S3_PUBLIC_ENDPOINT`) when `thumbnail_key` is set
- createdAt: string (ISO-8601)
- updatedAt: string (ISO-8601)

**Error responses:**
- 400 validation error: `id` is not a UUID
- 401 unauthorized
- 404 VIDEO_NOT_FOUND

---

#### GET /videos/{slug}/stream (SI-03.11)

Progressive streaming without full download (per `phase-03-videos/TD-11`, `TD-12`). The API authorizes and redirects; the object storage serves `Range` requests with `206 Partial Content`.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 302:**
- `Location`: presigned `GET` URL for `videos/{id}/original` (TTL 3600 s, signed for `S3_PUBLIC_ENDPOINT`, `ResponseContentType` = video `content_type`). A subsequent `GET <Location>` with `Range: bytes=a-b` returns `206` with `Content-Range`.

**Error responses:**
- 401 unauthorized
- 404 VIDEO_NOT_FOUND: unknown slug or video owned by another channel
- 409 VIDEO_NOT_READY: status is not `ready`

---

#### GET /videos/{slug}/download (SI-03.11)

Download of the original file (per `phase-03-videos/TD-11`, `TD-12`).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 302:**
- `Location`: presigned `GET` URL for `videos/{id}/original` with `ResponseContentDisposition: attachment; filename="<original_filename>"` (TTL 3600 s, signed for `S3_PUBLIC_ENDPOINT`).

**Error responses:**
- 401 unauthorized
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY

---

#### Validation Rules — videos

- `fileName`: required string, 1..255 characters
- `sizeBytes`: required integer, min 1, max 10737418240
- `contentType`: required, `@IsIn(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'])`
- `title`: optional string, 1..255 characters
- `partNumbers`: required array, 1..100 unique integers, each ≥ 1
- `{id}` path param: `ParseUUIDPipe`
- `{slug}` path param: string, `^[A-Za-z0-9_-]{11}$` (non-matching → `VIDEO_NOT_FOUND`)

**Environment variables introduced (Joi-validated, per `phase-01-configuracao-base/TD-02`, `TD-03`):**

| Variable | Default (dev `.env`) | Consumer |
|----------|----------------------|----------|
| `REDIS_HOST` | `redis` | `queue` config (per `phase-03-videos/TD-01`) |
| `REDIS_PORT` | `6379` | `queue` config |
| `S3_ENDPOINT` | `http://minio:9000` | `storage` config — server-side S3 client (per `phase-03-videos/TD-02`) |
| `S3_PUBLIC_ENDPOINT` | `http://localhost:9000` (e2e: `http://minio:9000`) | `storage` config — client-facing presigner (per `phase-03-videos/TD-11` Revision 2026-11-22) |
| `S3_REGION` | `us-east-1` | `storage` config |
| `S3_ACCESS_KEY` | `streamtube` | `storage` config, `minio`/`storage-init` services |
| `S3_SECRET_KEY` | `streamtube-secret` | `storage` config, `minio`/`storage-init` services |
| `S3_BUCKET` | `streamtube-videos` | `storage` config, `storage-init` service (per `phase-03-videos/TD-04`) |

### Authorization Matrix

Per `phase-03-videos/TD-12` (owner-only until Fases 04/05) and the inherited global JWT guard (`phase-02-auth/TD-02`). No endpoint in this phase is `@Public()`.

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos | ✗ (401) | ✓ (creates in own channel) | ✓ |
| POST /videos/{id}/upload/parts | ✗ (401) | ✗ (404 VIDEO_NOT_FOUND) | ✓ |
| GET /videos/{id}/upload/parts | ✗ (401) | ✗ (404 VIDEO_NOT_FOUND) | ✓ |
| POST /videos/{id}/upload/complete | ✗ (401) | ✗ (404 VIDEO_NOT_FOUND) | ✓ |
| GET /videos/{id} | ✗ (401) | ✗ (404 VIDEO_NOT_FOUND) | ✓ |
| GET /videos/{slug}/stream | ✗ (401) | ✗ (404 VIDEO_NOT_FOUND) | ✓ (`ready` only) |
| GET /videos/{slug}/download | ✗ (401) | ✗ (404 VIDEO_NOT_FOUND) | ✓ (`ready` only) |

### Error Catalog

**Error response format:** inherited from Fase 02 (`phase-02-auth/TD-07`) — `{ statusCode: number, error: string, message: string }`, `error` carrying the domain code below; validation errors use `"VALIDATION_ERROR"` with `message` as an array. New domain exceptions extend `DomainException` in `src/common/exceptions/domain.exception.ts`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| CHANNEL_NOT_FOUND | 404 | Channel not found for the authenticated user | `POST /videos` when `ChannelsService.findByUserId()` returns null |
| VIDEO_NOT_FOUND | 404 | Video not found | Any `{id}`/`{slug}` endpoint when the video does not exist, belongs to another channel, or the slug is malformed |
| VIDEO_NOT_DRAFT | 409 | Video upload is not in progress | Parts sign/list or complete when `status != draft` |
| INVALID_PART_NUMBER | 400 | Part number exceeds the upload part count | `POST /videos/{id}/upload/parts` with a part number > `partCount` |
| UPLOAD_INCOMPLETE | 400 | Upload has missing parts | Complete when any part in `1..partCount` is not stored |
| UPLOAD_SIZE_MISMATCH | 400 | Uploaded size does not match the declared size | Complete when the stored parts' sizes do not sum to `size_bytes` |
| VIDEO_NOT_READY | 409 | Video is not ready | Stream/download when `status != ready` |

**Worker-side failures (not HTTP):** recorded in `videos.failure_reason` when the job fails terminally (per `phase-03-videos/TD-13`): `ffprobe`/`ffmpeg` non-zero exit (stderr tail), "no video stream found" (`UnrecoverableError`), storage errors after the last attempt.

### Events/Messages

#### Queue `video-processing` — job `process-video`

**Payload:**

```json
{ "videoId": "uuid" }
```

**Job options:** `jobId = videoId` (idempotent enqueue — a second enqueue of the same video is ignored while the job exists), `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: true`, `removeOnFail: false` (per `phase-03-videos/TD-01`, `TD-13`).
**Producer:** `VideosService.completeUpload()` in the API via `@InjectQueue('video-processing')` (per `phase-03-videos/TD-07`).
**Consumer:** `VideoProcessingProcessor` (`@Processor('video-processing')`, `WorkerHost`) registered only in `WorkerModule`, booted by the `video-worker` Compose service through `src/worker.ts` (per `phase-03-videos/TD-08`).
**Trigger:** the owner completes the multipart upload (`draft → processing`).
**Processing (per `phase-03-videos/TD-09`):**
1. Load the video; if `status != processing`, return without changes (idempotent redelivery).
2. Presign an internal `GET` URL (server-side `S3_ENDPOINT`) for `storage_key`.
3. `ffprobe -v error -print_format json -show_format -show_streams <url>` → duration + metadata; no video stream → `UnrecoverableError`.
4. `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale=1280:-2 -f image2 -c:v mjpeg pipe:1` with `t = duration × 0.1` → JPEG buffer → `PutObject videos/{id}/thumbnail.jpg` (`image/jpeg`).
5. Update the row: `status = ready`, `duration_seconds`, `metadata`, `thumbnail_key`.
**Failure:** errors are rethrown so BullMQ retries; when the attempt is the last one (`job.attemptsMade + 1 >= job.opts.attempts`) or the error is an `UnrecoverableError`, the processor first sets `status = failed` + `failure_reason`, then rethrows.
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-01`); duplicates are neutralized by the `status = processing` guard in step 1.

---

## Dependency Map

```
SI-03.1 (root — infra: libs, FFmpeg, config, Redis/MinIO/storage-init)
├── SI-03.4 — StorageService precisa do config `storage` e do bucket
└── SI-03.8 — MediaService precisa do FFmpeg na imagem
SI-03.2 (root — ChannelsService.findByUserId)
SI-03.3 (root — entidade Video + migration)

SI-03.2 + SI-03.3 + SI-03.4
└── SI-03.5 — POST /videos (pré-cadastro + multipart)
    ├── SI-03.6 — sign/list parts
    │   └── SI-03.7 — complete + enqueue (fila)
    │       └── SI-03.9 — worker (+ SI-03.8 MediaService)
    ├── SI-03.10 — GET /videos/{id} (+ SI-03.4)
    └── SI-03.11 — stream/download (+ SI-03.4)

SI-03.9 + SI-03.10 + SI-03.11
└── SI-03.12 — documentação (OpenAPI, testing guide, diagrama, CLAUDE.md)
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3 (parallel) → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10, SI-03.11 (parallel) → SI-03.12

---

## Deliverables

- [ ] SI-03.1 — Infra: dependências, configuração e serviços de storage/fila no Compose
- [ ] SI-03.2 — Busca do canal do usuário em `ChannelsService`
- [ ] SI-03.3 — Entidade `Video` e migration `CreateVideos`
- [ ] SI-03.4 — Serviço de object storage S3 (`StorageModule`)
- [ ] SI-03.5 — Endpoint POST /videos (pré-cadastro como rascunho + início do upload)
- [ ] SI-03.6 — Endpoints de partes do upload (assinatura sob demanda e listagem para retomada)
- [ ] SI-03.7 — Endpoint POST /videos/{id}/upload/complete (conclusão do upload e enfileiramento)
- [ ] SI-03.8 — Serviço de mídia com FFmpeg (metadados e thumbnail)
- [ ] SI-03.9 — Worker de vídeo: processor, entrypoint standalone e serviço `video-worker`
- [ ] SI-03.10 — Endpoint GET /videos/{id} (status, metadados e thumbnail para o dono)
- [ ] SI-03.11 — Endpoints GET /videos/{slug}/stream e GET /videos/{slug}/download
- [ ] SI-03.12 — Documentação: OpenAPI, testing guide, diagrama e CLAUDE.md da fase de vídeos

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`cd nestjs-project && docker compose exec nestjs-api npm run build`)
