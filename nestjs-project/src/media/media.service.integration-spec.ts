import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MediaProcessError, NoVideoStreamError } from './media.errors';
import { MediaService } from './media.service';

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');
const SAMPLE = join(FIXTURES, 'sample.mp4');
const NOT_A_VIDEO = join(FIXTURES, 'not-a-video.mp4');

describe('MediaService (integration — real FFmpeg)', () => {
  const media = new MediaService();
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'media-spec-'));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('should probe duration, codecs and resolution of the sample video', async () => {
    const result = await media.probe(SAMPLE);

    expect(result.durationSeconds).toBeGreaterThanOrEqual(1.9);
    expect(result.durationSeconds).toBeLessThanOrEqual(2.1);
    expect(result.metadata.video).toEqual(
      expect.objectContaining({ codec: 'h264', width: 320, height: 240 }),
    );
    expect(result.metadata.audio).toEqual({ codec: 'aac' });
  });

  it('should extract a JPEG thumbnail no wider than 1280 px', async () => {
    const jpeg = await media.extractThumbnail(SAMPLE, 0.2);

    expect(jpeg.length).toBeGreaterThan(0);
    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const thumbPath = join(workDir, 'thumb.jpg');
    writeFileSync(thumbPath, jpeg);
    const probe = JSON.parse(
      execFileSync('ffprobe', [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_streams',
        thumbPath,
      ]).toString(),
    ) as { streams: { width: number }[] };
    expect(probe.streams[0].width).toBeLessThanOrEqual(1280);
  });

  it('should fail with MediaProcessError carrying the exit code for a non-media file', async () => {
    const error = await media.probe(NOT_A_VIDEO).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MediaProcessError);
    expect((error as MediaProcessError).exitCode).not.toBe(0);
  });

  it('should fail with NoVideoStreamError for an audio-only file', async () => {
    const audioOnly = join(workDir, 'audio-only.m4a');
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-c:a',
      'aac',
      audioOnly,
    ]);

    await expect(media.probe(audioOnly)).rejects.toBeInstanceOf(
      NoVideoStreamError,
    );
  });
});
