/** Normalise un numéro en E.164. Gère le format béninois à 10 chiffres (01XXXXXXXX) et l'ancien format à 8 chiffres. */
export function normalizePhone(input: string): string | null {
  const raw = input.trim().replace(/[\s().-]/g, '');
  if (!raw) return null;
  let s = raw.startsWith('00') ? `+${raw.slice(2)}` : raw;
  if (!s.startsWith('+')) {
    if (/^229\d{10}$/.test(s)) s = `+${s}`;
    else if (/^01\d{8}$/.test(s)) s = `+229${s}`;
    else if (/^\d{8}$/.test(s)) s = `+22901${s}`; // ancien numérotage à 8 chiffres
    else return null;
  }
  return /^\+\d{8,15}$/.test(s) ? s : null;
}
