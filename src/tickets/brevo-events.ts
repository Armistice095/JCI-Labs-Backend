import { EmailStatus } from '@prisma/client';

/**
 * Événements des webhooks transactionnels Brevo (doc : « How to use webhooks »).
 * Noms vus dans les charges utiles : request, delivered, soft_bounce, hard_bounce, invalid_email, deferred, blocked, spam, error,
 * (+ opened, click, unsubscribed… que l'on ignore). On normalise (casse, séparateurs) car l'API les nomme aussi hardBounce, softBounce…
 */
export function mapBrevoEvent(raw: unknown): EmailStatus | null {
  const k = String(raw ?? '').toLowerCase().replace(/[^a-z]/g, '');
  switch (k) {
    case 'request': case 'sent': return 'SENT';
    case 'delivered': return 'DELIVERED';
    case 'deferred': return 'DEFERRED';
    case 'softbounce': return 'SOFT_BOUNCE';
    case 'hardbounce': case 'invalid': case 'invalidemail': return 'HARD_BOUNCE';
    case 'blocked': return 'BLOCKED';
    case 'spam': case 'complaint': return 'SPAM';
    case 'error': return 'FAILED';
    default: return null;
  }
}

const RANK: Record<EmailStatus, number> = { QUEUED: 0, FAILED: 0, SENT: 1, DEFERRED: 2, SOFT_BOUNCE: 3, DELIVERED: 4, BLOCKED: 5, SPAM: 5, HARD_BOUNCE: 6 };

/** Les webhooks peuvent arriver dans le désordre : un statut ne peut qu'« avancer » (ex. un `delivered` tardif n'efface pas un `hard_bounce`). */
export const shouldApply = (current: EmailStatus, next: EmailStatus) => RANK[next] >= RANK[current];

/** Brevo renvoie le message-id entre chevrons (« <2026…@smtp-relay.mailin.fr> ») : on stocke et compare sans chevrons. */
export const normalizeMessageId = (id: string) => id.trim().replace(/^<|>$/g, '');
