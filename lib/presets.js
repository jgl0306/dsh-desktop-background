/**
 * The built-in gradient presets.
 *
 * A preset is an alternative to an uploaded picture: `preset:aurora` paints a
 * gradient instead of a file. These are plain CSS `background-image` values,
 * which is why the same table can be served by the host and inlined by the
 * browser bundle without translation.
 *
 * The browser bundle cannot import this module (it is a self-contained script),
 * so `client/client.js` carries a copy. `test/presets-parity.test.js` reads
 * that copy and fails if the two ever disagree, so drift cannot ship.
 *
 * @module dsh-desktop-background/presets
 */

/**
 * Preset identifier to CSS `background-image` value.
 *
 * Each value is written for a full-viewport backdrop: it stays legible under
 * both the light and dark application themes because the darkest and lightest
 * stops are never extreme.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const PRESET_GRADIENTS = Object.freeze({
  aurora: [
    'radial-gradient(ellipse 80% 60% at 20% 10%, rgba(56, 189, 248, 0.55), transparent 60%)',
    'radial-gradient(ellipse 70% 55% at 80% 25%, rgba(167, 139, 250, 0.5), transparent 62%)',
    'radial-gradient(ellipse 90% 70% at 50% 100%, rgba(45, 212, 191, 0.42), transparent 65%)',
    'linear-gradient(160deg, #0b1120 0%, #131c33 55%, #0a0f1c 100%)',
  ].join(', '),

  dusk: [
    'radial-gradient(ellipse 75% 60% at 75% 15%, rgba(244, 114, 182, 0.4), transparent 60%)',
    'linear-gradient(155deg, #1e1b4b 0%, #4c1d95 38%, #9d174d 72%, #c2410c 100%)',
  ].join(', '),

  ocean: [
    'radial-gradient(ellipse 85% 65% at 25% 20%, rgba(34, 211, 238, 0.38), transparent 62%)',
    'linear-gradient(165deg, #042f4a 0%, #0b4f71 45%, #0e7490 78%, #155e75 100%)',
  ].join(', '),

  graphite: [
    'radial-gradient(ellipse 70% 55% at 30% 12%, rgba(148, 163, 184, 0.22), transparent 65%)',
    'linear-gradient(170deg, #0f1115 0%, #1c2027 50%, #0b0d11 100%)',
  ].join(', '),

  sunrise: [
    'radial-gradient(ellipse 80% 60% at 70% 10%, rgba(253, 224, 71, 0.45), transparent 58%)',
    'linear-gradient(150deg, #7c2d12 0%, #c2410c 30%, #db2777 66%, #6d28d9 100%)',
  ].join(', '),

  forest: [
    'radial-gradient(ellipse 80% 60% at 22% 18%, rgba(74, 222, 128, 0.3), transparent 62%)',
    'linear-gradient(160deg, #052e16 0%, #14532d 42%, #166534 70%, #115e59 100%)',
  ].join(', '),
});

/**
 * Look up a preset's gradient.
 *
 * @param name - a preset identifier.
 * @returns the CSS value, or null when the name is not a preset.
 */
export function presetGradient(name) {
  if (typeof name !== 'string') return null;
  return Object.hasOwn(PRESET_GRADIENTS, name) ? PRESET_GRADIENTS[name] : null;
}

/**
 * The preset table as an API-friendly list, in a stable order.
 *
 * @returns `[{ id, gradient }]`.
 */
export function listPresets() {
  return Object.entries(PRESET_GRADIENTS).map(([id, gradient]) => ({ id, gradient }));
}
