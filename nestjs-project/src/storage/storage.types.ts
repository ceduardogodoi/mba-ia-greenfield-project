export type PresignAudience = 'internal' | 'public';

export interface UploadedPart {
  partNumber: number;
  sizeBytes: number;
  etag: string;
}

export interface PresignGetOptions {
  audience: PresignAudience;
  expiresInSeconds: number;
  contentDisposition?: string;
  contentType?: string;
}
