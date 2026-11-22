import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ALLOWED_VIDEO_CONTENT_TYPES,
  MAX_VIDEO_SIZE_BYTES,
} from '../upload-policy';

export class InitiateUploadDto {
  @ApiProperty({ example: 'aula.mp4', minLength: 1, maxLength: 255 })
  @IsString()
  @Length(1, 255)
  fileName: string;

  @ApiProperty({
    example: 150000000,
    minimum: 1,
    maximum: MAX_VIDEO_SIZE_BYTES,
    description: 'Declared file size in bytes (max 10 GiB)',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  sizeBytes: number;

  @ApiProperty({ enum: ALLOWED_VIDEO_CONTENT_TYPES, example: 'video/mp4' })
  @IsIn(ALLOWED_VIDEO_CONTENT_TYPES)
  contentType: string;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 255,
    description: 'Defaults to the file name without its extension',
  })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  title?: string;
}
