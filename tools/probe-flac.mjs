// 扫一遍音乐区热门，看匿名请求下 dash.flac / dash.dolby 是否会出现（验证无损分支）
const API = 'https://api.bilibili.com';
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const H = { 'User-Agent': ua, Referer: 'https://www.bilibili.com/' };
const j = (u) => fetch(u, { headers: H }).then((r) => r.json());

const rank = await j(`${API}/x/web-interface/ranking/v2?rid=3&type=all`);
if (rank.code !== 0) { console.log('ranking failed', rank.code, rank.message); process.exit(1); }
const list = (rank.data.list || []).slice(0, 20);
console.log('candidates', list.length);

let flacHits = 0, dolbyHits = 0;
for (const v of list) {
  const q = new URLSearchParams({ bvid: v.bvid, cid: String(v.cid), fnval: '4048', fnver: '0', fourk: '1' });
  const p = await j(`${API}/x/player/playurl?${q}`);
  const d = p.data && p.data.dash;
  const f = d && d.flac;
  const dol = d && d.dolby && d.dolby.audio && d.dolby.audio.length;
  if (f) flacHits++;
  if (dol) dolbyHits++;
  console.log(
    v.bvid, p.code,
    'flac=' + (f ? JSON.stringify(f.display || '') + ' sr=' + (f.audio && f.audio.sr) : 'no'),
    'dolby=' + (dol ? dol + ' track(s)' : 'no'),
    'aac=' + (d && d.audio ? d.audio.length : 0)
  );
  await new Promise((r) => setTimeout(r, 350));
}
console.log('\nflac videos:', flacHits, ' dolby videos:', dolbyHits);
