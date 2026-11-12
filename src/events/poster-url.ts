import { Env } from '../config/env';

export const posterUrl = (env: Pick<Env, 'SUPABASE_URL' | 'POSTER_BUCKET'>, storagePath: string) =>
  `${env.SUPABASE_URL}/storage/v1/object/public/${env.POSTER_BUCKET}/${storagePath}`;
