import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors';
import {
  ChannelNotFoundException,
  InvalidPartNumberException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotDraftException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from '../queue/video-processing.queue';
import { originalKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  defaultTitle,
  PART_SIZE_BYTES,
  PART_URL_TTL_SECONDS,
  partCount,
  PLAYBACK_URL_TTL_SECONDS,
} from './upload-policy';
import { generateVideoSlug } from './video-slug.util';
import type {
  CompletedUpload,
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
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoProcessingQueue: Queue<ProcessVideoJobData>,
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
   * Completes the multipart upload server-side and triggers processing
   * (phase-03-videos/TD-07, TD-13). Parts are listed from the storage — client
   * ETags are never trusted — and must cover 1..partCount with sizes summing
   * to the declared size.
   */
  async completeUpload(
    userId: string,
    videoId: string,
  ): Promise<CompletedUpload> {
    const video = await this.findOwnedDraft(userId, videoId);
    const uploadId = video.upload_id!;
    const parts = await this.storageService.listParts(
      video.storage_key,
      uploadId,
    );

    const stored = new Set(parts.map((part) => part.partNumber));
    for (let n = 1; n <= partCount(video.size_bytes); n++) {
      if (!stored.has(n)) {
        throw new UploadIncompleteException();
      }
    }
    const storedBytes = parts.reduce((sum, part) => sum + part.sizeBytes, 0);
    if (storedBytes !== video.size_bytes) {
      throw new UploadSizeMismatchException();
    }

    await this.storageService.completeMultipartUpload(
      video.storage_key,
      uploadId,
      parts,
    );

    // Conditional update: only one concurrent completion can move the row out of draft.
    const result = await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      { status: VideoStatus.PROCESSING, upload_id: null },
    );
    if (!result.affected) {
      throw new VideoNotDraftException();
    }

    try {
      await this.videoProcessingQueue.add(
        PROCESS_VIDEO_JOB,
        { videoId: video.id },
        { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: video.id },
      );
    } catch (err) {
      await this.videoRepository.update(
        { id: video.id },
        {
          status: VideoStatus.FAILED,
          failure_reason: `Failed to enqueue processing job: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      );
      throw err;
    }

    return { id: video.id, status: VideoStatus.PROCESSING };
  }

  /** Owner view of the lifecycle and processing result (validation AMB-3). */
  async getOwnedVideo(
    userId: string,
    videoId: string,
  ): Promise<VideoResponseDto> {
    const video = await this.findOwnedVideo(userId, videoId);
    const thumbnailUrl = video.thumbnail_key
      ? await this.storageService.presignGet(video.thumbnail_key, {
          audience: 'public',
          expiresInSeconds: PLAYBACK_URL_TTL_SECONDS,
        })
      : null;

    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      originalFilename: video.original_filename,
      contentType: video.content_type,
      sizeBytes: video.size_bytes,
      durationSeconds: video.duration_seconds,
      metadata: video.metadata,
      failureReason: video.failure_reason,
      thumbnailUrl,
      createdAt: video.created_at.toISOString(),
      updatedAt: video.updated_at.toISOString(),
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
