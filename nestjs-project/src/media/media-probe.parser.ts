import type { VideoMetadata } from '../videos/entities/video.entity';
import { NoVideoStreamError } from './media.errors';

export interface MediaProbeResult {
  durationSeconds: number;
  metadata: VideoMetadata;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
    size?: string;
  };
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parses ffprobe frame rates such as "25/1" or "30000/1001". */
function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [num, den] = value.split('/').map(Number);
  if (!Number.isFinite(num) || !den) return null;
  return Math.round((num / den) * 1000) / 1000;
}

/**
 * Maps `ffprobe -print_format json -show_format -show_streams` output to the
 * persisted metadata shape (phase-03-videos/TD-09, Data Model `metadata`).
 */
export function parseProbeOutput(raw: string): MediaProbeResult {
  const output = JSON.parse(raw) as FfprobeOutput;
  const streams = output.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video) {
    throw new NoVideoStreamError();
  }
  const audio = streams.find((s) => s.codec_type === 'audio');
  const format = output.format ?? {};

  return {
    durationSeconds: toNumber(format.duration) ?? 0,
    metadata: {
      formatName: format.format_name ?? null,
      bitRate: toNumber(format.bit_rate),
      sizeBytes: toNumber(format.size),
      video: {
        codec: video.codec_name ?? null,
        width: video.width ?? null,
        height: video.height ?? null,
        fps: parseFrameRate(video.avg_frame_rate ?? video.r_frame_rate),
      },
      audio: audio ? { codec: audio.codec_name ?? null } : null,
    },
  };
}
