import { originalKey, thumbnailKey } from './storage-keys';

describe('storage-keys', () => {
  it('should place the original under the per-video prefix', () => {
    expect(originalKey('abc')).toBe('videos/abc/original');
  });

  it('should place the thumbnail under the same per-video prefix', () => {
    expect(thumbnailKey('abc')).toBe('videos/abc/thumbnail.jpg');
  });
});
