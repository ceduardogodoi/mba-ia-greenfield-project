/** Upload limits and part policy — phase-03-videos/TD-06. */
export const PART_SIZE_BYTES = 64 * 1024 * 1024;
export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 * 1024 * 1024;
export const PART_URL_TTL_SECONDS = 3600;
export const MAX_PARTS_PER_SIGN_REQUEST = 100;
export const ALLOWED_VIDEO_CONTENT_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
] as const;

export function partCount(sizeBytes: number): number {
  return Math.ceil(sizeBytes / PART_SIZE_BYTES);
}

/** Original file name without its extension (validation AMB-2). */
export function defaultTitle(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  const base = lastDot > 0 ? fileName.slice(0, lastDot) : fileName;
  return base.trim() || fileName;
}
