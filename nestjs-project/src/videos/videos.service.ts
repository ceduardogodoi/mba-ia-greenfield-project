import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors';
import {
  ChannelNotFoundException,
  InvalidPartNumberException,
  VideoNotDraftException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { originalKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  defaultTitle,
  PART_SIZE_BYTES,
  PART_URL_TTL_SECONDS,
  partCount,
} from './upload-policy';
import { generateVideoSlug } from './video-slug.util';
import type {
  InitiatedUpload,
  SignedUploadParts,
  UploadedPartsView,
} from './videos.types';

const MAX_SLUG_ATTEMPTS = 5;

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
  ) {}

  /**
   * Pre-registers the video as `draft` and opens the multipart upload
   * (phase-03-videos/TD-05, TD-10, TD-13). No video bytes reach the API.
   */
  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiatedUpload> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const id = randomUUID();
    const storageKey = originalKey(id);
    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.contentType,
    );

    const video = await this.saveWithUniqueSlug({
      id,
      channel_id: channel.id,
      title: dto.title ?? defaultTitle(dto.fileName),
      original_filename: dto.fileName,
      content_type: dto.contentType,
      size_bytes: dto.sizeBytes,
      status: VideoStatus.DRAFT,
      storage_key: storageKey,
      upload_id: uploadId,
    });

    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      upload: {
        partSize: PART_SIZE_BYTES,
        partCount: partCount(video.size_bytes),
      },
    };
  }

  /** Presigns UploadPart URLs on demand (phase-03-videos/TD-06). */
  async signUploadParts(
    userId: string,
    videoId: string,
    partNumbers: number[],
  ): Promise<SignedUploadParts> {
    const video = await this.findOwnedDraft(userId, videoId);
    const total = partCount(video.size_bytes);
    if (partNumbers.some((partNumber) => partNumber > total)) {
      throw new InvalidPartNumberException();
    }

    const expiresAt = new Date(Date.now() + PART_URL_TTL_SECONDS * 1000);
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storageService.presignUploadPart(
          video.storage_key,
          video.upload_id!,
          partNumber,
          PART_URL_TTL_SECONDS,
        ),
      })),
    );
    return { parts, expiresAt: expiresAt.toISOString() };
  }

  /** Lists stored parts so an interrupted upload can resume (phase-03-videos/TD-05). */
  async listUploadedParts(
    userId: string,
    videoId: string,
  ): Promise<UploadedPartsView> {
    const video = await this.findOwnedDraft(userId, videoId);
    const uploadedParts = await this.storageService.listParts(
      video.storage_key,
      video.upload_id!,
    );
    return {
      partSize: PART_SIZE_BYTES,
      partCount: partCount(video.size_bytes),
      uploadedParts,
    };
  }

  /**
   * Loads a video owned by the caller's channel (phase-03-videos/TD-12).
   * Videos of other channels are reported as not found so existence never leaks.
   */
  private async findOwnedVideo(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const channel = await this.channelsService.findByUserId(userId);
    const video = channel
      ? await this.videoRepository.findOne({
          where: { id: videoId, channel_id: channel.id },
        })
      : null;
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  /** Owned video whose multipart upload is still open (status `draft`, TD-13). */
  private async findOwnedDraft(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.findOwnedVideo(userId, videoId);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoNotDraftException();
    }
    return video;
  }

  private async saveWithUniqueSlug(
    fields: Omit<Partial<Video>, 'slug'>,
  ): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({ ...fields, slug: generateVideoSlug() }),
        );
      } catch (err) {
        if (
          attempt < MAX_SLUG_ATTEMPTS &&
          isPgUniqueViolationOnColumn(err, 'slug')
        ) {
          continue;
        }
        throw err;
      }
    }
  }
}
