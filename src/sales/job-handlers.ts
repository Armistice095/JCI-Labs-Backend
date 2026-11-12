import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobsService, QUEUES } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { MaintenanceService } from './maintenance.service';
import { PaymentsService } from './payments.service';

@Injectable()
export class JobHandlers implements OnModuleInit {
  private readonly log = new Logger(JobHandlers.name);
  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly maintenance: MaintenanceService,
  ) {}

  onModuleInit() {
    this.jobs.register(QUEUES.RECONCILE, async (data: { paymentEventId?: string; transactionId: string }) => {
      try {
        const r = await this.payments.reconcileByTransactionId(data.transactionId);
        await this.markEvent(data.paymentEventId, r.outcome === 'UNKNOWN_TRANSACTION' ? 'UNKNOWN_TRANSACTION' : null);
      } catch (e) {
        // Erreur transitoire (FedaPay injoignable, base indisponible…) : on laisse pg-boss réessayer avec attente croissante.
        await this.markEvent(data.paymentEventId, (e as Error).message.slice(0, 300), false);
        throw e;
      }
    });
    this.jobs.register(QUEUES.MAINTENANCE, async () => { await this.maintenance.run(); });
    // order.fulfilled : consommé à l'étape 5. En attendant, le job reste en file (rétention 14 jours) et ne se perd pas.
  }

  private async markEvent(id: string | undefined, error: string | null, done = true) {
    if (!id) return;
    await this.prisma.paymentEvent.update({ where: { id }, data: { processedAt: done ? new Date() : null, processingError: error } }).catch((e) => this.log.warn(e.message));
  }
}
