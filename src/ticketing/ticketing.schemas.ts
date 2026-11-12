import { z } from 'zod';

export const isoDateTime = z.string().datetime({ offset: true }).transform((s) => new Date(s));

export const ticketingSettings = z.object({
  salesOpensAt: isoDateTime.nullable().optional(),
  salesClosesAt: isoDateTime.nullable().optional(),
  maxPerOrder: z.number().int().min(1).max(10).optional(),
});

const categoryBase = z.object({
  name: z.string().trim().min(1).max(60),
  priceXof: z.number().int().min(1, 'Les billets gratuits ne sont pas proposés dans cette version.').max(10_000_000),
  quota: z.number().int().min(1).max(100_000),
  conditions: z.string().trim().max(300).nullable().optional(),
  saleStartsAt: isoDateTime.nullable().optional(),
  saleEndsAt: isoDateTime.nullable().optional(),
  maxPerOrder: z.number().int().min(1).max(10).nullable().optional(),
  isActive: z.boolean().optional(),
});

type Period = { saleStartsAt?: Date | null; saleEndsAt?: Date | null };
const period = (v: Period, ctx: z.RefinementCtx) => {
  if (v.saleStartsAt && v.saleEndsAt && v.saleEndsAt <= v.saleStartsAt) {
    ctx.addIssue({ code: 'custom', path: ['saleEndsAt'], message: 'La fin de vente doit être après le début.' });
  }
};

export const categoryCreate = categoryBase.superRefine(period);
export const categoryUpdate = categoryBase.partial().superRefine(period);

export type CategoryCreate = z.infer<typeof categoryCreate>;
export type CategoryUpdate = z.infer<typeof categoryUpdate>;
export type TicketingSettings = z.infer<typeof ticketingSettings>;
