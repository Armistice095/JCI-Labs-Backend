import { PaymentMethod } from '@prisma/client';

export type StatusKind = 'PAID' | 'PARTIAL_REFUND' | 'REFUNDED' | 'FAILED' | 'PENDING';

/**
 * Statuts de transaction FedaPay (SDK officiel : PAID_STATUS = approved, transferred, refunded,
 * approved_partially_refunded, transferred_partially_refunded ; événements transaction.declined / canceled).
 * Tout statut inconnu est traité comme « en attente » : on ne délivre jamais un billet sur un statut non reconnu.
 */
export function classifyStatus(status: string | null | undefined): StatusKind {
  const s = (status ?? '').toLowerCase();
  if (s === 'approved' || s === 'transferred') return 'PAID';
  if (s === 'approved_partially_refunded' || s === 'transferred_partially_refunded') return 'PARTIAL_REFUND';
  if (s === 'refunded') return 'REFUNDED';
  if (s === 'declined' || s === 'canceled' || s === 'cancelled') return 'FAILED';
  return 'PENDING';
}

/** `mode` FedaPay (ex. mtn, moov, mtn_open, moov_tg, card…) → moyen de paiement affiché dans l'admin. */
export function mapMethod(mode: string | null | undefined): PaymentMethod {
  const m = (mode ?? '').toLowerCase();
  if (!m) return 'UNKNOWN';
  if (m.includes('mtn')) return 'MOBILE_MONEY_MTN';
  if (m.includes('moov')) return 'MOBILE_MONEY_MOOV';
  if (m.includes('card') || m.includes('visa') || m.includes('master') || m.includes('stripe')) return 'CARD';
  return 'MOBILE_MONEY_OTHER';
}
