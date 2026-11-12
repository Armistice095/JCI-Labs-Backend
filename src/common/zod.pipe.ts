import { PipeTransform } from '@nestjs/common';
import { ZodTypeAny, z } from 'zod';
import { AppException } from './errors';

export class ZodPipe<T extends ZodTypeAny> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.output<T> {
    const r = this.schema.safeParse(value ?? {});
    if (r.success) return r.data;
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[i.path.join('.') || '_'] ??= i.message;
    throw new AppException('VALIDATION_ERROR', 'Certaines données sont invalides.', 422, { fields });
  }
}
