/**
 * Plugin configuration model: defaults, bounds, and normalization.
 *
 * This module is the single source of truth for the *shape* of the plugin's
 * settings. It is dependency-free ESM so that it can be unit tested without a
 * build step and imported by the host entry point.
 *
 * The browser bundle (`client/client.js`) cannot import this file — a client
 * plugin is loaded as one self-contained script — so the browser keeps its own
 * copy of the numeric bounds. `test/config-parity.test.js` asserts the two
 * copies never drift.
 *
 * @module dsh-desktop-background/config
 */

/** Inclusive numeric bounds and UI steps for every numeric setting. */
export const LIMITS = {
  opacity: { min: 0, max: 1, step: 0.01 },
  blur: { min: 0, max: 40, step: 1 },
  brightness: { min: 0.2, max: 2, step: 0.05 },
  saturation: { min: 0, max: 2, step: 0.05 },
  contrast: { min: 0.5, max: 2, step: 0.05 },
  zoom: { min: 100, max: 200, step: 1 },
};

/**
 * How opaque the application's own surfaces stay while a background is shown.
 *
 * This is a constant rather than a setting: the background layer sits *behind*
 * the application, and DSH paints its surfaces with `--dsw-alias-bg-base`, so a
 * fully opaque surface hides the picture completely. Making the surfaces
 * translucent is therefore part of "show a background" rather than a knob the
 * user has to find — and one value means one thing to reason about. The same
 * number lives in `client/client.js`; `test/client-parity.test.js` keeps the
 * two copies in step.
 */
export const SURFACE_OPACITY = 0.72;

/** How the image is sized against the viewport. */
export const FITS = ['cover', 'contain', 'stretch', 'center', 'repeat'];

/** Where the image is anchored inside the viewport. */
export const POSITIONS = [
  'center',
  'top',
  'bottom',
  'left',
  'right',
  'top left',
  'top right',
  'bottom left',
  'bottom right',
];

/** Built-in gradient presets, usable without uploading anything. */
export const PRESETS = [
  'aurora',
  'dusk',
  'ocean',
  'graphite',
  'sunrise',
  'forest',
];

/** A stored image reference: `managed:<file>` or `preset:<name>`. */
const MANAGED_REF = /^managed:([A-Za-z0-9._-]{1,128})$/;
const PRESET_REF = /^preset:([a-z0-9-]{1,32})$/;

/**
 * The configuration a fresh install starts from.
 *
 * `enabled` is deliberately false and `image` null: installing the plugin must
 * not repaint the user's app until they choose a picture.
 *
 * There is one picture, shared by the light and the dark theme. (Earlier
 * versions stored a `lightImage`/`darkImage` pair; `normalizeConfig` still
 * reads those keys so an existing installation keeps its picture.)
 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  image: null,
  opacity: 1,
  blur: 0,
  brightness: 1,
  saturation: 1,
  contrast: 1,
  zoom: 100,
  fit: 'cover',
  position: 'center',
});

/**
 * Clamp `value` into the configured range for `key`.
 *
 * An unbounded value still clamps (`Infinity` means "as large as allowed"), but
 * input that carries no magnitude at all — `NaN`, or the empty string a
 * cleared `<input>` produces — falls back to the default instead of silently
 * becoming the minimum.
 *
 * @param key - a key of {@link LIMITS}.
 * @param value - the candidate value.
 * @returns the clamped number, or the default when there is no magnitude.
 */
export function clamp(key, value) {
  const limit = LIMITS[key];
  if (limit === undefined) return value;
  if (typeof value === 'string' && value.trim() === '') return DEFAULT_CONFIG[key];
  const number = Number(value);
  if (Number.isNaN(number)) return DEFAULT_CONFIG[key];
  return Math.min(limit.max, Math.max(limit.min, number));
}

/**
 * Validate one stored image reference.
 *
 * Only two forms are accepted, and both are opaque labels the host resolves
 * against its own data directory. A raw path, `file:` URL, or `../` cannot
 * survive this check, so a stored value can never point the host outside the
 * plugin's own folder.
 *
 * @param value - candidate reference.
 * @returns the reference, or null when it is not one.
 */
export function normalizeImageRef(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const managed = MANAGED_REF.exec(trimmed);
  if (managed !== null) return `managed:${managed[1]}`;
  const preset = PRESET_REF.exec(trimmed);
  if (preset !== null && PRESETS.includes(preset[1])) return `preset:${preset[1]}`;
  return null;
}

/** How many bytes of image data the plugin will store. */
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/** Image types the plugin accepts. SVG is excluded: it can carry script. */
export const ALLOWED_IMAGE_TYPES = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
});

/**
 * Normalize an arbitrary stored object into a complete, valid configuration.
 *
 * Unknown keys are dropped rather than preserved: the stored file is edited by
 * the plugin alone, and dropping unknown keys keeps a hand-edited or
 * downgraded file from carrying stale state forward.
 *
 * @param input - the raw object read from disk or received over HTTP.
 * @returns a complete configuration object.
 */
export function normalizeConfig(input) {
  const raw = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const config = {
    enabled: raw.enabled === true,
    // `lightImage`/`darkImage` are the pre-1.1 keys. Reading them keeps an
    // existing installation's picture instead of silently dropping it.
    image: normalizeImageRef(raw.image)
      ?? normalizeImageRef(raw.lightImage)
      ?? normalizeImageRef(raw.darkImage),
    fit: FITS.includes(raw.fit) ? raw.fit : DEFAULT_CONFIG.fit,
    position: POSITIONS.includes(raw.position) ? raw.position : DEFAULT_CONFIG.position,
  };
  for (const key of Object.keys(LIMITS)) config[key] = clamp(key, raw[key] ?? DEFAULT_CONFIG[key]);
  return config;
}

/**
 * Whether a configuration would visibly change anything.
 *
 * Used by the host to answer "is this plugin doing something right now" for
 * diagnostics, and by tests.
 *
 * @param config - a normalized configuration.
 * @returns the reference that would be painted, or null.
 */
export function activeImageRef(config) {
  if (config.enabled !== true) return null;
  return config.image ?? null;
}

/**
 * Merge a partial patch onto a normalized configuration.
 *
 * Re-normalizing the merge means a patch cannot smuggle in an out-of-range
 * value for a key it was not supposed to touch.
 *
 * @param current - the current normalized configuration.
 * @param patch - the partial update.
 * @returns a new normalized configuration.
 */
export function mergeConfig(current, patch) {
  const base = normalizeConfig(current);
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base;
  return normalizeConfig({ ...base, ...patch });
}
