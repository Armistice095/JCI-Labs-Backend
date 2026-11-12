import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RequirePermission } from '../auth/decorators';

@Controller('roles')
export class RolesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermission('user.manage')
  async list() {
    const roles = await this.prisma.role.findMany({ include: { permissions: true }, orderBy: { code: 'asc' } });
    return roles.map((r) => ({
      code: r.code,
      name: r.name,
      eventScope: r.eventScope,
      permissions: r.permissions.map((p) => p.permission).sort(),
    }));
  }
}
