import { randomBytes } from 'crypto';

/** 8 random bytes → 11 base64url characters (64 bits), per phase-03-videos/TD-10. */
export function generateVideoSlug(): string {
  return randomBytes(8).toString('base64url');
}

export const VIDEO_SLUG_PATTERN = /^[A-Za-z0-9_-]{11}$/;
