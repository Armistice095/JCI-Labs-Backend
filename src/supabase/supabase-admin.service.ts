import { Inject, Injectable, Logger } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ENV, Env } from '../config/env';
import { AppException, conflict } from '../common/errors';

/** Client Supabase avec la clé service : à n'utiliser que côté serveur. */
@Injectable()
export class SupabaseAdminService {
  private readonly log = new Logger(SupabaseAdminService.name);
  readonly client: SupabaseClient;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /** Crée le compte Supabase et envoie l'e-mail d'invitation (définition du mot de passe). */
  async inviteUser(email: string): Promise<string> {
    const { data, error } = await this.client.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${this.env.ADMIN_WEB_URL}/definir-mot-de-passe`,
    });
    if (error || !data.user) {
      if (error?.code === 'email_exists') throw conflict('Un compte existe déjà avec cette adresse e-mail.');
      this.log.error(`inviteUserByEmail: ${error?.message}`);
      throw new AppException('INTERNAL_ERROR', "Impossible de créer le compte d'accès.", 502);
    }
    return data.user.id;
  }

  async deleteUser(id: string): Promise<void> {
    const { error } = await this.client.auth.admin.deleteUser(id);
    if (error) this.log.error(`deleteUser(${id}): ${error.message}`);
  }

  /** Bannit ou rétablit un compte (invalide aussi le rafraîchissement des sessions). */
  async setBanned(id: string, banned: boolean): Promise<void> {
    const { error } = await this.client.auth.admin.updateUserById(id, { ban_duration: banned ? '876000h' : 'none' });
    if (error) throw new AppException('INTERNAL_ERROR', 'Impossible de mettre à jour le compte.', 502);
  }

  async sendPasswordReset(email: string): Promise<void> {
    const { error } = await this.client.auth.resetPasswordForEmail(email, {
      redirectTo: `${this.env.ADMIN_WEB_URL}/definir-mot-de-passe`,
    });
    if (error) throw new AppException('INTERNAL_ERROR', "Impossible d'envoyer l'e-mail de réinitialisation.", 502);
  }
}
