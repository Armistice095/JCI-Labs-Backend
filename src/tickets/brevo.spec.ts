import { mapBrevoEvent, normalizeMessageId, shouldApply } from './brevo-events';
import { buildTicketEmail, TicketEmailInput } from './email-template';

describe('événements Brevo', () => {
  it.each([
    ['request', 'SENT'], ['delivered', 'DELIVERED'], ['soft_bounce', 'SOFT_BOUNCE'], ['softBounce', 'SOFT_BOUNCE'], ['hard_bounce', 'HARD_BOUNCE'],
    ['hardBounce', 'HARD_BOUNCE'], ['invalid_email', 'HARD_BOUNCE'], ['invalid', 'HARD_BOUNCE'], ['blocked', 'BLOCKED'], ['spam', 'SPAM'], ['deferred', 'DEFERRED'], ['error', 'FAILED'],
  ])('%s → %s', (raw, expected) => expect(mapBrevoEvent(raw)).toBe(expected));
  it.each(['opened', 'unique_opened', 'click', 'unsubscribed', '', undefined, 'n’importe quoi'])('%s est ignoré', (raw) => expect(mapBrevoEvent(raw)).toBeNull());
  it('un statut ne recule jamais (webhooks dans le désordre)', () => {
    expect(shouldApply('DELIVERED', 'SENT')).toBe(false);
    expect(shouldApply('HARD_BOUNCE', 'DELIVERED')).toBe(false);
    expect(shouldApply('SENT', 'DELIVERED')).toBe(true);
    expect(shouldApply('SENT', 'HARD_BOUNCE')).toBe(true);
    expect(shouldApply('QUEUED', 'SENT')).toBe(true);
  });
  it('message-id sans chevrons', () => { expect(normalizeMessageId('<202612@smtp-relay.mailin.fr>')).toBe('202612@smtp-relay.mailin.fr'); expect(normalizeMessageId(' abc ')).toBe('abc'); });
});

const input: TicketEmailInput = {
  kind: 'CONFIRMATION', buyerFirstName: 'Koffi', reference: 'CMD-0012',
  event: { title: 'Leadership & Impact', startsAt: new Date('2026-11-28T07:00:00Z'), venueName: 'Centre des Congrès', city: 'Comé', contactEmail: 'contact@jci.bj', contactPhone: '+229 01 95 78 95 13' },
  tickets: [{ holderName: 'Koffi Ahoussou', categoryName: 'Standard', number: 'JCI-2026-000001' }, { holderName: 'Aïcha Hounkpatin', categoryName: 'VIP', number: 'JCI-2026-000002' }],
  orderUrl: 'https://jcicomee.com/commande/CMD-0012?token=abc&x=1', logoUrl: 'https://cdn.test/logo.png', pdfAttached: true, shareAttached: true,
};

describe('e-mail de confirmation', () => {
  const m = buildTicketEmail(input);
  it('objet adapté au nombre de billets', () => {
    expect(m.subject).toBe('Vos 2 billets — Leadership & Impact');
    expect(buildTicketEmail({ ...input, tickets: [input.tickets[0]] }).subject).toBe('Votre billet — Leadership & Impact');
  });
  it('contenu : événement, billets, bouton, consignes, contact', () => {
    for (const t of ['Bonjour Koffi', 'CMD-0012', 'Vendredi'.slice(0, 0), '28 Novembre 2026 à 08 h 00', 'Centre des Congrès, Comé', 'JCI-2026-000001', 'JCI-2026-000002', 'Aïcha Hounkpatin', 'Voir et télécharger mes billets', 'personnel', 'une seule fois', 'contact@jci.bj', 'J’y serai'])
      expect(m.html).toContain(t);
  });
  it('lien de suivi correctement échappé', () => expect(m.html).toContain('token=abc&amp;x=1'));
  it('responsive : tableau MJML compilé, aucun balisage MJML résiduel', () => { expect(m.html).toContain('<table'); expect(m.html).not.toMatch(/<mj-/); });
  it('échappe les valeurs saisies par des tiers', () => {
    const evil = buildTicketEmail({ ...input, buyerFirstName: '<img src=x onerror=1>', tickets: [{ holderName: '<script>alert(1)</script>', categoryName: '<b>x</b>', number: 'N' }], event: { ...input.event, title: '</mj-text><script>x</script>' } });
    expect(evil.html).not.toMatch(/<script>/i);
    expect(evil.html).not.toMatch(/<img src=x/i);
  });
  it('sans pièce jointe : renvoie vers le bouton', () => expect(buildTicketEmail({ ...input, pdfAttached: false, shareAttached: false }).html).toContain('Téléchargez vos billets depuis le bouton'));
  it('renvoi manuel : texte adapté, sans numéro de commande', () => {
    const r = buildTicketEmail({ ...input, kind: 'RESEND', reference: null, tickets: [input.tickets[0]] });
    expect(r.html).toContain('Voici votre billet');
    expect(r.html).not.toContain('commande <b>CMD-0012');
  });
  it('vente physique : pas de bouton sans lien de suivi', () => expect(buildTicketEmail({ ...input, orderUrl: null }).html).not.toContain('Voir et télécharger'));
});
