import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import PgBoss from 'pg-boss';
import { ENV, Env } from '../config/env';

export const QUEUES = {
  RECONCILE: 'payment.reconcile',   // { paymentEventId?, transactionId }
  MAINTENANCE: 'maintenance.sweep', // planifiée chaque minute
  ORDER_FULFILLED: 'order.fulfilled', // { orderId } — génère les billets (PDF/PNG/visuel) puis envoie l'e-mail
  TICKET_RESEND: 'ticket.resend',     // { ticketId, toEmail } — renvoi manuel d'un billet
} as const;

type Handler = (data: any, meta: { retryCount: number; retryLimit: number }) => Promise<void>;

/**
 * File de tâches dans PostgreSQL (pg-boss). Sans Redis : un job survit au redémarrage et est rejoué en cas d'échec.
 * PROCESS_ROLE=api : enfile seulement ; worker/all : exécute aussi les tâches et le planificateur.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(JobsService.name);
  readonly boss: PgBoss;
  private readonly handlers = new Map<string, Handler>();
  private readonly runs: boolean;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.runs = env.PROCESS_ROLE !== 'api';
    this.boss = new PgBoss({
      connectionString: env.DIRECT_URL,
      schema: 'pgboss',
      max: 4,
      application_name: 'jci-labs-jobs',
      schedule: this.runs,
      supervise: this.runs,
    });
    this.boss.on('error', (e) => this.log.error(`pg-boss : ${e.message}`));
  }

  register(queue: string, handler: Handler) { this.handlers.set(queue, handler); }

  async onApplicationBootstrap() {
    await this.boss.start();
    const retry = { retryLimit: 8, retryDelay: 15, retryBackoff: true, expireInSeconds: 300, retentionDays: 14 };
    await this.boss.createQueue(QUEUES.RECONCILE, { name: QUEUES.RECONCILE, ...retry });
    await this.boss.createQueue(QUEUES.ORDER_FULFILLED, { name: QUEUES.ORDER_FULFILLED, ...retry, retryLimit: 10, expireInSeconds: 600 });
    await this.boss.createQueue(QUEUES.TICKET_RESEND, { name: QUEUES.TICKET_RESEND, ...retry, retryLimit: 6, expireInSeconds: 300 });
    await this.boss.createQueue(QUEUES.MAINTENANCE, { name: QUEUES.MAINTENANCE, retryLimit: 0, expireInSeconds: 120, retentionDays: 1 });

    if (!this.runs) return;
    for (const [queue, handler] of this.handlers) {
      await this.boss.work(queue, { pollingIntervalSeconds: this.env.JOBS_POLL_SECONDS, includeMetadata: true }, async (jobs: any[]) => {
        for (const job of jobs) await handler(job.data, { retryCount: job.retryCount ?? 0, retryLimit: job.retryLimit ?? 0 });
      });
    }
    await this.boss.schedule(QUEUES.MAINTENANCE, '* * * * *', {}, { singletonKey: 'maintenance' });
    this.log.log(`Workers actifs (${[...this.handlers.keys()].join(', ')})`);
  }

  async enqueue(queue: string, data: object, options: PgBoss.SendOptions = {}): Promise<void> {
    await this.boss.send(queue, data, options);
  }

  async onModuleDestroy() {
    await this.boss.stop({ graceful: true, timeout: 10_000 }).catch((e) => this.log.warn(`stop pg-boss : ${e.message}`));
  }
}
