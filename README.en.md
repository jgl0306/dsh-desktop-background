# dsh-desktop-background

Custom background pictures for the **DeepSeek Harness desktop app** (and `dsh web`), with a translucent interface so the picture actually shows through.

[中文](README.md) | English

![Background applied](docs/01-background-applied.png)

A standard DSH bundle plugin: one `dsh plugin` command to install, no session token, no network calls, no build step — what ships is runnable plain JavaScript.

## What it does

DSH has **no** background / wallpaper / veil facility of its own (the word `wallpaper` occurs 0 times in `0.2.0-rc.2`), so this plugin builds one:

- Paints a fixed layer **behind** the application (`z-index: 0`, with `#root` lifted to `1`), with a **separate picture for the light and the dark theme** and automatic switching;
- **Opacity, blur, brightness, saturation, contrast, zoom, 5 fill modes and 9 positions**;
- An optional **veil** (any colour + opacity) to dim the picture and keep text readable;
- Because DSH's own panels are opaque, it can also make the **application surfaces and the sidebar translucent** (`Surface opacity`) — without that the picture is simply hidden behind the panels;
- Pictures come from **local upload** (PNG / JPEG / WebP / GIF / AVIF, ≤ 16 MB each) or from **6 built-in gradients**.

![Settings panel](docs/03-background-panel.png)

## Install

### Desktop app (Electron)

The desktop app installs plugins into the `desktop` profile, and that profile **can only be managed by the application's own CLI entry point** — running `dsh plugin --profile desktop …` is rejected with `profile "desktop" is managed exclusively by the Electron application`.

**Option 1 (recommended): use the plugin market.** Open **Settings → Plugin Market**, search for `dsh-desktop-background`. It takes effect in the running host immediately — **no restart**.

**Option 2: the command line**, using the entry point bundled with the app:

```sh
# default macOS location
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add dsh-desktop-background
```

Installing from GitHub or from a local checkout works the same way (this repository has **no** `install` / `prepare` / `postinstall` script, so pnpm's `allowBuilds` never blocks it):

```sh
"$DSH" plugin --profile desktop add github:jgl0306/dsh-desktop-background
"$DSH" plugin --profile desktop add /path/to/dsh-desktop-background   # local source, linked
```

Remove it:

```sh
"$DSH" plugin --profile desktop remove dsh-desktop-background
```

### dsh web

```sh
dsh plugin --profile web add dsh-desktop-background
```

Restart `dsh web`, then open **Settings → 背景**.

## Using it

The settings panel is **Chinese-only**, so the table below lists each control exactly as it appears, with an English gloss.

After installation the plugin is **off** (`enabled: false`, no picture chosen), so **installing it changes nothing**. Open **Settings → 背景**:

1. Tick **启用背景** (Enabled);
2. Choose a picture for **浅色主题背景** (Light theme) and **深色主题背景** (Dark theme) (click a swatch for a built-in gradient, or **上传图片** (Upload) your own). **Leaving one side empty leaves that theme without a background**;
3. If the picture is hidden behind the panels, pull **界面不透明度** (Surface opacity) down to about 60%.

Every change applies **immediately and is saved automatically** — no save button, no restart.

### Settings

| Setting | Range | Default | Notes |
|---|---|---|---|
| 启用背景 (Enabled) | on / off | off | When off the `data-dsh-dbg` attribute is removed and **every rule stops applying** — the interface returns to stock |
| 浅色 / 深色主题背景 | none / preset / uploaded | none | One per active theme |
| 不透明度 (Opacity) | 0 – 100% | 100% | Overall layer opacity |
| 模糊 (Blur) | 0 – 40 px | 0 | The layer is grown by `2 × blur` so no transparent edge appears |
| 亮度 (Brightness) | 20 – 200% | 100% | |
| 饱和度 (Saturation) | 0 – 200% | 100% | |
| 对比度 (Contrast) | 50 – 200% | 100% | |
| 缩放 (Zoom) | 100 – 200% | 100% | The floor is deliberately 100%: `scale()` below 1 would expose the layer's edges |
| 填充 (Fit) | 覆盖 / 完整显示 / 拉伸 / 居中 / 平铺 | 覆盖 | Stored as the CSS keywords `cover` / `contain` / `stretch` / `center` / `repeat` |
| 位置 (Position) | 9 anchors: 居中 / 顶部 / 底部 / 左侧 / 右侧 / 左上 / 右上 / 左下 / 右下 | 居中 | Shares its row with 填充 |
| 界面不透明度 (Surface opacity) | 20 – 100% | 72% | Transparency of the app surfaces and sidebar. The 20% floor keeps the interface usable |
| 侧边栏 (Sidebar) | on / off | on | Off leaves the sidebar opaque and only makes the main area translucent |
| 遮罩颜色 + 遮罩不透明度 | any / 0 – 90% | black / 0% | A flat colour above the picture, below the content |
| 恢复默认 (Reset) | — | — | Back to defaults (uploaded pictures are **not** deleted) |

## Where the data lives

The configuration and the pictures live in the **current profile**, **not inside the installed package**, so upgrading or reinstalling the plugin never loses them:

```
<profile>/.dsh-desktop-background/
├── config.json          # configuration
└── images/
    └── <sha256>.png     # uploaded pictures, named after their own content hash
```

- Pictures are **content-addressed**: identical bytes are stored once, and re-uploading de-duplicates;
- A file name **never comes from a request** (the plugin hashes the bytes itself), and every name read back is re-validated against `^[a-f0-9]{64}\.(png|jpg|webp|gif|avif)$`, so even a hand-edited `config.json` cannot escape the directory;
- A corrupt `config.json` **falls back to defaults** instead of stopping the profile from booting;
- Deleting a picture that is in use **also clears the reference** to it, leaving no dangling entry.

Deleting that directory from the profile cleans up completely.

## Security

The plugin's HTTP routes sit **outside** DSH's own `/api` authentication fence (a prefix route wins over the fence), so it enforces its own rules:

- **Same-origin check**: `sec-fetch-site: cross-site` is always refused; a present `Origin` must match `Host`; a request with neither (the desktop proxy strips `Origin`) is treated as a local page. A cross-site write gets `403` and the on-disk configuration is unchanged;
- Uploads **do not trust `Content-Type`** — the format is identified from magic bytes only. **`image/svg+xml` is explicitly refused** (SVG can carry script), and a lying `content-type` changes nothing;
- Served pictures carry `x-content-type-options: nosniff`, `cross-origin-resource-policy: same-origin` and a `default-src 'none'; sandbox` CSP;
- Body limits: `64 KB` for JSON, `16 MB` for pictures — checked against `content-length` first, so an oversized body is refused rather than drained;
- Malformed percent-encoding in a path is a `400`, not a `500`; an unexpected error becomes a flat `500 internal error` with a log line, and **internal paths are never echoed back** (only errors that declare a status are passed through).

## Coexisting with other plugins

- **Routes**: exactly **one** `prefix` route, `/dsh-desktop-background` — its own package name. It never touches `registerFallback` (already owned by `dsh-host-frontend-static`) and cannot swallow another plugin's namespace;
- **Styles**: every rule is gated by a single `html[data-dsh-dbg]` attribute, and every custom property and class name carries the `--dsh-dbg-` / `dsh-desktop-background` prefix. The style tag is marked with `data-plugin` so DSH's renderer removes it on unload;
- **Theme tokens**: only `theme.overrideTokens(source, …)`, the namespaced layer API (calling it again under the same source **replaces** rather than stacks), and the layer is withdrawn when the plugin unloads;
- **Settings**: registers into DSH's shared `settings.section` list slot, side by side with other third-party plugins, without overlapping them.

In validation, this plugin ran in one profile together with **`dshmarket`** and **`dsh-whale-widget`**: all three plugins' interfaces and routes worked, the boot log showed no duplicate route and no conflict warning, and the browser console reported **zero exceptions**. In the third screenshot above, "Plugin Market" and "Background" in the left nav are two third-party plugins coexisting.

## Compatibility

- Built and verified against **dsh 0.2.0-rc.2** (the version bundled with the DeepSeek Harness desktop app): the cordis `name` / `inject` / `apply` contract, `webServer.register`'s longest-prefix matching, `theme.overrideTokens`, the `settings.section` slot, the `insert` shape of `dsh.bundle.patch`, and the `dsh.client.platform` + `exports["./client"]` client-bundle delivery were all exercised on a real host;
- **No `peerDependencies` at all**: the host half never imports cordis (`ctx` is a plain injected object), so it does not participate in the host's version gating and cannot be skipped wholesale because a peer disagrees;
- The client half requires only `react` (a module in the platform seed table) and uses neither `react/jsx-runtime` nor any UI primitive — it draws with native elements and DSH's own CSS variables, keeping cross-version risk minimal;
- Light and dark themes both follow `prefers-color-scheme` and DSH's theme snapshot automatically.

## Development

```sh
git clone https://github.com/jgl0306/dsh-desktop-background.git
cd dsh-desktop-background
node --test          # 99 cases
```

**No build step**: `lib/*.js` and `client/client.js` in the repository *are* the runtime artifacts. There is no `tsc` / `tsdown` / bundler stage and no `install` / `prepare` / `postinstall` script — which is also why installing straight from git is not blocked by pnpm's build-script allowlist.

```
lib/
├── config.js     numeric bounds, enums, normalisation and merging (the host's single source of truth)
├── store.js      content-addressed picture library + config I/O (atomic writes, magic bytes, path checks)
├── presets.js    6 built-in gradients
├── http.js       same-origin check, body reading, error responses
├── routes.js     every endpoint under /dsh-desktop-background
└── index.js      the cordis entry point
client/
└── client.js     self-contained single-file bundle: the background layer and the settings panel
test/             config / store / routes / client-bundle / client-parity
tools/            screenshot.mjs — headless-Chrome/CDP probe and screenshot script
```

Platform contracts and design trade-offs (including what to re-check after a DSH upgrade) are in [docs/DESIGN.md](docs/DESIGN.md).

The client bundle is a standalone script and **cannot `import` host modules**, so the numeric bounds exist as two copies. `test/client-parity.test.js` extracts `LIMITS`, `FITS`, `POSITIONS` and `PRESETS` out of the **source text** of `client/client.js` and `assert.deepEqual`s each against `lib/` — **the moment the two copies drift, the suite fails**.

Coverage: config normalisation and clamping, content addressing and de-duplication, magic-byte detection (including refusing SVG), path traversal, corrupt-config fallback, every endpoint's status codes and headers, cross-site refusal, oversized and malformed input, isolation of the route namespace from another plugin's, and — via `node:vm` running the **real bundle source** against stubs — the rendered tokens and the accessibility of every settings control.

## What the endpoints do

The browser half reads and writes configuration and pictures through these endpoints under `/dsh-desktop-background` (if you want to drive it from your own UI, this is the whole contract):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/state` | Everything in one round trip: config, pictures, presets, bounds, accepted types |
| `PUT` / `POST` | `/api/v1/config` | Partial update (out-of-range values are clamped, unknown keys dropped) |
| `POST` | `/api/v1/config/reset` | Back to defaults |
| `POST` | `/api/v1/images` | The body *is* the picture bytes; answers `{ref, file, bytes, mime}` |
| `DELETE` | `/api/v1/images/<file>` | Delete, and clear any reference to it from the config |
| `GET` | `/assets/<file>` | The picture bytes (`immutable` caching + `nosniff` + same-origin CORP) |

## License

[MIT](LICENSE)
