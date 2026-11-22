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

**Setup:** `beforeAll` define `S3_PUBLIC_ENDPOINT=http://minio:9000` e compila `AppModule` com pipes/filtros globais de `main.ts`; `beforeEach` executa `cleanAllTables`, cria e autentica o usuário dono. Helper de upload: `POST /videos` declarando o tamanho de um buffer gerado de 1 KiB, assina a parte 1 e faz `PUT` do buffer na URL (o conteúdo não é processado neste SI). Requer a stack do Compose no ar (`db`, `redis`, `minio`).

#### 1.1. completes-upload-and-leaves-draft

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-11-22T14:09:38Z

**Steps:**
  1. Enviar o buffer pelo helper e chamar POST /videos/{id}/upload/complete
    - expect: status `202` com body `{ id, status: "processing" }`
  2. Consultar a linha do vídeo e o objeto no storage
    - expect: `upload_id` nulo e `status` ≠ `draft` (`processing`, ou já `ready` se o `video-worker` do Compose a consumiu)
    - expect: `videos/{id}/original` existe com tamanho igual ao do buffer

_The end-to-end path through the Compose `video-worker` (`processing → ready`) is asserted by `videos-get.plan.md` §1.2/§1.3 and `videos-playback.plan.md`, whose SIs run after SI-03.9 delivers the worker; the job itself (`jobId = videoId`) is asserted by the SI-03.7 integration spec with an isolated queue prefix._

#### 1.2. rejects-missing-parts

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-22T14:09:38Z

**Steps:**
  1. POST /videos com `sizeBytes` de 2 partes (67108864 + 10), enviar apenas a parte 1 e chamar POST /videos/{id}/upload/complete
    - expect: status `400` com `error` = `"UPLOAD_INCOMPLETE"`
    - expect: a linha permanece com `status = 'draft'`

#### 1.3. rejects-size-mismatch

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-22T14:09:38Z

**Steps:**
  1. POST /videos declarando `sizeBytes` = tamanho do buffer + 1, enviar o buffer como parte 1 e chamar POST /videos/{id}/upload/complete
    - expect: status `400` com `error` = `"UPLOAD_SIZE_MISMATCH"`
    - expect: a linha permanece com `status = 'draft'`

#### 1.4. rejects-second-completion

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-22T14:09:38Z

**Steps:**
  1. Concluir um upload válido e repetir POST /videos/{id}/upload/complete
    - expect: a segunda chamada retorna `409` com `error` = `"VIDEO_NOT_DRAFT"`

#### 1.5. hides-video-from-other-users

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-22T14:09:38Z

**Steps:**
  1. Um segundo usuário autenticado chama POST /videos/{id}/upload/complete para o vídeo do primeiro
    - expect: status `404` com `error` = `"VIDEO_NOT_FOUND"`
