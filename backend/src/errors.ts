import { ERROR_HTTP_STATUS, type ErrorCode } from '@roboflow/contracts';

/** Erro de aplicação: o status HTTP sai do mapa canônico dos contratos. */
export class AppError extends Error {
  readonly status: number;

  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = ERROR_HTTP_STATUS[code];
  }
}

export const invalidBody = (m: string, d?: unknown) => new AppError('INVALID_BODY', m, d);
export const invalidQuery = (m: string, d?: unknown) => new AppError('INVALID_QUERY', m, d);
export const unauthenticated = (m = 'Credencial ausente ou inválida.') => new AppError('UNAUTHENTICATED', m);
export const forbidden = (m = 'Sem permissão para esta operação.') => new AppError('FORBIDDEN', m);
export const notFound = (m: string) => new AppError('NOT_FOUND', m);
export const conflictState = (m: string, d?: unknown) => new AppError('CONFLICT_STATE', m, d);
export const tooMany = (m = 'Muitas requisições.') => new AppError('RATE_LIMITED', m);
export const deviceUnavailable = (m: string) => new AppError('DEVICE_UNAVAILABLE', m);

/** Lançado pelo Store quando um `create` encontra o documento já existente. */
export class AlreadyExistsError extends Error {
  constructor(
    public readonly collection: string,
    public readonly id: string,
  ) {
    super(`Documento já existe: ${collection}/${id}`);
    this.name = 'AlreadyExistsError';
  }
}
