export interface AppError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;
  expose?: boolean;
}

export const createHttpError = (
  message: string,
  statusCode: number,
  options?: {
    code?: string;
    details?: unknown;
    expose?: boolean;
  }
): AppError => {
  const error = new Error(message) as AppError;
  error.statusCode = statusCode;
  error.code = options?.code || 'INTERNAL_ERROR';
  error.details = options?.details;
  error.expose = options?.expose ?? statusCode < 500;
  return error;
};

export const isAppError = (value: unknown): value is AppError => {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'statusCode' in value &&
      typeof (value as AppError).statusCode === 'number' &&
      'code' in value &&
      typeof (value as AppError).code === 'string'
  );
};
