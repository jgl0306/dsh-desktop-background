/**
 * Smoke tests for the browser bundle.
 *
 * The bundle is a classic script addressed to `window.__ModuleLoader__`, so it
 * cannot be imported the ordinary way. These tests execute its real source in a
 * sandbox with a stubbed module loader, a stubbed React, and a minimal DOM, and
 * then assert the observable contract:
 *
 * - it registers under the right id and exports the plugin shape the loader
 *   expects,
 * - `apply` installs exactly one tagged stylesheet and registers into the
 *   settings slot,
 * - the published theme tokens follow the configuration, including the
 *   per-theme decision to keep the canvas opaque when a theme has no picture.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'client', 'client.js'), 'utf8');

const PLUGIN_ID = 'dsh-desktop-background';
const SOURCE_LABEL = `@${PLUGIN_ID}`;

/** A minimal `document` covering exactly what the bundle touches. */
function createDocument() {
  const created = [];
  const head = {
    children: [],
    appendChild(node) {
      this.children.push(node);
      return node;
    },
  };
  return {
    created,
    head,
    documentElement: { dataset: {} },
    body: {},
    createElement(tagName) {
      const node = {
        tagName,
        dataset: {},
        textContent: '',
        parentNode: null,
        remove() {
          const index = head.children.indexOf(node);
          if (index !== -1) head.children.splice(index, 1);
        },
      };
      created.push(node);
      return node;
    },
  };
}

/** A counter behind the `useId` stub, so ids are unique per hook call. */
let reactIdSequence = 0;

/** Restart the `useId` counter so a render's ids are deterministic. */
function resetReactIdSequence() {
  reactIdSequence = 0;
}

/** A React stub: enough for module scope and for lazy element creation. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  createContext: (value) => ({ Provider: 'Provider', Consumer: 'Consumer', _value: value }),
  useContext: () => null,
  useRef: () => ({ current: null }),
  useSyncExternalStore: () => null,
  // Real `useId` is unique per component instance, and the panel depends on
  // that to pair each label with its own control.
  useId: () => `:r${(reactIdSequence += 1)}:`,
};

/** A `require` that resolves the platform seed words the bundle asks for. */
function createRequire() {
  return (specifier) => {
    if (specifier === 'react') return reactStub;
    if (specifier === 'react/jsx-runtime') return {};
    throw new Error(`unexpected require("${specifier}")`);
  };
}

/**
 * Boot the bundle in a sandbox.
 *
 * @param state - the payload `GET /api/v1/state` should answer with.
 * @param options - `{ sidebarFill }`.
 * @returns the captured module, the sandbox, and the recorded calls.
 */
async function boot(state, options = {}) {
  const document = createDocument();
  const calls = { fetch: [], registeredSlots: [], themeOverrides: [] };
  let captured = null;

  const window = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition;
      },
    },
    getComputedStyle: () => ({
      getPropertyValue: () => options.sidebarFill ?? ' rgb(30, 32, 38) ',
    }),
  };

  const fetchStub = async (url, init = {}) => {
    calls.fetch.push({ url, method: init.method ?? 'GET', body: init.body ?? null });
    if (url.endsWith('/api/v1/state')) {
      return { ok: true, status: 200, json: async () => state };
    }
    if (url.endsWith('/api/v1/config')) {
      const patch = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ config: { ...state.config, ...patch } }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const context = vm.createContext({ window, document, fetch: fetchStub, console, setTimeout, clearTimeout });
  vm.runInContext(source, context, { filename: 'client/client.js' });

  assert.notEqual(captured, null, 'the bundle never called window.__ModuleLoader__.load');
  const exported = captured.factory(createRequire());
  return { captured, exported, document, calls };
}

/** Build a context whose `inject` runs its callbacks synchronously. */
function createCtx(calls, document) {
  const disposers = [];
  const theme = {
    overrideTokens(label, tokens) {
      calls.themeOverrides.push({ label, tokens });
      return () => {};
    },
  };
  const slots = {
    inject(key, callback) {
      calls.registeredSlots.push({ key, callback });
      callback();
    },
    register(options, component) {
      calls.registeredSlots.push({ key: options.name, options, component });
      return () => {};
    },
  };
  const ctx = {
    effect(fn, label) {
      const dispose = fn();
      disposers.push({ label, dispose });
      return typeof dispose === 'function' ? dispose : () => {};
    },
    inject(services, callback) {
      if (services.includes('theme')) callback({ theme });
      if (services.includes('slots')) callback({ slots });
      return () => {};
    },
  };
  return { ctx, disposers, theme, slots };
}

/** Let the fire-and-forget state load settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const DISABLED = {
  config: { enabled: false, lightImage: null, darkImage: null, opacity: 1, blur: 0, brightness: 1,
    saturation: 1, contrast: 1, zoom: 100, fit: 'cover', position: 'center', overlayColor: '#000000',
    overlayOpacity: 0, panelOpacity: 0.72, applyToPanels: true },
  images: [],
  presets: [{ id: 'aurora', gradient: 'linear-gradient(#000, #fff)' }],
};

let loaded;
before(async () => {
  loaded = await boot(DISABLED);
});

test('the bundle registers under the plugin id and exports the plugin shape', () => {
  assert.equal(loaded.captured.id, PLUGIN_ID);
  assert.equal(loaded.captured.chunk, undefined, 'a single-file bundle must not claim a chunk');
  assert.equal(loaded.exported.name, PLUGIN_ID);
  assert.equal(typeof loaded.exported.apply, 'function');
  assert.deepEqual([...loaded.exported.inject], ['theme', 'slots']);
});

test('apply installs exactly one stylesheet, tagged for eviction', async () => {
  const { ctx, disposers } = createCtx(loaded.calls, loaded.document);
  loaded.exported.apply(ctx);
  await settle();

  const styles = loaded.document.head.children;
  assert.equal(styles.length, 1, 'expected exactly one injected stylesheet');
  assert.equal(styles[0].dataset.plugin, PLUGIN_ID);
  assert.ok(styles[0].textContent.includes('body::before'), 'the layer rule must be present');
  assert.ok(styles[0].textContent.includes('data-dsh-dbg'), 'the on/off attribute must be present');

  for (const entry of disposers) entry.dispose?.();
  assert.equal(loaded.document.head.children.length, 0, 'unloading must remove the stylesheet');
});

test('apply registers a section into the settings list slot', async () => {
  const calls = { fetch: [], registeredSlots: [], themeOverrides: [] };
  const { ctx } = createCtx(calls, loaded.document);
  loaded.exported.apply(ctx);
  await settle();

  const injection = calls.registeredSlots.find((entry) => entry.key === 'settings.section' && entry.options === undefined);
  assert.notEqual(injection, undefined, 'settings.section was never injected into');

  const registration = calls.registeredSlots.find((entry) => entry.options !== undefined);
  assert.equal(registration.options.name, 'settings.section');
  assert.equal(registration.options.id, PLUGIN_ID);
  assert.equal(typeof registration.options.order, 'number');
  assert.equal(typeof registration.options.label, 'function');
  assert.equal(typeof registration.component, 'function');
});

/**
 * Expand a `createElement` tree into its host elements, invoking function
 * components along the way.
 *
 * @param node - element, array, or scalar produced by the React stub.
 * @returns every host element in document order.
 */
function renderHosts(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (Array.isArray(node)) return node.flatMap(renderHosts);
  if (typeof node === 'string' || typeof node === 'number') return [];
  if (typeof node.type === 'function') {
    const children = node.children.length === 1 ? node.children[0] : node.children;
    return renderHosts(node.type({ ...node.props, children }));
  }
  return [node, ...node.children.flatMap(renderHosts)];
}

test('every control in the settings panel is reachable from its label', async () => {
  const calls = { fetch: [], registeredSlots: [], themeOverrides: [] };
  const { ctx } = createCtx(calls, loaded.document);
  loaded.exported.apply(ctx);
  await settle();
  const registration = calls.registeredSlots.find((entry) => entry.options !== undefined);

  const config = { ...DISABLED.config, enabled: true, lightImage: 'preset:aurora' };
  const snapshot = { loading: false, error: null, notice: null, state: { config, images: [], presets: [] }, draft: null };
  const controller = {
    store: { subscribe: () => () => {}, get: () => snapshot, effective: () => config },
    edit: () => {},
    reset: async () => {},
    upload: async () => null,
  };

  // The panel takes its controller from context; the stub returns ours so the
  // real component body renders without a React runtime.
  const realUseContext = reactStub.useContext;
  const realUseSyncExternalStore = reactStub.useSyncExternalStore;
  reactStub.useContext = () => controller;
  reactStub.useSyncExternalStore = (_subscribe, get) => get();
  resetReactIdSequence();
  let hosts;
  try {
    hosts = renderHosts(registration.component());
  } finally {
    reactStub.useContext = realUseContext;
    reactStub.useSyncExternalStore = realUseSyncExternalStore;
  }

  const byTag = (tag) => hosts.filter((node) => node.type === tag);
  const inputs = byTag('input');
  const pick = (type) => inputs.filter((node) => node.props.type === type);
  const ranges = pick('range');
  const checkboxes = pick('checkbox');
  const colors = pick('color');
  const selects = byTag('select');
  const labels = byTag('label');

  // Guard the control surface itself: a silently dropped control is as bad as a
  // broken one, and these counts are what the browser panel shows.
  assert.equal(ranges.length, 8, 'expected the six appearance sliders plus surface and veil opacity');
  assert.equal(checkboxes.length, 2, 'expected the enable switch and the sidebar switch');
  assert.equal(colors.length, 1, 'expected the veil colour picker');
  assert.equal(selects.length, 2, 'expected the fit and position pickers');

  // A control must be reachable by its label: either a `<label for>` inside the
  // panel, or an explicit `aria-label`. A bare `<span>` next to an input looks
  // identical but leaves the control unnamed and the label text inert.
  const labelled = new Set(labels.map((label) => label.props.htmlFor).filter(Boolean));
  for (const control of [...ranges, ...checkboxes, ...colors, ...selects]) {
    const id = control.props.id;
    const aria = control.props['aria-label'];
    assert.ok(
      (id !== undefined && labelled.has(id)) || typeof aria === 'string',
      `unlabelled control: ${JSON.stringify({ tag: control.type, type: control.props.type, id, aria })}`,
    );
  }
  const targets = labels.map((label) => label.props.htmlFor);
  assert.equal(new Set(targets).size, targets.length, 'two controls must not share one label');
});

/**
 * Render the registered settings section against a stubbed controller.
 *
 * @param config - the effective configuration the panel should display.
 * @param overrides - extra store snapshot fields, e.g. `error` or `notice`.
 * @returns the host elements, the slot registration, and the snapshot used.
 */
async function renderPanel(config, overrides = {}) {
  const calls = { fetch: [], registeredSlots: [], themeOverrides: [] };
  const { ctx } = createCtx(calls, loaded.document);
  loaded.exported.apply(ctx);
  await settle();
  const registration = calls.registeredSlots.find((entry) => entry.options !== undefined);

  const snapshot = {
    loading: false,
    error: null,
    notice: null,
    state: { config, images: [], presets: [] },
    draft: null,
    ...overrides,
  };
  const controller = {
    store: { subscribe: () => () => {}, get: () => snapshot, effective: () => config },
    edit: () => {},
    reset: async () => {},
    upload: async () => null,
  };

  // The panel takes its controller from context; the stub returns ours so the
  // real component body renders without a React runtime.
  const realUseContext = reactStub.useContext;
  const realUseSyncExternalStore = reactStub.useSyncExternalStore;
  reactStub.useContext = () => controller;
  reactStub.useSyncExternalStore = (_subscribe, get) => get();
  resetReactIdSequence();
  try {
    return { hosts: renderHosts(registration.component()), registration };
  } finally {
    reactStub.useContext = realUseContext;
    reactStub.useSyncExternalStore = realUseSyncExternalStore;
  }
}

test('the settings panel shows Chinese only', async () => {
  const config = { ...DISABLED.config, enabled: true, lightImage: 'preset:aurora' };
  const { hosts, registration } = await renderPanel(config);

  assert.equal(registration.options.label(), '背景', 'the nav entry must be Chinese only');

  // Every human-readable string the panel can put on screen: control labels
  // (which double as `<label>` text), accessible names, tooltips and body text.
  const texts = [];
  for (const node of hosts) {
    if (typeof node.props['aria-label'] === 'string') texts.push(node.props['aria-label']);
    if (typeof node.props.title === 'string') texts.push(node.props.title);
    for (const child of node.children) {
      if (typeof child === 'string') texts.push(child);
    }
  }
  assert.ok(texts.length >= 20, `expected the panel to render plenty of text, saw ${texts.length}`);

  for (const text of texts) {
    assert.ok(!/ \/ /.test(text), `bilingual wording left in the panel: ${JSON.stringify(text)}`);
    // A filesystem path and a CSS unit are allowed to be Latin; prose is not.
    const prose = text
      .replace(/[A-Za-z0-9._-]*\/[A-Za-z0-9._/-]+/g, '')
      .replace(/\d+\s*(?:px|%|em|rem|s|ms)\b/g, '');
    assert.ok(!/[A-Za-z]/.test(prose), `English left in the panel: ${JSON.stringify(text)}`);
  }
});

test('host errors reach the panel in Chinese, with the original kept as a tooltip', async () => {
  const config = { ...DISABLED.config, enabled: true };

  const raw = 'unsupported image data (accepted: image/png, image/jpeg)';
  const { hosts } = await renderPanel(config, { error: raw });
  const banner = hosts.find((node) => node.props.title === raw);
  assert.notEqual(banner, undefined, 'the raw wording must stay available as a tooltip');
  assert.equal(banner.children[0], '不是支持的图片格式（仅支持 png、jpg、webp、gif、avif）');

  // An unrecognised message is shown as it arrived rather than swallowed.
  const { hosts: unknown } = await renderPanel(config, { error: 'a brand new host wording' });
  const passthrough = unknown.find((node) => node.props.title === 'a brand new host wording');
  assert.equal(passthrough.children[0], 'a brand new host wording');

  // `HTTP 500` is built on the client, so it has its own wording.
  const { hosts: http } = await renderPanel(config, { error: 'HTTP 503' });
  assert.equal(http.find((node) => node.props.title === 'HTTP 503').children[0], '后台返回 HTTP 503');
});

test('a disabled configuration leaves the interface untouched', async () => {
  const calls = { fetch: [], registeredSlots: [], themeOverrides: [] };
  const { ctx } = createCtx(calls, loaded.document);
  loaded.exported.apply(ctx);
  await settle();

  assert.equal(loaded.document.documentElement.dataset.dshDbg, undefined, 'the layer must stay off');
  const last = calls.themeOverrides.at(-1);
  assert.equal(last.label, SOURCE_LABEL);
  assert.equal(last.tokens['--dsw-alias-bg-base'].light, 'rgba(255,255,255,1)');
  assert.equal(last.tokens['--dsw-alias-bg-base'].dark, 'rgba(21,21,23,1)');
});

test('an enabled preset paints the layer and makes only that theme translucent', async () => {
  const calls = { fetch: [], registeredSlots: [], themeOverrides: [] };
  const state = {
    ...DISABLED,
    config: { ...DISABLED.config, enabled: true, lightImage: 'preset:aurora' },
  };
  const booted = await boot(state);
  const { ctx } = createCtx(calls, booted.document);
  booted.exported.apply(ctx);
  await settle();

  assert.equal(booted.document.documentElement.dataset.dshDbg, 'on');
  const tokens = calls.themeOverrides.at(-1).tokens;
  assert.equal(tokens['--dsh-dbg-image'].light, 'linear-gradient(#000, #fff)');
  assert.equal(tokens['--dsh-dbg-image'].dark, 'none');
  assert.equal(tokens['--dsw-alias-bg-base'].light, 'rgba(255,255,255,0.72)');
  assert.equal(tokens['--dsw-alias-bg-base'].dark, 'rgba(21,21,23,1)', 'a theme with no picture stays opaque');
});

test('an uploaded picture becomes a same-origin asset URL', async () => {
  const calls = { fetch: [], registeredSlots: [], themeOverrides: [] };
  const file = `${'a'.repeat(64)}.png`;
  const state = {
    ...DISABLED,
    config: { ...DISABLED.config, enabled: true, darkImage: `managed:${file}` },
  };
  const booted = await boot(state);
  const { ctx } = createCtx(calls, booted.document);
  booted.exported.apply(ctx);
  await settle();

  const tokens = calls.themeOverrides.at(-1).tokens;
  assert.equal(tokens['--dsh-dbg-image'].dark, `url("/dsh-desktop-background/assets/${file}")`);
});

test('a hostile stored reference paints nothing', async () => {
  const calls = { fetch: [], registeredSlots: [], themeOverrides: [] };
  const state = {
    ...DISABLED,
    config: { ...DISABLED.config, enabled: true, lightImage: 'managed:../../../etc/passwd' },
  };
  const booted = await boot(state);
  const { ctx } = createCtx(calls, booted.document);
  booted.exported.apply(ctx);
  await settle();

  const tokens = calls.themeOverrides.at(-1).tokens;
  assert.equal(tokens['--dsh-dbg-image'].light, 'none');
});

test('the sidebar is left alone when its original colour cannot be read', async () => {
  const calls = { fetch: [], registeredSlots: [], themeOverrides: [] };
  const state = { ...DISABLED, config: { ...DISABLED.config, enabled: true, lightImage: 'preset:aurora' } };
  const booted = await boot(state, { sidebarFill: '' });
  const { ctx } = createCtx(calls, booted.document);
  booted.exported.apply(ctx);
  await settle();

  const tokens = calls.themeOverrides.at(-1).tokens;
  assert.equal(tokens['--dsw-specific-sidebar-fill'], undefined, 'never guess another surface\'s colour');
});

test('the sidebar is tinted from the captured colour when it is available', async () => {
  const calls = { fetch: [], registeredSlots: [], themeOverrides: [] };
  const state = { ...DISABLED, config: { ...DISABLED.config, enabled: true, lightImage: 'preset:aurora' } };
  const booted = await boot(state, { sidebarFill: 'rgb(30, 32, 38)' });
  const { ctx } = createCtx(calls, booted.document);
  booted.exported.apply(ctx);
  await settle();

  const tokens = calls.themeOverrides.at(-1).tokens;
  assert.equal(tokens['--dsw-specific-sidebar-fill'].light, 'color-mix(in srgb, rgb(30, 32, 38) 72%, transparent)');
});

test('fill modes map to the matching background sizing', async () => {
  const cases = [
    ['cover', 'cover', 'no-repeat'],
    ['contain', 'contain', 'no-repeat'],
    ['stretch', '100% 100%', 'no-repeat'],
    ['center', 'auto', 'no-repeat'],
    ['repeat', 'auto', 'repeat'],
  ];
  for (const [fit, size, repeat] of cases) {
    const calls = { fetch: [], registeredSlots: [], themeOverrides: [] };
    const state = { ...DISABLED, config: { ...DISABLED.config, enabled: true, lightImage: 'preset:aurora', fit } };
    const booted = await boot(state);
    const { ctx } = createCtx(calls, booted.document);
    booted.exported.apply(ctx);
    await settle();
    const tokens = calls.themeOverrides.at(-1).tokens;
    // eslint-disable-next-line no-await-in-loop -- sequential on purpose, one sandbox per case
    assert.equal(tokens['--dsh-dbg-size'].light, size, `fit ${fit}`);
    assert.equal(tokens['--dsh-dbg-repeat'].light, repeat, `fit ${fit}`);
  }
});

test('an unknown fill mode falls back instead of breaking the layer', async () => {
  const calls = { fetch: [], registeredSlots: [], themeOverrides: [] };
  const state = { ...DISABLED, config: { ...DISABLED.config, enabled: true, lightImage: 'preset:aurora', fit: 'nonsense' } };
  const booted = await boot(state);
  const { ctx } = createCtx(calls, booted.document);
  booted.exported.apply(ctx);
  await settle();
  assert.equal(calls.themeOverrides.at(-1).tokens['--dsh-dbg-size'].light, 'cover');
});

test('zoom is published as a scale factor around 1', async () => {
  const calls = { fetch: [], registeredSlots: [], themeOverrides: [] };
  const state = { ...DISABLED, config: { ...DISABLED.config, enabled: true, lightImage: 'preset:aurora', zoom: 150 } };
  const booted = await boot(state);
  const { ctx } = createCtx(calls, booted.document);
  booted.exported.apply(ctx);
  await settle();
  assert.equal(calls.themeOverrides.at(-1).tokens['--dsh-dbg-zoom'].light, '1.5');
});

test('the state load is a single same-origin GET', async () => {
  const booted = await boot(DISABLED);
  // The fetch stub is closed over by `boot`, so its record of requests lives on
  // the boot result — a fresh object here would silently observe nothing.
  const { ctx } = createCtx(booted.calls, booted.document);
  booted.exported.apply(ctx);
  await settle();

  const stateCalls = booted.calls.fetch.filter((entry) => entry.url.endsWith('/api/v1/state'));
  assert.equal(stateCalls.length, 1);
  assert.equal(stateCalls[0].method, 'GET');
  assert.ok(stateCalls[0].url.startsWith('/dsh-desktop-background/'), 'must stay under the plugin prefix');
});
