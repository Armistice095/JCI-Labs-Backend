import { Controller, Get } from '@nestjs/common';
import { eventPermissionsMap, globalPermissions } from './access';
import { AuthUser } from './auth.types';
import { CurrentUser } from './decorators';

@Controller('me')
export class MeController {
  @Get()
  me(@CurrentUser() user: AuthUser) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      roles: user.grants.map((g) => ({ id: g.id, roleCode: g.roleCode, eventId: g.eventId })),
      permissions: globalPermissions(user),
      eventPermissions: eventPermissionsMap(user),
    };
  }
}
