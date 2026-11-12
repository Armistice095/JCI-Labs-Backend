export interface Publishable {
  title: string;
  description: string;
  startsAt: Date | null;
  endsAt: Date | null;
  venueName: string;
  city: string;
}

/** Champs manquants pour publier. Vide = publiable. Les brouillons peuvent être incomplets. */
export function missingForPublish(e: Publishable): Record<string, string> {
  const m: Record<string, string> = {};
  if (e.title.trim().length < 3) m.title = 'Le titre est obligatoire.';
  if (!e.description.trim()) m.description = 'La description est obligatoire.';
  if (!e.startsAt) m.date = 'La date est obligatoire.';
  if (!e.startsAt) m.startTime = "L'heure de début est obligatoire.";
  if (!e.endsAt) m.endTime = "L'heure de fin est obligatoire.";
  if (e.startsAt && e.endsAt && e.endsAt <= e.startsAt) m.endTime = "L'heure de fin doit être après le début.";
  if (!e.venueName.trim()) m.venueName = 'Le nom du lieu est obligatoire.';
  if (!e.city.trim()) m.city = 'La ville est obligatoire.';
  return m;
}
