import type { SchemaObject } from '@nestjs/swagger';
import { z } from 'zod';

export function zodOpenApi(schema: z.ZodType): SchemaObject {
  // Zod's declared JSON Schema type is broader; the selected target is OpenAPI 3.0.
  return z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io: 'input',
  }) as SchemaObject;
}
