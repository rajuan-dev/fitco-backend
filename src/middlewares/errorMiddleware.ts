import { NextFunction, Request, Response } from 'express';
import { isAppError } from '../utils/httpError';

export const notFound = (req: Request, res: Response, next: NextFunction): void => {
  res.status(404).json({
    message: 'Route not found',
    code: 'ROUTE_NOT_FOUND',
    requestId: req.requestId
  });
};

export const errorHandler = (err: Error & { statusCode?: number }, req: Request, res: Response, next: NextFunction): void => {
  const appError = isAppError(err) ? err : null;
  const status = appError?.statusCode || err.statusCode || 500;
  const code = appError?.code || 'INTERNAL_SERVER_ERROR';
  const message = appError?.expose === false && status >= 500 ? 'Internal server error' : err.message || 'Internal server error';

  console.error('[API_ERROR]', {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    status,
    code,
    message: err.message,
    details: appError?.details,
    stack: err.stack
  });

  const response: Record<string, unknown> = {
    message,
    code,
    requestId: req.requestId
  };
  if (process.env.NODE_ENV === 'development' && err.stack) {
    response.stack = err.stack;
  }
  if (process.env.NODE_ENV === 'development' && appError?.details !== undefined) {
    response.details = appError.details;
  }
  res.status(status).json(response);
};
