import { Injectable } from '@nestjs/common';
import { spawn } from 'child_process';
import { MediaProcessError } from './media.errors';
import { MediaProbeResult, parseProbeOutput } from './media-probe.parser';

const PROCESS_TIMEOUT_MS = 10 * 60 * 1000;
const STDERR_TAIL_CHARS = 500;

/**
 * Thin typed wrapper over the ffprobe/ffmpeg binaries (phase-03-videos/TD-09).
 * Binaries are spawned with argument arrays (no shell) and read the input from
 * a URL, so FFmpeg's HTTP range requests avoid downloading the whole file.
 */
@Injectable()
export class MediaService {
  async probe(url: string): Promise<MediaProbeResult> {
    const stdout = await this.run('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      url,
    ]);
    return parseProbeOutput(stdout.toString('utf8'));
  }

  async extractThumbnail(url: string, atSeconds: number): Promise<Buffer> {
    return this.run('ffmpeg', [
      '-v',
      'error',
      '-ss',
      atSeconds.toFixed(3),
      '-i',
      url,
      '-frames:v',
      '1',
      '-vf',
      'scale=1280:-2',
      '-f',
      'image2',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ]);
  }

  private run(tool: 'ffprobe' | 'ffmpeg', args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(tool, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      let stderr = '';

      const timer = setTimeout(() => child.kill('SIGKILL'), PROCESS_TIMEOUT_MS);

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const output = Buffer.concat(stdout);
        if (code === 0 && (tool === 'ffprobe' || output.length > 0)) {
          resolve(output);
          return;
        }
        reject(new MediaProcessError(tool, code, stderr.trim()));
      });
    });
  }
}
