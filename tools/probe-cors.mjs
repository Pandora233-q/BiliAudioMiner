// 检查音频 CDN 是否允许页面跨域读取（CORS），决定用页面 fetch 还是后台 fetch
const API = 'https://api.bilibili.com';
const bvid = process.argv[2] || 'BV1aYW86vEte';

const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const H = { 'User-Agent': ua, Referer: 'https://www.bilibili.com/' };

const v = await (await fetch(`${API}/x/web-interface/view?bvid=${bvid}`, { headers: H })).json();
const cid = v.data.cid;
console.log('cid', cid);

const q = new URLSearchParams({ bvid, cid: String(cid), fnval: '4048', fnver: '0', fourk: '1' });
const p = await (await fetch(`${API}/x/player/playurl?${q}`, { headers: H })).json();
console.log('code', p.code, 'dash', !!p.data?.dash);
const audios = p.data?.dash?.audio || [];
const url = audios[0]?.baseUrl || audios[0]?.base_url;
console.log('url host', url && new URL(url).host);

for (const origin of ['https://www.bilibili.com', 'chrome-extension://abcdefghijklmnop']) {
  const r = await fetch(url, {
    method: 'GET',
    headers: { ...H, Origin: origin, Range: 'bytes=0-15' }
  });
  const acao = r.headers.get('access-control-allow-origin');
  const acac = r.headers.get('access-control-allow-credentials');
  const acah = r.headers.get('access-control-allow-headers');
  const exp = r.headers.get('access-control-expose-headers');
  console.log(`\norigin=${origin}`);
  console.log(' status', r.status, 'acao=', acao, 'acac=', acac, 'acah=', acah, 'expose=', exp);
  console.log(' content-length', r.headers.get('content-length'), 'type', r.headers.get('content-type'));
  await r.arrayBuffer();
}
