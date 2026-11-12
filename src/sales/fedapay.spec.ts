import { computeSignature, parseSignatureHeader, verifyWebhookSignature } from './fedapay-signature';
import { classifyStatus, mapMethod } from './fedapay-status';
import { toFedaPayLocalPhone } from './fedapay.client';
import { safeEqual, newQrToken } from '../common/tokens';

const SECRET = 'wh_sandbox_test_secret';
const body = Buffer.from(JSON.stringify({ id: 7, name: 'transaction.approved', entity: { id: 123, amount: 6000 } }));
const header = (t: number, secret = SECRET, b = body) => `t=${t},s=${computeSignature(secret, t, b)}`;
const NOW = 1_800_000_000_000;
const check = (h: string | undefined, over: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {}) =>
  verifyWebhookSignature({ rawBody: body, header: h, secret: SECRET, toleranceSeconds: 300, nowMs: NOW, ...over });

describe('signature des webhooks FedaPay', () => {
  const t = NOW / 1000;
  it('accepte une signature valide', () => expect(check(header(t))).toEqual({ ok: true, timestamp: t }));
  it('refuse un mauvais secret', () => expect(check(header(t, 'autre_secret'))).toMatchObject({ ok: false, reason: 'MISMATCH' }));
  it('refuse un corps modifié', () => expect(check(header(t), { rawBody: Buffer.from(body.toString().replace('6000', '1')) })).toMatchObject({ ok: false, reason: 'MISMATCH' }));
  it('refuse un horodatage modifié (couvert par la signature)', () => expect(check(`t=${t + 1},s=${computeSignature(SECRET, t, body)}`)).toMatchObject({ ok: false, reason: 'MISMATCH' }));
  it('refuse un message trop ancien (rejeu)', () => expect(check(header(t - 301))).toMatchObject({ ok: false, reason: 'EXPIRED' }));
  it('refuse un message venu du futur', () => expect(check(header(t + 301))).toMatchObject({ ok: false, reason: 'EXPIRED' }));
  it('accepte à la limite de tolérance', () => expect(check(header(t - 300)).ok).toBe(true));
  it('en-tête absent ou mal formé', () => {
    expect(check(undefined)).toMatchObject({ reason: 'MISSING' });
    expect(check('garbage')).toMatchObject({ reason: 'MALFORMED' });
    expect(check(`t=${t}`)).toMatchObject({ reason: 'MALFORMED' });
    expect(check(`t=${t},s=zzzz`)).toMatchObject({ reason: 'MISMATCH' });
  });
  it('corps brut absent', () => expect(check(header(t), { rawBody: undefined })).toMatchObject({ reason: 'MISSING' }));
  it('plusieurs signatures : une valide suffit', () => expect(check(`t=${t},s=${'0'.repeat(64)},s=${computeSignature(SECRET, t, body)}`).ok).toBe(true));
  it('parse l’en-tête', () => expect(parseSignatureHeader('t=12, s=ab ,x=1')).toEqual({ timestamp: 12, signatures: ['ab'] }));
});

describe('statuts FedaPay', () => {
  it.each([
    ['approved', 'PAID'], ['transferred', 'PAID'], ['APPROVED', 'PAID'],
    ['approved_partially_refunded', 'PARTIAL_REFUND'], ['refunded', 'REFUNDED'],
    ['declined', 'FAILED'], ['canceled', 'FAILED'], ['pending', 'PENDING'],
    ['statut_inconnu', 'PENDING'], ['', 'PENDING'], [undefined, 'PENDING'],
  ])('%s → %s (jamais de billet sur un statut inconnu)', (s, k) => expect(classifyStatus(s as string)).toBe(k));
  it('moyen de paiement', () => {
    expect(mapMethod('mtn')).toBe('MOBILE_MONEY_MTN');
    expect(mapMethod('moov_tg')).toBe('MOBILE_MONEY_MOOV');
    expect(mapMethod('card')).toBe('CARD');
    expect(mapMethod('celtiis')).toBe('MOBILE_MONEY_OTHER');
    expect(mapMethod(null)).toBe('UNKNOWN');
  });
});

describe('utilitaires', () => {
  it('numéro local FedaPay', () => { expect(toFedaPayLocalPhone('+2290195789513')).toBe('0195789513'); expect(toFedaPayLocalPhone('+33612345678')).toBeNull(); });
  it('safeEqual', () => { expect(safeEqual('abc', 'abc')).toBe(true); expect(safeEqual('abc', 'abd')).toBe(false); expect(safeEqual('abc', 'abcd')).toBe(false); });
  it('jeton QR : 128 bits, unique', () => { const a = newQrToken(); expect(a).toHaveLength(22); expect(newQrToken()).not.toBe(a); });
});
