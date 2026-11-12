import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { BrandAssetsService } from './brand-assets.service';
import { BrevoClient } from './brevo.client';
import { BrevoWebhookController } from './brevo-webhook.controller';
import { RendererService } from './renderer.service';
import { TicketEmailService } from './ticket-email.service';
import { TicketFilesService } from './ticket-files.service';
import { TicketJobs } from './ticket-jobs';
import { TicketsController } from './tickets.controller';

@Module({
  imports: [EventsModule],
  controllers: [TicketsController, BrevoWebhookController],
  providers: [RendererService, BrandAssetsService, BrevoClient, TicketFilesService, TicketEmailService, TicketJobs],
  exports: [TicketFilesService],
})
export class TicketsModule {}
