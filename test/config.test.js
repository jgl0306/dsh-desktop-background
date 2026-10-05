/**
 * Unit tests for the configuration model.
 *
 * Run with: `npm test` (which is `node --test test/`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONFIG,
  LIMITS,
  MAX_IMAGE_BYTES,
  activeImageRef,
  clamp,
  mergeConfig,
  normalizeConfig,
  normalizeImageRef,
} from '../lib/config.js';

test('defaults are inert: installing the plugin paints nothing', () => {
  assert.equal(DEFAULT_CONFIG.enabled, false);
  assert.equal(DEFAULT_CONFIG.lightImage, null);
  assert.equal(DEFAULT_CONFIG.darkImage, null);
  assert.equal(activeImageRef(DEFAULT_CONFIG), null);
});

test('normalizeConfig fills every key of the default shape', () => {
  const config = normalizeConfig({});
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    assert.ok(key in config, `missing key ${key}`);
  }
  assert.deepEqual(Object.keys(config).sort(), Object.keys(DEFAULT_CONFIG).sort());
});

test('normalizeConfig survives junk input', () => {
  for (const junk of [null, undefined, 42, 'nope', [], true]) {
    const config = normalizeConfig(junk);
    assert.deepEqual(config, normalizeConfig({}));
  }
});

test('every numeric setting is clamped to its documented range', () => {
  for (const [key, limit] of Object.entries(LIMITS)) {
    const low = normalizeConfig({ [key]: -1e9 });
    const high = normalizeConfig({ [key]: 1e9 });
    assert.equal(low[key], limit.min, `${key} lower bound`);
    assert.equal(high[key], limit.max, `${key} upper bound`);
  }
});

test('clamp falls back to the default for input with no magnitude', () => {
  assert.equal(clamp('opacity', 'not a number'), DEFAULT_CONFIG.opacity);
  assert.equal(clamp('opacity', Number.NaN), DEFAULT_CONFIG.opacity);
  assert.equal(clamp('opacity', ''), DEFAULT_CONFIG.opacity, 'a cleared input is not zero');
  assert.equal(clamp('opacity', '   '), DEFAULT_CONFIG.opacity);
  assert.equal(clamp('opacity', Infinity), LIMITS.opacity.max, 'Infinity means "as large as allowed"');
  assert.equal(clamp('opacity', -Infinity), LIMITS.opacity.min);
});

test('numeric strings are coerced rather than rejected', () => {
  // The settings UI round-trips values through <input> elements, which are
  // always strings; a stored "0.5" must mean the number 0.5.
  assert.equal(normalizeConfig({ opacity: '0.5' }).opacity, 0.5);
  assert.equal(normalizeConfig({ blur: '12' }).blur, 12);
});

test('enum settings fall back to the default when unknown', () => {
  assert.equal(normalizeConfig({ fit: 'squish' }).fit, DEFAULT_CONFIG.fit);
  assert.equal(normalizeConfig({ position: 'middle' }).position, DEFAULT_CONFIG.position);
  assert.equal(normalizeConfig({ fit: 7 }).fit, DEFAULT_CONFIG.fit);
});

test('overlayColor accepts only hex colours', () => {
  assert.equal(normalizeConfig({ overlayColor: '#fff' }).overlayColor, '#fff');
  assert.equal(normalizeConfig({ overlayColor: '#10203040' }).overlayColor, '#10203040');
  assert.equal(normalizeConfig({ overlayColor: 'red' }).overlayColor, DEFAULT_CONFIG.overlayColor);
  assert.equal(
    normalizeConfig({ overlayColor: 'url(evil)' }).overlayColor,
    DEFAULT_CONFIG.overlayColor,
  );
});

test('unknown keys are dropped, not carried forward', () => {
  const config = normalizeConfig({ opacity: 0.5, somethingElse: 'x', __proto__: 'y' });
  assert.equal('somethingElse' in config, false);
  assert.equal(config.opacity, 0.5);
});

test('image references accept only managed and known preset forms', () => {
  assert.equal(normalizeImageRef('managed:wallpaper.png'), 'managed:wallpaper.png');
  assert.equal(normalizeImageRef('  managed:a_b-c.1.webp  '), 'managed:a_b-c.1.webp');
  assert.equal(normalizeImageRef('preset:aurora'), 'preset:aurora');
  assert.equal(normalizeImageRef('preset:does-not-exist'), null);
  assert.equal(normalizeImageRef(null), null);
  assert.equal(normalizeImageRef(12), null);
  assert.equal(normalizeImageRef(''), null);
});

test('image references cannot escape the plugin data directory', () => {
  const hostile = [
    '../../../../etc/passwd',
    'managed:../../etc/passwd',
    'managed:/etc/passwd',
    'managed:a/b',
    'file:///etc/passwd',
    '/etc/passwd',
    'https://example.com/x.png',
    'managed:',
    'managed:a b',
  ];
  for (const value of hostile) {
    assert.equal(normalizeImageRef(value), null, `must reject ${value}`);
  }
});

test('activeImageRef requires the plugin to be enabled', () => {
  const withImage = normalizeConfig({ lightImage: 'preset:aurora' });
  assert.equal(withImage.enabled, false);
  assert.equal(activeImageRef(withImage), null);
  assert.equal(activeImageRef({ ...withImage, enabled: true }), 'preset:aurora');
});

test('activeImageRef prefers the light image and falls back to the dark one', () => {
  const both = normalizeConfig({
    enabled: true,
    lightImage: 'preset:aurora',
    darkImage: 'preset:dusk',
  });
  assert.equal(activeImageRef(both), 'preset:aurora');
  const darkOnly = normalizeConfig({ enabled: true, darkImage: 'preset:dusk' });
  assert.equal(activeImageRef(darkOnly), 'preset:dusk');
});

test('mergeConfig applies a partial patch onto a normalized base', () => {
  const base = normalizeConfig({ enabled: true, opacity: 0.4, lightImage: 'preset:ocean' });
  const merged = mergeConfig(base, { opacity: 0.9 });
  assert.equal(merged.opacity, 0.9);
  assert.equal(merged.lightImage, 'preset:ocean');
  assert.equal(merged.enabled, true);
});

test('mergeConfig re-normalizes, so a patch cannot escape the bounds', () => {
  const base = normalizeConfig({});
  assert.equal(mergeConfig(base, { opacity: 99 }).opacity, LIMITS.opacity.max);
  assert.equal(mergeConfig(base, { opacity: 'x' }).opacity, DEFAULT_CONFIG.opacity);
  assert.equal(mergeConfig(base, { fit: 'nope' }).fit, DEFAULT_CONFIG.fit);
  assert.equal(mergeConfig(base, { lightImage: '../etc/passwd' }).lightImage, null);
});

test('mergeConfig ignores non-object patches', () => {
  const base = normalizeConfig({ opacity: 0.3 });
  for (const junk of [null, undefined, 'x', 5, []]) {
    assert.deepEqual(mergeConfig(base, junk), base);
  }
});

test('mergeConfig never mutates its input', () => {
  const base = normalizeConfig({ opacity: 0.3, enabled: true });
  const snapshot = JSON.stringify(base);
  mergeConfig(base, { opacity: 0.9 });
  assert.equal(JSON.stringify(base), snapshot);
});

test('the upload cap is a sane, documented value', () => {
  assert.ok(MAX_IMAGE_BYTES >= 1024 * 1024, 'must allow at least 1 MiB');
  assert.ok(MAX_IMAGE_BYTES <= 64 * 1024 * 1024, 'must not allow unbounded uploads');
});
