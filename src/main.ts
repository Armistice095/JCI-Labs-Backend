import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { loadEnv } from './config/env';

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true, bodyLimit: 1024 * 1024 }), // derrière Caddy : req.ip = IP réelle du client
    { rawBody: true }, // corps brut conservé : indispensable à la vérification de signature des webhooks
  );
  await app.register(helmet);
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableCors({
    origin: env.CORS_ORIGINS ? env.CORS_ORIGINS.split(',').map((s) => s.trim()) : false,
    credentials: true,
  });
  app.enableShutdownHooks();
  await app.listen(env.PORT, '0.0.0.0');
  new Logger('Bootstrap').log(`API prête sur le port ${env.PORT} (/api/v1)`);
}
bootstrap();
