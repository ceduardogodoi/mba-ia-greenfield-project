---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.11
target_file: test/videos-playback.e2e-spec.ts
---

# Stream and Download Endpoints Test Plan

## Application Overview

`GET /videos/{slug}/stream` e `GET /videos/{slug}/download` entregam o vídeo pela URL única: a API autoriza e redireciona (`302`) para uma URL pré-assinada do object storage, que atende `Range` com `206 Partial Content` (streaming sem download completo) ou entrega o arquivo como anexo (download).

## Test Scenarios

### 1. GET /videos/{slug}/stream and /download

**Setup:** `beforeAll` define `S3_PUBLIC_ENDPOINT=http://minio:9000` e compila `AppModule` com pipes/filtros globais de `main.ts`; `beforeAll` cria e autentica o usuário dono, envia `test/fixtures/sample.mp4`, conclui o upload e aguarda via polling de GET /videos/{id} o `status: "ready"` produzido pelo serviço `video-worker` do Compose (timeout 30 s). Os redirects não são seguidos automaticamente (supertest).

#### 1.1. redirects-stream-to-storage

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-22T14:09:38Z

**Steps:**
  1. GET /videos/{slug}/stream com o token do dono
    - expect: status `302` com header `Location` cujo host é `minio:9000` e path contém `videos/{id}/original`

#### 1.2. storage-serves-range-request

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-22T14:09:38Z

**Steps:**
  1. GET na `Location` do stream com header `Range: bytes=0-1023`
    - expect: status `206`, header `Content-Range` começando com `bytes 0-1023/` e corpo com 1024 bytes

#### 1.3. redirects-download-as-attachment

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-22T14:09:38Z

**Steps:**
  1. GET /videos/{slug}/download com o token do dono
    - expect: status `302` com `Location`
  2. GET na `Location`
    - expect: status `200`, `Content-Disposition` = `attachment; filename="sample.mp4"` e corpo com o tamanho do fixture

#### 1.4. rejects-video-not-ready

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-22T14:09:38Z

**Steps:**
  1. Criar um segundo vídeo via POST /videos (fica `draft`) e chamar GET /videos/{slug}/stream com o slug dele
    - expect: status `409` com `error` = `"VIDEO_NOT_READY"`

#### 1.5. hides-unknown-or-foreign-videos

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-22T14:09:38Z

**Steps:**
  1. GET /videos/AAAAAAAAAAA/stream (slug inexistente) com o token do dono
    - expect: status `404` com `error` = `"VIDEO_NOT_FOUND"`
  2. Um segundo usuário autenticado chama GET /videos/{slug}/stream do vídeo do primeiro
    - expect: status `404` com `error` = `"VIDEO_NOT_FOUND"`
  3. GET /videos/{slug}/stream sem `Authorization`
    - expect: status `401`
