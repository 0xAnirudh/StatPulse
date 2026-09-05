/**
 * An error with an HTTP status and a stable machine-readable code.
 *
 * Clients branch on `code`, never on the message. Messages are for
 * humans and change freely; codes are part of the API contract.
 */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message ?? code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }

  static badRequest(code, message, details) {
    return new ApiError(400, code, message, details);
  }

  static unauthorized(code = 'unauthorized', message) {
    return new ApiError(401, code, message);
  }

  static forbidden(code = 'forbidden', message) {
    return new ApiError(403, code, message);
  }

  static notFound(code = 'not_found', message) {
    return new ApiError(404, code, message);
  }

  static conflict(code, message) {
    return new ApiError(409, code, message);
  }

  static unprocessable(code, message) {
    return new ApiError(422, code, message);
  }

  static tooManyRequests(code = 'rate_limited', message) {
    return new ApiError(429, code, message);
  }

  static unavailable(code = 'unavailable', message) {
    return new ApiError(503, code, message);
  }
}
