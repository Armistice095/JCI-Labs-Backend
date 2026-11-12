import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ENV, Env } from '../config/env';
import { ChromiumRenderer } from './renderer';

@Injectable()
export class RendererService extends ChromiumRenderer implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    super({ executablePath: env.CHROMIUM_PATH, headlessShell: env.CHROMIUM_HEADLESS_SHELL === 'true', lowMemory: env.CHROMIUM_LOW_MEMORY === 'true' });
  }
  async onModuleDestroy() { await this.close(); }
}
