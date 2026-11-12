import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { MeController } from './me.controller';
import { TokenVerifier } from './token-verifier.service';

@Global()
@Module({
  controllers: [MeController],
  providers: [TokenVerifier, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [TokenVerifier],
})
export class AuthModule {}
