import { EventStatus } from '@prisma/client';

export type SalesStatus = 'NOT_OPEN' | 'OPEN' | 'CLOSED';
export type CategoryAvailability = 'AVAILABLE' | 'SOLD_OUT' | 'NOT_STARTED' | 'ENDED' | 'DISABLED';

export interface SalesWindow {
  status: EventStatus;
  salesOpensAt: Date | null;
  salesClosesAt: Date | null;
  salesManuallyClosed: boolean;
}

/** Statut de la billetterie : distinct du statut de publication de l'événement. null pour un brouillon. */
export function computeSalesStatus(e: SalesWindow, now = new Date()): SalesStatus | null {
  if (e.status === 'DRAFT') return null;
  if (e.status !== 'PUBLISHED') return 'CLOSED';
  if (e.salesManuallyClosed) return 'CLOSED';
  if (!e.salesOpensAt || now < e.salesOpensAt) return 'NOT_OPEN';
  if (e.salesClosesAt && now >= e.salesClosesAt) return 'CLOSED';
  return 'OPEN';
}

export interface CategoryLike {
  isActive: boolean;
  quota: number;
  soldCount: number;
  reservedCount: number;
  saleStartsAt: Date | null;
  saleEndsAt: Date | null;
}

export function remaining(c: Pick<CategoryLike, 'quota' | 'soldCount' | 'reservedCount'>): number {
  return Math.max(0, c.quota - c.soldCount - c.reservedCount);
}

export function computeAvailability(c: CategoryLike, e: Pick<SalesWindow, 'salesOpensAt' | 'salesClosesAt'>, now = new Date()): CategoryAvailability {
  if (!c.isActive) return 'DISABLED';
  if (remaining(c) <= 0) return 'SOLD_OUT';
  const start = c.saleStartsAt ?? e.salesOpensAt;
  if (!start || now < start) return 'NOT_STARTED';
  const end = c.saleEndsAt ?? e.salesClosesAt;
  if (end && now >= end) return 'ENDED';
  return 'AVAILABLE';
}
