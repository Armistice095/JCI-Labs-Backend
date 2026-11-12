import { AuthUser, EventRef } from './auth.types';

/** L'utilisateur possède-t-il cette permission dans au moins un de ses rôles ? (contrôle grossier, sans contexte d'événement) */
export function hasPermissionAnywhere(user: AuthUser, permission: string): boolean {
  return user.grants.some((g) => g.permissions.includes(permission));
}

/**
 * Contrôle fin.
 * - Sans `event` : il faut un grant GLOBAL portant la permission (ex. créer un événement).
 * - Avec `event` : grant global ALL_EVENTS, ou grant global OWN_OR_ASSIGNED si l'utilisateur est le créateur,
 *   ou grant limité à cet événement.
 */
export function can(user: AuthUser, permission: string, event?: EventRef): boolean {
  for (const g of user.grants) {
    if (!g.permissions.includes(permission)) continue;
    if (g.eventId === null) {
      if (!event) return true;
      if (g.eventScope === 'ALL_EVENTS') return true;
      if (event.createdById === user.id) return true;
    } else if (event && g.eventId === event.id) {
      return true;
    }
  }
  return false;
}

export type EventScope = { all: true } | { all: false; ownCreated: boolean; eventIds: string[] };

/** Périmètre d'événements sur lesquels l'utilisateur détient `permission` (pour filtrer les listes). */
export function eventScope(user: AuthUser, permission: string): EventScope {
  let ownCreated = false;
  const eventIds = new Set<string>();
  for (const g of user.grants) {
    if (!g.permissions.includes(permission)) continue;
    if (g.eventId === null) {
      if (g.eventScope === 'ALL_EVENTS') return { all: true };
      ownCreated = true;
    } else {
      eventIds.add(g.eventId);
    }
  }
  return { all: false, ownCreated, eventIds: [...eventIds] };
}

export function globalPermissions(user: AuthUser): string[] {
  return [...new Set(user.grants.filter((g) => g.eventId === null).flatMap((g) => g.permissions))].sort();
}

export function eventPermissionsMap(user: AuthUser): Record<string, string[]> {
  const map: Record<string, Set<string>> = {};
  for (const g of user.grants) {
    if (g.eventId === null) continue;
    const set = (map[g.eventId] ??= new Set<string>());
    g.permissions.forEach((p) => set.add(p));
  }
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, [...v].sort()]));
}
