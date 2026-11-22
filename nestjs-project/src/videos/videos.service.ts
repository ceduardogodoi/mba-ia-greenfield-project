import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors';
import { ChannelNotFoundException } from '../common/exceptions/domain.exception';
import { originalKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { defaultTitle, PART_SIZE_BYTES, partCount } from './upload-policy';
import { generateVideoSlug } from './video-slug.util';
import type { InitiatedUpload } from './videos.types';

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
