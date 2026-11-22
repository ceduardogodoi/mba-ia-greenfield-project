import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './video-processing/worker.module';

/** Entrypoint of the video worker: no HTTP server, only the queue consumer. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  Logger.log(
    'Video worker started — consuming the video-processing queue',
    'Worker',
  );
}
void bootstrap();
