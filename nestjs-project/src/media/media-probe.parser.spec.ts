import { NoVideoStreamError } from './media.errors';
import { parseProbeOutput } from './media-probe.parser';

const videoStream = {
  codec_type: 'video',
  codec_name: 'h264',
  width: 1920,
  height: 1080,
  r_frame_rate: '25/1',
  avg_frame_rate: '25/1',
};
const audioStream = { codec_type: 'audio', codec_name: 'aac' };
const format = {
  format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
  duration: '12.345000',
  bit_rate: '512000',
  size: '790000',
};

describe('parseProbeOutput', () => {
  it('should map video + audio streams and format into the metadata shape', () => {
    const result = parseProbeOutput(
      JSON.stringify({ streams: [videoStream, audioStream], format }),
    );

    expect(result).toEqual({
      durationSeconds: 12.345,
      metadata: {
        formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
        bitRate: 512000,
        sizeBytes: 790000,
        video: { codec: 'h264', width: 1920, height: 1080, fps: 25 },
        audio: { codec: 'aac' },
      },
    });
  });

  it('should report audio as null for a video-only file', () => {
    const result = parseProbeOutput(
      JSON.stringify({ streams: [videoStream], format }),
    );

    expect(result.metadata.audio).toBeNull();
  });

  it('should throw NoVideoStreamError when there is no video stream', () => {
    expect(() =>
      parseProbeOutput(JSON.stringify({ streams: [audioStream], format })),
    ).toThrow(NoVideoStreamError);
  });

  it('should convert fractional frame rates such as 30000/1001', () => {
    const result = parseProbeOutput(
      JSON.stringify({
        streams: [{ ...videoStream, avg_frame_rate: '30000/1001' }],
        format,
      }),
    );

    expect(result.metadata.video?.fps).toBe(29.97);
  });

  it('should leave fps null for an unknown 0/0 frame rate', () => {
    const result = parseProbeOutput(
      JSON.stringify({
        streams: [
          { ...videoStream, avg_frame_rate: '0/0', r_frame_rate: undefined },
        ],
        format,
      }),
    );

    expect(result.metadata.video?.fps).toBeNull();
  });
});
