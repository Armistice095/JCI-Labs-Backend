import { defaultPublicTexts } from './default-public-texts';

const base = { maxPerOrder: 5, reservationMinutes: 15, hasContact: true, hasCategoryConditions: false };

describe('Textes JCI par défaut de la page publique', () => {
  it('fournit les trois sections et la FAQ', () => {
    const t = defaultPublicTexts(base);
    expect(t.practicalInfo).toContain('30 minutes avant le début');
    expect(t.ticketTerms).toContain('personnel, non transférable');
    expect(t.refundPolicy).toContain('ni échangeables ni remboursables');
    expect(t.faq.map((f) => f.question)).toHaveLength(6);
    expect(t.faq.every((f) => f.question.trim() && f.answer.trim())).toBe(true);
  });

  it('reprend les vraies valeurs du système (durée de réservation, maximum par commande)', () => {
    const faq = (c: object) => Object.fromEntries(defaultPublicTexts({ ...base, ...c }).faq.map((f) => [f.question, f.answer]));
    expect(faq({ reservationMinutes: 20 })['Combien de temps ai-je pour payer ?']).toContain('réservées 20 minutes');
    expect(faq({ maxPerOrder: 3 })['Puis-je acheter plusieurs billets ?']).toBe('Oui, jusqu’à 3 par commande, avec le nom de chaque participant.');
    expect(faq({ maxPerOrder: 1 })['Puis-je acheter plusieurs billets ?']).toContain('Un seul billet par commande');
  });

  it('n’invite à écrire sur WhatsApp que si un numéro est disponible', () => {
    const withContact = JSON.stringify(defaultPublicTexts(base));
    const without = JSON.stringify(defaultPublicTexts({ ...base, hasContact: false }));
    expect(withContact).toContain('sur WhatsApp');
    expect(without).not.toContain('WhatsApp');
    expect(without).toContain('contactez l’organisation');
  });

  it('n’ajoute la question sur le justificatif que si une catégorie a une condition', () => {
    expect(defaultPublicTexts(base).faq.some((f) => f.question.includes('justificatif'))).toBe(false);
    const t = defaultPublicTexts({ ...base, hasCategoryConditions: true });
    expect(t.faq).toHaveLength(7);
    expect(t.faq[6].question).toContain('justificatif');
  });
});
