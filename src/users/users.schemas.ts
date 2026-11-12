import { z } from 'zod';
import { normalizePhone } from '../common/phone';

const phone = z.string().trim().transform((v, ctx) => {
  const n = normalizePhone(v);
  if (!n) ctx.addIssue({ code: 'custom', message: 'Numéro de téléphone invalide.' });
  return n as string;
});

export const roleGrantInput = z.object({
  roleCode: z.enum(['ADMIN', 'PRESIDENT', 'ORGANIZER', 'SELLER', 'GATE_AGENT']),
  eventId: z.string().uuid().nullable().optional(),
});

export const userCreate = z.object({
  email: z.string().trim().toLowerCase().email(),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  phone: phone.optional(),
  roles: z.array(roleGrantInput).min(1).max(10),
});

export const userUpdate = z.object({
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  phone: phone.nullable().optional(),
});

export const userListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  q: z.string().trim().max(100).optional(),
});

export type RoleGrantInput = z.infer<typeof roleGrantInput>;
export type UserCreate = z.infer<typeof userCreate>;
