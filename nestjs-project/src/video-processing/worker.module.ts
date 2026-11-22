import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from '../config/database.config';
import { envValidationSchema } from '../config/env.validation';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { typeOrmOptionsFactory } from '../database/typeorm-options.factory';
import { MediaModule } from '../media/media.module';
import { bullRootOptionsFactory } from '../queue/bull-root-options.factory';
import { VIDEO_PROCESSING_QUEUE } from '../queue/video-processing.queue';
import { StorageModule } from '../storage/storage.module';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingProcessor } from './video-processing.processor';

/**
 * Root module of the standalone video worker process (phase-03-videos/TD-08).
 * The processor is registered only here, so the API never consumes jobs.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, storageConfig, queueConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      inject: [databaseConfig.KEY],
      useFactory: typeOrmOptionsFactory,
    }),
    // Channel and User are registered for relation metadata only (Video → Channel → User).
    TypeOrmModule.forFeature([Video, Channel, User]),
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: bullRootOptionsFactory,
    }),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    StorageModule,
    MediaModule,
  ],
  providers: [VideoProcessingProcessor],
})
export class WorkerModule {}
