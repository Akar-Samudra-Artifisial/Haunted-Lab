export class HttpError extends Error {
  status: number;
  code: string;
  headers: Record<string, string>;
  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const unauthorized = (): HttpError =>
  new HttpError(401, 'unauthorized', 'missing or invalid bearer token', { 'www-authenticate': 'Bearer' });

export const badRequest = (message: string): HttpError => new HttpError(400, 'bad_request', message);

/** First stack frame (`at ...`) or ''. */
export function firstFrame(err: unknown): string {
  if (!(err instanceof Error) || typeof err.stack !== 'string') return '';
  const line = err.stack.split('\n').find((l) => l.trimStart().startsWith('at '));
  return line ? line.trim().slice(0, 300) : '';
}
