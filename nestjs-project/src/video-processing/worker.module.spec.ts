import { Test } from '@nestjs/testing';
import { VideoProcessingProcessor } from './video-processing.processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile the worker context with the video-processing processor', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessingProcessor)).toBeInstanceOf(
      VideoProcessingProcessor,
    );
    await module.close();
  }, 30000);
});
