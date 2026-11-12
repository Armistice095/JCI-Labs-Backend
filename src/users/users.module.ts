import { Module } from '@nestjs/common';
import { RolesController } from '../roles/roles.controller';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({ controllers: [UsersController, RolesController], providers: [UsersService] })
export class UsersModule {}
