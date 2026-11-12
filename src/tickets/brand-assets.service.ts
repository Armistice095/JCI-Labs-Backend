import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENV, Env } from '../config/env';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

/** Les e-mails ne peuvent pas embarquer le logo (Gmail bloque les data-URI) : il est hébergé dans le bucket public des affiches. */
@Injectable()
export class BrandAssetsService implements OnApplicationBootstrap {
  private readonly log = new Logger(BrandAssetsService.name);
  constructor(private readonly supabase: SupabaseAdminService, @Inject(ENV) private readonly env: Env) {}

  get logoUrl(): string {
    return this.env.EMAIL_LOGO_URL ?? `${this.env.SUPABASE_URL}/storage/v1/object/public/${this.env.POSTER_BUCKET}/brand/logo.png`;
  }

  async onApplicationBootstrap() {
    if (this.env.PROCESS_ROLE === 'api' || this.env.EMAIL_LOGO_URL) return;
    try {
      const file = readFileSync(join(__dirname, '..', '..', 'assets', 'logo.png'));
      const { error } = await this.supabase.client.storage.from(this.env.POSTER_BUCKET).upload('brand/logo.png', file, { contentType: 'image/png', upsert: true, cacheControl: '86400' });
      if (error) this.log.warn(`Logo des e-mails non publié : ${error.message}`);
    } catch (e) {
      this.log.warn(`Logo des e-mails non publié : ${(e as Error).message}`);
    }
  }
}
