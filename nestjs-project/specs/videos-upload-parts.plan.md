---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-upload-parts.e2e-spec.ts
---

# Upload Parts Endpoints Test Plan

## Application Overview

`POST /videos/{id}/upload/parts` assina sob demanda URLs de `UploadPart` (TTL 1 h) para o dono enviar cada parte direto ao object storage; `GET /videos/{id}/upload/parts` lista as partes já armazenadas para retomar um upload interrompido.

## Test Scenarios

### 1. POST/GET /videos/{id}/upload/parts

**Setup:** `beforeAll` define `S3_PUBLIC_ENDPOINT=http://minio:9000` e compila `AppModule` com pipes/filtros globais de `main.ts`; `beforeEach` executa `cleanAllTables`, cria e autentica o usuário dono e cria um vídeo via `POST /videos` (`sizeBytes` de 2 partes: 67108864 + 10).

#### 1.1. signs-requested-parts

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-22T12:29:47Z

**Steps:**
  1. POST /videos/{id}/upload/parts com `{ partNumbers: [1, 2] }`
    - expect: status `200`
    - expect: `parts` com 2 itens `{ partNumber, url }` e `url` com host `minio:9000`
    - expect: `expiresAt` entre agora + 3500 s e agora + 3700 s

#### 1.2. uploads-part-directly-and-lists-it

**Covers AC:** #2, #3
**Source:** auto
**Last sync:** 2026-11-22T12:29:47Z

**Steps:**
  1. POST /videos/{id}/upload/parts com `{ partNumbers: [1] }` e `PUT` de um buffer de 64 MiB direto na `url` retornada (fetch, sem passar pela API)
    - expect: o `PUT` responde `200` com header `ETag`
  2. GET /videos/{id}/upload/parts
    - expect: status `200`, `partSize: 67108864`, `partCount: 2`
    - expect: `uploadedParts` = `[{ partNumber: 1, sizeBytes: 67108864, etag }]`

#### 1.3. rejects-part-number-above-part-count

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-22T12:29:47Z

**Steps:**
  1. POST /videos/{id}/upload/parts com `{ partNumbers: [3] }`
    - expect: status `400` com `error` = `"INVALID_PART_NUMBER"`

#### 1.4. hides-video-from-other-users

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-22T12:29:47Z

**Steps:**
  1. Autenticar um segundo usuário e chamar POST /videos/{id}/upload/parts com `{ partNumbers: [1] }`
    - expect: status `404` com `error` = `"VIDEO_NOT_FOUND"`
  2. O segundo usuário chama GET /videos/{id}/upload/parts
    - expect: status `404` com `error` = `"VIDEO_NOT_FOUND"`

#### 1.5. rejects-after-upload-completed

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-22T12:29:47Z

**Steps:**
  1. Atualizar a linha do vídeo para `status = 'processing'` (estado pós-conclusão)
  2. POST /videos/{id}/upload/parts com `{ partNumbers: [1] }` e GET /videos/{id}/upload/parts
    - expect: ambos `409` com `error` = `"VIDEO_NOT_DRAFT"`
