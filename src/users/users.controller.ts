import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { UsersService } from './users.service';
import { roleGrantInput, RoleGrantInput, userCreate, UserCreate, userListQuery, userUpdate } from './users.schemas';
import type { FastifyRequest } from 'fastify';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get() @RequirePermission('user.manage')
  list(@Query(new ZodPipe(userListQuery)) q: ReturnType<typeof userListQuery.parse>) { return this.users.list(q); }

  @Post() @RequirePermission('user.manage')
  create(@CurrentUser() me: AuthUser, @Body(new ZodPipe(userCreate)) body: UserCreate, @Req() req: FastifyRequest) {
    return this.users.create(me, body, req.ip);
  }

  @Get(':userId') @RequirePermission('user.manage')
  get(@Param('userId', ParseUUIDPipe) id: string) { return this.users.get(id); }

  @Patch(':userId') @RequirePermission('user.manage')
  update(@CurrentUser() me: AuthUser, @Param('userId', ParseUUIDPipe) id: string,
         @Body(new ZodPipe(userUpdate)) body: ReturnType<typeof userUpdate.parse>, @Req() req: FastifyRequest) {
    return this.users.update(me, id, body, req.ip);
  }

  @Post(':userId/disable') @HttpCode(204) @RequirePermission('user.manage')
  disable(@CurrentUser() me: AuthUser, @Param('userId', ParseUUIDPipe) id: string, @Req() req: FastifyRequest) {
    return this.users.setStatus(me, id, false, req.ip);
  }

  @Post(':userId/enable') @HttpCode(204) @RequirePermission('user.manage')
  enable(@CurrentUser() me: AuthUser, @Param('userId', ParseUUIDPipe) id: string, @Req() req: FastifyRequest) {
    return this.users.setStatus(me, id, true, req.ip);
  }

  @Post(':userId/reset-password') @HttpCode(204) @RequirePermission('user.manage')
  reset(@CurrentUser() me: AuthUser, @Param('userId', ParseUUIDPipe) id: string, @Req() req: FastifyRequest) {
    return this.users.resetPassword(me, id, req.ip);
  }

  @Post(':userId/roles') @RequirePermission('role.manage')
  grant(@CurrentUser() me: AuthUser, @Param('userId', ParseUUIDPipe) id: string,
        @Body(new ZodPipe(roleGrantInput)) body: RoleGrantInput, @Req() req: FastifyRequest) {
    return this.users.grantRole(me, id, body, req.ip);
  }

  @Delete(':userId/roles/:grantId') @HttpCode(204) @RequirePermission('role.manage')
  revoke(@CurrentUser() me: AuthUser, @Param('userId', ParseUUIDPipe) id: string,
         @Param('grantId', ParseUUIDPipe) grantId: string, @Req() req: FastifyRequest) {
    return this.users.revokeRole(me, id, grantId, req.ip);
  }
}
