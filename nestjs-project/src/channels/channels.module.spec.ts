import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { User } from '../users/entities/user.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import { Channel } from './entities/channel.entity';
import { ChannelsModule } from './channels.module';
import { ChannelsService } from './channels.service';
import { Video } from '../videos/entities/video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('ChannelsModule', () => {
  it('should compile with TypeOrmModule.forFeature([Channel]) and ChannelsService', async () => {
    const module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        ChannelsModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  }, 30000);

  it('should export ChannelsService to importing modules', async () => {
    @Module({ imports: [ChannelsModule] })
    class ConsumerModule {}

    const module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        ConsumerModule,
      ],
    }).compile();

    const service = module.select(ConsumerModule).get(ChannelsService);
    expect(typeof service.findByUserId).toBe('function');
    await module.close();
  }, 30000);
});
