/**
 * Small HTTP helpers shared by the plugin's routes.
 *
 * Deliberately dependency-free: the host injects a `webServer` service whose
 * registrations hand us plain Node `request`/`response` objects, so everything
 * here is built on `node:http` primitives.
 *
 * @module dsh-desktop-background/http
 */

/** Default ceiling for a JSON request body. */
export const JSON_BODY_LIMIT = 64 * 1024;

/**
 * Write a JSON response.
 *
 * `no-store` is deliberate: every one of these responses is derived from
 * mutable state on disk, and a cached copy would leave the UI describing a
 * background the profile no longer has.
 *
 * @param response - the Node response object.
 * @param status - HTTP status code.
 * @param payload - value to serialize.
 * @param headers - extra headers to merge in.
 */
export function sendJson(response, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    ...headers,
  });
  response.end(body);
}

/**
 * Write a binary response.
 *
 * @param response - the Node response object.
 * @param status - HTTP status code.
 * @param body - the bytes.
 * @param headers - response headers.
 */
export function sendBuffer(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-length': String(body.length), ...headers });
  response.end(body);
}

/** The error used for every oversized body, however it was detected. */
function bodyTooLarge(limit) {
  const error = new Error(`request body exceeds ${limit} bytes`);
  error.code = 'BODY_TOO_LARGE';
  return error;
}

/**
 * Read a request body with a hard size ceiling.
 *
 * Two independent guards, because they catch different clients:
 *
 * - a declared `Content-Length` over the ceiling is refused *before* reading,
 *   so an impossible upload costs nothing;
 * - a body that crosses the ceiling while streaming is cut off mid-flight,
 *   which is the only defence against a chunked body that never declares its
 *   size.
 *
 * Neither guard destroys the socket. A reset would reach the caller as a
 * network failure rather than as the 413 that explains what went wrong, so the
 * stream is paused instead and the response is what closes the connection.
 *
 * @param request - the Node request object.
 * @param limit - maximum accepted bytes.
 * @returns the body as a Buffer.
 * @throws when the body exceeds `limit`.
 */
export async function readBody(request, limit) {
  const declared = Number(request.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    request.pause?.();
    throw bodyTooLarge(limit);
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      request.pause?.();
      throw bodyTooLarge(limit);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Read and parse a JSON request body.
 *
 * @param request - the Node request object.
 * @param limit - maximum accepted bytes.
 * @returns the parsed value.
 * @throws when the body is oversized or not valid JSON.
 */
export async function readJsonBody(request, limit = JSON_BODY_LIMIT) {
  const buffer = await readBody(request, limit);
  if (buffer.length === 0) return {};
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    const error = new Error('request body is not valid JSON');
    error.code = 'BAD_JSON';
    throw error;
  }
}

/**
 * Whether a request may mutate this plugin's state.
 *
 * The plugin's routes are `prefix` registrations on the bare web server, which
 * places them outside DSH's own `/api` authorization fence. That is the price
 * of being reachable from a page; this check is what pays it back. Three
 * signals, in order of strength:
 *
 * - `sec-fetch-site: cross-site` is the browser's own statement that the
 *   request came from another site, and it is refused outright.
 * - a present `Origin` must equal the `Host` we were reached on.
 * - an absent `Origin` is allowed: browsers send it on same-origin POSTs too,
 *   so its absence means the caller is not a page, and a non-browser client
 *   can forge an `Origin` anyway. Refusing it would break the desktop shell's
 *   proxy, which strips the header.
 *
 * @param request - the Node request object.
 * @returns true when the request is same-origin (or not from a page at all).
 */
export function sameOrigin(request) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  const host = request.headers.host;
  if (typeof host !== 'string' || host === '') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Restrict a response to a method, answering anything else with 405.
 *
 * @param request - the Node request object.
 * @param response - the Node response object.
 * @param allowed - the accepted methods.
 * @returns true when the caller should continue handling the request.
 */
export function requireMethod(request, response, allowed) {
  const method = request.method ?? 'GET';
  if (allowed.includes(method)) return true;
  sendJson(response, 405, { error: 'method not allowed' }, { allow: allowed.join(', ') });
  return false;
}

/**
 * Guard a mutating route: same-origin only, and the method must match.
 *
 * @param request - the Node request object.
 * @param response - the Node response object.
 * @param allowed - the accepted methods.
 * @returns true when the caller should continue handling the request.
 */
export function guardMutation(request, response, allowed) {
  if (!sameOrigin(request)) {
    sendJson(response, 403, { error: 'cross-origin request refused' });
    return false;
  }
  return requireMethod(request, response, allowed);
}

/** An error that already knows the status code it deserves. */
export class HttpError extends Error {
  /**
   * @param status - the HTTP status to answer with.
   * @param message - a message safe to show the caller.
   */
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * Report a thrown error as a JSON response.
 *
 * Only errors that explicitly claim a status are repeated to the caller: a
 * message a plugin did not choose to publish can name paths, hosts, or
 * internals, so anything unexpected becomes a flat 500 and goes to the log
 * instead.
 *
 * @param error - the thrown value.
 * @param response - the Node response object.
 * @param log - a logging function for unexpected failures.
 * @param context - a short label for the log line.
 */
export function sendError(error, response, log, context) {
  if (error?.code === 'BODY_TOO_LARGE') {
    // `readBody` stopped reading partway through, so the rest of the request is
    // still in flight. Answering and closing is the only correct exit: keeping
    // the connection would mean either draining the body we just refused or
    // desynchronizing the next request on the socket.
    sendJson(response, 413, { error: error.message }, { connection: 'close' });
    return;
  }
  if (error?.code === 'BAD_JSON') {
    sendJson(response, 400, { error: error.message });
    return;
  }
  if (error instanceof HttpError) {
    sendJson(response, error.status, { error: error.message });
    return;
  }
  log?.(`${context}: ${error?.stack ?? String(error)}`);
  sendJson(response, 500, { error: 'internal error' });
}
