/**
 * dsh-desktop-background — host half.
 *
 * Owns the profile's background configuration and its library of uploaded
 * pictures, and serves both to the browser half over a private HTTP prefix.
 *
 * The split is forced by the platform: a client bundle is delivered as
 * JavaScript through DSH's `/plugins` route, which serves nothing else, so the
 * plugin cannot read an image out of its own package. Pictures therefore live
 * in the profile (`<profile>/.dsh-desktop-background/images/`) and reach the
 * page through {@link module:dsh-desktop-background/routes}, which keeps the
 * user's own files out of the installed package and survives upgrades.
 *
 * @module dsh-desktop-background
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROUTE_PREFIX, mountBackgroundRoutes } from './routes.js';
import { BackgroundStore } from './store.js';

/** The cordis plugin name, and the entry id this plugin registers under. */
export const name = 'dsh-desktop-background';

/** Used only when `package.json` cannot be read. */
const FALLBACK_VERSION = '0.0.0';

/**
 * The version reported to the browser half.
 *
 * Read from `package.json` rather than written out here: the two drifted apart
 * once already, and a stale number makes it impossible to tell which build a
 * running host actually loaded.
 *
 * @returns the package version, or a placeholder when it cannot be read.
 */
function readVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' && manifest.version !== ''
      ? manifest.version
      : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

export const version = readVersion();

/**
 * The services this plugin needs before it can do anything.
 *
 * Declared so the host holds the plugin back until the web server exists,
 * rather than running `apply` into a context that has nowhere to mount.
 */
export const inject = ['webServer'];

/**
 * Locate the profile directory this process is running for.
 *
 * Three sources, strongest first, because they disagree in real deployments:
 *
 * 1. `profileContext` is the launcher's own answer, and the launcher owns
 *    where a profile lives — deriving the path from the name would disagree
 *    with it for any profile outside the default location.
 * 2. `DSH_PROFILE_DIR` is exported into the host process by the desktop app.
 * 3. `$DSH_HOME/profiles/$DSH_PROFILE` is the documented default layout.
 *
 * @param ctx - the host context.
 * @returns an absolute directory, or null when nothing identifies the profile.
 */
export function resolveProfileDir(ctx) {
  const fromContext = ctx?.get?.('profileContext');
  if (fromContext !== undefined && fromContext !== null) {
    const dir = typeof fromContext.dir === 'string' ? fromContext.dir.trim() : '';
    if (dir !== '') return dir;
  }

  const explicit = process.env.DSH_PROFILE_DIR;
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();

  const home = process.env.DSH_HOME;
  const profile = process.env.DSH_PROFILE;
  if (typeof home === 'string' && home.trim() !== '' && typeof profile === 'string' && profile.trim() !== '') {
    return join(home.trim(), 'profiles', profile.trim());
  }

  return null;
}

/**
 * The profile's name, for display.
 *
 * @param ctx - the host context.
 * @returns the name, or null when unknown.
 */
function resolveProfileName(ctx) {
  const fromContext = ctx?.get?.('profileContext');
  const named = typeof fromContext?.name === 'string' ? fromContext.name.trim() : '';
  if (named !== '') return named;

  const fromEnv = process.env.DSH_PROFILE;
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : null;
}

/**
 * Register the plugin's routes once the host has composed its web server.
 *
 * @param ctx - the host context.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (host) => {
    const profileDir = resolveProfileDir(ctx);
    if (profileDir === null) {
      // Failing closed is the only safe answer: without a profile directory
      // there is nowhere to store a configuration, and guessing a path would
      // mean writing a user's files into a directory that is not theirs.
      console.warn(
        'dsh-desktop-background: cannot identify the active profile directory; the plugin is inactive',
      );
      return;
    }

    const store = new BackgroundStore(profileDir);
    const meta = { version, profile: resolveProfileName(ctx) };
    const log = (message) => console.warn(`dsh-desktop-background: ${message}`);

    host.effect(() => {
      const disposeRoutes = mountBackgroundRoutes(host, store, {
        meta,
        log: (message) => log(message),
      });
      log(`mounted ${ROUTE_PREFIX} (profile: ${meta.profile ?? 'unknown'})`);
      return () => {
        disposeRoutes();
      };
    }, 'dsh-desktop-background: http routes');
  });
}

export { BackgroundStore } from './store.js';
export { ROUTE_PREFIX } from './routes.js';
export * from './config.js';
export { PRESET_GRADIENTS, listPresets, presetGradient } from './presets.js';
