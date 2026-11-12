import ExcelJS from 'exceljs';

export interface ExportRow {
  n: number; lastName: string; firstName: string; phone: string; email: string; category: string; ticketNumber: string; amountXof: number;
  payment: string; method: string; presence: string; purchasedAt: string; checkedInAt: string; emailStatus: string; orderReference: string;
}

const COLUMNS: { header: string; key: keyof ExportRow; width: number }[] = [
  { header: 'N°', key: 'n', width: 6 }, { header: 'Nom', key: 'lastName', width: 22 }, { header: 'Prénom', key: 'firstName', width: 22 },
  { header: 'Téléphone', key: 'phone', width: 18 }, { header: 'E-mail', key: 'email', width: 30 }, { header: 'Catégorie', key: 'category', width: 16 },
  { header: 'Référence billet', key: 'ticketNumber', width: 20 }, { header: 'Montant (XOF)', key: 'amountXof', width: 14 },
  { header: 'Paiement', key: 'payment', width: 14 }, { header: 'Mode de paiement', key: 'method', width: 22 }, { header: 'Présence', key: 'presence', width: 12 },
  { header: "Date d'achat", key: 'purchasedAt', width: 18 }, { header: "Heure d'arrivée", key: 'checkedInAt', width: 18 },
  { header: 'Statut e-mail', key: 'emailStatus', width: 20 }, { header: 'Commande', key: 'orderReference', width: 14 },
];

/**
 * Les noms viennent de formulaires publics : une cellule commençant par = + - @ serait exécutée comme une formule à l'ouverture dans Excel.
 * On la préfixe d'une apostrophe, sauf pour un numéro de téléphone international (+229…).
 */
export function neutralize(v: string): string {
  if (/^\+\d{6,15}$/.test(v)) return v;
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/** CSV pour Excel en français : séparateur « ; », UTF-8 avec BOM (accents corrects à l'ouverture). */
export function buildCsv(rows: ExportRow[]): Buffer {
  const cell = (v: string | number) => (typeof v === 'number' ? String(v) : `"${neutralize(v).replaceAll('"', '""')}"`);
  const lines = [COLUMNS.map((c) => `"${c.header}"`).join(';'), ...rows.map((r) => COLUMNS.map((c) => cell(r[c.key])).join(';'))];
  return Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8');
}

export async function buildXlsx(rows: ExportRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'JCI Comé Labs';
  const ws = wb.addWorksheet('Participants', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
  for (const r of rows) ws.addRow(r); // chaînes écrites comme texte : jamais interprétées comme formules
  ws.getColumn('amountXof').numFmt = '#,##0';
  return Buffer.from(await wb.xlsx.writeBuffer());
}
