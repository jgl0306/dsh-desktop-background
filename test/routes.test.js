/**
 * Integration tests for the plugin's HTTP surface.
 *
 * The route handler is mounted on a real `node:http` server and driven with
 * real requests, so what is asserted here is the wire contract the browser half
 * depends on: status codes, headers, the shape of each payload, and the guards
 * that keep a page on another origin from rewriting the profile.
 *
 * A throwaway profile directory is used throughout — nothing touches the user's
 * real profile, and nothing depends on a DSH process being up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CONFIG, MAX_IMAGE_BYTES, PRESETS } from '../lib/config.js';
import { HttpError, readBody, sameOrigin, sendError } from '../lib/http.js';
import { ROUTE_PREFIX, mountBackgroundRoutes } from '../lib/routes.js';
import { BackgroundStore, DATA_DIR_NAME } from '../lib/store.js';

/** A real 1×1 PNG, so the magic-byte check sees genuine image data. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Mount the routes on a real server over a throwaway profile.
 *
 * @param run - receives `{ base, store, dir, registrations, dispose }`.
 */
async function withServer(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dbg-http-'));
  const store = new BackgroundStore(dir);
  const registrations = [];
  const host = {
    webServer: {
      register(spec) {
        registrations.push(spec);
        return () => {
          const index = registrations.indexOf(spec);
          if (index !== -1) registrations.splice(index, 1);
        };
      },
    },
  };
  const dispose = mountBackgroundRoutes(host, store, {
    meta: { version: '1.0.0', profile: 'test' },
    log: () => {},
  });

  assert.equal(registrations.length, 1, 'exactly one registration owns the namespace');
  const spec = registrations[0];
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1');
    const owned = pathname === spec.path || pathname.startsWith(`${spec.path}/`);
    if (!owned) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"host 404"}');
      return;
    }
    spec.handler(request, response);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run({ base: `http://127.0.0.1:${port}`, store, dir, registrations, spec, dispose });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

/** @returns the parsed body plus the response, for header assertions. */
async function getJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  return { response, body: text === '' ? null : JSON.parse(text) };
}

test('the registration is a single prefix, not a set of exact paths', async () => {
  await withServer(async ({ spec }) => {
    assert.equal(spec.kind, 'prefix');
    assert.equal(spec.path, ROUTE_PREFIX);
    assert.equal(typeof spec.handler, 'function');
  });
});

test('the registration can be torn down', async () => {
  await withServer(async ({ registrations, dispose }) => {
    assert.equal(registrations.length, 1);
    dispose();
    assert.equal(registrations.length, 0, 'unload must release the prefix');
  });
});

test('state answers with the full world in one round trip', async () => {
  await withServer(async ({ base }) => {
    const { response, body } = await getJson(`${base}${ROUTE_PREFIX}/api/v1/state`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(body.schema, 'dsh-desktop-background/v1');
    assert.equal(body.version, '1.0.0');
    assert.equal(body.profile, 'test');
    assert.deepEqual(body.config, { ...DEFAULT_CONFIG });
    assert.deepEqual(body.images, []);
    assert.equal(body.presets.length, PRESETS.length);
    for (const preset of body.presets) {
      assert.equal(typeof preset.id, 'string');
      assert.ok(preset.gradient.length > 0);
    }
    assert.equal(body.maxImages, 50);
    assert.deepEqual(body.acceptedTypes, ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
    assert.ok(!body.acceptedTypes.includes('image/svg+xml'), 'SVG is a script container and must not be accepted');
    assert.equal(typeof body.limits.opacity.max, 'number');
  });
});

test('a fresh install changes nothing until it is asked to', async () => {
  await withServer(async ({ base }) => {
    const { body } = await getJson(`${base}${ROUTE_PREFIX}/api/v1/state`);
    assert.equal(body.config.enabled, false);
    assert.equal(body.config.lightImage, null);
    assert.equal(body.config.darkImage, null);
  });
});

test('state is read-only over this plugin\'s route table', async () => {
  await withServer(async ({ base }) => {
    const { response, body } = await getJson(`${base}${ROUTE_PREFIX}/api/v1/state`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
    assert.equal(body.error, 'method not allowed');
  });
});

test('a path outside the prefix is never this plugin\'s business', async () => {
  await withServer(async ({ base }) => {
    const { response, body } = await getJson(`${base}/api/v1/something-else`);
    assert.equal(response.status, 404);
    assert.equal(body.error, 'host 404');
  });
});

test('an unknown path inside the prefix is a JSON 404', async () => {
  await withServer(async ({ base }) => {
    const { response, body } = await getJson(`${base}${ROUTE_PREFIX}/api/v1/nope`);
    assert.equal(response.status, 404);
    assert.equal(body.error, 'not found');
  });
});

test('a configuration patch is merged, clamped, and stripped of unknown keys', async () => {
  await withServer(async ({ base }) => {
    const { response, body } = await getJson(`${base}${ROUTE_PREFIX}/api/v1/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        opacity: 5,
        blur: -3,
        zoom: 10_000,
        fit: 'nonsense',
        lightImage: 'preset:aurora',
        'not-a-field': 'ignored',
        __proto__: { polluted: true },
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(body.config.enabled, true);
    assert.equal(body.config.opacity, 1, 'above the maximum clamps to it');
    assert.equal(body.config.blur, 0, 'below the minimum clamps to it');
    assert.equal(body.config.zoom, 200, 'the zoom ceiling holds');
    assert.equal(body.config.fit, 'cover', 'an unknown enum falls back');
    assert.equal(body.config.lightImage, 'preset:aurora');
    assert.equal(body.config['not-a-field'], undefined);
    assert.equal({}.polluted, undefined, 'a prototype key must not survive normalization');
  });
});

test('the patch is durable: it is on disk and visible to the next read', async () => {
  await withServer(async ({ base, dir }) => {
    await getJson(`${base}${ROUTE_PREFIX}/api/v1/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, opacity: 0.4 }),
    });

    const onDisk = JSON.parse(await readFile(join(dir, DATA_DIR_NAME, 'config.json'), 'utf8'));
    assert.equal(onDisk.enabled, true);
    assert.equal(onDisk.opacity, 0.4);

    const { body } = await getJson(`${base}${ROUTE_PREFIX}/api/v1/state`);
    assert.equal(body.config.enabled, true);
    assert.equal(body.config.opacity, 0.4);
  });
});

test('a cross-site request cannot rewrite the configuration', async () => {
  await withServer(async ({ base, store }) => {
    const before = await store.readConfig();
    const { response, body } = await getJson(`${base}${ROUTE_PREFIX}/api/v1/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ enabled: true }),
    });

    assert.equal(response.status, 403);
    assert.equal(body.error, 'cross-origin request refused');
    assert.deepEqual(await store.readConfig(), before, 'the profile must be untouched');
  });
});

test('the browser\'s own cross-site claim is believed over a matching origin', async () => {
  await withServer(async ({ base, store }) => {
    const before = await store.readConfig();
    const port = new URL(base).port;
    const { response } = await getJson(`${base}${ROUTE_PREFIX}/api/v1/config`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${port}`,
        'sec-fetch-site': 'cross-site',
      },
      body: JSON.stringify({ enabled: true }),
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await store.readConfig(), before);
  });
});

test('a same-origin request is accepted', async () => {
  await withServer(async ({ base }) => {
    const { response } = await getJson(`${base}${ROUTE_PREFIX}/api/v1/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(response.status, 200);
  });
});

test('a malformed JSON body is a 400, not a crash', async () => {
  await withServer(async ({ base }) => {
    const { response, body } = await getJson(`${base}${ROUTE_PREFIX}/api/v1/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(response.status, 400);
    assert.match(body.error, /not valid JSON/);
  });
});

test('a non-object configuration patch is refused', async () => {
  await withServer(async ({ base }) => {
    for (const payload of ['[1,2,3]', '"a string"', 'null']) {
      const { response } = await getJson(`${base}${ROUTE_PREFIX}/api/v1/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
      // eslint-disable-next-line no-await-in-loop -- one request per rejected shape
      assert.equal(response.status, 400, `payload ${payload}`);
    }
  });
});

test('reset restores the shipped defaults', async () => {
  await withServer(async ({ base, store }) => {
    await getJson(`${base}${ROUTE_PREFIX}/api/v1/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, opacity: 0.3 }),
    });

    const { response, body } = await getJson(`${base}${ROUTE_PREFIX}/api/v1/config/reset`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(body.config, { ...DEFAULT_CONFIG });
    assert.deepEqual(await store.readConfig(), { ...DEFAULT_CONFIG });
  });
});

test('an upload is stored under its own content hash and served back byte-for-byte', async () => {
  await withServer(async ({ base }) => {
    const upload = await getJson(`${base}${ROUTE_PREFIX}/api/v1/images`, { method: 'POST', body: PNG });
    assert.equal(upload.response.status, 201);
    const { file, ref, bytes, mime } = upload.body.image;
    assert.match(file, /^[a-f0-9]{64}\.png$/);
    assert.equal(ref, `managed:${file}`);
    assert.equal(bytes, PNG.length);
    assert.equal(mime, 'image/png');

    const download = await fetch(`${base}${ROUTE_PREFIX}/assets/${file}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'image/png');
    assert.equal(download.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(download.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.match(download.headers.get('content-security-policy'), /default-src 'none'/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), PNG);
  });
});

test('the same bytes are stored once', async () => {
  await withServer(async ({ base }) => {
    const first = await getJson(`${base}${ROUTE_PREFIX}/api/v1/images`, { method: 'POST', body: PNG });
    const second = await getJson(`${base}${ROUTE_PREFIX}/api/v1/images`, { method: 'POST', body: PNG });
    assert.equal(first.body.image.ref, second.body.image.ref);

    const { body } = await getJson(`${base}${ROUTE_PREFIX}/api/v1/state`);
    assert.equal(body.images.length, 1);
  });
});

test('the declared content type is never trusted', async () => {
  await withServer(async ({ base }) => {
    // Bytes are a PNG, the header lies. The stored extension follows the bytes,
    // because an extension is what the server later uses to pick a MIME type.
    const { response, body } = await getJson(`${base}${ROUTE_PREFIX}/api/v1/images`, {
      method: 'POST',
      headers: { 'content-type': 'text/html' },
      body: PNG,
    });
    assert.equal(response.status, 201);
    assert.equal(body.image.mime, 'image/png');
    assert.ok(body.image.file.endsWith('.png'));
  });
});

test('an upload that is not a picture is refused', async () => {
  await withServer(async ({ base, store }) => {
    const { response, body } = await getJson(`${base}${ROUTE_PREFIX}/api/v1/images`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    });
    assert.equal(response.status, 400);
    assert.match(body.error, /unsupported|image/i);
    assert.deepEqual(await store.listImages(), [], 'nothing may be written for a rejected upload');
  });
});

test('uploads are refused on a read-only method', async () => {
  await withServer(async ({ base }) => {
    const { response } = await getJson(`${base}${ROUTE_PREFIX}/api/v1/images`);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  });
});

test('an asset is addressed by a validated name only', async () => {
  await withServer(async ({ base }) => {
    // `%252e%252e%252f` survives URL normalization and decodes once more in the
    // route, so this reaches `readImage` as `../config.json` and must be refused
    // by the name check rather than by the URL parser.
    const traversal = await getJson(`${base}${ROUTE_PREFIX}/assets/%252e%252e%252fconfig.json`);
    assert.equal(traversal.response.status, 404);

    const malformed = await getJson(`${base}${ROUTE_PREFIX}/assets/%zz`);
    assert.equal(malformed.response.status, 400, 'malformed encoding is the caller\'s error, not a 500');

    const missing = await getJson(`${base}${ROUTE_PREFIX}/assets/${'0'.repeat(64)}.png`);
    assert.equal(missing.response.status, 404);
  });
});

test('deleting the picture a theme points at clears that reference', async () => {
  await withServer(async ({ base }) => {
    const upload = await getJson(`${base}${ROUTE_PREFIX}/api/v1/images`, { method: 'POST', body: PNG });
    const ref = upload.body.image.ref;

    await getJson(`${base}${ROUTE_PREFIX}/api/v1/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, lightImage: ref }),
    });

    const removed = await getJson(`${base}${ROUTE_PREFIX}/api/v1/images/${upload.body.image.file}`, {
      method: 'DELETE',
    });
    assert.equal(removed.response.status, 200);
    assert.equal(removed.body.removed, true);
    // A reference left behind would render an empty backdrop with no
    // explanation, so it is cleared together with the file.
    assert.equal(removed.body.state.config.lightImage, null);
    assert.deepEqual(removed.body.state.images, []);

    const asset = await fetch(`${base}${ROUTE_PREFIX}/assets/${upload.body.image.file}`);
    assert.equal(asset.status, 404, 'the bytes must be gone too');
  });
});

test('deleting an unrelated picture leaves the configuration alone', async () => {
  await withServer(async ({ base }) => {
    const first = await getJson(`${base}${ROUTE_PREFIX}/api/v1/images`, { method: 'POST', body: PNG });
    const other = await getJson(`${base}${ROUTE_PREFIX}/api/v1/images`, {
      method: 'POST',
      body: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 1)]),
    });

    await getJson(`${base}${ROUTE_PREFIX}/api/v1/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lightImage: first.body.image.ref }),
    });

    const removed = await getJson(`${base}${ROUTE_PREFIX}/api/v1/images/${other.body.image.file}`, {
      method: 'DELETE',
    });
    assert.equal(removed.body.state.config.lightImage, first.body.image.ref);
  });
});

test('a delete names a stored image or is refused', async () => {
  await withServer(async ({ base }) => {
    const unsafe = await getJson(`${base}${ROUTE_PREFIX}/api/v1/images/..%2F..%2Fetc%2Fpasswd`, { method: 'DELETE' });
    assert.equal(unsafe.response.status, 400);

    const missing = await getJson(`${base}${ROUTE_PREFIX}/api/v1/images/${'0'.repeat(64)}.png`, {
      method: 'DELETE',
    });
    assert.equal(missing.response.status, 404);
  });
});

test('a non-prefix path handed to the handler directly is still a JSON 404', async () => {
  await withServer(async ({ base }) => {
    // The host only routes matching prefixes here, but the handler must not
    // depend on that: a mis-registration must not turn into a 500.
    const { response } = await getJson(`${base}${ROUTE_PREFIX}`);
    assert.equal(response.status, 404);
  });
});

test('a JSON body past the ceiling is refused with a 413', async () => {
  await withServer(async ({ base }) => {
    const { response, body } = await getJson(`${base}${ROUTE_PREFIX}/api/v1/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(100 * 1024) }),
    });
    assert.equal(response.status, 413);
    assert.match(body.error, /exceeds/);
    assert.equal(response.headers.get('connection'), 'close');
  });
});

test('the upload ceiling is above a real photograph and below a runaway', () => {
  assert.equal(MAX_IMAGE_BYTES, 16 * 1024 * 1024);
});

// --- unit level, where the socket behaviour of an early 413 is not the point --

/** A request stand-in that records whether it was consumed or paused. */
function fakeRequest({ headers = {}, chunks = [] } = {}) {
  return {
    headers,
    pauseCount: 0,
    iterated: 0,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        this.iterated += 1;
        yield chunk;
      }
    },
    pause() {
      this.pauseCount += 1;
    },
    destroy() {
      throw new Error('readBody must not destroy the socket; it destroys the response');
    },
  };
}

/** A response stand-in that captures what would be written. */
function fakeResponse() {
  const captured = { status: null, headers: null, body: null, ended: false };
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers;
      return this;
    },
    end(body) {
      captured.body = body;
      captured.ended = true;
    },
  };
}

test('readBody refuses a declared content length over the ceiling without reading', async () => {
  const request = fakeRequest({ headers: { 'content-length': '4096' }, chunks: [Buffer.alloc(10)] });
  await assert.rejects(() => readBody(request, 64), (error) => error.code === 'BODY_TOO_LARGE');
  assert.equal(request.iterated, 0, 'an impossible upload must not be buffered at all');
  assert.equal(request.pauseCount, 1);
});

test('readBody refuses a chunked body that crosses the ceiling while streaming', async () => {
  // Five chunks of 32 bytes against a 64-byte ceiling: reading must stop at the
  // third chunk, the one that crosses, and never reach the fourth or fifth.
  const request = fakeRequest({
    headers: {},
    chunks: [Buffer.alloc(32), Buffer.alloc(32), Buffer.alloc(32), Buffer.alloc(32), Buffer.alloc(32)],
  });
  await assert.rejects(() => readBody(request, 64), (error) => error.code === 'BODY_TOO_LARGE');
  assert.equal(request.iterated, 3, 'reading must stop at the chunk that crosses the ceiling');
  assert.equal(request.pauseCount, 1);
});

test('readBody accepts a body exactly on the ceiling', async () => {
  const request = fakeRequest({ headers: { 'content-length': '64' }, chunks: [Buffer.alloc(64)] });
  assert.equal((await readBody(request, 64)).length, 64);
});

test('readBody does not migrate the error code of an unrelated failure', async () => {
  const request = fakeRequest({ headers: { 'content-length': 'not-a-number' }, chunks: [Buffer.alloc(4)] });
  assert.equal((await readBody(request, 64)).length, 4);
});

test('sameOrigin follows the three documented signals', () => {
  assert.equal(sameOrigin({ headers: {} }), true, 'no Origin means not a page');
  assert.equal(sameOrigin({ headers: { origin: 'http://127.0.0.1:1', host: '127.0.0.1:1' } }), true);
  assert.equal(sameOrigin({ headers: { origin: 'http://127.0.0.1:2', host: '127.0.0.1:1' } }), false);
  assert.equal(sameOrigin({ headers: { origin: 'http://127.0.0.1:1' } }), false, 'no Host to compare against');
  assert.equal(sameOrigin({ headers: { origin: 'not a url', host: '127.0.0.1:1' } }), false);
  assert.equal(
    sameOrigin({ headers: { origin: 'http://127.0.0.1:1', host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' } }),
    false,
    'the browser statement outranks a matching origin',
  );
});

test('an unexpected error is a flat 500 and is logged, not echoed', () => {
  const response = fakeResponse();
  const logged = [];
  sendError(new Error('/Users/someone/.dsh/profiles/desktop/compat.json is unreadable'), response, (line) => logged.push(line), 'PUT x');

  assert.equal(response.captured.status, 500);
  assert.equal(JSON.parse(response.captured.body).error, 'internal error');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /PUT x:/);
});

test('an HttpError publishes the status and message it chose', () => {
  const response = fakeResponse();
  sendError(new HttpError(400, 'not a stored image name'), response, () => {}, 'ctx');
  assert.equal(response.captured.status, 400);
  assert.equal(JSON.parse(response.captured.body).error, 'not a stored image name');
});

test('an oversized body becomes a 413 that closes the connection', () => {
  const response = fakeResponse();
  const error = Object.assign(new Error('request body exceeds 64 bytes'), { code: 'BODY_TOO_LARGE' });
  sendError(error, response, () => {}, 'ctx');
  assert.equal(response.captured.status, 413);
  assert.equal(response.captured.headers.connection, 'close');
});

/**
 * Mount our prefix next to a stand-in for a real neighbour plugin — the
 * desktop profile ships with `dshmarket`, which owns `/dsh-market` — and
 * dispatch the way the host does: longest matching prefix wins, and a prefix
 * matches only on a path-segment boundary.
 *
 * @param run - receives `{ base, disposeMine, registrations }`.
 */
async function withSharedServer(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dbg-coexist-'));
  const store = new BackgroundStore(dir);
  const registrations = [];
  const host = {
    webServer: {
      register(spec) {
        registrations.push(spec);
        return () => {
          const index = registrations.indexOf(spec);
          if (index !== -1) registrations.splice(index, 1);
        };
      },
    },
  };

  const disposeMine = mountBackgroundRoutes(host, store, {
    meta: { version: '1.0.0', profile: 'test' },
    log: () => {},
  });
  host.webServer.register({
    kind: 'prefix',
    path: '/dsh-market',
    handler: (request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"who":"neighbour"}');
    },
  });

  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1');
    const match = registrations
      .filter((spec) => pathname === spec.path || pathname.startsWith(`${spec.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!match) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"host 404"}');
      return;
    }
    match.handler(request, response);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run({ base: `http://127.0.0.1:${port}`, disposeMine, store, dir, registrations });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test('a neighbour plugin keeps its namespace while we are mounted', async () => {
  await withSharedServer(async ({ base, registrations }) => {
    assert.equal(registrations.length, 2, 'one registration each');

    const neighbour = await getJson(`${base}/dsh-market/api/v1/capabilities`);
    assert.equal(neighbour.response.status, 200);
    assert.equal(neighbour.body.who, 'neighbour', 'our requests must never be routed to a neighbour handler');

    const mine = await getJson(`${base}${ROUTE_PREFIX}/api/v1/state`);
    assert.equal(mine.response.status, 200);
    assert.equal(mine.body.schema, 'dsh-desktop-background/v1');
  });
});

test('a path that only shares our prefix as a string is not ours', async () => {
  await withSharedServer(async ({ base }) => {
    // Without the segment-boundary rule a naive `startsWith` would hand this to
    // us, and a future plugin named `dsh-desktop-background-tools` would break.
    const { response, body } = await getJson(`${base}${ROUTE_PREFIX}-extra/api/v1/state`);
    assert.equal(response.status, 404);
    assert.equal(body.error, 'host 404');
  });
});

test('unloading us leaves a neighbour serving', async () => {
  await withSharedServer(async ({ base, disposeMine, registrations }) => {
    disposeMine();
    assert.equal(registrations.length, 1, 'only our prefix is released');

    assert.equal((await getJson(`${base}/dsh-market/api/v1/capabilities`)).response.status, 200);
    assert.equal((await getJson(`${base}${ROUTE_PREFIX}/api/v1/state`)).response.status, 404);
  });
});

test('the namespace is our own package name, claimed exactly once', async () => {
  await withSharedServer(async ({ registrations }) => {
    const paths = registrations.map((spec) => spec.path);
    assert.equal(new Set(paths).size, paths.length, 'no duplicate prefix can be claimed');
    assert.ok(paths.includes(ROUTE_PREFIX));
  });
});
