import { EmailStatus, OrderStatus, PaymentMethod, TicketStatus } from '@prisma/client';
import { Presence } from './participants.schemas';

export type EmailDelivery = EmailStatus | 'NOT_REQUESTED' | 'NOT_SENT';

/** Présence à l'entrée, déduite du statut du billet. */
export function presenceOf(status: TicketStatus): Presence {
  if (status === 'USED') return 'PRESENT';
  if (status === 'VALID') return 'UPCOMING';
  return 'CANCELLED';
}

export const PRESENCE_FR: Record<Presence, string> = { UPCOMING: 'À venir', PRESENT: 'Présent', CANCELLED: 'Annulé' };

export const PAYMENT_STATUS_FR: Partial<Record<OrderStatus, string>> & Record<string, string> = {
  PAID: 'Payée', PENDING_PAYMENT: 'En attente', PAYMENT_IN_PROGRESS: 'En attente', FAILED: 'Échouée', EXPIRED: 'Expirée',
  CANCELLED: 'Annulée', REFUNDED: 'Remboursée', REFUND_REQUIRED: 'Remboursement à faire',
};

export const METHOD_FR: Record<PaymentMethod, string> = {
  MOBILE_MONEY_MTN: 'Mobile Money (MTN)', MOBILE_MONEY_MOOV: 'Mobile Money (Moov)', MOBILE_MONEY_OTHER: 'Mobile Money',
  CARD: 'Carte bancaire', CASH: 'Espèces', MOBILE_MONEY_DIRECT: 'Mobile Money direct', UNKNOWN: '—',
};

export const EMAIL_FR: Record<EmailDelivery, string> = {
  NOT_REQUESTED: 'Non demandé', NOT_SENT: 'Pas encore envoyé', QUEUED: 'En file', SENT: 'Envoyé', DELIVERED: 'Délivré', DEFERRED: 'Différé',
  SOFT_BOUNCE: 'Rebond temporaire', HARD_BOUNCE: 'Rebond définitif', BLOCKED: 'Bloqué', SPAM: 'Marqué spam', FAILED: 'Échec',
};
