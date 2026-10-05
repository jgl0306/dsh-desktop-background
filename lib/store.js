/**
 * On-disk state for the plugin: the configuration file and the managed image
 * library.
 *
 * Everything the plugin owns lives under one directory inside the active
 * profile:
 *
 * ```
 * <profile>/.dsh-desktop-background/
 *   config.json          the normalized configuration
 *   images/<sha256>.<ext>  uploaded pictures, content-addressed
 * ```
 *
 * The store is the only place that turns an untrusted string (a filename from
 * a request, or an image reference read back from disk) into a filesystem
 * path. Two rules hold everywhere in this file:
 *
 * 1. A name never comes from the request — an upload's filename is derived
 *    from the hash of its own bytes, so `../../etc/passwd` cannot be
 *    expressed.
 * 2. Every candidate name is re-validated on the way back in, so a
 *    hand-edited `config.json` cannot point the host outside its own folder.
 *
 * @module dsh-desktop-background/store
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ALLOWED_IMAGE_TYPES,
  DEFAULT_CONFIG,
  MAX_IMAGE_BYTES,
  mergeConfig,
  normalizeConfig,
  normalizeImageRef,
} from './config.js';

/** The directory the plugin owns inside a profile. */
export const DATA_DIR_NAME = '.dsh-desktop-background';

/** How many images the library keeps. Old uploads are not evicted silently. */
export const MAX_IMAGES = 50;

/** Stored filenames are content hashes plus an extension. */
const SAFE_FILE_NAME = /^[a-f0-9]{64}\.(?:png|jpg|webp|gif|avif)$/;

/**
 * Identify an image by its magic bytes.
 *
 * The declared `Content-Type` of an upload is attacker-controlled and is never
 * trusted; this is what actually decides whether bytes are stored, and which
 * extension they get. SVG is deliberately absent: it is a script container.
 *
 * @param buffer - the candidate bytes.
 * @returns a MIME type from {@link ALLOWED_IMAGE_TYPES}, or null.
 */
export function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';

  const head6 = buffer.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';

  if (
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }

  // ISO base media file format: `ftyp` at offset 4, then a major brand.
  if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }

  return null;
}

/** Validate a stored file name. */
export function isSafeFileName(name) {
  return typeof name === 'string' && SAFE_FILE_NAME.test(name);
}

/** The MIME type for a validated stored file name. */
export function mimeForFileName(name) {
  const ext = name.slice(name.lastIndexOf('.') + 1);
  for (const [mime, suffix] of Object.entries(ALLOWED_IMAGE_TYPES)) {
    if (suffix === `.${ext}`) return mime;
  }
  return null;
}

/** Write a file atomically: a sibling temp file, then a rename. */
async function writeFileAtomic(path, data) {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, data);
  await rename(temp, path);
}

/**
 * Read a JSON file, treating a missing or unreadable file as absent.
 *
 * A corrupt `config.json` must not stop the profile from booting: the plugin
 * falls back to defaults and the next write repairs the file.
 *
 * @param path - file to read.
 * @returns the parsed value, or null.
 */
async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Manages the plugin's configuration file and image library for one profile. */
export class BackgroundStore {
  /**
   * @param profileDir - absolute path of the active DSH profile directory.
   */
  constructor(profileDir) {
    if (typeof profileDir !== 'string' || profileDir === '') {
      throw new TypeError('BackgroundStore requires a profile directory');
    }
    this.profileDir = profileDir;
  }

  /** The plugin's private directory inside the profile. */
  get dataDir() {
    return join(this.profileDir, DATA_DIR_NAME);
  }

  /** Where uploaded pictures are kept. */
  get imagesDir() {
    return join(this.dataDir, 'images');
  }

  /** Path of the configuration file. */
  get configPath() {
    return join(this.dataDir, 'config.json');
  }

  /** Create the directory layout. Safe to call repeatedly. */
  async ensureDirs() {
    await mkdir(this.imagesDir, { recursive: true });
  }

  /**
   * Read the configuration, repaired to the current schema.
   *
   * @returns a complete, normalized configuration.
   */
  async readConfig() {
    const raw = await readJsonOrNull(this.configPath);
    return normalizeConfig(raw);
  }

  /**
   * Merge a patch into the stored configuration and persist the result.
   *
   * @param patch - the partial update.
   * @returns the normalized configuration that was written.
   */
  async writeConfig(patch) {
    const current = await this.readConfig();
    const next = mergeConfig(current, patch);
    await this.ensureDirs();
    await writeFileAtomic(this.configPath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  /** Restore the shipped defaults. */
  async resetConfig() {
    return this.writeConfig(DEFAULT_CONFIG);
  }

  /**
   * Store an uploaded picture.
   *
   * The bytes decide the type, the content hash decides the name, and an
   * identical re-upload is therefore a no-op that returns the same reference.
   *
   * @param buffer - the uploaded bytes.
   * @returns `{ ref, file, bytes }`.
   * @throws when the bytes are not an accepted image, or too large.
   */
  async addImage(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error('empty upload');
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new Error(`image exceeds the ${MAX_IMAGE_BYTES} byte limit`);
    }
    const mime = sniffImageType(buffer);
    if (mime === null) {
      const accepted = Object.keys(ALLOWED_IMAGE_TYPES).join(', ');
      throw new Error(`unsupported image data (accepted: ${accepted})`);
    }

    const hash = createHash('sha256').update(buffer).digest('hex');
    const file = `${hash}${ALLOWED_IMAGE_TYPES[mime]}`;
    await this.ensureDirs();

    const existing = await stat(join(this.imagesDir, file)).catch(() => null);
    if (existing === null) {
      const current = await this.listImages();
      if (current.length >= MAX_IMAGES) {
        throw new Error(
          `image library is full (${MAX_IMAGES}); remove a picture before adding another`,
        );
      }
      await writeFileAtomic(join(this.imagesDir, file), buffer);
    }

    return { ref: `managed:${file}`, file, bytes: buffer.length, mime };
  }

  /**
   * List the stored pictures, newest first.
   *
   * @returns `[{ file, ref, bytes, modifiedAt }]`.
   */
  async listImages() {
    let names;
    try {
      names = await readdir(this.imagesDir);
    } catch {
      return [];
    }
    const entries = [];
    for (const name of names) {
      if (!isSafeFileName(name)) continue;
      const info = await stat(join(this.imagesDir, name)).catch(() => null);
      if (info === null || !info.isFile()) continue;
      entries.push({
        file: name,
        ref: `managed:${name}`,
        bytes: info.size,
        modifiedAt: info.mtime.toISOString(),
      });
    }
    return entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  /**
   * Delete a stored picture.
   *
   * @param name - a stored file name.
   * @returns true when a file was removed.
   */
  async removeImage(name) {
    if (!isSafeFileName(name)) return false;
    const path = join(this.imagesDir, name);
    const existed = (await stat(path).catch(() => null)) !== null;
    if (!existed) return false;
    await rm(path, { force: true });
    return true;
  }

  /**
   * Turn a stored reference into something the host can serve.
   *
   * @param ref - a `managed:`/`preset:` reference from the configuration.
   * @returns `{ kind: 'file', path, mime }`, `{ kind: 'preset', name }`, or null.
   */
  resolveImageRef(ref) {
    const normalized = normalizeImageRef(ref);
    if (normalized === null) return null;
    if (normalized.startsWith('preset:')) {
      return { kind: 'preset', name: normalized.slice('preset:'.length) };
    }
    const file = normalized.slice('managed:'.length);
    if (!isSafeFileName(file)) return null;
    return { kind: 'file', path: join(this.imagesDir, file), mime: mimeForFileName(file) };
  }

  /**
   * Read a stored picture's bytes.
   *
   * @param name - a stored file name.
   * @returns `{ data, mime }`, or null when it is missing or unsafe.
   */
  async readImage(name) {
    if (!isSafeFileName(name)) return null;
    const data = await readFile(join(this.imagesDir, name)).catch(() => null);
    if (data === null) return null;
    return { data, mime: mimeForFileName(name) };
  }
}
