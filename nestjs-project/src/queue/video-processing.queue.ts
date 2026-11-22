import type { JobsOptions } from 'bullmq';

/** Queue contract — see `### Events/Messages` (phase-03-videos/TD-01, TD-13). */
export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const PROCESS_VIDEO_JOB = 'process-video';

export interface ProcessVideoJobData {
  videoId: string;
}

export const PROCESS_VIDEO_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: true,
  removeOnFail: false,
} as const satisfies JobsOptions;
