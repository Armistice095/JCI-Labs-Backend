import { Prisma } from '@prisma/client';
import { AppException } from '../common/errors';

export interface StockLine { categoryId: string; eventId: string; qty: number }
type Tx = Prisma.TransactionClient;

/** Verrouillage toujours dans le même ordre (id de catégorie) pour éviter les interblocages entre commandes concurrentes. */
const sorted = (lines: StockLine[]) => [...lines].sort((a, b) => a.categoryId.localeCompare(b.categoryId));

export function groupLines(rows: { categoryId: string; eventId: string; qty: number }[]): StockLine[] {
  const m = new Map<string, StockLine>();
  for (const r of rows) {
    const cur = m.get(r.categoryId);
    if (cur) cur.qty += r.qty; else m.set(r.categoryId, { ...r });
  }
  return [...m.values()];
}

const quotaError = () => new AppException('QUOTA_EXCEEDED', "Il n'y a plus assez de places disponibles pour cette catégorie.", 409);

/** Réserve des places : une seule requête atomique par catégorie. 0 ligne modifiée = plus de stock. */
export async function reserve(tx: Tx, lines: StockLine[]): Promise<void> {
  for (const l of sorted(lines)) {
    const n = await tx.$executeRaw`
      UPDATE ticket_categories SET reserved_count = reserved_count + ${l.qty}, updated_at = now()
      WHERE id = ${l.categoryId}::uuid AND event_id = ${l.eventId}::uuid AND is_active
        AND sold_count + reserved_count + ${l.qty} <= quota`;
    if (n === 0) throw quotaError();
  }
}

/** Vend directement (vente physique, ou paiement tardif dont la réservation a été libérée). */
export async function sellDirect(tx: Tx, lines: StockLine[], opts: { requireActive: boolean }): Promise<void> {
  for (const l of sorted(lines)) {
    const n = await tx.$executeRaw`
      UPDATE ticket_categories SET sold_count = sold_count + ${l.qty}, updated_at = now()
      WHERE id = ${l.categoryId}::uuid AND event_id = ${l.eventId}::uuid AND (is_active OR ${!opts.requireActive})
        AND sold_count + reserved_count + ${l.qty} <= quota`;
    if (n === 0) throw quotaError();
  }
}

/** Transforme une réservation en vente (paiement confirmé). */
export async function convertReservation(tx: Tx, lines: StockLine[]): Promise<void> {
  for (const l of sorted(lines)) {
    const n = await tx.$executeRaw`
      UPDATE ticket_categories SET reserved_count = reserved_count - ${l.qty}, sold_count = sold_count + ${l.qty}, updated_at = now()
      WHERE id = ${l.categoryId}::uuid AND reserved_count >= ${l.qty}`;
    if (n === 0) throw new Error(`Incohérence de stock : réservation introuvable (catégorie ${l.categoryId}).`);
  }
}

export async function releaseReservation(tx: Tx, lines: StockLine[]): Promise<void> {
  for (const l of sorted(lines)) {
    await tx.$executeRaw`
      UPDATE ticket_categories SET reserved_count = GREATEST(reserved_count - ${l.qty}, 0), updated_at = now()
      WHERE id = ${l.categoryId}::uuid`;
  }
}

/** Libère des places vendues (billet annulé ou remboursé). */
export async function releaseSold(tx: Tx, lines: StockLine[]): Promise<void> {
  for (const l of sorted(lines)) {
    await tx.$executeRaw`
      UPDATE ticket_categories SET sold_count = GREATEST(sold_count - ${l.qty}, 0), updated_at = now()
      WHERE id = ${l.categoryId}::uuid`;
  }
}

export async function nextCounter(tx: Tx, key: string): Promise<number> {
  const rows = await tx.$queryRaw<{ next_counter: bigint }[]>`SELECT next_counter(${key})`;
  return Number(rows[0].next_counter);
}
