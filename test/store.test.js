/**
 * Unit tests for the on-disk store.
 *
 * Every test runs against a fresh temporary directory, so nothing here touches
 * the user's real profile.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BackgroundStore,
  MAX_IMAGES,
  isSafeFileName,
  mimeForFileName,
  sniffImageType,
} from '../lib/store.js';
import { DEFAULT_CONFIG, MAX_IMAGE_BYTES } from '../lib/config.js';

/** A minimal but genuinely-shaped PNG. */
function png(fill = 0) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, Buffer.alloc(16, fill)]);
}

function jpeg(fill = 0) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, fill)]);
}

let root;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-bg-store-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A store rooted at a fresh subdirectory. */
async function freshStore(name) {
  const dir = join(root, name);
  const store = new BackgroundStore(dir);
  await store.ensureDirs();
  return store;
}

test('sniffImageType identifies the accepted formats from magic bytes', () => {
  assert.equal(sniffImageType(png()), 'image/png');
  assert.equal(sniffImageType(jpeg()), 'image/jpeg');
  assert.equal(sniffImageType(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16)])), 'image/gif');
  assert.equal(
    sniffImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)])),
    'image/webp',
  );
  assert.equal(
    sniffImageType(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif'), Buffer.alloc(8)])),
    'image/avif',
  );
});

test('sniffImageType rejects what it must not store', () => {
  const rejected = [
    Buffer.alloc(0),
    Buffer.from('too short'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
    Buffer.from('<?php echo 1; ?>'),
    Buffer.from('GIF00a padding padding'),
    Buffer.concat([Buffer.alloc(4), Buffer.from('ftypmp42'), Buffer.alloc(8)]),
  ];
  for (const buffer of rejected) {
    assert.equal(sniffImageType(buffer), null, `must reject ${buffer.toString('latin1').slice(0, 20)}`);
  }
  assert.equal(sniffImageType('not a buffer'), null);
});

test('isSafeFileName accepts only content-hash names', () => {
  assert.equal(isSafeFileName(`${'a'.repeat(64)}.png`), true);
  assert.equal(isSafeFileName(`${'a'.repeat(64)}.avif`), true);
  for (const bad of [
    `${'a'.repeat(64)}.svg`,
    `${'a'.repeat(63)}.png`,
    `${'A'.repeat(64)}.png`,
    '../../etc/passwd',
    'wallpaper.png',
    '',
    null,
    123,
  ]) {
    assert.equal(isSafeFileName(bad), false, `must reject ${String(bad)}`);
  }
});

test('mimeForFileName round-trips the allowed extensions', () => {
  assert.equal(mimeForFileName(`${'a'.repeat(64)}.png`), 'image/png');
  assert.equal(mimeForFileName(`${'a'.repeat(64)}.jpg`), 'image/jpeg');
  assert.equal(mimeForFileName(`${'a'.repeat(64)}.webp`), 'image/webp');
});

test('a fresh store reads the shipped defaults', async () => {
  const store = await freshStore('fresh');
  assert.deepEqual(await store.readConfig(), { ...DEFAULT_CONFIG });
  assert.deepEqual(await store.listImages(), []);
});

test('a corrupt config file degrades to defaults instead of throwing', async () => {
  const store = await freshStore('corrupt');
  await writeFile(store.configPath, '{ this is not json');
  assert.deepEqual(await store.readConfig(), { ...DEFAULT_CONFIG });

  await writeFile(store.configPath, 'null');
  assert.deepEqual(await store.readConfig(), { ...DEFAULT_CONFIG });
});

test('writeConfig merges, normalizes, and round-trips', async () => {
  const store = await freshStore('write');
  const written = await store.writeConfig({ enabled: true, opacity: 0.42 });
  assert.equal(written.enabled, true);
  assert.equal(written.opacity, 0.42);

  const reread = await store.readConfig();
  assert.equal(reread.opacity, 0.42);
  assert.equal(reread.enabled, true);
  assert.equal(reread.image, null);
});

test('writeConfig clamps what it is given', async () => {
  const store = await freshStore('clamp');
  const written = await store.writeConfig({ opacity: 500, fit: 'nonsense' });
  assert.equal(written.opacity, 1);
  assert.equal(written.fit, DEFAULT_CONFIG.fit);
});

test('resetConfig restores the defaults', async () => {
  const store = await freshStore('reset');
  await store.writeConfig({ enabled: true, opacity: 0.1 });
  assert.deepEqual(await store.resetConfig(), { ...DEFAULT_CONFIG });
  assert.deepEqual(await store.readConfig(), { ...DEFAULT_CONFIG });
});

test('addImage stores bytes under their content hash', async () => {
  const store = await freshStore('add');
  const bytes = png(1);
  const added = await store.addImage(bytes);

  assert.match(added.file, /^[a-f0-9]{64}\.png$/);
  assert.equal(added.ref, `managed:${added.file}`);
  assert.equal(added.mime, 'image/png');
  assert.equal(added.bytes, bytes.length);
  assert.deepEqual(await readFile(join(store.imagesDir, added.file)), bytes);
});

test('addImage is content-addressed: the same bytes store once', async () => {
  const store = await freshStore('dedupe');
  const first = await store.addImage(png(7));
  const second = await store.addImage(png(7));
  assert.equal(second.ref, first.ref);
  assert.equal((await store.listImages()).length, 1);
});

test('addImage derives the extension from the bytes, not the caller', async () => {
  const store = await freshStore('ext');
  // A .png name with JPEG bytes must be stored as a .jpg.
  const added = await store.addImage(jpeg(3));
  assert.match(added.file, /\.jpg$/);
  assert.equal(added.mime, 'image/jpeg');
});

test('addImage rejects anything that is not an accepted image', async () => {
  const store = await freshStore('reject');
  await assert.rejects(() => store.addImage(Buffer.alloc(0)), /empty upload/);
  await assert.rejects(() => store.addImage('text'), /empty upload/);
  await assert.rejects(() => store.addImage(Buffer.from('hello world, not an image')), /unsupported image/);
  await assert.rejects(
    () => store.addImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
    /unsupported image/,
  );
});

test('addImage enforces the size cap before touching the disk', async () => {
  const store = await freshStore('toobig');
  const oversized = Buffer.concat([png(), Buffer.alloc(MAX_IMAGE_BYTES, 1)]);
  await assert.rejects(() => store.addImage(oversized), /exceeds/);
  assert.deepEqual(await store.listImages(), []);
});

test('addImage refuses to grow the library past its cap', async () => {
  const store = await freshStore('full');
  for (let index = 0; index < MAX_IMAGES; index += 1) {
    // Distinct bytes per iteration so each hash is unique.
    await store.addImage(Buffer.concat([png(), Buffer.from([index, index, index, index])]));
  }
  assert.equal((await store.listImages()).length, MAX_IMAGES);
  await assert.rejects(() => store.addImage(png(200)), /library is full/);
});

test('listImages skips files that are not content-addressed images', async () => {
  const store = await freshStore('junkfiles');
  await store.addImage(png(5));
  await writeFile(join(store.imagesDir, 'notes.txt'), 'hello');
  await writeFile(join(store.imagesDir, `${'b'.repeat(64)}.png.bak`), 'x');

  const images = await store.listImages();
  assert.equal(images.length, 1);
  assert.match(images[0].file, /\.png$/);
});

test('removeImage deletes by validated name and refuses anything else', async () => {
  const store = await freshStore('remove');
  const added = await store.addImage(png(9));

  assert.equal(await store.removeImage('../../etc/passwd'), false);
  assert.equal(await store.removeImage(`${'c'.repeat(64)}.png`), false, 'missing file');
  assert.equal(await store.removeImage(added.file), true);
  assert.deepEqual(await store.listImages(), []);
});

test('resolveImageRef understands presets and stored pictures', async () => {
  const store = await freshStore('resolve');
  const added = await store.addImage(png(11));

  const preset = store.resolveImageRef('preset:aurora');
  assert.deepEqual(preset, { kind: 'preset', name: 'aurora' });

  const file = store.resolveImageRef(added.ref);
  assert.equal(file.kind, 'file');
  assert.equal(file.mime, 'image/png');
  assert.equal(file.path, join(store.imagesDir, added.file));
});

test('resolveImageRef refuses to resolve outside the images directory', () => {
  const store = new BackgroundStore('/tmp/does-not-matter');
  for (const hostile of [
    'managed:../../../../etc/passwd',
    'managed:/etc/passwd',
    '../../etc/passwd',
    'preset:../../etc/passwd',
    'preset:unknown-preset',
    null,
    '',
  ]) {
    assert.equal(store.resolveImageRef(hostile), null, `must refuse ${String(hostile)}`);
  }
});

test('readImage returns bytes plus MIME, and null for unsafe names', async () => {
  const store = await freshStore('read');
  const added = await store.addImage(png(13));

  const read = await store.readImage(added.file);
  assert.equal(read.mime, 'image/png');
  assert.deepEqual(read.data, png(13));

  assert.equal(await store.readImage('../../etc/passwd'), null);
  assert.equal(await store.readImage(`${'d'.repeat(64)}.png`), null);
});

test('the data directory stays inside the profile it was given', async () => {
  const store = await freshStore('inside');
  await store.writeConfig({ enabled: true });
  const entries = await readdir(join(root, 'inside'));
  assert.ok(entries.includes('.dsh-desktop-background'));
  assert.equal(store.dataDir, join(root, 'inside', '.dsh-desktop-background'));
});

test('the store refuses to be constructed without a profile directory', () => {
  assert.throws(() => new BackgroundStore(''), TypeError);
  assert.throws(() => new BackgroundStore(null), TypeError);
});
