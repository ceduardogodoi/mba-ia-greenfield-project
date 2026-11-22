import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

class VideoStreamMetadataDto {
  @ApiProperty({ type: String, nullable: true, example: 'h264' })
  codec: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 25 })
  fps: number | null;
}

class AudioStreamMetadataDto {
  @ApiProperty({ type: String, nullable: true, example: 'aac' })
  codec: string | null;
}

class VideoMetadataDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'mov,mp4,m4a,3gp,3g2,mj2',
  })
  formatName: string | null;

  @ApiProperty({ type: Number, nullable: true })
  bitRate: number | null;

  @ApiProperty({ type: Number, nullable: true })
  sizeBytes: number | null;

  @ApiProperty({ type: VideoStreamMetadataDto, nullable: true })
  video: VideoStreamMetadataDto | null;

  @ApiProperty({ type: AudioStreamMetadataDto, nullable: true })
  audio: AudioStreamMetadataDto | null;
}

/** Owner view of a video — `### API Contracts → GET /videos/{id}`. */
export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  slug: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoStatus, enumName: 'VideoStatus' })
  status: VideoStatus;

  @ApiProperty()
  originalFilename: string;

  @ApiProperty({ example: 'video/mp4' })
  contentType: string;

  @ApiProperty()
  sizeBytes: number;

  @ApiProperty({ type: Number, nullable: true })
  durationSeconds: number | null;

  @ApiProperty({ type: VideoMetadataDto, nullable: true })
  metadata: VideoMetadataDto | null;

  @ApiProperty({ type: String, nullable: true })
  failureReason: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Presigned GET URL of the thumbnail, valid for 1 hour',
  })
  thumbnailUrl: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: string;
}
