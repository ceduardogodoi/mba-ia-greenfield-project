import {
  defaultTitle,
  MAX_VIDEO_SIZE_BYTES,
  PART_SIZE_BYTES,
  partCount,
} from './upload-policy';
import { generateVideoSlug, VIDEO_SLUG_PATTERN } from './video-slug.util';

describe('upload-policy', () => {
  describe('partCount', () => {
    it('should need a single part for a 1-byte file', () => {
      expect(partCount(1)).toBe(1);
    });

    it('should not add a part for an exact multiple of the part size', () => {
      expect(partCount(PART_SIZE_BYTES * 2)).toBe(2);
    });

    it('should round up a partial trailing part', () => {
      expect(partCount(PART_SIZE_BYTES * 2 + 1)).toBe(3);
    });

    it('should need 160 parts of 64 MiB for the 10 GiB limit', () => {
      expect(partCount(MAX_VIDEO_SIZE_BYTES)).toBe(160);
    });
  });

  describe('defaultTitle', () => {
    it('should strip the extension', () => {
      expect(defaultTitle('aula.mp4')).toBe('aula');
    });

    it('should strip only the last extension', () => {
      expect(defaultTitle('aula.final.mov')).toBe('aula.final');
    });

    it('should keep a name without extension', () => {
      expect(defaultTitle('aula')).toBe('aula');
    });

    it('should keep dotfiles as they are', () => {
      expect(defaultTitle('.mp4')).toBe('.mp4');
    });
  });
});

describe('generateVideoSlug', () => {
  it('should produce 11 base64url characters', () => {
    expect(generateVideoSlug()).toMatch(VIDEO_SLUG_PATTERN);
  });

  it('should produce different values across calls', () => {
    const slugs = new Set(Array.from({ length: 100 }, generateVideoSlug));
    expect(slugs.size).toBe(100);
  });
});
