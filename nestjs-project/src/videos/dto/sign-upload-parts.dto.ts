import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MAX_PARTS_PER_SIGN_REQUEST } from '../upload-policy';

export class SignUploadPartsDto {
  @ApiProperty({
    type: [Number],
    example: [1, 2],
    minItems: 1,
    maxItems: MAX_PARTS_PER_SIGN_REQUEST,
    uniqueItems: true,
    description: 'Part numbers to sign (1-based, unique)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PARTS_PER_SIGN_REQUEST)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  partNumbers: number[];
}
