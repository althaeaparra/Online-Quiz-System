import { ZodError } from 'zod';
import { ValidationError } from '../utils/errors.js';

/**
 * Validate & coerce a request part with a Zod schema.
 * Parsed (typed, stripped) data replaces the raw input.
 */
export const validate = (schema, source = 'body') => (req, _res, next) => {
  try {
    const parsed = schema.parse(req[source] ?? {});
    if (source === 'query') {
      // Express 5 exposes req.query as a getter; assign onto a plain object.
      Object.defineProperty(req, 'validatedQuery', { value: parsed, writable: true, configurable: true });
    } else {
      req[source] = parsed;
    }
    return next();
  } catch (err) {
    if (err instanceof ZodError) {
      const details = err.issues.map((issue) => ({
        field: issue.path.join('.') || source,
        message: issue.message,
        code: issue.code,
      }));
      return next(new ValidationError('Please check the highlighted fields', details));
    }
    return next(err);
  }
};

export default validate;
