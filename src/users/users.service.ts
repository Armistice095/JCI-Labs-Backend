import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { conflict, invalidState, notFound, validation } from '../common/errors';
import { pageMeta } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { RoleGrantInput, UserCreate } from './users.schemas';

type UserWithRoles = Prisma.ProfileGetPayload<{ include: { userRoles: { include: { role: true } } } }>;
const include = { userRoles: { include: { role: true } } } satisfies Prisma.ProfileInclude;
const ALL_EVENT_ROLES = ['ADMIN', 'PRESIDENT']; // rôles qui n'ont pas de portée par événement

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseAdminService,
    private readonly audit: AuditService,
  ) {}

  private toDto(u: UserWithRoles) {
    return {
      id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName, phone: u.phone, status: u.status,
      roles: u.userRoles.map((r) => ({ id: r.id, roleCode: r.role.code, eventId: r.eventId })),
      createdAt: u.createdAt,
    };
  }

  async list(q: { page: number; pageSize: number; q?: string }) {
    const where: Prisma.ProfileWhereInput = q.q
      ? { OR: [
          { email: { contains: q.q, mode: 'insensitive' } },
          { firstName: { contains: q.q, mode: 'insensitive' } },
          { lastName: { contains: q.q, mode: 'insensitive' } },
        ] }
      : {};
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.profile.count({ where }),
      this.prisma.profile.findMany({
        where, include, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      }),
    ]);
    return { data: rows.map((r) => this.toDto(r)), meta: pageMeta(q.page, q.pageSize, total) };
  }

  async get(id: string) {
    const u = await this.prisma.profile.findUnique({ where: { id }, include });
    if (!u) throw notFound('Utilisateur introuvable.');
    return this.toDto(u);
  }

  async create(actor: AuthUser, input: UserCreate, ip?: string) {
    if (await this.prisma.profile.findUnique({ where: { email: input.email } })) {
      throw conflict('Un compte existe déjà avec cette adresse e-mail.');
    }
    const roles = await this.resolveGrants(input.roles);
    const authId = await this.supabase.inviteUser(input.email);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const profile = await tx.profile.create({
          data: { id: authId, email: input.email, firstName: input.firstName, lastName: input.lastName, phone: input.phone ?? null, createdById: actor.id },
        });
        await tx.userRole.createMany({
          data: roles.map((r) => ({ userId: authId, roleId: r.roleId, eventId: r.eventId, grantedBy: actor.id })),
        });
        await this.audit.log({ actorId: actor.id, action: 'user.create', entityType: 'user', entityId: profile.id, metadata: { email: input.email, roles: input.roles }, ip }, tx);
        return tx.profile.findUniqueOrThrow({ where: { id: profile.id }, include });
      });
      return this.toDto(created);
    } catch (e) {
      await this.supabase.deleteUser(authId); // compensation : pas de compte Supabase orphelin
      throw e;
    }
  }

  async update(actor: AuthUser, id: string, data: { firstName?: string; lastName?: string; phone?: string | null }, ip?: string) {
    await this.mustExist(id);
    const u = await this.prisma.profile.update({ where: { id }, data, include });
    await this.audit.log({ actorId: actor.id, action: 'user.update', entityType: 'user', entityId: id, ip });
    return this.toDto(u);
  }

  async setStatus(actor: AuthUser, id: string, active: boolean, ip?: string) {
    const target = await this.mustExist(id);
    if (!active) {
      if (id === actor.id) throw invalidState('Vous ne pouvez pas désactiver votre propre compte.');
      await this.assertNotLastAdmin(id);
    }
    await this.supabase.setBanned(id, !active);
    await this.prisma.profile.update({ where: { id }, data: { status: active ? 'ACTIVE' : 'DISABLED' } });
    await this.audit.log({ actorId: actor.id, action: active ? 'user.enable' : 'user.disable', entityType: 'user', entityId: target.id, ip });
  }

  async resetPassword(actor: AuthUser, id: string, ip?: string) {
    const u = await this.mustExist(id);
    await this.supabase.sendPasswordReset(u.email);
    await this.audit.log({ actorId: actor.id, action: 'user.reset_password', entityType: 'user', entityId: id, ip });
  }

  async grantRole(actor: AuthUser, userId: string, input: RoleGrantInput, ip?: string) {
    await this.mustExist(userId);
    const [grant] = await this.resolveGrants([input]);
    const exists = await this.prisma.userRole.findFirst({ where: { userId, roleId: grant.roleId, eventId: grant.eventId } });
    if (exists) throw conflict('Ce rôle est déjà attribué.');
    const created = await this.prisma.userRole.create({ data: { userId, roleId: grant.roleId, eventId: grant.eventId, grantedBy: actor.id }, include: { role: true } });
    await this.audit.log({ actorId: actor.id, action: 'role.grant', entityType: 'user', entityId: userId, metadata: { ...input }, ip });
    return { id: created.id, roleCode: created.role.code, eventId: created.eventId };
  }

  async revokeRole(actor: AuthUser, userId: string, grantId: string, ip?: string) {
    const grant = await this.prisma.userRole.findFirst({ where: { id: grantId, userId }, include: { role: true } });
    if (!grant) throw notFound('Attribution introuvable.');
    if (grant.role.code === 'ADMIN' && grant.eventId === null) await this.assertNotLastAdmin(userId);
    await this.prisma.userRole.delete({ where: { id: grantId } });
    await this.audit.log({ actorId: actor.id, action: 'role.revoke', entityType: 'user', entityId: userId, metadata: { roleCode: grant.role.code, eventId: grant.eventId }, ip });
  }

  private async mustExist(id: string) {
    const u = await this.prisma.profile.findUnique({ where: { id } });
    if (!u) throw notFound('Utilisateur introuvable.');
    return u;
  }

  private async resolveGrants(grants: RoleGrantInput[]) {
    const roles = await this.prisma.role.findMany({ where: { code: { in: grants.map((g) => g.roleCode) } } });
    const byCode = new Map(roles.map((r) => [r.code, r]));
    const out: { roleId: string; eventId: string | null }[] = [];
    for (const g of grants) {
      const role = byCode.get(g.roleCode);
      if (!role) throw validation(`Rôle inconnu : ${g.roleCode}.`);
      const eventId = g.eventId ?? null;
      if (eventId) {
        if (ALL_EVENT_ROLES.includes(role.code)) throw validation(`Le rôle ${role.name} ne peut pas être limité à un événement.`);
        if (!(await this.prisma.event.findUnique({ where: { id: eventId }, select: { id: true } }))) throw validation('Événement introuvable.');
      }
      out.push({ roleId: role.id, eventId });
    }
    return out;
  }

  /** Empêche de se retrouver sans aucun administrateur actif. */
  private async assertNotLastAdmin(userId: string) {
    const isAdmin = await this.prisma.userRole.count({ where: { userId, eventId: null, role: { code: 'ADMIN' } } });
    if (!isAdmin) return;
    const others = await this.prisma.userRole.count({
      where: { userId: { not: userId }, eventId: null, role: { code: 'ADMIN' }, user: { status: 'ACTIVE' } },
    });
    if (others === 0) throw invalidState('Il doit toujours rester au moins un administrateur actif.');
  }
}
