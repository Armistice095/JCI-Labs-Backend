import { checkContract } from '../../test/contract';

/** Le vérificateur de contrat doit DÉTECTER les écarts, sinon il ne protège rien. */
const ok = { id: '11111111-1111-4111-8111-111111111111', email: 'a@b.bj', firstName: 'A', lastName: 'B', roles: [{ id: '22222222-2222-4222-8222-222222222222', roleCode: 'ADMIN', eventId: null }], permissions: ['event.read'], eventPermissions: {} };
const run = (body: object, status = 200, method = 'GET', url = '/api/v1/me') => () => checkContract(method, url, status, JSON.stringify(body));

describe('vérificateur de contrat', () => {
  it('accepte une réponse conforme', () => expect(run(ok)).not.toThrow());
  it('refuse un champ obligatoire manquant', () => { const { email, ...bad } = ok; expect(run(bad)).toThrow(/email/); });
  it('refuse un champ non documenté', () => expect(run({ ...ok, secret: 'x' })).toThrow(/champ non documenté/));
  it('refuse un champ non documenté dans un objet imbriqué', () => expect(run({ ...ok, roles: [{ ...ok.roles[0], extra: 1 }] })).toThrow(/champ non documenté/));
  it('refuse un mauvais type', () => expect(run({ ...ok, permissions: 'event.read' })).toThrow(/array|type/));
  it('refuse une valeur hors énumération', () => expect(run({ ...ok, roles: [{ ...ok.roles[0], roleCode: 'ROI' }] })).toThrow(/allowed|enum/));
  it('refuse un format invalide', () => expect(run({ ...ok, id: 'pas-un-uuid' })).toThrow(/format|uuid/));
  it('refuse un statut non documenté', () => expect(run({ code: 'NOT_FOUND', message: 'x' }, 418)).toThrow(/statut non documenté/));
  it('refuse une route non documentée', () => expect(run({}, 200, 'GET', '/api/v1/inconnu')).toThrow(/route non documentée/));
  it('valide aussi les erreurs', () => {
    expect(run({ code: 'NOT_FOUND', message: 'Introuvable.' }, 404, 'GET', '/api/v1/events/11111111-1111-4111-8111-111111111111')).not.toThrow();
    expect(run({ code: 'PAS_UN_CODE', message: 'x' }, 404, 'GET', '/api/v1/events/11111111-1111-4111-8111-111111111111')).toThrow();
  });
  it('une valeur nullable accepte null mais pas un autre type', () => {
    const detail = '/api/v1/public/tickets/abc';
    const t = { eventTitle: 'E', startsAt: null, venueName: 'V', category: 'C', holderShortName: 'K A.', status: 'VALID' };
    expect(run(t, 200, 'GET', detail)).not.toThrow();
    expect(run({ ...t, startsAt: 5 }, 200, 'GET', detail)).toThrow();
  });
});
