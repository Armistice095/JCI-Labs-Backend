import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SUPABASE_JWT_SECRET: z.string().optional().transform((v) => v || undefined),
  POSTER_BUCKET: z.string().default('event-posters'),
  PUBLIC_WEB_URL: z.string().url(),
  // Numéro WhatsApp de l'organisation : repli du bouton « Écrire sur WhatsApp » quand l'événement n'a pas de numéro (format international, ex. +2290197000000)
  ORG_CONTACT_PHONE: z.string().trim().max(30).optional().transform((v) => v || undefined),
  ADMIN_WEB_URL: z.string().url(),
  CORS_ORIGINS: z.string().default(''),
  // File de tâches (pg-boss) : connexion DIRECTE ou pooler en mode session, jamais le pooler « transaction ».
  DIRECT_URL: z.string().min(1),
  PROCESS_ROLE: z.enum(['all', 'api', 'worker']).default('all'),
  JOBS_POLL_SECONDS: z.coerce.number().min(0.5).default(2),
  // FedaPay
  FEDAPAY_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
  FEDAPAY_API_BASE: z.string().url().optional().or(z.literal('').transform(() => undefined)), // pour les tests uniquement
  FEDAPAY_SECRET_KEY: z.string().min(10),
  FEDAPAY_WEBHOOK_SECRET: z.string().min(10),
  FEDAPAY_WEBHOOK_IPS: z.string().default(''),
  FEDAPAY_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  // Cloudflare Turnstile (anti-robots sur l'achat public)
  TURNSTILE_SECRET_KEY: z.string().optional().transform((v) => v || undefined),
  RATE_LIMIT_DISABLED: z.enum(['true', 'false']).default('false'), // tests uniquement
  // Billets : stockage, rendu, QR
  TICKETS_BUCKET: z.string().default('tickets'), // bucket PRIVÉ (URL signées)
  TICKET_QR_BASE_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)), // défaut : {PUBLIC_WEB_URL}/billet
  CHROMIUM_PATH: z.string().optional().transform((v) => v || undefined),
  CHROMIUM_HEADLESS_SHELL: z.enum(['true', 'false']).default('false'),
  CHROMIUM_LOW_MEMORY: z.enum(['true', 'false']).default('false'), // true sur un hébergement de 512 Mo (Render gratuit) : un seul processus Chromium, éteint au repos
  // E-mails (Brevo)
  BREVO_API_KEY: z.string().optional().transform((v) => v || undefined),
  BREVO_API_BASE: z.string().url().optional().or(z.literal('').transform(() => undefined)), // tests uniquement
  BREVO_SENDER_EMAIL: z.string().email().optional().or(z.literal('').transform(() => undefined)),
  BREVO_SENDER_NAME: z.string().default('JCI Comé Excellence'),
  BREVO_WEBHOOK_TOKEN: z.string().min(16).optional().or(z.literal('').transform(() => undefined)),
  BREVO_WEBHOOK_IPS: z.string().default(''),
  EMAIL_LOGO_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)), // défaut : logo hébergé dans le bucket public
}).superRefine((e, ctx) => {
  if (e.NODE_ENV === 'production') {
    for (const k of ['BREVO_API_KEY', 'BREVO_SENDER_EMAIL', 'BREVO_WEBHOOK_TOKEN'] as const) {
      if (!e[k]) ctx.addIssue({ code: 'custom', path: [k], message: 'Obligatoire en production.' });
    }
  }
  if (e.NODE_ENV === 'production' && !e.TURNSTILE_SECRET_KEY) {
    ctx.addIssue({ code: 'custom', path: ['TURNSTILE_SECRET_KEY'], message: 'Obligatoire en production.' });
  }
  const keyIsSandbox = /sandbox/i.test(e.FEDAPAY_SECRET_KEY);
  if (e.FEDAPAY_ENV === 'live' && keyIsSandbox) ctx.addIssue({ code: 'custom', path: ['FEDAPAY_SECRET_KEY'], message: 'Clé sandbox avec FEDAPAY_ENV=live.' });
  if (e.FEDAPAY_ENV === 'sandbox' && /live/i.test(e.FEDAPAY_SECRET_KEY) && !e.FEDAPAY_API_BASE) ctx.addIssue({ code: 'custom', path: ['FEDAPAY_SECRET_KEY'], message: 'Clé live avec FEDAPAY_ENV=sandbox.' });
});

export type Env = z.infer<typeof schema>;
export const ENV = Symbol('ENV');

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Configuration invalide :\n${lines.join('\n')}`);
  }
  return parsed.data;
}
