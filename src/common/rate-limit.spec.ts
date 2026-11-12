import { Reflector } from '@nestjs/core';
import { RateLimit, RateLimitGuard } from './rate-limit';

class Ctl { @RateLimit('t', 3, 60) handler() {} }
const ctx = (ip: string) => ({
  getHandler: () => Ctl.prototype.handler, getClass: () => Ctl,
  switchToHttp: () => ({ getRequest: () => ({ ip }), getResponse: () => ({ header: () => undefined }) }),
}) as never;

describe('RateLimitGuard', () => {
  it('bloque au-delà de la limite, par IP', () => {
    const g = new RateLimitGuard(new Reflector(), { RATE_LIMIT_DISABLED: 'false' });
    for (let i = 0; i < 3; i++) expect(g.canActivate(ctx('1.1.1.1'))).toBe(true);
    expect(() => g.canActivate(ctx('1.1.1.1'))).toThrow();
    expect(g.canActivate(ctx('2.2.2.2'))).toBe(true);
    g.onModuleDestroy();
  });
  it('désactivable en test', () => {
    const g = new RateLimitGuard(new Reflector(), { RATE_LIMIT_DISABLED: 'true' });
    for (let i = 0; i < 10; i++) expect(g.canActivate(ctx('1.1.1.1'))).toBe(true);
    g.onModuleDestroy();
  });
});
