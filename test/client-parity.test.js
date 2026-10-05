/**
 * Source-parity tests between the host modules and the browser bundle.
 *
 * `client/client.js` is loaded as one self-contained classic script, so it
 * cannot import `lib/config.js` or `lib/presets.js`. It carries its own copies
 * of the numeric bounds and the preset gradients — which means the two can
 * silently drift, and a drifted bound is not a cosmetic bug: the panel would
 * offer a value the host refuses, or paint a preset the host does not know.
 *
 * These tests read the bundle's *text* and compare it against the host
 * modules, so a divergence fails the suite instead of reaching a user.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FITS, LIMITS, POSITIONS, PRESETS, SURFACE_OPACITY } from '../lib/config.js';
import { PRESET_GRADIENTS } from '../lib/presets.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'client', 'client.js'), 'utf8');

/**
 * Extract a top-level `const NAME = …;` literal from the bundle's text.
 *
 * The bundle is not a module and cannot be imported, so its constants are
 * recovered by evaluating the slice of source between the declaration and the
 * terminating semicolon. Only literals are read this way; anything executable
 * would not be extractable, which is itself a useful signal.
 *
 * @param name - the declared constant.
 * @returns the evaluated value.
 */
function literal(name) {
  const start = source.indexOf(`const ${name} = `);
  assert.notEqual(start, -1, `client/client.js does not declare ${name}`);
  const from = start + `const ${name} = `.length;
  const end = source.indexOf(';', from);
  assert.notEqual(end, -1, `${name} declaration is not terminated`);
  return Function(`"use strict"; return (${source.slice(from, end)});`)();
}

test('the bundle declares the same numeric limits as lib/config.js', () => {
  assert.deepEqual(literal('LIMITS'), LIMITS);
});

test('the bundle keeps the same surface opacity as lib/config.js', () => {
  // The one number both halves must agree on for the background to be visible
  // at all: `lib/config.js` documents it, the bundle applies it.
  assert.equal(literal('SURFACE_OPACITY'), SURFACE_OPACITY);
});

test('the bundle declares the same fill modes and positions as lib/config.js', () => {
  assert.deepEqual(literal('FITS'), FITS);
  assert.deepEqual(literal('POSITIONS'), POSITIONS);
});

test('the bundle declares the same preset names, in the same order', () => {
  assert.deepEqual(literal('PRESET_ORDER'), PRESETS);
});

test('the bundle declares byte-identical preset gradients', () => {
  assert.deepEqual(literal('PRESETS'), { ...PRESET_GRADIENTS });
});

test('every preset name in lib/config.js has a gradient', () => {
  for (const name of PRESETS) {
    assert.equal(typeof PRESET_GRADIENTS[name], 'string', `${name} has no gradient`);
    assert.ok(PRESET_GRADIENTS[name].length > 0, `${name} has an empty gradient`);
  }
  assert.deepEqual(Object.keys(PRESET_GRADIENTS).sort(), [...PRESETS].sort());
});

test('the bundle resolves every position the host accepts', () => {
  // A position the bundle did not know would be silently replaced by the
  // fallback, which is a setting that appears saved but does nothing.
  const positions = literal('POSITIONS');
  for (const position of POSITIONS) {
    assert.ok(positions.includes(position), `bundle does not support position ${position}`);
  }
});
