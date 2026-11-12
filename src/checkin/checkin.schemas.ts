import { z } from 'zod';

/**
 * Un scan porte soit le jeton lu dans le QR code, soit le numéro saisi à la main (billet abîmé).
 * Le jeton n'est volontairement pas validé plus finement : un QR étranger doit donner « BILLET INCONNU », pas une erreur 422.
 */
export const scanBody = z.object({
  eventId: z.string().uuid(),
  qrToken: z.string().trim().min(1).max(200).optional(),
  ticketNumber: z.string().trim().toUpperCase().min(1).max(40).optional(),
  deviceId: z.string().trim().max(100).optional(),
  appVersion: z.string().trim().max(30).optional(),
}).refine((b) => (b.qrToken === undefined) !== (b.ticketNumber === undefined), {
  message: 'Fournissez soit qrToken, soit ticketNumber (un seul des deux).',
  path: ['qrToken'],
});
export type ScanBody = z.infer<typeof scanBody>;
