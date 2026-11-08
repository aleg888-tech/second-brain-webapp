import type { ApiErrorBody, ApiErrorCode, FileContent } from '@brain/shared';

export class AppError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly current?: FileContent;

  constructor(status: number, code: ApiErrorCode, message: string, current?: FileContent) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.current = current;
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.current ? { current: this.current } : {}),
      },
    };
  }
}

export const badRequest = (message: string) => new AppError(400, 'bad_request', message);
export const invalidPath = (message: string) => new AppError(400, 'invalid_path', message);
export const unauthorized = (message: string) => new AppError(401, 'unauthorized', message);
export const forbidden = (message: string) => new AppError(403, 'forbidden', message);
export const notFound = (message: string) => new AppError(404, 'not_found', message);
export const alreadyExists = (message: string) => new AppError(409, 'already_exists', message);
export const conflict = (message: string, current?: FileContent) =>
  new AppError(409, 'conflict', message, current);

export function errorBody(code: ApiErrorCode, message: string): ApiErrorBody {
  return { error: { code, message } };
}
