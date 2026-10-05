/**
 * The package manifest is the one place a version and a name are declared.
 *
 * `lib/index.js` used to carry its own copy of the version, and the copy went
 * stale the moment the package was bumped — the running host then reported a
 * build number that no longer existed, which makes "which version am I running"
 * unanswerable. These tests keep the single source single.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { name, version } from '../lib/index.js';
import { ROUTE_PREFIX } from '../lib/routes.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('the reported version is the package version, not a copy that can drift', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(version, manifest.version);
});

test('the plugin name and its route prefix both come from the package name', () => {
  assert.equal(name, manifest.name);
  assert.equal(ROUTE_PREFIX, `/${manifest.name}`);
});
