import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { forbidden, unauthorized } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { hasPermissionAnywhere } from './access';
import { AuthUser } from './auth.types';
import { AuthedRequest, IS_PUBLIC, PERMISSION_KEY } from './decorators';
import { TokenVerifier } from './token-verifier.service';

/** Authentifie (jeton Supabase), charge le profil et les rôles, puis applique @RequirePermission. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();

    const userId = await this.verifier.verify(header.slice(7));
    req.user = await this.loadUser(userId);

    const required = this.reflector.getAllAndOverride<string | undefined>(PERMISSION_KEY, targets);
    if (required && !hasPermissionAnywhere(req.user, required)) throw forbidden();
    return true;
  }

  private async loadUser(id: string): Promise<AuthUser> {
    const p = await this.prisma.profile.findUnique({
      where: { id },
      include: { userRoles: { include: { role: { include: { permissions: true } } } } },
    });
    if (!p) throw forbidden("Ce compte n'est pas activé dans JCI Comé Labs. Contactez un administrateur.");
    if (p.status !== 'ACTIVE') throw forbidden('Ce compte est désactivé.');
    return {
      id: p.id,
      email: p.email,
      firstName: p.firstName,
      lastName: p.lastName,
      grants: p.userRoles.map((ur) => ({
        id: ur.id,
        roleCode: ur.role.code,
        eventScope: ur.role.eventScope,
        eventId: ur.eventId,
        permissions: ur.role.permissions.map((rp) => rp.permission),
      })),
    };
  }
}
