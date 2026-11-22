import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { MediaProcessError, NoVideoStreamError } from '../media/media.errors';
import { MediaService } from '../media/media.service';
import {
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from '../queue/video-processing.queue';
import { thumbnailKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';

const INPUT_URL_TTL_SECONDS = 3600;
const THUMBNAIL_POSITION_RATIO = 0.1;

/**
 * Consumes `process-video` jobs in the video worker process (phase-03-videos/TD-08):
 * extracts duration/metadata and a thumbnail (TD-09) and records the outcome on the
 * video row — `ready`, or `failed` once retries are exhausted (TD-13).
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly mediaService: MediaService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video || video.status !== VideoStatus.PROCESSING) {
      // Redelivery of an already handled job, or a video removed meanwhile.
      this.logger.log(
        `Skipping job ${job.id}: video ${videoId} is ${video?.status ?? 'missing'}`,
      );
      return;
    }

    try {
      await this.processVideo(video);
    } catch (err) {
      const error = this.classify(err);
      await this.recordFailureIfTerminal(job, video.id, error);
      throw error;
    }
  }

  private async processVideo(video: Video): Promise<void> {
    const inputUrl = await this.storageService.presignGet(video.storage_key, {
      audience: 'internal',
      expiresInSeconds: INPUT_URL_TTL_SECONDS,
    });

    const { durationSeconds, metadata } =
      await this.mediaService.probe(inputUrl);
    const thumbnail = await this.mediaService.extractThumbnail(
      inputUrl,
      durationSeconds * THUMBNAIL_POSITION_RATIO,
    );
    const key = thumbnailKey(video.id);
    await this.storageService.putObject(key, thumbnail, 'image/jpeg');

    await this.videoRepository.update(
      { id: video.id, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        duration_seconds: durationSeconds,
        metadata,
        thumbnail_key: key,
      },
    );
    this.logger.log(`Video ${video.id} ready (${durationSeconds}s)`);
  }

  /** Unreadable media will never succeed on retry — fail fast. */
  private classify(err: unknown): unknown {
    if (err instanceof NoVideoStreamError) {
      return new UnrecoverableError(err.message);
    }
    if (err instanceof MediaProcessError && !err.isTransient) {
      return new UnrecoverableError(err.message);
    }
    return err;
  }

  private async recordFailureIfTerminal(
    job: Job<ProcessVideoJobData>,
    videoId: string,
    error: unknown,
  ): Promise<void> {
    const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (!(error instanceof UnrecoverableError) && !isLastAttempt) {
      this.logger.warn(
        `Video ${videoId} attempt ${job.attemptsMade + 1} failed; will retry: ${String(error)}`,
      );
      return;
    }
    const reason = error instanceof Error ? error.message : String(error);
    await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, failure_reason: reason },
    );
    this.logger.error(`Video ${videoId} failed: ${reason}`);
  }
}
