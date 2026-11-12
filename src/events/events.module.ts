import { Module } from '@nestjs/common';
import { EventAccess } from './event-access.service';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { PostersService } from './posters.service';

@Module({
  controllers: [EventsController],
  providers: [EventsService, PostersService, EventAccess],
  exports: [EventAccess],
})
export class EventsModule {}
