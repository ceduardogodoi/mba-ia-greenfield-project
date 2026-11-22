---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: test/videos-get.e2e-spec.ts
---

# GET /videos/{id} Test Plan

## Application Overview

`GET /videos/{id}` expõe ao dono o estado do ciclo de vida (`draft → processing → ready | failed`) e o resultado do processamento — duração, metadados, motivo de falha e uma URL temporária do thumbnail gerado pelo worker.

## Test Scenarios

### 1. GET /videos/{id}

**Setup:** `beforeAll` define `S3_PUBLIC_ENDPOINT=http://minio:9000` e compila `AppModule` com pipes/filtros globais de `main.ts`; `beforeEach` executa `cleanAllTables`, cria e autentica o usuário dono. Requer a stack do Compose no ar, incluindo `video-worker`, para os cenários `ready`/`failed`.

#### 1.1. returns-draft-video

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-22T14:09:38Z

**Steps:**
  1. POST /videos com body válido e GET /videos/{id}
    - expect: status `200` com `status: "draft"`, `durationSeconds: null`, `metadata: null`, `thumbnailUrl: null`, `failureReason: null`

#### 1.2. returns-ready-video-with-thumbnail

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-22T14:09:38Z

**Steps:**
  1. Enviar `test/fixtures/sample.mp4` (parte única), concluir o upload e fazer polling de GET /videos/{id} até `status: "ready"` (timeout 30 s)
    - expect: `durationSeconds` entre 1.9 e 2.1 e `metadata.video` com `codec: "h264"`, `width: 320`, `height: 240`
  2. GET na `thumbnailUrl`
    - expect: status `200` com `Content-Type: image/jpeg`

#### 1.3. returns-failed-video-with-reason

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-22T14:09:38Z

**Steps:**
  1. Enviar `test/fixtures/not-a-video.mp4` (parte única), concluir o upload e fazer polling de GET /videos/{id} até `status: "failed"` (timeout 30 s)
    - expect: `failureReason` não nulo e `thumbnailUrl: null`

#### 1.4. validates-id-and-ownership

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-22T14:09:38Z

**Steps:**
  1. GET /videos/not-a-uuid
    - expect: status `400`
  2. Um segundo usuário autenticado chama GET /videos/{id} do vídeo do primeiro
    - expect: status `404` com `error` = `"VIDEO_NOT_FOUND"`
