import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      // Do not echo invalid inputs, which may contain personal data or secrets.
      throw new BadRequestException('Request validation failed');
    }
    return result.data;
  }
}
