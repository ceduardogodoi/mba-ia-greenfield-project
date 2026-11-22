import type { VideoStatus } from './entities/video.entity';

export interface InitiatedUpload {
  id: string;
  slug: string;
  title: string;
  status: VideoStatus;
  upload: { partSize: number; partCount: number };
}
