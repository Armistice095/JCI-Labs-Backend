import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

/** Processus sans HTTP : exécute les tâches de fond (webhooks FedaPay, maintenance, billets…). */
async function bootstrap() {
  process.env.PROCESS_ROLE = 'worker';
  loadEnv();
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  new Logger('Worker').log('Worker démarré');
}
bootstrap();
