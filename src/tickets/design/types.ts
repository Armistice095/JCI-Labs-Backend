export interface TicketRenderData {
  number: string;                 // JCI-2026-000001
  qrUrl: string;                  // URL encodée dans le QR (jeton aléatoire)
  holderFirstName: string;
  holderLastName: string;
  categoryName: string;
  priceXof: number;
  conditions: string | null;      // consigne d'accès (ex. « Justificatif demandé »)
  event: {
    title: string;
    category: string;             // CONFERENCE, GALA…
    startsAt: Date | null;
    venueName: string;
    city: string;
    accentColor: string | null;
    publicUrl: string | null;
  };
  /** Affiche de l'événement en data-URI (null = artwork généré aux couleurs de la JCI). */
  posterDataUri: string | null;
}

export const TICKET_W = 1122; // 297 mm à 96 dpi
export const TICKET_H = 376;  // ≈ 99,5 mm
