import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 128 bits aléatoires, encodés base64url (22 caractères) : jeton de QR code. */
export const newQrToken = () => randomBytes(16).toString('base64url');
/** 256 bits : jeton de suivi de commande côté acheteur. */
export const newAccessToken = () => randomBytes(32).toString('base64url');

/** Comparaison en temps constant de deux secrets de longueur quelconque. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export const sha256Hex = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
