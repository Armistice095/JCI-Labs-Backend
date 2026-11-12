import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Vérification des webhooks FedaPay.
 * Source : SDK officiel `fedapay` (src/Webhook.ts, WebhookSignature) :
 *   en-tête  X-FEDAPAY-SIGNATURE: t=<timestamp>,s=<hex>
 *   s = HMAC-SHA256(secret, "<timestamp>.<corps brut>") en hexadécimal ; tolérance par défaut 300 s.
 */
export function computeSignature(secret: string, timestamp: number | string, rawBody: Buffer | string): string {
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  return createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}

export function parseSignatureHeader(header: string | undefined): { timestamp: number | null; signatures: string[] } {
  const out: { timestamp: number | null; signatures: string[] } = { timestamp: null, signatures: [] };
  if (!header) return out;
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') { const n = Number.parseInt(v, 10); if (Number.isFinite(n)) out.timestamp = n; }
    if (k === 's' && v) out.signatures.push(v);
  }
  return out;
}

export type SignatureCheck = { ok: true; timestamp: number } | { ok: false; reason: 'MISSING' | 'MALFORMED' | 'MISMATCH' | 'EXPIRED' };

export function verifyWebhookSignature(p: {
  rawBody: Buffer | undefined;
  header: string | undefined;
  secret: string;
  toleranceSeconds: number;
  nowMs?: number;
}): SignatureCheck {
  if (!p.header || !p.rawBody) return { ok: false, reason: 'MISSING' };
  const { timestamp, signatures } = parseSignatureHeader(p.header);
  if (timestamp === null || signatures.length === 0) return { ok: false, reason: 'MALFORMED' };

  const expected = Buffer.from(computeSignature(p.secret, timestamp, p.rawBody), 'hex');
  const match = signatures.some((s) => {
    if (!/^[0-9a-fA-F]+$/.test(s)) return false;
    const given = Buffer.from(s, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!match) return { ok: false, reason: 'MISMATCH' };

  // Anti-rejeu : l'horodatage est couvert par la signature, on refuse les messages trop vieux (ou venus du futur).
  const ageSeconds = Math.floor((p.nowMs ?? Date.now()) / 1000) - timestamp;
  if (Math.abs(ageSeconds) > p.toleranceSeconds) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, timestamp };
}
