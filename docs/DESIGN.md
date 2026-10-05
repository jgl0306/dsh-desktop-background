# 设计说明

这份文档记录**为什么**插件长成这样，以及它依赖了哪些平台契约。改动之前请先读这里 —— 好几处看起来「多余」的写法都是踩过坑之后的结果。

标 `[C]` 的结论读自真实宿主（`DeepSeek Harness.app/Contents/Resources/app.asar` 内的 dsh **0.2.0-rc.2**），并已在运行中的宿主上验证过。

---

## 1. 为什么是「主机端 + 客户端」两半

DSH 的插件可以只有主机端（`Config` schemastery 对象**就是**设置表单，由宿主自动渲染，不需要客户端 bundle）。这个插件却必须自带客户端 bundle，因为：

- DSH **没有**背景 / 壁纸 / 遮罩 API `[C]`（`0.2.0-rc.2` 里 `wallpaper` 出现 0 次，也没有 `--dsw-alias-bg-image` 之类的 token）。背景层必须由插件自己用 CSS 画。
- 画出来的层要在**浏览器**里生效，只能在客户端半边做。

反过来，图片也**不能**放在插件包里让浏览器取：

- 宿主的 `/plugins` 路由**只发 JavaScript** `[C]`（`client.js` / `client.<chunk>.js` 及其 `.map`），`/plugins/<pkg>/assets/x.png` 必然 404；`serveBundle` 兜底返回 `{status:404}`。DSH **没有**任何插件静态资源路由。
- 客户端 bundle 是 classic script，**无法 `import` 主机端模块**，也读不到文件系统。

所以图片必须由**主机端**从磁盘读出来、经插件自己的 HTTP 端点送给浏览器。这就是两半的分工：主机端 = 配置 + 图片库 + HTTP 端点；客户端 = 背景层 + 设置面板。

## 2. 为什么自建 HTTP API，而不用 DSH 的 settings / configForms

`0.2.0-rc.2` 里 **`settings.register(ns, schema, …)` 不存在** `[C]`；插件自己的 `Config` schemastery 对象就是设置表单，而它的值会被写进 profile 的 `cordis.patch.yml`。

图片如果走这条路，16 MB 的图片会变成 data URL 进 YAML —— 不可接受。而且：

- 我们需要**自建**存储、校验、去重、路径安全，这些在自己的 `lib/store.js` 里可以完整单测，不必去猜 schemastery / settings 的第三方签名；
- 参考插件 `dshmarket` 也是自建路由 + 自建 store。

代价：路由注册在裸 `webServer` 上，**在 DSH 自己的 `/api` 鉴权围栏之外**，必须自己校验同源。见第 5 节。

## 3. 主题与颜色：为什么必须动 `--dsw-alias-bg-base`

**层叠事实** `[C]`：

- shell CSS 有 `html,body,#root{height:100%;margin:0}`、`body{background:var(--dsw-alias-bg-base,#fff)}`、`body{isolation:isolate}`；
- 应用帧 `._6Qf49G_frame{background:var(--dsw-alias-bg-base)}`，darwin 下 `[data-platform=darwin] ._6Qf49G_frame{background:0 0}` **已经透明**；
- 但 `._6Qf49G_centerCol`（darwin 下仍不透明）和 `._6Qf49G_sidebarCol{background:var(--dsw-specific-sidebar-fill)}` 会挡住背景。

结论：**只画背景层是看不见效果的**，必须同时把应用表面的颜色改成半透明。于是插件覆盖两个 token：

- `--dsw-alias-bg-base` → 改成 `rgba(255,255,255,A)`（浅色）/ `rgba(21,21,23,A)`（深色）。这两个基色是 DSH 自己的 token 值 `[C]`（light `#fff` / dark `#151517`），所以覆盖后颜色依然正确，只是多了 alpha。
- `--dsw-specific-sidebar-fill` → 侧边栏颜色**在构建期无法得知**（可能是主题插件给的任意值），而 CSS 自定义属性**不能自我引用**来生成 alpha。所以运行时先 `getComputedStyle(document.body).getPropertyValue('--dsw-specific-sidebar-fill')` **捕获一次原值**，再用 `color-mix(in srgb, <base> N%, transparent)` 生成半透明版本。
  - 捕获时**拒绝**以 `color-mix(` 开头的值 —— 那是插件自己的产物，HMR 重载时若捕获到就会反复叠加 alpha；
  - **捕获不到就整个不覆盖该 token**，绝不猜别人的表面颜色。

`A` 的取值是**逐主题**决定的：`surface[theme] = enabled && image[theme] !== 'none' ? panelOpacity : 1`。即**某个主题没有配图时，那个主题保持完全不透明** —— 否则会直接透出窗口背景，而不是透出图。

## 4. 背景层的几何

```css
html[data-dsh-dbg] body::before {
  position: fixed; inset: calc(-2 * var(--dsh-dbg-blur, 0px)); z-index: 0; pointer-events: none;
  background-image: var(--dsh-dbg-image, none);
  filter: blur(…) brightness(…) saturate(…) contrast(…);
  transform: scale(var(--dsh-dbg-zoom, 1)); transform-origin: center center;
}
```

- `inset: calc(-2 * blur)`：图层向外扩张两倍模糊半径。否则 `blur()` 会把视口边缘的像素往外羽化，露出一圈透明边。
- `z-index: 0` + `#root { z-index: 1 }`：DSH 的 z-index 从 10 起才被占用（dockkit 10、handle 11、leadingSeat 15、overlayLayer 20、菜单 70、hovercard 100、modal 1000、portal 1100）`[C]`，**`<= 0` 整段空闲**，所以 0 不会撞车。
- 遮罩用 `body::after`，与 `::before` 同 `z-index` 但**晚绘制**，因此稳定地压在背景之上、内容之下。
- **缩放下限是 100%**：`transform: scale()` 小于 1 会让图层小于视口，露出边缘。

### 为什么没有「毛玻璃 / backdrop-filter」

面板的选择器是 CSS Module 的哈希类名（`_6Qf49G_frame` 之类），跨版本不稳定。要在**只给面板**加 `backdrop-filter` 而不写死这些类名，做不到。宁可少一个控件，也不上线一个**在某些版本上静默失效**的控件。

（`panelOpacity` + `applyToPanels` 覆盖 token 的方案是精确的，因为它用的是 DSH 自己的变量名。）

## 5. 威胁模型

路由在 `/api` 围栏之外 `[C]`，所以插件自己实现同源校验（三条规则，读自 `dshmarket/lib/http.js`）：

1. `sec-fetch-site === 'cross-site'` → 拒绝（浏览器的自述优先于任何 Origin）；
2. `Origin` 缺失 → 放行（桌面代理会剥掉它，缺失说明不是浏览器页面）；
3. 否则 `new URL(origin).host` 必须等于 `Host`。

其余措施：

- 上传**只按字节魔数**判定格式，**不信 `Content-Type`**；**显式拒绝 SVG**（可携带脚本）；
- 文件名**从不来自请求**：由插件对字节做 sha256 生成，回读时再用 `^[a-f0-9]{64}\.(png|jpg|webp|gif|avif)$` 校验。手改 `config.json` 也越不出目录；
- 写入用**同级 tmp + rename** 的原子写；
- 请求体上限：JSON 64 KB / 图片 16 MB。**先看 `content-length`**，超限直接拒绝而不读完；流式中途越界则 `pause()` 后返回 `413 + connection: close`。（早期实现用 `request.destroy()`，结果是 socket 被重置、用户看到网络错误而不是能解释原因的 413。）
- 路径里畸形的百分号编码（`/assets/%zz` 是客户端可控的）返回 **400**，不是 `decodeURIComponent` 抛出的 500；
- 未预期错误统一 `500 internal error` + 写日志，**不回显内部路径**；只有显式带 `status` 的错误才原样返回。

## 6. 客户端契约（`[C]`）

- bundle 是 classic script，自我注册：
  ```js
  window.__ModuleLoader__.load({ id: 'dsh-desktop-background', factory: (require) => { /* … */ } });
  ```
  重复 id 抛 `client-modules: duplicate factory registration for "<name>"`。
- `package.json` 必须有 `dsh.client.platform === 'web'` **且** `exports["./client"]` 是字符串，否则抛 `client-modules: <pkg> declares dsh.client but exports no "./client" bundle`。
- `require` 的可用模块受平台 seed 表限制，恰好是：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。**本项目只 `require('react')`** —— 其余的一概不用，尤其不用 `ui-primitives`（其 API 未确认），全部用原生元素 + DSH 的 CSS 变量自绘。
- 主题：`ctx.theme.overrideTokens(source, tokens)`，值必须是 `{light, dark}` 字符串对（传裸字符串会抛错）；同名 source 再次调用是**替换**该层并返回 disposer。`ui-layout` 的 `ThemePresenter.apply` 会把 `snapshot.active.tokens` **逐条写成 `document.body` 的内联自定义属性**，所以 override 能到达 `body::before`。
- 设置面板：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name, id, order, label, inject }, Component))`。`settings.section` 已由 `ui-settings-general` 声明为 `{kind:'list', scope:'root'}`，第三方可直接注册，**多个插件并列共存**。
- **bundle 的真实 URL 是 combo 路由** `/plugins/??<id>/client.js&rev=<rev>`（多个包用逗号连接），**不是** `/plugins/<id>/client.js`（后者 404）。宿主会自动发现 `dsh.client`、解析 `exports["./client"]`、读文件并算出内容 rev，**源码变了 rev 就变**（HMR / 重载据此判断）。

## 7. 打包与兼容

- `dsh.bundle.patch` 必填，可以是**一个字符串或有序数组**；`insert:` 行的形状见 `cordis.patch.yml`，插入的 `id` 不必等于包名 `[C]`。
- 只有 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 peer **会被版本门控**（`evaluatePluginCompatibility`，`{includePrerelease:true}`）；不兼容会让**整个 bundle 被跳过**。本项目**不声明任何 peerDependencies**（主机端不 `import` cordis），因此不可能因为 peer 对不上而被跳过。
- profile 用 pnpm `autoInstallPeers: false` + `nodeLinker: hoisted`，peer 由宿主解析。
- 桌面版 profile **只能由应用自己的 CLI 入口管理**：`dsh/lib/bin.js` 的 `rejectElectronProfile` 在 `!manageDesktopProfile` 时报 `error: profile "desktop" is managed exclusively by the Electron application`。

## 8. 已验证的证据

| 验证 | 方式 | 结果 |
|---|---|---|
| bundle patch 与兼容性门控 | `web --dump-config` | 出现 `# == dsh-desktop-background` / `- id: …` / `name: …` |
| 插件真的被加载 | 真实 boot 日志 | `dsh-desktop-background: mounted /dsh-desktop-background (profile: web)` |
| 路由挂载且绕开 `/api` 围栏 | `GET /dsh-desktop-background/api/v1/state` | `200` + 完整 JSON（无 token） |
| 上传 / 取图逐字节一致 | `POST /api/v1/images` → `GET /assets/<file>` | sha256 内容寻址，`cmp` 相同，响应头含 `immutable` / `nosniff` / CORP / CSP |
| 删图清理引用 | `DELETE /api/v1/images/<file>` | `lightImage` 一并置空 |
| 客户端 bundle 被发现并原样送达 | boot 图 + combo URL | `{"id":"dsh-desktop-background","url":"plugins/??…&rev=…"}`，`served.includes(source) === true` |
| token 真的到 CSS | 无头 Chrome 读 computed style | 渐变、`opacity`、`filter`、`transform: matrix(1.3,…)`、`z-index` 全部正确；`exceptions: []` |
| **按主题选图** | 同上 | 深色主题下画出来的是 `darkImage` 的渐变，不是 `lightImage` 的 |
| 关闭后界面复原 | 点标签文字关掉开关 | `data-dsh-dbg` 属性消失，`--dsw-alias-bg-base` 回到 `rgba(21,21,23,1)` |
| 设置面板可用 | 点击真实 React 控件 | 滑杆写入 → 180 ms 后持久化到宿主；标签文字能驱动开关 |
| 与其它插件共存 | 同 profile 装 `dshmarket` + `dsh-whale-widget` | 各自路由 200、各自命名空间 404 互不干扰、两个客户端 bundle 同图、导航并列、零异常 |
| 命名空间边界 | 单测 | `/dsh-desktop-background-extra` 不归本插件；卸载只释放自己的前缀 |
| 面板文字只有中文 | 单测 + 无头 Chrome 截图 | 渲染整棵控件树后断言每个 label / `aria-label` / tooltip / 正文除路径与 CSS 单位外不含拉丁字母；`docs/*.png` 复拍确认 |
| 宿主错误文案已汉化 | 单测 | 已知英文措辞（`lib/http.js` / `lib/routes.js` / `lib/store.js` 的文本）映射为中文，原文保留在 `title`；未知措辞原样透出而不是吞掉 |

## 9. DSH 升级时该重新确认什么

改动集中在少数几处平台契约上，升级宿主后优先复核：

1. `--dsw-alias-bg-base` 与 `--dsw-specific-sidebar-fill` 是否还是这两个 token 名、基色是否还是 `#fff` / `#151517`；
2. 应用帧是否仍在 `#root` 之内（决定 `z-index: 0` + `#root{z-index:1}` 这套是否还成立）；
3. 平台 seed 表是否仍提供 `react`；
4. `theme.overrideTokens` 是否仍要求 `{light, dark}` 且同名 source 为替换语义；
5. `settings.section` 是否仍由 `ui-settings-general` 声明、id 与 `order` 是否仍可自定义；
6. `/plugins/??` combo 路由与 `exports["./client"]` 的发现方式是否不变。

任何一条变了，先跑 `node --test`，再用 `tools/screenshot.mjs`（无头 Chrome + CDP，直接读真实 computed style 并截图）复核一遍真实渲染 —— 单元测试抓不到「token 名变了」这类问题。
