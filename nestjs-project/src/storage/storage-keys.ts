const VIDEO_PREFIX = 'videos';

export function originalKey(videoId: string): string {
  return `${VIDEO_PREFIX}/${videoId}/original`;
}

export function thumbnailKey(videoId: string): string {
  return `${VIDEO_PREFIX}/${videoId}/thumbnail.jpg`;
}
