import { z } from 'zod';

/** Période du graphique « Ventes » : 7 ou 30 derniers jours (aujourd'hui inclus). */
export const dashboardQuery = z.object({
  range: z.enum(['7', '30']).default('30').transform(Number),
});
export type DashboardQuery = z.infer<typeof dashboardQuery>;
