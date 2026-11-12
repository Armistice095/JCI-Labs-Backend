import { computeAvailability, computeSalesStatus, SalesWindow } from './sales-status';

const d = (s: string) => new Date(s);
const base: SalesWindow = { status: 'PUBLISHED', salesOpensAt: d('2026-10-01T07:00:00Z'), salesClosesAt: d('2026-11-27T17:00:00Z'), salesManuallyClosed: false };

describe('computeSalesStatus', () => {
  it('brouillon : null', () => expect(computeSalesStatus({ ...base, status: 'DRAFT' })).toBeNull());
  it('avant ouverture : NOT_OPEN', () => expect(computeSalesStatus(base, d('2026-09-30T00:00:00Z'))).toBe('NOT_OPEN'));
  it('ouverture non définie : NOT_OPEN', () => expect(computeSalesStatus({ ...base, salesOpensAt: null }, d('2026-10-15T00:00:00Z'))).toBe('NOT_OPEN'));
  it('pendant la fenêtre : OPEN', () => expect(computeSalesStatus(base, d('2026-10-15T00:00:00Z'))).toBe('OPEN'));
  it('après la clôture : CLOSED', () => expect(computeSalesStatus(base, d('2026-11-27T17:00:00Z'))).toBe('CLOSED'));
  it('fermeture manuelle : CLOSED', () => expect(computeSalesStatus({ ...base, salesManuallyClosed: true }, d('2026-10-15T00:00:00Z'))).toBe('CLOSED'));
  it('événement clôturé ou annulé : CLOSED', () => {
    expect(computeSalesStatus({ ...base, status: 'CLOSED' })).toBe('CLOSED');
    expect(computeSalesStatus({ ...base, status: 'CANCELLED' })).toBe('CLOSED');
  });
});

describe('computeAvailability', () => {
  const cat = { isActive: true, quota: 10, soldCount: 4, reservedCount: 2, saleStartsAt: null, saleEndsAt: null };
  const now = d('2026-10-15T00:00:00Z');
  it('disponible', () => expect(computeAvailability(cat, base, now)).toBe('AVAILABLE'));
  it('les réservations comptent dans le stock', () => expect(computeAvailability({ ...cat, soldCount: 5, reservedCount: 5 }, base, now)).toBe('SOLD_OUT'));
  it('désactivée', () => expect(computeAvailability({ ...cat, isActive: false }, base, now)).toBe('DISABLED'));
  it("période propre à la catégorie prioritaire sur l'événement", () => {
    expect(computeAvailability({ ...cat, saleStartsAt: d('2026-11-01T00:00:00Z') }, base, now)).toBe('NOT_STARTED');
    expect(computeAvailability({ ...cat, saleEndsAt: d('2026-10-10T00:00:00Z') }, base, now)).toBe('ENDED');
  });
});
