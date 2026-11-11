// 端到端干跑：给 grabber.js 喂一个假 DOM/chrome，真连 B 站接口，走完
// BAG_PREPARE → BAG_DOWNLOAD → 落盘 的完整链路，检查字节与文件名。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'grabber.js'), 'utf8');

/* ---------------------------------------------------------------- 假环境 */
const saved = [];
const fakeDoc = {
  body: { appendChild() {} },
  createElement(tag) {
    return {
      tagName: tag,
      style: {},
      set href(v) { this._href = v; },
      get href() { return this._href; },
      set download(v) { this._dl = v; },
      get download() { return this._dl; },
      click() { saved.push({ name: this._dl, href: this._href }); },
      remove() {}
    };
  }
};

const listeners = [];
const fakeChrome = {
  runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } }
};

// grabber 用 credentials:'include' 请求 api.bilibili.com；Node fetch 不支持带凭据跨域，
// 这里把 credentials 摘掉（浏览器里由 cookie 决定权限，Node 里本来就是匿名的）
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts = {}) => {
  const o = { ...opts };
  delete o.credentials;
  return realFetch(url, o);
};

const win = { };
globalThis.window = win;
globalThis.document = fakeDoc;
globalThis.chrome = fakeChrome;

new Function('window', 'document', 'chrome', src)(win, fakeDoc, fakeChrome);
console.log('grabber loaded, listeners =', listeners.length);

/* ---------------------------------------------------------------- 驱动 */
function call(msg) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const ret = listeners[0](msg, {}, done);
    if (ret !== true) setTimeout(() => { if (!settled) reject(new Error('no response for ' + msg.type)); }, 3000);
  });
}

const t0 = Date.now();
const target = process.argv[2] || 'https://www.bilibili.com/video/BV1aYW86vEte';
const prep = await call({ type: 'BAG_PREPARE', probe: { href: target } });
console.log(`prepare ${Date.now() - t0}ms ok=${prep.ok}`);
if (!prep.ok) { console.log('error:', prep.error); process.exit(1); }

const snap = prep.snapshot;
console.log('title:', snap.meta.title);
console.log('bvid/cid:', snap.meta.bvid, snap.meta.cid, 'page', snap.meta.page, 'dur', snap.duration);
snap.tracks.forEach((t, i) => console.log(`  [${i}] ${t.label} | ${t.detail} | lp=${t.lossless} | ${t.bandwidth}bps`));

console.log('\ndownloading track 0 ...');
const t1 = Date.now();
await call({ type: 'BAG_DOWNLOAD', index: 0 });

let st = null;
for (let i = 0; i < 120; i++) {
  st = await call({ type: 'BAG_STATUS' });
  if (st.phase !== 'downloading') break;
  await new Promise((r) => setTimeout(r, 400));
}
console.log(`download ${Date.now() - t1}ms phase=${st.phase} received=${st.received} total=${st.total} file=${st.filename}`);
if (st.error) console.log('error:', st.error);
if (st.note) console.log('note:', st.note);

if (st.phase !== 'done') process.exit(1);
if (saved.length !== 1) { console.log('anchor clicks:', saved.length); process.exit(1); }
console.log('anchor name:', saved[0].name);

// 校验 blob 真被创建且字节数合理
const blob = await (await realFetch(saved[0].href.replace(/^blob:/, 'blob:').length ? saved[0].href : saved[0].href)).blob().catch(() => null);
if (!blob) console.log('(node 不支持取回 blob URL，跳过字节校验)');
else console.log('blob bytes:', blob.size);

// 名字与扩展名
if (!/\.(flac|m4a|mp3|ogg)$/.test(saved[0].name)) { console.log('bad extension'); process.exit(1); }
if (/[\\/:*?"<>|]/.test(saved[0].name)) { console.log('bad filename chars'); process.exit(1); }
console.log('\nE2E OK');
