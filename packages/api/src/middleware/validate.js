import { ApiError } from '@statpulse/core';

/**
 * Validate a request against a zod schema.
 *
 * Validation happens at the boundary and the handler downstream receives
 * parsed data - it never re-checks shapes. `parse` also strips unknown
 * keys, so a client cannot smuggle an extra field into an object that
 * later gets spread into a database write. That is not hypothetical: it
 * is how a `role: "owner"` ends up on a self-registration.
 */
function formatIssues(error) {
  return error.issues.map((i) => ({
    field: i.path.join('.') || '(body)',
    message: i.message,
  }));
}

export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(
        ApiError.badRequest(
          'validation_failed',
          'Request body failed validation',
          formatIssues(result.error),
        ),
      );
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return next(
        ApiError.badRequest(
          'validation_failed',
          'Query parameters failed validation',
          formatIssues(result.error),
        ),
      );
    }
    // Express 5 makes req.query a getter, so it cannot be reassigned.
    // The parsed result is handed on through a field of our own.
    req.validatedQuery = result.data;
    next();
  };
}
