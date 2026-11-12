import { z } from 'zod';
import { normalizePhone } from '../common/phone';

const phone = z.string().trim().transform((v, ctx) => {
  const n = normalizePhone(v);
  if (!n) ctx.addIssue({ code: 'custom', message: 'Numéro de téléphone invalide.' });
  return n as string;
});
const name = z.string().trim().min(1, 'Obligatoire.').max(80);
const email = z.string().trim().toLowerCase().email('Adresse e-mail invalide.').max(200);

const holder = z.object({
  categoryId: z.string().uuid(),
  firstName: name,
  lastName: name,
  email: email.nullable().optional(),
  phone: phone.nullable().optional(),
});

export const publicOrderCreate = z.object({
  buyer: z.object({ firstName: name, lastName: name, email, phone }),
  tickets: z.array(holder).min(1).max(10),
  captchaToken: z.string().max(2048).optional(),
  acceptedTerms: z.literal(true, { errorMap: () => ({ message: 'Vous devez accepter les conditions.' }) }),
});

export const physicalSaleCreate = z.object({
  eventId: z.string().uuid(),
  buyer: z.object({ firstName: name, lastName: name, email: email.nullable().optional(), phone: phone.nullable().optional() }),
  tickets: z.array(holder).min(1).max(10),
  paymentMethod: z.enum(['CASH', 'MOBILE_MONEY_DIRECT']),
  paymentReference: z.string().trim().max(100).nullable().optional(),
  paymentReceivedConfirmed: z.literal(true, { errorMap: () => ({ message: 'Confirmez que le paiement a bien été reçu.' }) }),
  sendEmail: z.boolean().default(true),
});

export const orderListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  // PENDING = alias « En attente » : PENDING_PAYMENT + PAYMENT_IN_PROGRESS (un seul onglet dans l'interface)
  status: z.enum(['PENDING', 'PENDING_PAYMENT', 'PAYMENT_IN_PROGRESS', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED', 'REFUND_REQUIRED']).optional(),
  q: z.string().trim().max(100).optional(),
  eventId: z.string().uuid().optional(),
});

export const idempotencyKey = z.string().min(16, 'Idempotency-Key trop courte (16 caractères minimum).').max(80);
export const tokenQuery = z.object({ token: z.string().min(20).max(200) });
export const cancelTicketBody = z.object({ reason: z.string().trim().min(3).max(500) });

export type PublicOrderCreate = z.infer<typeof publicOrderCreate>;
export type PhysicalSaleCreate = z.infer<typeof physicalSaleCreate>;
export type OrderListQuery = z.infer<typeof orderListQuery>;
