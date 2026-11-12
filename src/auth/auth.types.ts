export type EventScopeMode = 'ALL_EVENTS' | 'OWN_OR_ASSIGNED';

export interface Grant {
  id: string;
  roleCode: string;
  eventScope: EventScopeMode;
  eventId: string | null; // null = grant global
  permissions: string[];
}

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  grants: Grant[];
}

export interface EventRef { id: string; createdById: string }
