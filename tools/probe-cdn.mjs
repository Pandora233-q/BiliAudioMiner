/** 一次性联调：完整下载一条真实音轨，验证 Content-Length / Referer 行为 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync('grabber.js', 'utf8');
const sandbox = {
  console, fetch, URL, URLSearchParams, TextEncoder, Blob, AbortController,
  setTimeout, clearTimeout, queueMicrotask,
  location: { href: 'https://www.bilibili.com/video/BV1aYW86vEte' },
  document: { createElement: () => ({ style: {}, click() {}, remove() {} }), body: { appendChild() {} } },
  chrome: { runtime: { onMessage: { addListener() {} } } }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const T = sandbox.window.__bagTest;

const view = await (await fetch('https://api.bilibili.com/x/web-interface/view?bvid=BV1aYW86vEte', {
  headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' }
})).json();
const data = await T.fetchPlayurl({ bvid: 'BV1aYW86vEte', aid: view.data.aid, cid: view.data.cid });
const track = T.parseTracks(data).tracks[0];
console.log('音轨:', track.label, track.url.slice(0, 70) + '…');

for (const [name, headers] of [
  ['无 Referer', {}],
  ['B 站 Referer', { Referer: 'https://www.bilibili.com/' }],
  ['错误 Referer', { Referer: 'https://example.com/' }]
]) {
  try {
    const r = await fetch(track.url, { headers: { ...headers, Range: 'bytes=0-99' } });
    console.log(`  ${name}: HTTP ${r.status}, content-length=${r.headers.get('content-length')}, accept-ranges=${r.headers.get('accept-ranges')}`);
  } catch (e) {
    console.log(`  ${name}: 失败 ${e.message}`);
  }
}

const full = await fetch(track.url, { headers: { Referer: 'https://www.bilibili.com/' } });
console.log('完整 GET:', full.status, 'content-length =', full.headers.get('content-length'), 'content-type =', full.headers.get('content-type'));
const buf = Buffer.from(await full.arrayBuffer());
console.log('实际字节:', buf.length, '头部:', buf.subarray(0, 16).toString('hex'));
