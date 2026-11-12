import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { TicketingController } from './ticketing.controller';
import { TicketingService } from './ticketing.service';

@Module({ imports: [EventsModule], controllers: [TicketingController], providers: [TicketingService] })
export class TicketingModule {}
