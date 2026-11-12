import { HttpException, HttpStatus } from '@nestjs/common';

export type ErrorCode =
  | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'VALIDATION_ERROR' | 'CONFLICT' | 'QUOTA_EXCEEDED'
  | 'SALES_CLOSED' | 'MAX_PER_ORDER_EXCEEDED' | 'EVENT_NOT_PUBLISHED' | 'INVALID_STATE'
  | 'DUPLICATE_REQUEST' | 'CAPTCHA_FAILED' | 'RATE_LIMITED' | 'PAYMENT_PROVIDER_ERROR' | 'APP_UPDATE_REQUIRED' | 'INTERNAL_ERROR';

export class AppException extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, details }, status);
  }
}

export const unauthorized = (m = 'Authentification requise.') => new AppException('UNAUTHORIZED', m, HttpStatus.UNAUTHORIZED);
export const forbidden = (m = "Vous n'avez pas la permission d'effectuer cette action.") => new AppException('FORBIDDEN', m, HttpStatus.FORBIDDEN);
export const notFound = (m = 'Ressource introuvable.') => new AppException('NOT_FOUND', m, HttpStatus.NOT_FOUND);
export const conflict = (m: string, code: ErrorCode = 'CONFLICT') => new AppException(code, m, HttpStatus.CONFLICT);
export const invalidState = (m: string) => new AppException('INVALID_STATE', m, HttpStatus.CONFLICT);
export const validation = (m: string, fields?: Record<string, string>) =>
  new AppException('VALIDATION_ERROR', m, HttpStatus.UNPROCESSABLE_ENTITY, fields ? { fields } : undefined);
