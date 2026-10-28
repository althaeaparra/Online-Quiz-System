/** Consistent JSON envelope: { success, data, meta?, message? }. */

export function ok(res, data = null, { status = 200, meta, message } = {}) {
  return res.status(status).json({
    success: true,
    ...(message ? { message } : {}),
    data,
    ...(meta ? { meta } : {}),
  });
}

export function created(res, data = null, { meta, message } = {}) {
  return ok(res, data, { status: 201, meta, message });
}

export function noContent(res) {
  return res.status(204).end();
}

export default { ok, created, noContent };
