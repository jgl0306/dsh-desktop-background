/**
 * Capture the README screenshots from a running host, through headless Chrome
 * and the DevTools protocol.
 *
 * Development tooling, not part of the plugin: it needs a `dsh web` (or the
 * desktop app) already serving this plugin, and a URL carrying a valid token —
 * take the `http://127.0.0.1:<port>/?token=…` line the host prints at startup.
 *
 *   node tools/screenshot.mjs "http://127.0.0.1:19401/?token=…" docs
 *
 * Writes `01-background-applied.png`, `02-settings-nav.png` and
 * `03-background-panel.png` into the output directory. Configure the plugin
 * through the UI (or its API) first: the shots capture whatever is set.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';

const [url, outdir = 'docs'] = process.argv.slice(2);
if (!url) {
  console.error('usage: node tools/screenshot.mjs <token-url> [outdir]');
  process.exit(2);
}

const PORT = Number(process.env.CDP_PORT ?? 9347);
const PROFILE = process.env.CHROME_PROFILE ?? '/tmp/dsh-desktop-background-chrome';
const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

await mkdir(outdir, { recursive: true });
await rm(PROFILE, { recursive: true, force: true });

// `--no-sandbox` and the crash-reporter switches are required when Chrome runs
// inside a restricted file sandbox, where crashpad cannot write its settings
// file and Chrome aborts before the first frame.
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--headless=new',
    '--no-sandbox',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    '--window-size=1440,900',
    url,
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] },
);

let page;
for (let attempt = 0; attempt < 80 && !page; attempt += 1) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  } catch {
    /* the debugging endpoint is not up yet */
  }
  if (!page) await sleep(250);
}
if (!page) {
  chrome.kill('SIGKILL');
  throw new Error('no page target appeared; is the URL reachable?');
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id === undefined) return;
  const settle = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) settle.reject(new Error(JSON.stringify(message.error)));
  else settle.resolve(message.result);
});

/** Every command is bounded: a crashed renderer stops answering entirely. */
function send(method, params = {}, timeoutMs = 20000) {
  const id = (nextId += 1);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP "${method}" timed out`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return result.result.value;
}

/** Poll rather than sleep: panels render at their own pace. */
async function waitFor(expression, label, tries = 80) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (await evaluate(expression)) return true;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${outdir}/${name}.png`, Buffer.from(data, 'base64'));
  console.log(`wrote ${outdir}/${name}.png`);
}

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await waitFor('document.querySelector("#root")?.childElementCount > 0', 'the app to mount');
  await sleep(2000);

  // A fresh profile shows first-run notices; dismiss them so the picture is
  // what the shot shows.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const dismissed = await evaluate(`(() => {
      for (const label of ['继续', '稍后配置', '跳过', '我知道了']) {
        const button = [...document.querySelectorAll('button')]
          .find((candidate) => (candidate.innerText || '').trim() === label);
        if (button) { button.click(); return label; }
      }
      return null;
    })()`);
    if (!dismissed) break;
    console.log(`dismissed: ${dismissed}`);
    await sleep(1500);
  }
  await sleep(2500);
  await shot('01-background-applied');

  await evaluate(
    `[...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '设置')?.click()`,
  );
  await waitFor('document.querySelectorAll("[role=dialog]").length > 0', 'the settings dialog');
  await sleep(2000);
  await shot('02-settings-nav');

  await evaluate(`[...document.querySelectorAll('*')]
    .filter((el) => (el.textContent || '').trim() === '背景 / Background').pop()?.click()`);
  await waitFor('document.querySelectorAll("input[type=range]").length > 0', 'the background controls');
  await sleep(1200);
  await shot('03-background-panel');
} finally {
  socket.close();
  chrome.kill('SIGKILL');
}
