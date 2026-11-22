import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelNotFoundException } from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

type Mocked<T, K extends keyof T> = {
  [P in K]: T[P] extends (...args: infer A) => infer R
    ? jest.Mock<R, A>
    : never;
};

function uniqueSlugViolation(): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error('duplicate'));
  Object.assign(err, {
    code: '23505',
    detail: 'Key (slug)=(abc) already exists.',
  });
  return err;
}

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: Mocked<Repository<Video>, 'create' | 'save'>;
  let channelsService: Mocked<ChannelsService, 'findByUserId'>;
  let storageService: Mocked<StorageService, 'createMultipartUpload'>;

  const channel = { id: 'channel-1' } as Channel;
  const dto = {
    fileName: 'aula.mp4',
    sizeBytes: 150000000,
    contentType: 'video/mp4',
  };

  beforeEach(async () => {
    videoRepository = {
      create: jest.fn((fields) => fields as Video),
      save: jest.fn((video) => Promise.resolve(video as Video)),
    };
    channelsService = {
      findByUserId: jest
        .fn<Promise<Channel | null>, [string]>()
        .mockResolvedValue(channel),
    };
    storageService = {
      createMultipartUpload: jest
        .fn<Promise<string>, [string, string]>()
        .mockResolvedValue('upload-1'),
    };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  describe('initiateUpload', () => {
    it('should throw CHANNEL_NOT_FOUND when the user has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(service.initiateUpload('user-1', dto)).rejects.toThrow(
        ChannelNotFoundException,
      );
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should open the multipart upload under the video original key and save a draft', async () => {
      const result = await service.initiateUpload('user-1', dto);

      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        `videos/${result.id}/original`,
        'video/mp4',
      );
      expect(videoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: result.id,
          channel_id: 'channel-1',
          status: VideoStatus.DRAFT,
          upload_id: 'upload-1',
          size_bytes: 150000000,
        }),
      );
      expect(result.upload).toEqual({ partSize: 67108864, partCount: 3 });
    });

    it('should default the title to the file name without extension', async () => {
      const result = await service.initiateUpload('user-1', dto);

      expect(result.title).toBe('aula');
    });

    it('should keep a provided title', async () => {
      const result = await service.initiateUpload('user-1', {
        ...dto,
        title: 'Custom',
      });

      expect(result.title).toBe('Custom');
    });

    it('should regenerate the slug after a unique violation on slug', async () => {
      videoRepository.save
        .mockRejectedValueOnce(uniqueSlugViolation())
        .mockImplementationOnce((video) => Promise.resolve(video as Video));

      const result = await service.initiateUpload('user-1', dto);

      expect(videoRepository.save).toHaveBeenCalledTimes(2);
      const firstSlug = (videoRepository.create.mock.calls[0][0] as Video).slug;
      expect(result.slug).not.toBe(firstSlug);
    });

    it('should give up after 5 slug collisions', async () => {
      videoRepository.save.mockRejectedValue(uniqueSlugViolation());

      await expect(
        service.initiateUpload('user-1', dto),
      ).rejects.toBeInstanceOf(QueryFailedError);
      expect(videoRepository.save).toHaveBeenCalledTimes(5);
    });

    it('should not retry on errors other than a slug violation', async () => {
      videoRepository.save.mockRejectedValue(new Error('db down'));

      await expect(service.initiateUpload('user-1', dto)).rejects.toThrow(
        'db down',
      );
      expect(videoRepository.save).toHaveBeenCalledTimes(1);
    });
  });
});
