import { z } from 'zod';
import { categoryCreate, ticketingSettings } from '../ticketing/ticketing.schemas';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Heure invalide (HH:mm).');
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide (AAAA-MM-JJ).').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Date invalide.');

/** Texte facultatif de la page publique : une chaîne vide équivaut à « pas de texte » (la section n'est alors pas affichée). */
const publicText = z.string().trim().max(2000).nullable().transform((v) => (v ? v : null));

const eventBase = z.object({
  title: z.string().trim().min(3, 'Le titre doit faire au moins 3 caractères.').max(150),
  category: z.enum(['CONFERENCE', 'FORMATION', 'ATELIER', 'NETWORKING', 'GALA', 'AUTRE']),
  description: z.string().trim().max(5000),
  date: ymd,
  startTime: hhmm,
  endTime: hhmm,
  venueName: z.string().trim().max(150),
  city: z.string().trim().max(100),
  accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Couleur invalide (#RRGGBB).').nullable(),
  contactEmail: z.string().trim().email().nullable(),
  contactPhone: z.string().trim().max(30).nullable(),
  practicalInfo: publicText,
  ticketTerms: publicText,
  refundPolicy: publicText,
  programme: z.array(z.object({ time: hhmm, label: z.string().trim().min(1).max(200) })).max(30),
  organizers: z.array(z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(200).nullable().optional() })).max(10),
  ticketing: ticketingSettings,
});

export const eventUpdate = eventBase.partial();

export const eventCreate = eventBase.partial().extend({
  title: eventBase.shape.title,
  categories: z.array(categoryCreate).max(10).optional().superRefine((cats, ctx) => {
    const names = (cats ?? []).map((c) => c.name.toLowerCase());
    if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: 'Deux catégories portent le même nom.' });
  }),
  publish: z.boolean().default(false),
});

export const eventListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  status: z.enum(['DRAFT', 'PUBLISHED', 'CLOSED', 'CANCELLED']).optional(),
  sales: z.enum(['open', 'not_open', 'closed']).optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['startsAt', '-startsAt', 'createdAt', '-createdAt']).default('-startsAt'),
  upcoming: z.enum(['true', 'false']).optional(), // true = événements dont la date n'est pas passée
});

export const cancelBody = z.object({ reason: z.string().trim().min(3).max(500) });
export const posterPatch = z.object({ isCover: z.boolean().optional(), position: z.number().int().min(0).max(20).optional() });
export const posterQuery = z.object({ isCover: z.enum(['true', 'false']).optional() });

export type EventCreate = z.infer<typeof eventCreate>;
export type EventUpdate = z.infer<typeof eventUpdate>;
