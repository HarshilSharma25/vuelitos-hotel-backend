import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import crypto from 'node:crypto';

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID();

  if (err instanceof AppError) {
    if (err.statusCode === 429 && 'retryAfter' in err) {
      res.setHeader('Retry-After', (err as any).retryAfter);
    }
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        request_id: requestId,
      },
    });
  }

  if (err instanceof ZodError) {
    const details = (err as any).errors?.map((e: any) => ({
      path: e.path?.join('.') ?? '',
      message: e.message,
    })) ?? [];
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details,
        request_id: requestId,
      },
    });
  }

  // Check for multer file limit errors or similar
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'File size exceeds maximum limit of 10MB',
        request_id: requestId,
      },
    });
  }

  // Prisma Known Request Errors
  if (err?.code === 'P2025') {
    return res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found',
        request_id: requestId,
      },
    });
  }

  if (err?.code === 'P2002') {
    const target = Array.isArray(err.meta?.target) ? err.meta.target.join(', ') : err.meta?.target;
    return res.status(409).json({
      error: {
        code: 'CONFLICT',
        message: target ? `A record with this ${target} already exists` : 'Unique constraint violation',
        request_id: requestId,
      },
    });
  }

  // Internal error - NEVER leak internals in message
  console.error(`[ERROR] [${requestId}]`, err);
  return res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: 'Internal error',
      request_id: requestId,
    },
  });
}
