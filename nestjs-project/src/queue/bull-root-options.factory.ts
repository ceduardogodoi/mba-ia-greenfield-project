import type { ConfigType } from '@nestjs/config';
import type { QueueOptions } from 'bullmq';
import queueConfig from '../config/queue.config';

/** BullMQ root connection, shared by the API producer and the video worker. */
export function bullRootOptionsFactory(
  queue: ConfigType<typeof queueConfig>,
): QueueOptions {
  return { connection: { host: queue.host, port: queue.port } };
}
