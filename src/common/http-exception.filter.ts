import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import { AppException, ErrorCode } from './errors';

const STATUS_CODE: Record<number, ErrorCode> = {
  400: 'VALIDATION_ERROR', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
  409: 'CONFLICT', 413: 'VALIDATION_ERROR', 415: 'VALIDATION_ERROR', 422: 'VALIDATION_ERROR', 429: 'RATE_LIMITED',
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const { status, body } = this.normalize(exception);
    if (status >= 500) this.log.error(exception instanceof Error ? exception.stack : String(exception));
    reply.status(status).send(body);
  }

  private normalize(e: unknown): { status: number; body: { code: ErrorCode; message: string; details?: unknown } } {
    if (e instanceof AppException) {
      return { status: e.getStatus(), body: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } };
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2002') return { status: 409, body: { code: 'CONFLICT', message: 'Cette valeur existe déjà.' } };
      if (e.code === 'P2025') return { status: 404, body: { code: 'NOT_FOUND', message: 'Ressource introuvable.' } };
      if (e.code === 'P2003') return { status: 409, body: { code: 'CONFLICT', message: "Cette ressource est liée à d'autres données." } };
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      return { status, body: { code: STATUS_CODE[status] ?? 'INTERNAL_ERROR', message: e.message } };
    }
    const err = e as { code?: string; statusCode?: number };
    if (err?.code === 'FST_REQ_FILE_TOO_LARGE') return { status: 413, body: { code: 'VALIDATION_ERROR', message: 'Fichier trop lourd (2 Mo maximum).' } };
    if (err?.statusCode && err.statusCode < 500) return { status: err.statusCode, body: { code: STATUS_CODE[err.statusCode] ?? 'VALIDATION_ERROR', message: 'Requête invalide.' } };
    return { status: 500, body: { code: 'INTERNAL_ERROR', message: 'Une erreur interne est survenue.' } };
  }
}
