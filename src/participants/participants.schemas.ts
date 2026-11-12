import { z } from 'zod';

export const PRESENCES = ['UPCOMING', 'PRESENT', 'CANCELLED'] as const;
export type Presence = (typeof PRESENCES)[number];

const filters = {
  q: z.string().trim().max(100).optional(),
  categoryId: z.string().uuid().optional(),
  /** À venir (billet valide, pas encore scanné) · Présent (scanné à l'entrée) · Annulé (billet annulé ou remboursé). */
  presence: z.enum(PRESENCES).optional(),
  sort: z.enum(['number', 'name', 'purchasedAt', 'category']).default('number'),
  dir: z.enum(['asc', 'desc']).default('asc'),
};

export const participantListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  ...filters,
});

export const participantExportQuery = z.object({
  format: z.enum(['csv', 'xlsx']).default('csv'),
  ...filters,
});

export type ParticipantListQuery = z.infer<typeof participantListQuery>;
export type ParticipantExportQuery = z.infer<typeof participantExportQuery>;
