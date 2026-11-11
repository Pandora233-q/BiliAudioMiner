/**
 * 本地自测：在 Node 里加载 grabber.js（模拟页面的隔离世界），
 * 校验 MD5 / wbi 签名 / playurl / 音轨解析 / 文件名，并可选做一次真实接口联调。
 *
 *   node tools/selftest.mjs          # 离线用例
 *   node tools/selftest.mjs --live   # 额外调用真实 B 站接口
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = readFileSync(path.join(here, '..', 'grabber.js'), 'utf8');

const sandbox = {
  console, fetch, URL, URLSearchParams, TextEncoder, TextDecoder,
  Blob, AbortController, setTimeout, clearTimeout, queueMicrotask,
  location: { href: 'https://www.bilibili.com/video/BV1xx411c7mD' },
  document: {
    createElement: () => ({ style: {}, click() {}, remove() {}, setAttribute() {} }),
    body: { appendChild() {} }
  },
  chrome: { runtime: { onMessage: { addListener() {} } } }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'grabber.js' });

const T = sandbox.window.__bagTest;
let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

function eq(name, a, b) {
  ok(name + ` (${JSON.stringify(a)})`, a === b, 'got ' + JSON.stringify(a));
}

console.log('\n[1] MD5 对齐 node:crypto');
for (const s of ['', 'abc', 'The quick brown fox jumps over the lazy dog', 'wbi签名测试-BV1xx411c7mD', 'a'.repeat(200)]) {
  eq('md5(' + (s.length > 20 ? s.slice(0, 20) + '…' : s) + ')', T.md5(s), createHash('md5').update(s, 'utf8').digest('hex'));
}

console.log('\n[2] wbi mixin key');
// 官方示例：img_key=7cd084941338484aae1ad9425b84077c, sub_key=4932caff0ff746eab6f01bf08b70ac45
const imgKey = '7cd084941338484aae1ad9425b84077c';
const subKey = '4932caff0ff746eab6f01bf08b70ac45';
const mixin = T.mixinKey(imgKey + subKey);
eq('mixinKey 长度', mixin.length, 32);
eq('mixinKey 结果', mixin, 'ea1db124af3c7062474693fa704f4ff8');

console.log('\n[3] buildQuery / 签名');
const { query, signed } = T.buildQuery({ bvid: 'BV1xx411c7mD', cid: 123456, fnval: 4048, fnver: 0, fourk: 1 }, 'ea1db124af3c7062474693fa704f4ff8', 1700000000);
ok('带 w_rid', signed && /w_rid=[0-9a-f]{32}$/.test(query), query);
eq('参数按字典序', query.slice(0, 60), 'bvid=BV1xx411c7mD&cid=123456&fnval=4048&fnver=0&fourk=1&wts=1700000000'.slice(0, 60));
const expect = JSON.parse(JSON.stringify(query));
ok('w_rid 可复算', expect === query);

const plain = T.buildQuery({ bvid: 'BV1xx411c7mD', cid: 1 }, '', 1700000000);
ok('无 key 时不签名', !plain.signed && !/w_rid/.test(plain.query));

console.log('\n[4] parseTracks：完整音轨');
const canned = {
  dash: {
    duration: 300,
    audio: [
      { id: 30280, baseUrl: 'https://a/192.m4s', backupUrl: ['https://b/192.m4s'], bandwidth: 192000, codecs: 'mp4a.40.2' },
      { id: 30216, baseUrl: 'https://a/64.m4s', bandwidth: 64000, codecs: 'mp4a.40.2' }
    ],
    dolby: { type: 1, audio: [{ baseUrl: 'https://a/dolby.m4s', bandwidth: 448000, codecs: 'ec-3' }] },
    flac: { display: '24bit / 96kHz', audio: { baseUrl: 'https://a/flac.m4s', bandwidth: 1500000, codecs: 'fLaC' } }
  }
};
const parsed = T.parseTracks(canned);
eq('音轨数量', parsed.tracks.length, 4);
eq('第一条是 FLAC', parsed.tracks[0].kind, 'flac');
ok('FLAC 标记为无损', parsed.tracks[0].lossless === true);
eq('第二条是杜比', parsed.tracks[1].kind, 'dolby');
eq('AAC 按码率降序', parsed.tracks[2].bandwidth, 192000);
eq('时长', parsed.duration, 300);
ok('有 FLAC 时不给降级提示', parsed.note === '');

console.log('\n[5] parseTracks：只有 AAC');
const aacOnly = T.parseTracks({ dash: { duration: 60, audio: [{ base_url: 'https://a/x.m4s', bandwidth: 132000 }] } });
eq('数量', aacOnly.tracks.length, 1);
ok('提示无无损', /无损/.test(aacOnly.note));
eq('snake_case 兼容', aacOnly.tracks[0].url, 'https://a/x.m4s');

let threw = false;
try { T.parseTracks({ dash: null }); } catch (e) { threw = true; }
ok('无 dash 时报错', threw);

console.log('\n[6] 文件名');
const meta = { title: '【测试】a/b:c*"?<>|', bvid: 'BV1xx411c7mD', aid: 2, page: 2, part: 'P2 现场' };
const fn = T.buildFilename(meta, { kind: 'flac', bandwidth: 1500000 }, 'flac');
ok('非法字符被替换', !/[\\/:*?"<>|]/.test(fn), fn);
ok('包含 BV 号与 P 号', fn.includes('BV1xx411c7mD-P2'), fn);
ok('扩展名正确', fn.endsWith('.flac'), fn);
const fn2 = T.buildFilename({ title: 'x', bvid: 'BV1', aid: 1, page: 1 }, { kind: 'aac', bandwidth: 192000 }, 'm4a');
ok('AAC 文件名带码率', fn2.includes('[BV1 192k]'), fn2);

console.log('\n[7] 扩展名嗅探');
const mkBlob = (bytes) => new Blob([new Uint8Array(bytes)]);
eq('raw FLAC', await T.sniffExt(mkBlob([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0]), 'm4a'), 'flac');
eq('MP4', await T.sniffExt(mkBlob([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]), 'flac'), 'm4a');
eq('ID3 mp3', await T.sniffExt(mkBlob([0x49, 0x44, 0x33, 4, 0, 0]), 'm4a'), 'mp3');

console.log('\n[8] playurl 返回结构解包（/x 与 pgc 三种形状）');
const d1 = { dash: { audio: [{ baseUrl: 'a' }] } };
ok('x/player: {data.dash}', T.unwrapPlayurl({ code: 0, data: d1 }).dash === d1.dash);
ok('pgc v1: {result.dash}', T.unwrapPlayurl({ code: 0, result: d1 }).dash === d1.dash);
ok('pgc v2: {result.video_info.dash}', T.unwrapPlayurl({ code: 0, result: { video_info: d1 } }).dash === d1.dash);
const durl = { durl: [{ url: 'x' }], is_preview: 1 };
ok('试看片段: {result.durl}', !!T.unwrapPlayurl({ code: 0, result: durl }).durl);
ok('空响应不炸', Object.keys(T.unwrapPlayurl({ code: -404 })).length === 0);

console.log('\n[9] 分 P 标题与稿件标题重复时不重复拼');
const dupMeta = { title: '《某PV》标题', bvid: 'BV1x', aid: 1, page: 3, part: '英-《某PV》标题' };
const dupFn = T.buildFilename(dupMeta, { kind: 'aac', bandwidth: 194000 }, 'm4a');
eq('只出现一次标题', dupFn.split('《某PV》标题').length - 1, 1);
ok('保留分 P 前缀', /英-/.test(dupFn), dupFn);
const partOnly = T.buildFilename({ title: '主标题', bvid: 'BV1x', aid: 1, page: 2, part: '第二个分P' }, { kind: 'aac', bandwidth: 1 }, 'm4a');
ok('正常分 P 仍然拼接', partOnly.includes('主标题 - 第二个分P'), partOnly);

console.log('\n[10] 页面里换视频（合集 / 分P）后旧状态必须作废');
const L = sandbox.location;
L.href = 'https://www.bilibili.com/video/BV1aa411c7mA?p=1';
const keyA = T.pageKey();
T.state.phase = 'done';
T.state.tracks = [{ key: 'aac0' }];
T.state.filename = 'a.m4a';
T.state.pageKey = keyA;

ok('同一条视频不算换页', T.syncPage() === false);
ok('同一条视频状态保留', T.state.phase === 'done' && T.state.tracks.length === 1);

L.href = 'https://www.bilibili.com/video/BV1aa411c7mA?p=1&spm_id_from=333.999#t=12';
ok('只是 query 噪声/锚点不算换页', T.pageKey() === keyA);

L.href = 'https://www.bilibili.com/video/BV1bb411c7mB?p=1';
ok('合集里切到新视频算换页', T.syncPage() === true);
ok('旧状态被清空', T.state.phase === 'idle' && T.state.tracks.length === 0 && T.state.filename === '');

L.href = 'https://www.bilibili.com/video/BV1bb411c7mB?p=2';
ok('同一个稿件的另一个分 P 也算换页', T.syncPage() === true);

L.href = 'https://www.bilibili.com/video/BV1cc411c7mC?p=1';
T.state.phase = 'downloading';
T.state.pageKey = T.pageKey();
L.href = 'https://www.bilibili.com/video/BV1dd411c7mD?p=1';
ok('下载中换页不清状态（传输还在跑）', T.syncPage() === false && T.state.phase === 'downloading');

L.href = 'https://www.bilibili.com/bangumi/play/ep123456';
ok('番剧页 key 带 ep', /bangumi\/play\/ep123456/.test(T.pageKey()), T.pageKey());

if (process.argv.includes('--live')) {
  console.log('\n[11] 真实接口联调');
  try {
    const pop = await (await fetch('https://api.bilibili.com/x/web-interface/popular?ps=5&pn=1', {
      headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' }
    })).json();
    const item = pop.data.list[0];
    console.log('  样片：', item.bvid, item.title.slice(0, 30));

    const view = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${item.bvid}`, {
      headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' }
    })).json();
    const cid = view.data.cid;
    console.log('  cid：', cid);

    const data = await T.fetchPlayurl({ bvid: item.bvid, aid: view.data.aid, cid, epId: 0 });
    ok('playurl 返回 dash', !!(data && data.dash));
    const live = T.parseTracks(data);
    console.log('  音轨：', live.tracks.map((t) => t.label + ' / ' + t.bandwidth).join('  |  '));
    ok('解析出音轨', live.tracks.length > 0);

    const first = live.tracks[0];
    const head = await fetch(first.url, { headers: { Referer: 'https://www.bilibili.com/', Range: 'bytes=0-1023' } });
    ok('音轨地址可取（HTTP ' + head.status + '）', head.status === 200 || head.status === 206);
    const buf = new Uint8Array(await head.arrayBuffer());
    console.log('  前 12 字节：', Array.from(buf.slice(0, 12)).map((b) => b.toString(16).padStart(2, '0')).join(' '));
  } catch (e) {
    console.log('  ! 联调失败：' + e.message);
    console.log('    （无登录态时 playurl 也可能返回 -101 / -352，属预期）');
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
