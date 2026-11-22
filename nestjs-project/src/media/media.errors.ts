const URL_PATTERN = /\bhttps?:\/\/\S+/gi;

/** Presigned input URLs carry signatures — never persist or log them. */
function redactUrls(text: string): string {
  return text.replace(URL_PATTERN, '<input-url>');
}

const TRANSIENT_STDERR_PATTERN =
  /connection refused|connection reset|connection timed out|timed out|network is unreachable|failed to resolve|server returned 5\d\d|server returned 403/i;

/** An ffprobe/ffmpeg process exited unsuccessfully (or timed out). */
export class MediaProcessError extends Error {
  constructor(
    public readonly tool: 'ffprobe' | 'ffmpeg',
    public readonly exitCode: number | null,
    stderrTail: string,
  ) {
    stderrTail = redactUrls(stderrTail);
    super(
      `${tool} failed (exit code ${exitCode ?? 'none'}): ${stderrTail || 'no stderr output'}`,
    );
    this.name = 'MediaProcessError';
    this.stderrTail = stderrTail;
  }

  readonly stderrTail: string;

  /**
   * True when FFmpeg failed to reach the input (connection/HTTP errors against
   * the object storage) rather than failing to decode it — worth a retry.
   */
  get isTransient(): boolean {
    return TRANSIENT_STDERR_PATTERN.test(this.stderrTail);
  }
}

/** The media was read but carries no video stream (e.g. audio-only file). */
export class NoVideoStreamError extends Error {
  constructor() {
    super('No video stream found in the uploaded file');
    this.name = 'NoVideoStreamError';
  }
}
