import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
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
import { SignUploadPartsDto } from './dto/sign-upload-parts.dto';
import { VideosService } from './videos.service';
import type {
  InitiatedUpload,
  SignedUploadParts,
  UploadedPartsView,
} from './videos.types';

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

  @Post(':id/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign upload part URLs',
    description:
      'Returns short-lived (1 hour) presigned URLs to PUT each requested part directly to the object storage. The client reads the ETag response header of each part upload.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    schema: {
      properties: {
        parts: {
          type: 'array',
          items: {
            properties: {
              partNumber: { type: 'integer' },
              url: { type: 'string', format: 'uri' },
            },
          },
        },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed, or a part number exceeds the part count (INVALID_PART_NUMBER)',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found (VIDEO_NOT_FOUND)',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Upload already completed (VIDEO_NOT_DRAFT)',
    schema: errorSchema,
  })
  async signUploadParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SignUploadPartsDto,
  ): Promise<SignedUploadParts> {
    return this.videosService.signUploadParts(user.sub, id, dto.partNumbers);
  }

  @Get(':id/upload/parts')
  @ApiOperation({
    summary: 'List uploaded parts',
    description:
      'Lists the parts already stored for the pending multipart upload, so an interrupted upload can resume by re-sending only the missing parts.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload progress',
    schema: {
      properties: {
        partSize: { type: 'integer' },
        partCount: { type: 'integer' },
        uploadedParts: {
          type: 'array',
          items: {
            properties: {
              partNumber: { type: 'integer' },
              sizeBytes: { type: 'integer' },
              etag: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid video id',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found (VIDEO_NOT_FOUND)',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Upload already completed (VIDEO_NOT_DRAFT)',
    schema: errorSchema,
  })
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UploadedPartsView> {
    return this.videosService.listUploadedParts(user.sub, id);
  }
}
