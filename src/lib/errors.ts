export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHENTICATED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access forbidden') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(409, 'CONFLICT', message);
  }
}

export class InvalidTransitionError extends AppError {
  constructor(message = 'Invalid state transition') {
    super(409, 'INVALID_TRANSITION', message);
  }
}

export class InvalidStayWindowError extends AppError {
  constructor(message = 'Stay window must be between 1 and 60 nights with checkout after checkin') {
    super(422, 'INVALID_STAY_WINDOW', message);
  }
}

export class StayNotBookableError extends AppError {
  constructor(message = 'Stay is not bookable with the selected dates or rooms', details?: unknown) {
    super(422, 'STAY_NOT_BOOKABLE', message, details);
  }
}

export class GroupRequestRequiredError extends AppError {
  constructor(message = 'Group request required for stays with 5+ rooms or 12+ guests', details?: unknown) {
    super(422, 'GROUP_REQUEST_REQUIRED', message, details);
  }
}

export class RateLimitedError extends AppError {
  constructor(public retryAfter: number, message = 'Too many requests') {
    super(429, 'RATE_LIMITED', message);
  }
}
