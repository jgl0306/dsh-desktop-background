/**
 * The plugin's HTTP surface.
 *
 * This is how the browser half talks to the profile: the web module system
 * serves plugin *JavaScript* only (there is no static-asset route for a
 * plugin's own files), so a user-chosen picture has to travel over a route of
 * our own rather than being read out of the installed package.
 *
 * All of it lives under one prefix so that a single registration owns the
 * namespace, one disposer tears it down, and the plugin can never shadow a
 * route belonging to the host or to another plugin:
 *
 * ```
 * GET    /dsh-desktop-background/api/v1/state            configuration + library + presets
 * PUT    /dsh-desktop-background/api/v1/config           merge a patch into the configuration
 * POST   /dsh-desktop-background/api/v1/config/reset     restore the defaults
 * POST   /dsh-desktop-background/api/v1/images           upload a picture (raw body)
 * DELETE /dsh-desktop-background/api/v1/images/<file>    delete a stored picture
 * GET    /dsh-desktop-background/assets/<file>           serve a stored picture
 * ```
 *
 * @module dsh-desktop-background/routes
 */

import { ALLOWED_IMAGE_TYPES, LIMITS, MAX_IMAGE_BYTES, mergeConfig } from './config.js';
import { HttpError, guardMutation, readBody, readJsonBody, requireMethod, sendBuffer, sendError, sendJson } from './http.js';
import { MAX_IMAGES, isSafeFileName } from './store.js';
import { listPresets } from './presets.js';

/** Every route this plugin owns begins here. */
export const ROUTE_PREFIX = '/dsh-desktop-background';

/**
 * Turn a store rejection into a 400.
 *
 * {@link BackgroundStore} answers in plain `Error`s because it is also used
 * outside HTTP; at this boundary every one of them is the caller's fault (an
 * oversized upload, bytes that are not a picture, a full library), so they are
 * promoted to a client error rather than logged as a plugin failure.
 *
 * @param operation - the store call.
 * @returns its result.
 */
async function asClientError(operation) {
  try {
    return await operation();
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'invalid request');
  }
}

/** The static half of every `state` response. */
function capabilityBlock() {
  return {
    schema: 'dsh-desktop-background/v1',
    acceptedTypes: Object.keys(ALLOWED_IMAGE_TYPES),
    maxImageBytes: MAX_IMAGE_BYTES,
    maxImages: MAX_IMAGES,
    limits: LIMITS,
  };
}

/**
 * Percent-decode one path segment.
 *
 * `decodeURIComponent` throws a `URIError` on malformed input, and this is
 * reachable straight from a URL — `/assets/%zz` must be a 400, not an
 * unhandled rejection reported as an internal error.
 *
 * @param value - the raw segment.
 * @returns the decoded segment.
 * @throws {HttpError} 400 when the encoding is malformed.
 */
function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'malformed percent-encoding in the request path');
  }
}

/**
 * Build the full state the browser half renders from.
 *
 * One round trip carries the configuration, the library, and the preset table,
 * so the panel never renders a half-known world and the image list cannot
 * disagree with the configuration it is shown next to.
 *
 * @param store - the profile-scoped store.
 * @param meta - extra identifying fields (`profile`, `version`).
 * @returns the state payload.
 */
async function buildState(store, meta) {
  const [config, images] = await Promise.all([store.readConfig(), store.listImages()]);
  return {
    ...capabilityBlock(),
    ...meta,
    config,
    images,
    presets: listPresets(),
  };
}

/**
 * Mount the plugin's routes onto the host's web server.
 *
 * @param host - the context that owns the `webServer` service.
 * @param store - the profile-scoped store.
 * @param options - `{ meta, log }`.
 * @returns a disposer for the registration.
 */
export function mountBackgroundRoutes(host, store, options = {}) {
  const { meta = {}, log = () => {} } = options;

  /**
   * Dispatch one request.
   *
   * @param request - the Node request object.
   * @param response - the Node response object.
   */
  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (!path.startsWith(ROUTE_PREFIX)) {
      sendJson(response, 404, { error: 'not found' });
      return;
    }
    const rest = path.slice(ROUTE_PREFIX.length);

    if (rest === '/api/v1/state') {
      if (!requireMethod(request, response, ['GET'])) return;
      sendJson(response, 200, await buildState(store, meta));
      return;
    }

    if (rest === '/api/v1/config') {
      if (!guardMutation(request, response, ['PUT', 'POST'])) return;
      const patch = await readJsonBody(request);
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new HttpError(400, 'the configuration patch must be a JSON object');
      }
      // `mergeConfig` re-normalizes, so an out-of-range or unknown field is
      // dropped rather than stored: the panel cannot be talked into an
      // unrenderable configuration by a hand-written request.
      const config = await store.writeConfig(patch);
      sendJson(response, 200, { config });
      return;
    }

    if (rest === '/api/v1/config/reset') {
      if (!guardMutation(request, response, ['POST'])) return;
      sendJson(response, 200, { config: await store.resetConfig() });
      return;
    }

    if (rest === '/api/v1/images') {
      if (!guardMutation(request, response, ['POST'])) return;
      // The declared content type is not consulted: the bytes are sniffed, and
      // any surplus request header is not a reason to trust a file.
      const body = await readBody(request, MAX_IMAGE_BYTES);
      const image = await asClientError(() => store.addImage(body));
      sendJson(response, 201, { image });
      return;
    }

    const deleteMatch = /^\/api\/v1\/images\/(.+)$/.exec(rest);
    if (deleteMatch !== null) {
      if (!guardMutation(request, response, ['DELETE'])) return;
      const file = decodeSegment(deleteMatch[1]);
      if (!isSafeFileName(file)) {
        throw new HttpError(400, 'not a stored image name');
      }
      const removed = await store.removeImage(file);
      if (!removed) throw new HttpError(404, 'no such image');

      // A configuration left pointing at a deleted file would render an empty
      // backdrop with no explanation, so the reference is cleared with it.
      const ref = `managed:${file}`;
      const config = await store.readConfig();
      if (config.image === ref) {
        await store.writeConfig({ image: null });
      }
      sendJson(response, 200, { removed: true, state: await buildState(store, meta) });
      return;
    }

    const assetMatch = /^\/assets\/(.+)$/.exec(rest);
    if (assetMatch !== null) {
      if (!requireMethod(request, response, ['GET'])) return;
      const file = decodeSegment(assetMatch[1]);
      const image = await store.readImage(file);
      if (image === null) throw new HttpError(404, 'no such image');
      sendBuffer(response, 200, image.data, {
        'content-type': image.mime,
        // Stored names are content hashes, so the bytes behind a URL can never
        // change: this is the one place `immutable` is literally true. A new
        // picture is a new URL, which is what makes the cache safe.
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      });
      return;
    }

    sendJson(response, 404, { error: 'not found' });
  }

  return host.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (request, response) => {
      Promise.resolve(handle(request, response)).catch((error) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        sendError(error, response, log, `${request.method} ${request.url}`);
      });
    },
  });
}
