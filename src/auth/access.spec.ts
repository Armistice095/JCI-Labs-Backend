import { can, eventPermissionsMap, eventScope, globalPermissions, hasPermissionAnywhere } from './access';
import { AuthUser, Grant } from './auth.types';

const grant = (g: Partial<Grant> & { permissions: string[] }): Grant => ({ id: 'g', roleCode: 'X', eventScope: 'ALL_EVENTS', eventId: null, ...g });
const user = (grants: Grant[], id = 'u1'): AuthUser => ({ id, email: 'a@b.c', firstName: 'A', lastName: 'B', grants });
const ev = (id: string, createdById: string) => ({ id, createdById });

describe('can()', () => {
  it('ADMIN/PRESIDENT (ALL_EVENTS global) : accès à tous les événements', () => {
    const u = user([grant({ permissions: ['event.publish', 'event.create'] })]);
    expect(can(u, 'event.publish', ev('e1', 'someone'))).toBe(true);
    expect(can(u, 'event.create')).toBe(true);
  });

  it('ORGANIZER global : seulement ses propres événements, et ne publie pas', () => {
    const u = user([grant({ eventScope: 'OWN_OR_ASSIGNED', permissions: ['event.create', 'event.update', 'event.read'] })]);
    expect(can(u, 'event.create')).toBe(true);
    expect(can(u, 'event.update', ev('e1', 'u1'))).toBe(true);
    expect(can(u, 'event.update', ev('e2', 'other'))).toBe(false);
    expect(can(u, 'event.publish', ev('e1', 'u1'))).toBe(false);
  });

  it("grant limité à un événement : ne donne ni création ni accès aux autres événements", () => {
    const u = user([grant({ eventScope: 'OWN_OR_ASSIGNED', eventId: 'e1', permissions: ['event.read', 'checkin.scan'] })]);
    expect(can(u, 'checkin.scan', ev('e1', 'x'))).toBe(true);
    expect(can(u, 'checkin.scan', ev('e2', 'x'))).toBe(false);
    expect(can(u, 'checkin.scan')).toBe(false);
  });

  it('hasPermissionAnywhere : contrôle grossier tous grants confondus', () => {
    const u = user([grant({ eventId: 'e1', permissions: ['checkin.scan'] })]);
    expect(hasPermissionAnywhere(u, 'checkin.scan')).toBe(true);
    expect(hasPermissionAnywhere(u, 'user.manage')).toBe(false);
  });
});

describe('eventScope()', () => {
  it('all pour un grant global ALL_EVENTS', () => {
    expect(eventScope(user([grant({ permissions: ['event.read'] })]), 'event.read')).toEqual({ all: true });
  });
  it('combine créés + assignés', () => {
    const u = user([
      grant({ eventScope: 'OWN_OR_ASSIGNED', permissions: ['event.read'] }),
      grant({ eventScope: 'OWN_OR_ASSIGNED', eventId: 'e9', permissions: ['event.read'] }),
    ]);
    expect(eventScope(u, 'event.read')).toEqual({ all: false, ownCreated: true, eventIds: ['e9'] });
  });
  it('aucun périmètre sans la permission', () => {
    expect(eventScope(user([grant({ permissions: ['x'] })]), 'event.read')).toEqual({ all: false, ownCreated: false, eventIds: [] });
  });
});

describe('/me', () => {
  it('sépare permissions globales et par événement', () => {
    const u = user([grant({ permissions: ['b', 'a'] }), grant({ eventId: 'e1', permissions: ['checkin.scan'] })]);
    expect(globalPermissions(u)).toEqual(['a', 'b']);
    expect(eventPermissionsMap(u)).toEqual({ e1: ['checkin.scan'] });
  });
});
