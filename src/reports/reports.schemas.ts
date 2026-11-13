import { z } from 'zod';

export const REPORT_KINDS = ['participants', 'ticketing', 'attendance', 'payments'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const reportKindParam = z.enum(REPORT_KINDS);

/** Au-delà, le PDF devient inutilisable (centaines de pages) et le rendu pèse sur le serveur : on demande d'affiner ou d'utiliser l'export Excel/CSV. */
export const MAX_REPORT_ROWS = 3000;
