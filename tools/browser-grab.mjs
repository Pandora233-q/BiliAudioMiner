/**
 * 真浏览器（headless Chrome）里跑 grabber.js：验证真实页面源下的 CORS、
 * wbi 签名、流式下载与 <a download> 落盘。只把 chrome.runtime 消息层换成直接调用，
 * 其余（fetch、Blob、DOM 下载）全是真 Chrome。
 *
 *   node --experimental-websocket tools/browser-grab.mjs [视频URL]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync, readdirSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const DLDIR = join(ROOT, '.shots', 'dl2');
const PROFILE = join(ROOT, '.shots', 'prof_grab');
const PORT = 9336;
const VIDEO = process.argv[2] || 'https://www.bilibili.com/video/BV1aYW86vEte';

rmSync(DLDIR, { recursive: true, force: true });
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(DLDIR, { recursive: true });

const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu',
  `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,900',
  VIDEO
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch (e) {} });

let ver;
for (let i = 0; i < 60; i++) {
  try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch (e) { await sleep(500); }
}
if (!ver) { console.log('× Chrome 没起来'); process.exit(1); }

const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 0;
const waiters = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiters.has(m.id)) { const w = waiters.get(m.id); waiters.delete(m.id); w(m); }
};
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const id = ++seq;
  waiters.set(id, res);
  ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
});
const evalIn = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session);
  if (r.error) throw new Error('CDP: ' + r.error.message);
  const res = r.result;
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error('页面异常: ' + (d.exception?.description || d.text));
  }
  return res.result.value;
};

await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DLDIR.replace(/\//g, '\\') });

// 找到视频页 target
await sleep(2500);
const page = (await send('Target.getTargets')).result.targetInfos.find(
  (t) => t.type === 'page' && /bilibili\.com/.test(t.url)
);
if (!page) { console.log('× 没找到视频页'); process.exit(1); }
const session = (await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).result.sessionId;
await send('Runtime.enable', {}, session);
console.log('页面：', page.url);

// 注入 fake chrome.runtime + grabber.js（真 Chrome 没装扩展，消息层用直接调用代替）
const src = readFileSync(join(ROOT, 'grabber.js'), 'utf8');
await evalIn(`(() => {
  window.__msgs = [];
  window.chrome = window.chrome || {};
  window.chrome.runtime = {
    onMessage: { addListener(fn) { window.__listener = fn; } },
    sendMessage() {},
    getURL(p) { return 'chrome-extension://fake/' + p; },
    id: 'fake'
  };
  return true;
})()`);
await evalIn(src + '\n//# sourceURL=grabber.js\n; true');
console.log('已注入 grabber.js, listener =', await evalIn('typeof window.__listener'));

const call = (msg) => `new Promise((res) => { window.__listener(${JSON.stringify(msg)}, {}, res); })`;

const t0 = Date.now();
const prep = await evalIn(call({ type: 'BAG_PREPARE', probe: {} }));
console.log(`准备完成 ${Date.now() - t0}ms：`, prep.ok, '|', prep.snapshot?.phase,
  '|', (prep.snapshot?.tracks || []).map((t) => t.label + ' ' + t.bandwidth).join(' , '));
if (!prep.ok) { console.log('× 解析失败：', prep.error); ws.close(); chrome.kill(); process.exit(1); }

const tracks = prep.snapshot.tracks;
const pick = tracks.length - 1; // 最低码率，省流量
await evalIn(call({ type: 'BAG_DOWNLOAD', index: pick }));

let st = null;
for (let i = 0; i < 120; i++) {
  await sleep(600);
  st = await evalIn(call({ type: 'BAG_STATUS' }));
  if (st.phase === 'done' || st.phase === 'error') break;
  if (i % 5 === 0) console.log('  ', st.phase, Math.round((st.progress || 0) * 100) + '%', (st.received / 1048576).toFixed(2) + 'MB');
}
console.log('结束状态：', JSON.stringify({ phase: st.phase, file: st.file, error: st.error, size: st.received }));

await sleep(1200);
const files = readdirSync(DLDIR).map((f) => ({ f, size: statSync(join(DLDIR, f)).size }));
console.log('下载目录：', JSON.stringify(files));

ws.close();
chrome.kill();
await sleep(500);

const okFile = files.find((x) => x.size > 100000 && !/\.crdownload$/.test(x.f));
if (st.phase === 'done' && okFile) {
  console.log('\nREAL PAGE OK — 真页面里解析 + 流式下载 + <a download> 落盘：' + okFile.f + ' (' + okFile.size + ' bytes)');
  process.exit(0);
}
console.log('\nREAL PAGE FAILED');
process.exit(1);
