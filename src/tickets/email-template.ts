import mjml2html from 'mjml';
import { BRAND, escapeHtml as e, formatDateParts, formatTime } from './design/tokens';

export interface TicketEmailInput {
  kind: 'CONFIRMATION' | 'RESEND';
  buyerFirstName: string;
  reference: string | null;
  event: { title: string; startsAt: Date | null; venueName: string; city: string; contactEmail: string | null; contactPhone: string | null };
  tickets: { holderName: string; categoryName: string; number: string }[];
  orderUrl: string | null;      // page « Mes billets » (jeton de suivi de la commande)
  logoUrl: string;
  pdfAttached: boolean;
}

/** E-mail de confirmation (MJML → HTML responsive). Toutes les valeurs dynamiques sont échappées. */
export function buildTicketEmail(i: TicketEmailInput): { subject: string; html: string } {
  const n = i.tickets.length;
  const subject = i.kind === 'RESEND'
    ? `Votre billet — ${i.event.title}`
    : n > 1 ? `Vos ${n} billets — ${i.event.title}` : `Votre billet — ${i.event.title}`;
  const date = formatDateParts(i.event.startsAt);
  const when = i.event.startsAt ? `${date.long} à ${formatTime(i.event.startsAt)}` : 'Date à confirmer';
  const where = [i.event.venueName, i.event.city].filter(Boolean).join(', ') || 'Lieu à confirmer';
  const contact = [i.event.contactEmail, i.event.contactPhone].filter(Boolean).map(e).join(' · ');

  const rows = i.tickets.map((t) => `<tr>
      <td style="padding:10px 8px;border-bottom:1px solid #E3E8F4;font-weight:700">${e(t.holderName)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #E3E8F4">${e(t.categoryName)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #E3E8F4;white-space:nowrap;font-family:monospace;font-size:13px">${e(t.number)}</td></tr>`).join('');

  const attachNote = i.pdfAttached
    ? `Votre${n > 1 ? 's' : ''} billet${n > 1 ? 's' : ''} (PDF) ${n > 1 ? 'sont joints' : 'est joint'} à ce message.`
    : `Téléchargez ${n > 1 ? 'vos billets' : 'votre billet'} depuis le bouton ci-dessus.`;

  const source = `<mjml>
  <mj-head>
    <mj-title>${e(subject)}</mj-title>
    <mj-preview>${e(`${i.event.title} — ${when}`)}</mj-preview>
    <mj-attributes>
      <mj-all font-family="Montserrat, Arial, Helvetica, sans-serif" />
      <mj-text font-size="15px" line-height="23px" color="${BRAND.ink}" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="#EEF2FA" width="620px">
    <mj-section background-color="#FFFFFF" padding="22px 28px 14px" border-top="5px solid ${BRAND.accentDefault}">
      <mj-column><mj-image src="${e(i.logoUrl)}" alt="JCI Comé Excellence" width="150px" align="left" padding="0" /></mj-column>
    </mj-section>
    <mj-section background-color="#FFFFFF" padding="6px 28px 4px">
      <mj-column>
        <mj-text font-size="22px" line-height="30px" font-weight="800" padding-bottom="6px">${i.kind === 'RESEND' ? 'Voici votre billet' : 'Votre paiement est confirmé'}</mj-text>
        <mj-text>Bonjour ${e(i.buyerFirstName)},<br/>${i.kind === 'RESEND'
          ? `voici ${n > 1 ? 'vos billets' : 'votre billet'} pour <b>${e(i.event.title)}</b>.`
          : `merci pour votre achat${i.reference ? ` (commande <b>${e(i.reference)}</b>)` : ''}. ${n > 1 ? 'Vos billets sont prêts' : 'Votre billet est prêt'} pour <b>${e(i.event.title)}</b>.`}</mj-text>
      </mj-column>
    </mj-section>
    <mj-section background-color="#FFFFFF" padding="6px 28px">
      <mj-column background-color="#F7F9FD" border-radius="14px" padding="14px 18px">
        <mj-text padding="0"><b>Quand :</b> ${e(when)}<br/><b>Où :</b> ${e(where)}</mj-text>
      </mj-column>
    </mj-section>
    <mj-section background-color="#FFFFFF" padding="10px 28px 0">
      <mj-column>
        <mj-table font-size="14px" padding="0">
          <tr style="text-align:left;color:${BRAND.muted};font-size:12px"><th style="padding:6px 8px">Participant</th><th style="padding:6px 8px">Catégorie</th><th style="padding:6px 8px">N° de billet</th></tr>
          ${rows}
        </mj-table>
      </mj-column>
    </mj-section>
    <mj-section background-color="#FFFFFF" padding="14px 28px 4px">
      <mj-column>
        ${i.orderUrl ? `<mj-button href="${e(i.orderUrl)}" background-color="${BRAND.navy}" color="#FFFFFF" border-radius="26px" font-weight="700" font-size="15px" inner-padding="13px 28px" padding="4px 0 10px">Voir et télécharger ${n > 1 ? 'mes billets' : 'mon billet'}</mj-button>` : ''}
        <mj-text font-size="14px" color="${BRAND.muted}">${attachNote}</mj-text>
      </mj-column>
    </mj-section>
    <mj-section background-color="#FFFFFF" padding="6px 28px 6px">
      <mj-column background-color="#FFF8E8" border="1.5px solid #F2D28A" border-radius="14px" padding="12px 18px">
        <mj-text font-size="13.5px" line-height="21px" padding="0"><b>À l’entrée :</b> présentez le QR code de votre billet (sur téléphone ou imprimé). Chaque billet est <b>personnel</b>, <b>non transférable</b> et ne peut être utilisé <b>qu’une seule fois</b>.</mj-text>
      </mj-column>
    </mj-section>
    <mj-section background-color="#FFFFFF" padding="10px 28px 24px">
      <mj-column>
        <mj-text font-size="13px" color="${BRAND.muted}" padding="0">Une question ? Répondez à cet e-mail${contact ? ` ou contactez-nous : ${contact}` : ''}.</mj-text>
      </mj-column>
    </mj-section>
    <mj-section background-color="${BRAND.navy}" padding="16px 28px">
      <mj-column><mj-text align="center" color="#FFFFFF" font-size="12px" padding="0">JCI Comé Excellence · Organisation de jeunes citoyens actifs</mj-text></mj-column>
    </mj-section>
  </mj-body>
</mjml>`;
  const { html, errors } = mjml2html(source, { validationLevel: 'soft' });
  if (!html || (errors?.length && !html.includes('<table'))) throw new Error(`Gabarit e-mail invalide : ${errors?.[0]?.message}`);
  return { subject, html };
}
