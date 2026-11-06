import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export type RequestWithId = Request & { requestId?: string };

export function requestIdMiddleware(
  req: RequestWithId,
  res: Response,
  next: NextFunction,
): void {
  // Generate on the server; never trust user-provided identifiers in logs.
  req.requestId = randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}
