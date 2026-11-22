import type { VideoStatus } from './entities/video.entity';

export interface InitiatedUpload {
  id: string;
  slug: string;
  title: string;
  status: VideoStatus;
  upload: { partSize: number; partCount: number };
}

export interface SignedUploadParts {
  parts: { partNumber: number; url: string }[];
  expiresAt: string;
}

export interface UploadedPartsView {
  partSize: number;
  partCount: number;
  uploadedParts: { partNumber: number; sizeBytes: number; etag: string }[];
}
