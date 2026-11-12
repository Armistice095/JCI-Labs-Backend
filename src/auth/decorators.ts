import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthUser } from './auth.types';

export const IS_PUBLIC = 'isPublic';
export const PERMISSION_KEY = 'requiredPermission';

/** Route sans authentification. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Contrôle grossier : l'utilisateur doit avoir cette permission dans au moins un rôle. Le contrôle fin est fait dans les services. */
export const RequirePermission = (permission: string) => SetMetadata(PERMISSION_KEY, permission);

export type AuthedRequest = FastifyRequest & { user?: AuthUser };

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  return req.user as AuthUser;
});
