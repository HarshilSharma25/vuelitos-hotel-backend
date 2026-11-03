import { Response } from 'express';
import { ZodType } from 'zod';

export function sendData<T>(
  res: Response,
  schema: ZodType<T>,
  data: unknown,
  meta?: unknown
): Response {
  const validated = schema.parse(data);
  const payload: { data: T; meta?: unknown } = { data: validated };
  if (meta !== undefined) {
    payload.meta = meta;
  }
  return res.json(payload);
}
