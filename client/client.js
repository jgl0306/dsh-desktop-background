/**
 * dsh-desktop-background — browser half.
 *
 * A self-contained classic script: DSH's web module system loads it as-is and
 * never bundles it, so everything it needs is either a platform "seed word"
 * (`react`, `react-dom`, …) or inlined here.
 *
 * How the background is painted, and why:
 *
 * - The layer is `body::before` at `z-index: 0` with `#root` lifted to
 *   `z-index: 1`. Nothing in the application occupies `z-index <= 0`, so the
 *   whole app keeps its stacking order and simply gains a floor.
 * - `ctx.theme.overrideTokens` publishes the knobs as custom properties. The
 *   layout's theme presenter writes every theme token as an *inline* property
 *   on `document.body`, so a variable published here reaches the layer.
 * - An image behind an opaque application is invisible, so the canvas token
 *   `--dsw-alias-bg-base` is made translucent in step with the opacity
 *   control. Its two theme values are the values DSH itself ships, so the
 *   override is exact rather than an approximation.
 * - The attribute `data-dsh-dbg` on `<html>` is the single on/off switch for
 *   the whole effect: no attribute, no pseudo-element, no side effects.
 *
 * @module dsh-desktop-background/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-desktop-background',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    /** The entry id, matching `package.json` `name`. */
    const PLUGIN_ID = 'dsh-desktop-background';
    /** The host route prefix, and the source label for theme overrides. */
    const API = '/dsh-desktop-background';
    const SOURCE = `@${PLUGIN_ID}`;

    /**
     * Numeric bounds, mirrored from `lib/config.js`.
     *
     * This file cannot import the host module, so the two copies are held
     * together by `test/client-parity.test.js`, which reads this source and
     * fails when either side drifts.
     */
    const LIMITS = {
      opacity: { min: 0, max: 1, step: 0.01 },
      blur: { min: 0, max: 40, step: 1 },
      brightness: { min: 0.2, max: 2, step: 0.05 },
      saturation: { min: 0, max: 2, step: 0.05 },
      contrast: { min: 0.5, max: 2, step: 0.05 },
      zoom: { min: 100, max: 200, step: 1 },
      overlayOpacity: { min: 0, max: 0.9, step: 0.01 },
      panelOpacity: { min: 0.2, max: 1, step: 0.01 },
    };

    /** Fill modes, mirrored from `lib/config.js`. */
    const FITS = ['cover', 'contain', 'stretch', 'center', 'repeat'];
    const POSITIONS = [
      'center', 'top', 'bottom', 'left', 'right',
      'top left', 'top right', 'bottom left', 'bottom right',
    ];

    /** Gradient presets, mirrored from `lib/presets.js` and parity-tested. */
    const PRESETS = {
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
    };

    /** Fallback preset list, used until the host answers. */
    const PRESET_ORDER = ['aurora', 'dusk', 'ocean', 'graphite', 'sunrise', 'forest'];

    /** The canvas colours DSH itself paints, for the two themes. */
    const CANVAS = { light: '255,255,255', dark: '21,21,23' };

    /** The stylesheet, installed once and driven entirely by custom properties. */
    const CSS = `
html[data-dsh-dbg] body { background-color: transparent !important; }
html[data-dsh-dbg] { background-color: transparent !important; }
html[data-dsh-dbg] #root { position: relative; z-index: 1; }
html[data-dsh-dbg] body::before {
  content: "";
  position: fixed;
  inset: calc(-2 * var(--dsh-dbg-blur, 0px));
  z-index: 0;
  pointer-events: none;
  background-image: var(--dsh-dbg-image, none);
  background-size: var(--dsh-dbg-size, cover);
  background-position: var(--dsh-dbg-position, center);
  background-repeat: var(--dsh-dbg-repeat, no-repeat);
  opacity: var(--dsh-dbg-opacity, 1);
  filter: blur(var(--dsh-dbg-blur, 0px))
          brightness(var(--dsh-dbg-brightness, 1))
          saturate(var(--dsh-dbg-saturation, 1))
          contrast(var(--dsh-dbg-contrast, 1));
  transform: scale(var(--dsh-dbg-zoom, 1));
  transform-origin: center center;
}
html[data-dsh-dbg] body::after {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background-color: var(--dsh-dbg-overlay-color, transparent);
  opacity: var(--dsh-dbg-overlay-opacity, 0);
}
body[data-dsh-dbg-hide-frame-background="1"] { --dsw-alias-bg-base: transparent; }
`;

    /* ------------------------------------------------------------------ *
     * Configuration helpers
     * ------------------------------------------------------------------ */

    /** Clamp a number into a limit block. */
    function clampNumber(value, limit, fallback) {
      const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
      if (!Number.isFinite(parsed)) return fallback;
      if (parsed < limit.min) return limit.min;
      if (parsed > limit.max) return limit.max;
      return parsed;
    }

    /** The stored reference for a theme, or null. */
    function imageRefFor(config, theme) {
      if (config === null || config === undefined) return null;
      const ref = theme === 'dark' ? config.darkImage : config.lightImage;
      return typeof ref === 'string' && ref !== '' ? ref : null;
    }

    /** Turn a stored reference into a CSS `background-image` value. */
    function imageCssFor(config, theme, presets) {
      const ref = imageRefFor(config, theme);
      if (ref === null) return 'none';
      if (ref.startsWith('preset:')) {
        const name = ref.slice('preset:'.length);
        return presets[name] ?? PRESETS[name] ?? 'none';
      }
      if (ref.startsWith('managed:')) {
        const file = ref.slice('managed:'.length);
        if (!/^[a-f0-9]{64}\.(?:png|jpg|webp|gif|avif)$/.test(file)) return 'none';
        return `url("${API}/assets/${file}")`;
      }
      return 'none';
    }

    /** `background-size` and `background-repeat` for a fill mode. */
    function fitFor(fit) {
      switch (fit) {
        case 'contain':
          return { size: 'contain', repeat: 'no-repeat' };
        case 'stretch':
          return { size: '100% 100%', repeat: 'no-repeat' };
        case 'center':
          return { size: 'auto', repeat: 'no-repeat' };
        case 'repeat':
          return { size: 'auto', repeat: 'repeat' };
        default:
          return { size: 'cover', repeat: 'no-repeat' };
      }
    }

    /**
     * Read the sidebar's own fill colour before anything overrides it.
     *
     * The application's sidebar paints `--dsw-specific-sidebar-fill`, whose
     * value is not published anywhere this plugin can read at build time, and a
     * custom property cannot reference itself to grow an alpha channel. So the
     * live computed value is captured once, before the first override, and used
     * as the base for the translucent variant.
     *
     * A value this plugin produced is refused: on a hot reload the property may
     * already be ours, and building on top of our own output would compound the
     * alpha on every reload.
     *
     * @returns the original colour, or null when it could not be read.
     */
    function captureSidebarFill() {
      try {
        const value = window.getComputedStyle(document.body).getPropertyValue('--dsw-specific-sidebar-fill');
        const trimmed = value.trim();
        if (trimmed === '' || trimmed.startsWith('color-mix(')) return null;
        return trimmed;
      } catch {
        return null;
      }
    }

    /* ------------------------------------------------------------------ *
     * Store: one immutable snapshot, fetched from the host
     * ------------------------------------------------------------------ */

    /**
     * Create the plugin's state container.
     *
     * React reads it through `useSyncExternalStore`, which needs `get` to
     * return the same object until something actually changes; every mutation
     * therefore replaces the snapshot rather than mutating it.
     *
     * @returns the store handle.
     */
    function createStore() {
      let snapshot = {
        loading: true,
        error: null,
        notice: null,
        state: null,
        /** Local edits, applied on top of the last server answer. */
        draft: null,
      };
      const listeners = new Set();

      function emit() {
        for (const listener of listeners) listener();
      }

      function set(patch) {
        snapshot = { ...snapshot, ...patch };
        emit();
      }

      return {
        get: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        set,
        /** Drop local edits once the server has acknowledged them. */
        clearDraft: () => set({ draft: null }),
        /** The configuration the UI and the layer should both use. */
        effective: () => snapshot.draft ?? snapshot.state?.config ?? null,
      };
    }

    /* ------------------------------------------------------------------ *
     * Controller: state, HTTP, and the theme override
     * ------------------------------------------------------------------ */

    /**
     * Build the controller that owns everything stateful.
     *
     * @returns the controller.
     */
    function createController() {
      const store = createStore();
      let themeApi = null;
      let disposeTokens = null;
      let sidebarBase = null;
      let sidebarBaseRead = false;
      let flushTimer = null;
      let pendingPatch = null;
      let mounted = false;

      /** The sidebar base colour, captured at most once. */
      function sidebarBaseOnce() {
        if (!sidebarBaseRead) {
          sidebarBaseRead = true;
          sidebarBase = captureSidebarFill();
        }
        return sidebarBase;
      }

      /** The `on` switch plus every custom property the stylesheet reads. */
      function publish() {
        const config = store.effective();
        const enabled = config?.enabled === true;
        const presets = (store.get().state?.presets ?? []).reduce((accumulator, preset) => {
          accumulator[preset.id] = preset.gradient;
          return accumulator;
        }, {});

        if (typeof document !== 'undefined') {
          if (enabled) document.documentElement.dataset.dshDbg = 'on';
          else delete document.documentElement.dataset.dshDbg;
        }

        if (themeApi === null) return;

        const opacity = clampNumber(config?.opacity, LIMITS.opacity, 1);
        const blur = clampNumber(config?.blur, LIMITS.blur, 0);
        const brightness = clampNumber(config?.brightness, LIMITS.brightness, 1);
        const saturation = clampNumber(config?.saturation, LIMITS.saturation, 1);
        const contrast = clampNumber(config?.contrast, LIMITS.contrast, 1);
        const zoom = clampNumber(config?.zoom, LIMITS.zoom, 100);
        const overlayOpacity = clampNumber(config?.overlayOpacity, LIMITS.overlayOpacity, 0);
        const panelOpacity = clampNumber(config?.panelOpacity, LIMITS.panelOpacity, 1);
        const fit = FITS.includes(config?.fit) ? config.fit : 'cover';
        const position = POSITIONS.includes(config?.position) ? config.position : 'center';
        const fitStyle = fitFor(fit);

        const image = { light: 'none', dark: 'none' };
        const surface = { light: 1, dark: 1 };
        for (const theme of ['light', 'dark']) {
          image[theme] = imageCssFor(config, theme, presets);
          // A theme with no picture of its own keeps an opaque canvas: a
          // translucent one with nothing behind it would show the window
          // through the interface, which is worse than having no background.
          surface[theme] = enabled && image[theme] !== 'none' ? panelOpacity : 1;
        }

        const same = (value) => ({ light: value, dark: value });
        const tokens = {
          '--dsh-dbg-image': { light: image.light, dark: image.dark },
          '--dsh-dbg-size': same(fitStyle.size),
          '--dsh-dbg-repeat': same(fitStyle.repeat),
          '--dsh-dbg-position': same(position),
          '--dsh-dbg-opacity': same(String(opacity)),
          '--dsh-dbg-blur': same(`${blur}px`),
          '--dsh-dbg-brightness': same(String(brightness)),
          '--dsh-dbg-saturation': same(String(saturation)),
          '--dsh-dbg-contrast': same(String(contrast)),
          '--dsh-dbg-zoom': same(String(zoom / 100)),
          '--dsh-dbg-overlay-color': same(typeof config?.overlayColor === 'string' ? config.overlayColor : 'transparent'),
          '--dsh-dbg-overlay-opacity': same(String(overlayOpacity)),
          '--dsw-alias-bg-base': {
            light: `rgba(${CANVAS.light},${surface.light})`,
            dark: `rgba(${CANVAS.dark},${surface.dark})`,
          },
        };

        // The sidebar is only tinted when the original colour was actually
        // read: guessing it would repaint somebody else's surface with the
        // wrong colour, so the token is left alone instead.
        if (config?.applyToPanels !== false) {
          const base = sidebarBaseOnce();
          if (base !== null) {
            const mix = (percent) => `color-mix(in srgb, ${base} ${percent}%, transparent)`;
            const mixed = { light: mix(surface.light * 100), dark: mix(surface.dark * 100) };
            tokens['--dsw-specific-sidebar-fill'] = surface.light === 1 && surface.dark === 1 ? same(base) : mixed;
          }
        }

        disposeTokens?.();
        disposeTokens = themeApi.overrideTokens(SOURCE, tokens) ?? null;
      }

      /** Pull the full state from the host. */
      async function load() {
        try {
          const response = await fetch(`${API}/api/v1/state`, { headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const state = await response.json();
          store.set({ loading: false, error: null, state });
        } catch (error) {
          store.set({ loading: false, error: error instanceof Error ? error.message : String(error) });
        }
        publish();
      }

      /** Send the accumulated edit to the host. */
      async function flush() {
        flushTimer = null;
        const patch = pendingPatch;
        pendingPatch = null;
        if (patch === null) return;
        try {
          const response = await fetch(`${API}/api/v1/config`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
          store.set({ state: { ...store.get().state, config: payload.config }, error: null, notice: null });
        } catch (error) {
          store.set({ error: error instanceof Error ? error.message : String(error), notice: null });
        }
        store.clearDraft();
        publish();
      }

      return {
        store,
        get effective() {
          return store.effective;
        },
        /** Bind the theme service, then publish for the first time. */
        attachTheme(theme) {
          themeApi = theme;
          publish();
        },
        /** Record the mount and fetch the state. */
        start() {
          if (mounted) return;
          mounted = true;
          sidebarBaseOnce();
          publish();
          void load();
        },
        /** Apply an edit locally at once, and persist it after a pause. */
        edit(patch) {
          store.set({ draft: { ...store.effective(), ...patch } });
          publish();
          pendingPatch = { ...(pendingPatch ?? {}), ...patch };
          if (flushTimer !== null) clearTimeout(flushTimer);
          flushTimer = setTimeout(() => void flush(), 180);
        },
        /** Replace the whole configuration with the shipped defaults. */
        async reset() {
          try {
            const response = await fetch(`${API}/api/v1/config/reset`, { method: 'POST' });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
            store.set({ state: { ...store.get().state, config: payload.config }, error: null });
            store.clearDraft();
          } catch (error) {
            store.set({ error: error instanceof Error ? error.message : String(error) });
          }
          publish();
        },
        /** Upload a picture and refresh the library. */
        async upload(file) {
          try {
            const response = await fetch(`${API}/api/v1/images`, { method: 'POST', body: file });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
            store.set({ notice: `已添加 ${payload.image.file.slice(0, 12)}… / added`, error: null });
            await load();
            return payload.image.ref;
          } catch (error) {
            store.set({ error: error instanceof Error ? error.message : String(error) });
            return null;
          }
        },
        /** Delete a picture from the library. */
        async remove(file) {
          try {
            const response = await fetch(`${API}/api/v1/images/${encodeURIComponent(file)}`, { method: 'DELETE' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            await load();
          } catch (error) {
            store.set({ error: error instanceof Error ? error.message : String(error) });
          }
        },
        dispose() {
          if (flushTimer !== null) clearTimeout(flushTimer);
          disposeTokens?.();
          disposeTokens = null;
          delete document.documentElement.dataset.dshDbg;
        },
      };
    }

    /* ------------------------------------------------------------------ *
     * UI
     * ------------------------------------------------------------------ */

    const labelStyle = { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6b7280)', minWidth: 96 };
    const rowStyle = { display: 'flex', alignItems: 'center', gap: 12, margin: '10px 0' };
    const buttonStyle = {
      font: 'inherit',
      fontSize: 12,
      padding: '4px 10px',
      cursor: 'pointer',
      color: 'var(--dsw-alias-label-primary, inherit)',
      background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.12))',
      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3))',
      borderRadius: 'var(--dsw-radius-s, 6px)',
    };

    /**
     * A labelled control row.
     *
     * When `htmlFor` is given the label text becomes a real `<label>` element
     * associated with the control, so clicking the words focuses or toggles it
     * — a plain `<span>` next to an input looks identical but is inert, and
     * leaves screen readers announcing an unlabelled control.
     */
    function Row(props) {
      const label = props.htmlFor
        ? h('label', { htmlFor: props.htmlFor, style: labelStyle }, props.label)
        : h('span', { style: labelStyle }, props.label);
      return h('div', { style: rowStyle }, label, props.children);
    }

    /** A range input with a live readout, sized to fit its column. */
    function Slider(props) {
      const limit = LIMITS[props.name];
      const inputId = React.useId();
      return h(
        Row,
        { label: props.label, htmlFor: inputId },
        h('input', {
          id: inputId,
          type: 'range',
          min: limit.min,
          max: limit.max,
          step: limit.step,
          value: props.value,
          style: { flex: 1, minWidth: 120, accentColor: 'var(--dsw-alias-label-primary, currentColor)' },
          onChange: (event) => props.onChange(Number.parseFloat(event.target.value)),
        }),
        h('span', { style: { fontSize: 12, minWidth: 44, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } },
          props.format ? props.format(props.value) : String(props.value)),
      );
    }

    /** One thumbnail choice in the picture grid. */
    function Thumb(props) {
      const selected = props.selected;
      return h(
        'button',
        {
          type: 'button',
          title: props.title ?? props.id,
          onClick: props.onClick,
          style: {
            width: 56,
            height: 40,
            padding: 0,
            cursor: 'pointer',
            overflow: 'hidden',
            backgroundImage: props.preview === null ? 'none' : props.preview,
            backgroundColor: props.preview === null ? 'transparent' : undefined,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            border: selected ? '2px solid var(--dsw-alias-label-primary, #4b5563)' : '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
            borderRadius: 'var(--dsw-radius-s, 6px)',
            fontSize: 11,
            color: 'var(--dsw-alias-label-secondary, #6b7280)',
          },
        },
        props.preview === null ? props.children : null,
      );
    }

    /** The picture picker for one theme. */
    function Picker(props) {
      const { config, images, label, theme, controller } = props;
      const selectedRef = imageRefFor(config, theme);
      const fileRef = React.useRef(null);

      return h(
        'div',
        { style: { margin: '12px 0' } },
        h('div', { style: { ...labelStyle, minWidth: 0, marginBottom: 6 } }, label),
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } },
          h(Thumb, {
            id: 'none',
            title: '不使用图片 / none',
            selected: selectedRef === null,
            preview: null,
            onClick: () => controller.edit(theme === 'dark' ? { darkImage: null } : { lightImage: null }),
          }, '无'),
          PRESET_ORDER.map((name) => h(Thumb, {
            key: name,
            id: `preset:${name}`,
            title: name,
            selected: selectedRef === `preset:${name}`,
            preview: PRESETS[name],
            onClick: () => controller.edit(theme === 'dark' ? { darkImage: `preset:${name}` } : { lightImage: `preset:${name}` }),
          })),
          images.map((image) => h(Thumb, {
            key: image.file,
            id: image.ref,
            title: image.ref,
            selected: selectedRef === image.ref,
            preview: `url("${API}/assets/${image.file}")`,
            onClick: () => controller.edit(theme === 'dark' ? { darkImage: image.ref } : { lightImage: image.ref }),
          })),
          h('input', {
            ref: fileRef,
            type: 'file',
            accept: 'image/png,image/jpeg,image/webp,image/gif,image/avif',
            style: { display: 'none' },
            onChange: async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file === undefined) return;
              const ref = await controller.upload(file);
              if (ref !== null) {
                controller.edit(theme === 'dark' ? { darkImage: ref } : { lightImage: ref });
              }
            },
          }),
          h('button', { type: 'button', style: buttonStyle, onClick: () => fileRef.current?.click() }, '上传图片 / Upload'),
        ),
      );
    }

    /** The settings panel body. */
    function BackgroundSection() {
      const controller = React.useContext(ControllerContext);
      const snapshot = React.useSyncExternalStore(controller.store.subscribe, controller.store.get, controller.store.get);
      // Hooks must run before the early return below, and every id must be
      // derived from this single call so React owns uniqueness for us.
      const uid = React.useId();
      const config = controller.store.effective();

      if (config === null) {
        return h('div', { style: { fontSize: 13, padding: 8 } },
          snapshot.loading ? '加载中… / Loading…' : snapshot.error ?? '配置不可用 / configuration unavailable');
      }

      const images = snapshot.state?.images ?? [];
      const edit = controller.edit;

      return h(
        'div',
        { style: { padding: '4px 2px', fontSize: 13, maxWidth: 640 } },

        h(Row, { label: '启用背景 / Enabled', htmlFor: uid + '-enabled' },
          h('input', {
            id: uid + '-enabled',
            type: 'checkbox',
            checked: config.enabled === true,
            onChange: (event) => edit({ enabled: event.target.checked }),
          }),
          h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #9ca3af)' } },
            '关闭后不修改任何界面外观 / off leaves the interface untouched'),
        ),

        snapshot.error !== null
          ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-error, #dc2626)', margin: '6px 0' } }, snapshot.error)
          : null,
        snapshot.notice !== null
          ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6b7280)', margin: '6px 0' } }, snapshot.notice)
          : null,

        h(Picker, { config, images, label: '浅色主题背景 / Light theme', theme: 'light', controller }),
        h(Picker, { config, images, label: '深色主题背景 / Dark theme', theme: 'dark', controller }),

        h('div', { style: { ...labelStyle, minWidth: 0, marginTop: 14, marginBottom: 2 } }, '外观 / Appearance'),
        h(Slider, { name: 'opacity', label: '不透明度 / Opacity', value: config.opacity,
          onChange: (value) => edit({ opacity: value }), format: (value) => `${Math.round(value * 100)}%` }),
        h(Slider, { name: 'blur', label: '模糊 / Blur', value: config.blur,
          onChange: (value) => edit({ blur: value }), format: (value) => `${value}px` }),
        h(Slider, { name: 'brightness', label: '亮度 / Brightness', value: config.brightness,
          onChange: (value) => edit({ brightness: value }), format: (value) => `${Math.round(value * 100)}%` }),
        h(Slider, { name: 'saturation', label: '饱和度 / Saturation', value: config.saturation,
          onChange: (value) => edit({ saturation: value }), format: (value) => `${Math.round(value * 100)}%` }),
        h(Slider, { name: 'contrast', label: '对比度 / Contrast', value: config.contrast,
          onChange: (value) => edit({ contrast: value }), format: (value) => `${Math.round(value * 100)}%` }),
        h(Slider, { name: 'zoom', label: '缩放 / Zoom', value: config.zoom,
          onChange: (value) => edit({ zoom: value }), format: (value) => `${value}%` }),

        h(Row, { label: '填充 / Fit', htmlFor: uid + '-fit' },
          h('select', {
            id: uid + '-fit',
            value: config.fit,
            style: { fontSize: 12, padding: '3px 6px' },
            onChange: (event) => edit({ fit: event.target.value }),
          }, FITS.map((fit) => h('option', { key: fit, value: fit }, fit))),
          h('select', {
            'aria-label': '位置 / Position',
            value: config.position,
            style: { fontSize: 12, padding: '3px 6px' },
            onChange: (event) => edit({ position: event.target.value }),
          }, POSITIONS.map((position) => h('option', { key: position, value: position }, position))),
        ),

        h('div', { style: { ...labelStyle, minWidth: 0, marginTop: 14, marginBottom: 2 } }, '界面与遮罩 / Surfaces & veil'),
        h(Slider, { name: 'panelOpacity', label: '界面不透明度 / Surface opacity', value: config.panelOpacity,
          onChange: (value) => edit({ panelOpacity: value }), format: (value) => `${Math.round(value * 100)}%` }),
        h(Row, { label: '侧边栏 / Sidebar', htmlFor: uid + '-sidebar' },
          h('input', {
            id: uid + '-sidebar',
            type: 'checkbox',
            checked: config.applyToPanels !== false,
            onChange: (event) => edit({ applyToPanels: event.target.checked }),
          }),
          h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #9ca3af)' } },
            '让侧边栏跟随同样的透明度 / make the sidebar translucent too'),
        ),
        h(Row, { label: '遮罩颜色 / Veil', htmlFor: uid + '-veil' },
          h('input', {
            id: uid + '-veil',
            type: 'color',
            value: config.overlayColor,
            style: { width: 40, height: 26, padding: 0, border: 'none', background: 'none' },
            onChange: (event) => edit({ overlayColor: event.target.value }),
          }),
          h('input', {
            type: 'range',
            'aria-label': '遮罩不透明度 / Veil opacity',
            min: LIMITS.overlayOpacity.min,
            max: LIMITS.overlayOpacity.max,
            step: LIMITS.overlayOpacity.step,
            value: config.overlayOpacity,
            style: { flex: 1, minWidth: 120 },
            onChange: (event) => edit({ overlayOpacity: Number.parseFloat(event.target.value) }),
          }),
          h('span', { style: { fontSize: 12, minWidth: 44, textAlign: 'right' } },
            `${Math.round(config.overlayOpacity * 100)}%`),
        ),

        h('div', { style: { marginTop: 16, display: 'flex', gap: 8 } },
          h('button', { type: 'button', style: buttonStyle, onClick: () => void controller.reset() },
            '恢复默认 / Reset'),
        ),
        h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9ca3af)', marginTop: 10, lineHeight: 1.6 } },
          '图片保存在当前 profile 的 .dsh-desktop-background/images 目录，不写入插件包，升级插件不会丢失。',
          h('br'),
          'Pictures are stored in the current profile, not in the installed package, so upgrading the plugin keeps them.',
        ),
      );
    }

    const ControllerContext = React.createContext(null);

    /* ------------------------------------------------------------------ *
     * Plugin entry
     * ------------------------------------------------------------------ */

    /**
     * Install the stylesheet, tagged with `data-plugin` so the module loader
     * removes it when the plugin unloads or hot-reloads.
     *
     * @param ctx - the client plugin context.
     */
    function installStyles(ctx) {
      if (typeof document === 'undefined') return;
      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = PLUGIN_ID;
        tag.dataset.pluginCss = `${PLUGIN_ID}/layer`;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, 'dsh-desktop-background: layer stylesheet');
    }

    /**
     * Register the plugin against a browser context.
     *
     * @param ctx - the client plugin context.
     */
    function apply(ctx) {
      const controller = createController();

      ctx.effect(
        () => () => controller.dispose(),
        'dsh-desktop-background: state',
      );

      installStyles(ctx);

      ctx.inject(['theme'], (themeCtx) => {
        controller.attachTheme(themeCtx.theme);
      });

      ctx.inject(['slots'], (slotCtx) => {
        slotCtx.slots.inject('settings.section', () => slotCtx.slots.register(
          {
            name: 'settings.section',
            id: PLUGIN_ID,
            order: 100,
            label: () => '背景 / Background',
            inject: () => ({}),
          },
          () => h(ControllerContext.Provider, { value: controller }, h(BackgroundSection)),
        ));
      });

      controller.start();
    }

    exports.name = PLUGIN_ID;
    exports.apply = apply;
    exports.inject = ['theme', 'slots'];
    return module.exports;
  },
});
