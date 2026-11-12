import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobsService, QUEUES } from '../jobs/jobs.service';
import { TicketEmailService } from './ticket-email.service';
import { TicketFilesService } from './ticket-files.service';

@Injectable()
export class TicketJobs implements OnModuleInit {
  private readonly log = new Logger(TicketJobs.name);
  constructor(private readonly jobs: JobsService, private readonly files: TicketFilesService, private readonly email: TicketEmailService) {}

  onModuleInit() {
    // Paiement confirmé (ou vente physique) → fichiers des billets, puis e-mail. Chaque étape est idempotente : le job peut être rejoué sans risque.
    this.jobs.register(QUEUES.ORDER_FULFILLED, async (data: { orderId: string }) => {
      const n = await this.files.ensureOrderFiles(data.orderId);
      const mail = await this.email.sendOrderConfirmation(data.orderId);
      if (n || mail === 'SENT') this.log.log(`Commande ${data.orderId} : ${n} fichier(s) généré(s), e-mail ${mail}`);
    });
    this.jobs.register(QUEUES.TICKET_RESEND, async (data: { ticketId: string; toEmail: string }) => {
      const t = await this.files.ensureTicketFiles(data.ticketId);
      const mail = await this.email.sendTicketCopy(data.ticketId, data.toEmail);
      this.log.log(`Renvoi du billet ${data.ticketId} : ${t.generated} fichier(s), e-mail ${mail}`);
    });
  }
}
