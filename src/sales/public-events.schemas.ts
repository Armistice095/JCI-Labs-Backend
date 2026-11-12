import { z } from 'zod';
import { pageQuery } from '../common/pagination';

/**
 * Liste publique des événements. `when` : à venir (par défaut, du plus proche au plus lointain), passés (du plus récent au plus ancien) ou tous.
 * Un événement est « à venir » tant qu'il n'est pas terminé (fin, sinon début, dans le futur).
 */
export const publicEventsQuery = pageQuery.extend({
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  when: z.enum(['upcoming', 'past', 'all']).default('upcoming'),
});
export type PublicEventsQuery = z.infer<typeof publicEventsQuery>;
