/**
 * Textes généraux JCI de la page publique : affichés quand l'organisateur n'a rien rédigé pour son événement.
 * Texte validé par l'organisation. Les valeurs qui dépendent du système (durée de réservation, maximum de billets par commande, contact)
 * sont injectées pour que la page ne promette jamais autre chose que ce que fait réellement la billetterie.
 */
export interface DefaultTextsContext {
  /** Nombre maximal de billets par commande pour cet événement. */
  maxPerOrder: number;
  /** Durée pendant laquelle les places sont retenues pendant le paiement. */
  reservationMinutes: number;
  /** Un numéro WhatsApp est disponible (celui de l'événement, sinon celui de l'organisation). */
  hasContact: boolean;
  /** Au moins une catégorie de billet porte une condition (ex. justificatif étudiant). */
  hasCategoryConditions: boolean;
}

export interface FaqItem { question: string; answer: string }

export interface DefaultTexts {
  practicalInfo: string;
  ticketTerms: string;
  refundPolicy: string;
  faq: FaqItem[];
}

export function defaultPublicTexts(c: DefaultTextsContext): DefaultTexts {
  // Sans numéro WhatsApp, on n'invite pas à « écrire sur WhatsApp » : la page n'aurait pas de bouton pour le faire.
  const contactUs = c.hasContact ? 'contactez-nous sur WhatsApp' : 'contactez l’organisation';
  const writeUs = c.hasContact ? 'écrivez-nous sur WhatsApp' : 'contactez l’organisation';
  const askResend = c.hasContact ? 'demandez-nous de vous le renvoyer sur WhatsApp' : 'demandez à l’organisation de vous le renvoyer';

  const faq: FaqItem[] = [
    {
      question: 'Comment je reçois mon billet ?',
      answer: 'Dès le paiement confirmé, par e-mail (pensez à vérifier vos courriers indésirables). Vous pouvez aussi le retrouver à tout moment sur la page de confirmation de votre commande.',
    },
    {
      question: 'J’ai payé mais je n’ai pas reçu mon billet.',
      answer: `Attendez quelques minutes et vérifiez vos courriers indésirables. Sinon, retournez sur la page de votre commande, ou ${writeUs} avec votre numéro de commande.`,
    },
    {
      question: 'Combien de temps ai-je pour payer ?',
      answer: `Vos places sont réservées ${c.reservationMinutes} minutes. Passé ce délai, la réservation est annulée : recommencez simplement votre commande.`,
    },
    {
      question: 'Comment puis-je payer ?',
      answer: 'Par Mobile Money ou par carte bancaire, via la page de paiement sécurisée FedaPay.',
    },
    {
      question: 'Puis-je acheter plusieurs billets ?',
      answer: c.maxPerOrder > 1
        ? `Oui, jusqu’à ${c.maxPerOrder} par commande, avec le nom de chaque participant.`
        : 'Un seul billet par commande : passez une commande par participant.',
    },
    {
      question: 'Que se passe-t-il si je perds mon billet ?',
      answer: `Retrouvez-le sur la page de votre commande ou ${askResend}.`,
    },
  ];
  if (c.hasCategoryConditions) {
    faq.push({
      question: 'Certains billets demandent-ils un justificatif ?',
      answer: 'Oui : lorsqu’une catégorie de billet l’indique (par exemple le tarif étudiant), un justificatif vous sera demandé à l’entrée. Consultez la description du billet avant de commander.',
    });
  }

  return {
    practicalInfo:
      'Présentez-vous à l’entrée au moins 30 minutes avant le début, avec votre billet (QR code) sur téléphone ou imprimé. '
      + 'Pensez à charger votre téléphone et à régler la luminosité de l’écran au maximum pour faciliter le scan. '
      + `Les organisateurs vous orienteront sur place. Pour toute information sur l’accès ou le programme, ${contactUs}.`,
    ticketTerms:
      'Chaque billet est personnel, non transférable et ne peut être utilisé qu’une seule fois : le QR code est validé à l’entrée et un billet déjà scanné est refusé. '
      + 'Ne partagez pas votre QR code publiquement (réseaux sociaux, groupes) : toute personne qui le présente avant vous prend votre place. '
      + 'Le nom indiqué sur le billet peut être contrôlé à l’entrée. '
      + 'L’organisation se réserve le droit de refuser l’accès à toute personne dont le comportement compromet la sécurité ou le bon déroulement de l’événement.',
    refundPolicy:
      'Les billets achetés ne sont ni échangeables ni remboursables, sauf en cas d’annulation de l’événement par l’organisation '
      + 'ou si vos places n’ont pas pu être garanties après un paiement reçu : vous êtes alors remboursé, et l’organisation vous contacte. '
      + `En cas de report, votre billet reste valable pour la nouvelle date. Pour toute situation particulière, ${writeUs}.`,
    faq,
  };
}
