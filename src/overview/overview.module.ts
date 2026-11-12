import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { OverviewController } from './overview.controller';
import { OverviewService } from './overview.service';

@Module({ imports: [EventsModule], controllers: [OverviewController], providers: [OverviewService] })
export class OverviewModule {}
