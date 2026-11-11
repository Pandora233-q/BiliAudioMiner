// 找几个测试样本：多 P 视频、番剧剧集
const API = 'https://api.bilibili.com';
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const H = { 'User-Agent': ua, Referer: 'https://www.bilibili.com/' };
const j = (u) => fetch(u, { headers: H }).then((r) => r.json());

const rank = await j(`${API}/x/web-interface/ranking/v2?rid=0&type=all`);
const list = (rank.data && rank.data.list) || [];
for (const v of list.slice(0, 30)) {
  const view = await j(`${API}/x/web-interface/view?bvid=${v.bvid}`);
  const d = view.data || {};
  if ((d.videos || 0) >= 3) {
    console.log('multiP', d.bvid, 'videos=' + d.videos, d.title);
    break;
  }
  await new Promise((r) => setTimeout(r, 250));
}

const tl = await j('https://api.bilibili.com/pgc/web/timeline?types=1&before=2&after=2');
const days = (tl.result || []).filter((d) => (d.episodes || []).length);
for (const d of days) {
  const ep = d.episodes[0];
  console.log('bangumi ep', ep.ep_id, ep.title || '', '|', ep.pub_index || '');
  break;
}
console.log('season_ids', (days[0] && days[0].episodes || []).slice(0, 3).map((e) => e.ep_id).join(','));
