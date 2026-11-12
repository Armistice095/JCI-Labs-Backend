// Le Bénin est en UTC+1 toute l'année (pas d'heure d'été) : un décalage fixe suffit.
export const TZ_NAME = 'Africa/Porto-Novo';
const OFFSET_MIN = 60;

export function localToUtc(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+01:00`);
}

export function utcToLocalParts(d: Date): { date: string; time: string } {
  const iso = new Date(d.getTime() + OFFSET_MIN * 60_000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Par défaut, la billetterie se clôture la veille de l'événement à 18h00 (heure locale). */
export function defaultSalesClose(eventDate: string, hourLocal = 18): Date {
  return localToUtc(addDays(eventDate, -1), `${String(hourLocal).padStart(2, '0')}:00`);
}
