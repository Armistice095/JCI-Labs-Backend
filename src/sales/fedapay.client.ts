import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, Env } from '../config/env';

export class FedaPayError extends Error {
  constructor(message: string, public readonly status?: number, public readonly retryable = false) { super(message); }
}

export interface FedaTransaction {
  id: number;
  reference: string | null;
  status: string;
  amount: number;
  mode: string | null;
  paidAt: string | null;
  metadata: Record<string, unknown> | null;
}

export interface CreateTransactionInput {
  amountXof: number;
  description: string;
  callbackUrl: string;
  customer: { firstname: string; lastname: string; email: string; phoneLocal?: string | null };
  metadata: Record<string, string>;
}

const BASES = { sandbox: 'https://sandbox-api.fedapay.com', live: 'https://api.fedapay.com' } as const;
const TIMEOUT_MS = 15_000;

/**
 * Client minimal de l'API FedaPay (doc : docs.fedapay.com, « Create a transaction », « Generate token »).
 *  POST /v1/transactions            → { "v1/transaction": { id, reference, status, amount, … } }
 *  POST /v1/transactions/{id}/token → { token, url }   (url = page de paiement hébergée)
 *  GET  /v1/transactions/{id}       → { "v1/transaction": { … } }
 * Authentification : Authorization: Bearer <clé secrète>. La clé ne sort jamais du serveur et n'est jamais journalisée.
 */
@Injectable()
export class FedaPayClient {
  private readonly log = new Logger(FedaPayClient.name);
  private readonly base: string;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.base = (env.FEDAPAY_API_BASE ?? BASES[env.FEDAPAY_ENV]).replace(/\/+$/, '');
  }

  async createTransaction(i: CreateTransactionInput): Promise<{ id: number; reference: string | null; status: string }> {
    const body = {
      description: i.description.slice(0, 250),
      amount: i.amountXof,
      currency: { iso: 'XOF' },
      callback_url: i.callbackUrl,
      custom_metadata: i.metadata,
      customer: {
        firstname: i.customer.firstname,
        lastname: i.customer.lastname,
        email: i.customer.email,
        ...(i.customer.phoneLocal ? { phone_number: { number: i.customer.phoneLocal, country: 'bj' } } : {}),
      },
    };
    // Pas de nouvelle tentative automatique sur une création : on préfère échouer proprement qu'en créer deux.
    const data = await this.request('POST', '/v1/transactions', body, 0);
    const t = this.unwrap(data, 'v1/transaction');
    const id = Number(t.id);
    if (!Number.isInteger(id)) throw new FedaPayError('Réponse FedaPay inattendue (id de transaction manquant).');
    return { id, reference: t.reference != null ? String(t.reference) : null, status: String(t.status ?? 'pending') };
  }

  async generateToken(transactionId: number | string): Promise<{ token: string; url: string }> {
    const data = await this.request('POST', `/v1/transactions/${encodeURIComponent(String(transactionId))}/token`, undefined, 0);
    const token = data.token; const url = data.url;
    if (typeof token !== 'string' || typeof url !== 'string' || !/^https:\/\//.test(url) && !this.env.FEDAPAY_API_BASE) {
      throw new FedaPayError('Réponse FedaPay inattendue (jeton ou lien de paiement manquant).');
    }
    return { token, url };
  }

  /** Source de vérité du statut d'un paiement : on ne se fie ni au navigateur ni au contenu du webhook. */
  async getTransaction(transactionId: number | string): Promise<FedaTransaction> {
    const data = await this.request('GET', `/v1/transactions/${encodeURIComponent(String(transactionId))}`, undefined, 2);
    const t = this.unwrap(data, 'v1/transaction');
    const amount = Number(t.amount);
    if (!Number.isFinite(amount)) throw new FedaPayError('Réponse FedaPay inattendue (montant manquant).');
    const meta = (t.custom_metadata ?? t.metadata) as unknown;
    return {
      id: Number(t.id),
      reference: t.reference != null ? String(t.reference) : null,
      status: String(t.status ?? ''),
      amount,
      mode: t.mode != null ? String(t.mode) : null,
      paidAt: t.paid_at != null ? String(t.paid_at) : null,
      metadata: meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : null,
    };
  }

  private unwrap(data: Record<string, any>, key: string): Record<string, any> {
    const inner = data?.[key];
    return inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : data;
  }

  private async request(method: 'GET' | 'POST', path: string, body: unknown, retries: number): Promise<Record<string, any>> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${this.base}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.env.FEDAPAY_SECRET_KEY}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const text = await res.text();
        if (!res.ok) {
          const retryable = res.status >= 500 || res.status === 429;
          // Le détail renvoyé par FedaPay (ex. « account not activated ») n'est écrit que dans les journaux, jamais renvoyé au client.
          const detail = text.replace(/\s+/g, ' ').slice(0, 300);
          throw new FedaPayError(`FedaPay ${method} ${path} → HTTP ${res.status}${detail ? ` : ${detail}` : ''}`, res.status, retryable);
        }
        try { return text ? JSON.parse(text) : {}; } catch { throw new FedaPayError('Réponse FedaPay illisible.'); }
      } catch (e) {
        const err = e instanceof FedaPayError ? e : new FedaPayError(`FedaPay injoignable (${(e as Error).name})`, undefined, true);
        if (err.retryable && attempt < retries) { await new Promise((r) => setTimeout(r, 300 * 2 ** attempt)); continue; }
        this.log.warn(`${method} ${path} échec : ${err.message}`);
        throw err;
      }
    }
  }
}

/** Numéro local sans indicatif pays (+229) : « +2290195789513 » → « 0195789513 ». À valider en sandbox (voir scripts/fedapay-sandbox-check.ts). */
export function toFedaPayLocalPhone(e164: string | null | undefined): string | null {
  if (!e164) return null;
  return e164.startsWith('+229') ? e164.slice(4) : null;
}
