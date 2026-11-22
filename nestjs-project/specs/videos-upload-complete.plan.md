---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/{id}/upload/complete Test Plan

## Application Overview

`POST /videos/{id}/upload/complete` conclui o multipart upload no servidor (listando as partes no storage, sem confiar em ETags do cliente), valida o tamanho declarado, move o vídeo para `processing` e publica o job `process-video` na fila `video-processing`, que o serviço `video-worker` do Compose consome para levar o vídeo a `ready`.

## Test Scenarios

### 1. POST /videos/{id}/upload/complete

**Setup:** `beforeAll` define `S3_PUBLIC_ENDPOINT=http://minio:9000` e compila `AppModule` com pipes/filtros globais de `main.ts`; `beforeEach` executa `cleanAllTables`, cria e autentica o usuário dono. Helper de upload: `POST /videos` com o tamanho de `test/fixtures/sample.mp4`, assina a parte 1 e faz `PUT` do fixture na URL. Requer a stack do Compose no ar, incluindo `video-worker`.

#### 1.1. completes-upload-and-processes-through-compose-worker

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-11-22T12:29:47Z

**Steps:**
  1. Enviar o fixture pelo helper e chamar POST /videos/{id}/upload/complete
    - expect: status `202` com body `{ id, status: "processing" }`
  2. Consultar a linha do vídeo imediatamente
    - expect: `upload_id` nulo e `status` ∈ (`processing`, `ready`)
  3. Fazer polling de GET /videos/{id} (intervalo 500 ms, timeout 30 s)
    - expect: `status` chega a `"ready"` (processado pelo serviço `video-worker` do Compose) com `durationSeconds` > 0

#### 1.2. rejects-missing-parts

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-22T12:29:47Z

**Steps:**
  1. POST /videos com `sizeBytes` de 2 partes (67108864 + 10), enviar apenas a parte 1 e chamar POST /videos/{id}/upload/complete
    - expect: status `400` com `error` = `"UPLOAD_INCOMPLETE"`
    - expect: a linha permanece com `status = 'draft'`

#### 1.3. rejects-size-mismatch

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-22T12:29:47Z

**Steps:**
  1. POST /videos declarando `sizeBytes` = tamanho do fixture + 1, enviar o fixture como parte 1 e chamar POST /videos/{id}/upload/complete
    - expect: status `400` com `error` = `"UPLOAD_SIZE_MISMATCH"`
    - expect: a linha permanece com `status = 'draft'`

#### 1.4. rejects-second-completion

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-22T12:29:47Z

**Steps:**
  1. Concluir um upload válido e repetir POST /videos/{id}/upload/complete
    - expect: a segunda chamada retorna `409` com `error` = `"VIDEO_NOT_DRAFT"`

#### 1.5. hides-video-from-other-users

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-22T12:29:47Z

**Steps:**
  1. Um segundo usuário autenticado chama POST /videos/{id}/upload/complete para o vídeo do primeiro
    - expect: status `404` com `error` = `"VIDEO_NOT_FOUND"`
