// 回归测试：同一个页面里换了视频（合集 / 分P）之后，旧状态必须作废、要能解析并
// 下载到「新」的那一条。真连 B 站接口。
//
//   node tools/e2e-switch.mjs
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
const fakeChrome = { runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } } };

const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts = {}) => {
  const o = { ...opts };
  delete o.credentials;
  return realFetch(url, o);
};

// grabber 用 location.href 判断「现在在播哪一条」
const loc = { href: 'https://www.bilibili.com/video/BV1aYW86vEte' };
globalThis.location = loc;

const win = { location: loc };
globalThis.window = win;
globalThis.document = fakeDoc;
globalThis.chrome = fakeChrome;

new Function('window', 'document', 'chrome', 'location', src)(win, fakeDoc, fakeChrome, loc);
console.log('grabber loaded, listeners =', listeners.length);

function call(msg) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const ret = listeners[0](msg, {}, done);
    if (ret !== true) setTimeout(() => { if (!settled) reject(new Error('no response for ' + msg.type)); }, 3000);
  });
}

const A = 'https://www.bilibili.com/video/BV1aYW86vEte';
const B = 'https://www.bilibili.com/video/BV1tS4n6CEoJ?p=3';

let bad = 0;
const ok = (name, cond, extra) => {
  if (cond) console.log('  ✓ ' + name);
  else { bad++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

/* --------------------------------------------------- 1. 第一条视频跑完整流程 */
console.log('\n[1] 视频 A 解析 + 下载');
loc.href = A;
const prepA = await call({ type: 'BAG_PREPARE', probe: { href: A } });
if (!prepA.ok) { console.log('prepare A failed:', prepA.error); process.exit(1); }
ok('A 解析出音轨', prepA.snapshot.tracks.length > 0, String(prepA.snapshot.tracks.length));
const bvidA = prepA.snapshot.meta.bvid;
console.log('  A =', bvidA, '| tracks', prepA.snapshot.tracks.length);

await call({ type: 'BAG_DOWNLOAD', index: 0 });
let st;
for (let i = 0; i < 60; i++) {
  st = await call({ type: 'BAG_STATUS' });
  if (st.phase !== 'downloading') break;
  await new Promise((r) => setTimeout(r, 300));
}
ok('A 下载完成', st.phase === 'done', st.phase + ' ' + (st.error || ''));
console.log('  A 文件：', st.filename, st.received, 'bytes');

/* --------------------------------------- 2. 在合集里切到新视频，旧状态要作废 */
console.log('\n[2] 页面切到视频 B（合集 / 分P 同一条路径）');
loc.href = B;
const statusB = await call({ type: 'BAG_STATUS' });
ok('旧状态已清空（不是 done）', statusB.phase === 'idle', statusB.phase);
ok('旧音轨列表已清空', statusB.tracks.length === 0, String(statusB.tracks.length));
ok('旧文件名已清空', !statusB.filename, statusB.filename);

/* ------------------------------------------------- 3. 重新解析要拿到 B 的 */
console.log('\n[3] 重新解析 B');
const prepB = await call({ type: 'BAG_PREPARE', probe: { href: B } });
if (!prepB.ok) { console.log('prepare B failed:', prepB.error); process.exit(1); }
const metaB = prepB.snapshot.meta;
ok('解析到了新的稿件', metaB.bvid !== bvidA, metaB.bvid + ' vs ' + bvidA);
ok('分 P 号跟地址栏一致', prepB.snapshot.meta.page === 3, String(prepB.snapshot.meta.page));
ok('B 也有音轨', prepB.snapshot.tracks.length > 0, String(prepB.snapshot.tracks.length));
console.log('  B =', metaB.bvid, 'P' + metaB.page, '|', metaB.title.slice(0, 24), '| cid', metaB.cid);

/* --------------------------------- 4. 页面又换了却没重新解析：不许下错文件 */
console.log('\n[4] 页面再换一条但没重新解析时，拒绝下载');
loc.href = 'https://www.bilibili.com/video/BV1GJ411x7h7';
const guard = await call({ type: 'BAG_DOWNLOAD', index: 0 });
ok('拒绝下载', guard && guard.ok === false, JSON.stringify(guard));
ok('给了明确提示', /换了/.test((guard && guard.error) || ''), guard && guard.error);

/* ----------------------------------------------- 5. 重新解析后能下载新视频 */
console.log('\n[5] 再解析一次，然后下载');
const prepC = await call({ type: 'BAG_PREPARE', probe: { href: loc.href } });
if (!prepC.ok) { console.log('prepare C failed:', prepC.error); process.exit(1); }
const before = saved.length;
await call({ type: 'BAG_DOWNLOAD', index: prepC.snapshot.tracks.length - 1 });
for (let i = 0; i < 60; i++) {
  st = await call({ type: 'BAG_STATUS' });
  if (st.phase !== 'downloading') break;
  await new Promise((r) => setTimeout(r, 300));
}
ok('新视频下载完成', st.phase === 'done', st.phase + ' ' + (st.error || ''));
ok('触发了一次保存', saved.length === before + 1, String(saved.length - before));
console.log('  文件：', st.filename);
ok('文件名里是新稿件的 BV 号', st.filename.includes(prepC.snapshot.meta.bvid), st.filename);

console.log(bad ? `\n回归测试失败：${bad} 项\n` : '\n回归测试通过\n');
process.exit(bad ? 1 : 0);
