import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import {
  ALLOWED_VIDEO_CONTENT_TYPES,
  MAX_VIDEO_SIZE_BYTES,
} from '../upload-policy';

export class InitiateUploadDto {
  @IsString()
  @Length(1, 255)
  fileName: string;

  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  sizeBytes: number;

  @IsIn(ALLOWED_VIDEO_CONTENT_TYPES)
  contentType: string;

  @IsOptional()
  @IsString()
  @Length(1, 255)
  title?: string;
}
