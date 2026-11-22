---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: test/videos-create.e2e-spec.ts
---

# POST /videos Test Plan

## Application Overview

`POST /videos` pré-cadastra um vídeo como `draft` no canal do usuário autenticado, gera o identificador único (`slug`) e abre o multipart upload no object storage, devolvendo a política de partes (`partSize`, `partCount`). Nenhum byte de vídeo trafega pela API.

## Test Scenarios

### 1. POST /videos

**Setup:** `beforeAll` define `S3_PUBLIC_ENDPOINT=http://minio:9000`, compila `AppModule` com `ValidationPipe` + `DomainExceptionFilter` + `ValidationExceptionFilter` (como `main.ts`); `beforeEach` executa `cleanAllTables` e cria um usuário confirmado com login (access token).

#### 1.1. creates-draft-video-with-upload-policy

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-11-22T14:09:38Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <token>` e body `{ fileName: "aula.mp4", sizeBytes: 150000000, contentType: "video/mp4" }`
    - expect: status `201`
    - expect: body `status` = `"draft"`, `title` = `"aula"`, `slug` casa `^[A-Za-z0-9_-]{11}$`, `upload` = `{ partSize: 67108864, partCount: 3 }`
  2. Consultar a linha em `videos` pelo `id` retornado
    - expect: `status = 'draft'`, `channel_id` = canal do usuário, `storage_key = videos/{id}/original`, `upload_id` não nulo

#### 1.2. uses-provided-title

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-22T14:09:38Z

**Steps:**
  1. POST /videos com body válido incluindo `title: "Minha aula de NestJS"`
    - expect: status `201` e body `title` = `"Minha aula de NestJS"`
    - expect: a coluna `title` da linha persistida é `"Minha aula de NestJS"`

#### 1.3. rejects-invalid-body

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-22T14:09:38Z

**Steps:**
  1. POST /videos com `sizeBytes: 10737418241`
    - expect: status `400` com `error` = `"VALIDATION_ERROR"`
  2. POST /videos com `contentType: "application/pdf"`
    - expect: status `400` com `error` = `"VALIDATION_ERROR"`
  3. Contar linhas em `videos`
    - expect: nenhuma linha criada

#### 1.4. requires-authentication

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-22T14:09:38Z

**Steps:**
  1. POST /videos com body válido e sem header `Authorization`
    - expect: status `401`

#### 1.5. generates-distinct-slugs

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-22T14:09:38Z

**Steps:**
  1. POST /videos duas vezes com o mesmo body válido
    - expect: ambos `201` com `slug`s diferentes e `id`s diferentes
