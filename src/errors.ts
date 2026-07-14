export class RequestValidationError extends Error {
  readonly statusCode = 400;
  readonly code: string = 'invalid_request';

  constructor(message: string) {
    super(message);
    this.name = 'RequestValidationError';
  }
}

export class AuthorizationError extends Error {
  readonly statusCode = 403;
  readonly code = 'forbidden';

  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export class ForgetLimitError extends RequestValidationError {
  readonly code = 'forget_match_limit_exceeded';

  constructor(limit: number) {
    super(`Forget request matches more than ${limit} memories; narrow the selectors`);
    this.name = 'ForgetLimitError';
  }
}

export class TombstonedSourceKeyConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'idempotency_key_tombstoned';

  constructor() {
    super('Idempotency key refers to a deleted memory');
    this.name = 'TombstonedSourceKeyConflictError';
  }
}

export class SupersededSourceKeyConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'source_key_superseded';

  constructor() {
    super('Source key refers to a superseded memory and cannot rewrite history');
    this.name = 'SupersededSourceKeyConflictError';
  }
}

export class MemoryNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'memory_not_found';

  constructor() {
    super('Memory not found or access denied');
    this.name = 'MemoryNotFoundError';
  }
}

export class MemoryConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'memory_conflict';

  constructor(message: string) {
    super(message);
    this.name = 'MemoryConflictError';
  }
}

export function isPublicApiError(error: unknown): error is Error & { statusCode: number; code: string } {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { statusCode?: unknown; code?: unknown };
  return (
    candidate.statusCode === 400 ||
    candidate.statusCode === 403 ||
    candidate.statusCode === 404 ||
    candidate.statusCode === 409
  ) && typeof candidate.code === 'string';
}
