---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-22T14:09:22Z"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-22T14:09:22Z"
issues:
  - id: IC-2
    status: resolved
    summary: "TD-11 public presign endpoint unreachable from in-container e2e (TD-14)"
    resolved_by: phase-03-videos/TD-11
  - id: IC-1
    status: resolved
    summary: "Testing guide prescribes local-FS storage in tests; TD-03/TD-14 put real MinIO"
    resolved_by: clarification
  - id: AMB-1
    status: resolved
    summary: "'rascunho' (F03 pre-registration) vs 'rascunho → publicação' (F04) semantics"
    resolved_by: phase-03-videos/TD-13
  - id: AMB-2
    status: resolved
    summary: "Source of the video title at pre-registration is undefined"
    resolved_by: clarification
  - id: AMB-3
    status: resolved
    summary: "No read surface defined for status/metadata/thumbnail of a video in F03"
    resolved_by: clarification
  - id: DG-1
    status: resolved
    summary: "Dev image (Dockerfile.dev from F01) has no FFmpeg; worker/tests need it"
    resolved_by: clarification
  - id: DG-2
    status: resolved
    summary: "ChannelsService (F02) exposes no lookup of a user's channel"
    resolved_by: clarification
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Message Queue Technology"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — S3 Client Library"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — Local S3-Compatible Storage Image and Provisioning"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Bucket and Object Key Layout"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Upload Strategy for Files up to 10GB"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Upload Limits and Part Policy"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Upload Completion and Processing Trigger"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Video Worker Runtime"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Media Processing (FFmpeg invocation, input, thumbnail)"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Unique Video URL Identifier"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Streaming and Download Delivery"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-12
    status: resolved
    summary: "TD-12 pending — Access Policy for Stream and Download in Phase 03"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-13
    status: resolved
    summary: "TD-13 pending — Video Status Lifecycle and Failure Handling"
    resolved_by: phase-03-videos/TD-13
  - id: OQ-14
    status: resolved
    summary: "TD-14 pending — Testing Strategy for the Async Pipeline"
    resolved_by: phase-03-videos/TD-14
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(no UI scope in this phase — `## UI Inventory` absent)_

## Resolved Issues

- **IC-1** _(resolved_by clarification)_ — Testing guide prescribes local-FS storage in tests; TD-03/TD-14 put real MinIO. Option (a): tests run against the real Compose S3-compatible storage (MinIO); the Object Storage strategy in `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` is updated during implementation to match TD-03/TD-14.
- **AMB-1** _(resolved_by phase-03-videos/TD-13)_ — 'rascunho' (F03 pre-registration) vs 'rascunho → publicação' (F04) semantics. Option (a): Phase 03 *rascunho* is the processing-lifecycle state `draft` (`draft → processing → ready | failed`, TD-13); publication state is a separate concept introduced by Phase 04.
- **AMB-2** _(resolved_by clarification)_ — Source of the video title at pre-registration is undefined. Option (a): upload initiation accepts an optional `title`; when absent it defaults to the original file name without extension.
- **AMB-3** _(resolved_by clarification)_ — No read surface defined for status/metadata/thumbnail of a video in F03. Option (a): owner-only `GET /videos/{id}` returns status, slug, duration, metadata, failure reason and a short-lived presigned thumbnail URL.
- **DG-1** _(resolved_by clarification)_ — Dev image (Dockerfile.dev from F01) has no FFmpeg; worker/tests need it. Option (a): an early SI extends `nestjs-project/Dockerfile.dev` with `ffmpeg` (ffmpeg + ffprobe) for the image shared by API and worker.
- **DG-2** _(resolved_by clarification)_ — ChannelsService (F02) exposes no lookup of a user's channel. Option (a): add `ChannelsService.findByUserId()` in `channels/` (owner of the entity), consumed by the videos module.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — TD-01 pending — Message Queue Technology.
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — TD-02 pending — S3 Client Library.
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — TD-03 pending — Local S3-Compatible Storage Image and Provisioning.
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — TD-04 pending — Bucket and Object Key Layout.
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — TD-05 pending — Upload Strategy for Files up to 10GB.
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — TD-06 pending — Upload Limits and Part Policy.
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — TD-07 pending — Upload Completion and Processing Trigger.
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — TD-08 pending — Video Worker Runtime.
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — TD-09 pending — Media Processing (FFmpeg invocation, input, thumbnail).
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — TD-10 pending — Unique Video URL Identifier.
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — TD-11 pending — Streaming and Download Delivery.
- **OQ-12** _(resolved_by phase-03-videos/TD-12)_ — TD-12 pending — Access Policy for Stream and Download in Phase 03.
- **OQ-13** _(resolved_by phase-03-videos/TD-13)_ — TD-13 pending — Video Status Lifecycle and Failure Handling.
- **OQ-14** _(resolved_by phase-03-videos/TD-14)_ — TD-14 pending — Testing Strategy for the Async Pipeline.
- **IC-2** _(resolved_by phase-03-videos/TD-11 — Revision 2026-11-22)_ — TD-11 public presign endpoint unreachable from in-container e2e (TD-14). Option (a): `S3_PUBLIC_ENDPOINT` is environment-specific (dev `http://localhost:9000`; e2e `http://minio:9000`).
