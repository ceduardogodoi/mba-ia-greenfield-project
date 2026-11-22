/** An ffprobe/ffmpeg process exited unsuccessfully (or timed out). */
export class MediaProcessError extends Error {
  constructor(
    public readonly tool: 'ffprobe' | 'ffmpeg',
    public readonly exitCode: number | null,
    public readonly stderrTail: string,
  ) {
    super(
      `${tool} failed (exit code ${exitCode ?? 'none'}): ${stderrTail || 'no stderr output'}`,
    );
    this.name = 'MediaProcessError';
  }
}

/** The media was read but carries no video stream (e.g. audio-only file). */
export class NoVideoStreamError extends Error {
  constructor() {
    super('No video stream found in the uploaded file');
    this.name = 'NoVideoStreamError';
  }
}
