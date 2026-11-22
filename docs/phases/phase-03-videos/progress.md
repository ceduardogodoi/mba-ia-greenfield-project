# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/12 completed

### SI-03.1 — Infra: dependências, configuração e serviços de storage/fila no Compose
- **Status:** completed
- **Tests:** 4 new passing (`src/config/env.validation.integration-spec.ts`); full suite 148 + e2e 52 passing
- **Observations:**
  - `storage-init` uses the MinIO root credentials (`S3_ACCESS_KEY`/`S3_SECRET_KEY` interpolated from `.env` by Compose); `mc mb --ignore-existing` makes reruns exit 0.
  - MinIO healthcheck probes `http://localhost:9000/minio/health/live` from inside its own container (self-probe, not inter-service traffic).

### SI-03.2 — Busca do canal do usuário em `ChannelsService`
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.3 — Entidade `Video` e migration `CreateVideos`
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Serviço de object storage S3 (`StorageModule`)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Endpoint POST /videos (pré-cadastro como rascunho + início do upload)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Endpoints de partes do upload (assinatura sob demanda e listagem para retomada)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Endpoint POST /videos/{id}/upload/complete (conclusão do upload e enfileiramento)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Serviço de mídia com FFmpeg (metadados e thumbnail)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Worker de vídeo: processor, entrypoint standalone e serviço `video-worker`
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Endpoint GET /videos/{id} (status, metadados e thumbnail para o dono)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Endpoints GET /videos/{slug}/stream e GET /videos/{slug}/download
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Documentação: OpenAPI, testing guide, diagrama e CLAUDE.md da fase de vídeos
- **Status:** pending
- **Tests:** —
- **Observations:** none
