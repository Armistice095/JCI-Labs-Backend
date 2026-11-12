import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { TicketsModule } from '../tickets/tickets.module';
import { AdminOrdersService } from './admin-orders.service';
import { FedaPayClient } from './fedapay.client';
import { FulfillmentService } from './fulfillment.service';
import { JobHandlers } from './job-handlers';
import { MaintenanceService } from './maintenance.service';
import { OrdersService } from './orders.service';
import { PaymentsService } from './payments.service';
import { PhysicalSalesService } from './physical-sales.service';
import { PublicEventsService } from './public-events.service';
import { AdminSalesController, PublicSalesController } from './sales.controllers';
import { SettingsService } from './settings.service';
import { TicketsService } from './tickets.service';
import { TurnstileService } from './turnstile.service';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [EventsModule, TicketsModule],
  controllers: [AdminSalesController, PublicSalesController, WebhooksController],
  providers: [
    FedaPayClient, FulfillmentService, PaymentsService, MaintenanceService, JobHandlers, OrdersService, AdminOrdersService,
    PhysicalSalesService, PublicEventsService, TicketsService, TurnstileService, SettingsService,
  ],
  exports: [PaymentsService, MaintenanceService],
})
export class SalesModule {}
