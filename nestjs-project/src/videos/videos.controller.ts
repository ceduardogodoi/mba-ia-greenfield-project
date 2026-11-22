import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { VideosService } from './videos.service';
import type { InitiatedUpload } from './videos.types';

const errorSchema = { $ref: getSchemaPath(ApiErrorEnvelope) };

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Pre-register a video and start its upload',
    description:
      'Creates the video as a draft with a unique slug and opens a multipart upload in the object storage. The file bytes are sent directly to the storage through presigned part URLs (see POST /videos/{id}/upload/parts); they never pass through the API.',
  })
  @ApiResponse({
    status: 201,
    description: 'Video pre-registered as draft; multipart upload started',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string', example: 'dQw4w9WgXcQ' },
        title: { type: 'string' },
        status: { type: 'string', enum: ['draft'] },
        upload: {
          type: 'object',
          properties: {
            partSize: { type: 'integer', example: 67108864 },
            partCount: { type: 'integer', example: 3 },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'The authenticated user has no channel (CHANNEL_NOT_FOUND)',
    schema: errorSchema,
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiatedUpload> {
    return this.videosService.initiateUpload(user.sub, dto);
  }
}
