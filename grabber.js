/* ============================================================================
 * B站音频提取器 · 页面执行器 (grabber.js)
 * ----------------------------------------------------------------------------
 * 运行环境：bilibili.com 页面的「隔离世界」(ISOLATED world)，由 popup 通过
 *          chrome.scripting.executeScript 注入。
 * 职责：
 *   1. 解析当前播放的视频（普通稿件 / 番剧），拿到 bvid / aid / cid / ep_id
 *   2. 用 wbi 签名请求 x/player/wbi/playurl，拿到 DASH 音轨（含 FLAC / 杜比）
 *   3. 下载音轨分片（fetch 流式读取），探测真实容器扩展名，交给浏览器保存
 *   4. 通过 chrome.runtime 消息把状态回报给 popup
 * ==========================================================================*/
(() => {
  'use strict';

  if (window.__BAG_LOADED__) return;
  window.__BAG_LOADED__ = true;

  const API = 'https://api.bilibili.com';
  /** fnval: dash(16) + hdr(64) + 4k(128) + dolby(256) + dolbyVision(512) + 8k(1024) + flac(2048) */
  const FNVAL = 4048;

  const state = {
    phase: 'idle',   // idle | preparing | ready | downloading | done | error
    meta: null,
    tracks: [],
    duration: 0,
    received: 0,
    total: 0,
    filename: '',
    error: '',
    note: '',
    startedAt: 0,
    /** 这份状态属于「哪一条视频」；页面里换视频（合集 / 分P / 自动连播）后必须作废 */
    pageKey: ''
  };

  let abortCtl = null;
  let wbiCache = { key: '', ts: 0 };

  /* ------------------------------------------------------- 页面身份追踪 */

  /**
   * 当前页面在播哪一条视频 —— 只用 URL 里真正决定视频身份的部分。
   * B 站换合集里的视频、换分 P 都是 SPA 跳转（history.pushState），页面不重载，
   * 注入的脚本也还在；不看这个就会拿着上一条视频的状态去下载。
   */
  function pageKey() {
    let u;
    try {
      u = new URL(location.href);
    } catch (e) {
      return String(location.href || '');
    }
    const path = u.pathname.replace(/\/+$/, '');
    const bv = (path.match(/\/video\/(BV[0-9A-Za-z]{6,}|av\d+)/i) || [])[1] || '';
    const ep = (path.match(/\/bangumi\/play\/((?:ep|ss)\d+)/i) || [])[1] || '';
    const q = u.searchParams;
    return [
      u.host,
      path,
      bv,
      ep,
      q.get('p') || q.get('page') || '',
      q.get('bvid') || '',
      q.get('ep_id') || q.get('season_id') || ''
    ].join('|');
  }

  function clearVideoState() {
    state.phase = 'idle';
    state.meta = null;
    state.tracks = [];
    state.duration = 0;
    state.received = 0;
    state.total = 0;
    state.filename = '';
    state.error = '';
    state.note = '';
    state.startedAt = 0;
  }

  /**
   * 页面换了视频就把旧状态丢掉。下载中不动（传输还在跑，中途清掉会把进度弄丢）。
   * @returns {boolean} 是否发生了作废
   */
  function syncPage() {
    const key = pageKey();
    if (!state.pageKey) {
      state.pageKey = key;
      return false;
    }
    if (key === state.pageKey) return false;
    if (state.phase === 'downloading') return false;
    clearVideoState();
    state.pageKey = key;
    return true;
  }

  /* ------------------------------------------------------------------ MD5 */
  function md5(str) {
    const bytes = new TextEncoder().encode(str);
    const len = bytes.length;
    const total = (((len + 8) >> 6) + 1) * 64;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[len] = 0x80;

    const view = new DataView(buf.buffer);
    view.setUint32(total - 8, (len * 8) >>> 0, true);
    view.setUint32(total - 4, Math.floor((len * 8) / 4294967296), true);

    const S = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];
    const K = new Int32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

    for (let off = 0; off < total; off += 64) {
      const M = new Int32Array(16);
      for (let i = 0; i < 16; i++) M[i] = view.getInt32(off + i * 4, true);

      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }

        F = (F + A + K[i] + M[g]) | 0;
        A = D; D = C; C = B;
        const s = S[i];
        B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }

    const out = new Uint8Array(16);
    const ov = new DataView(out.buffer);
    ov.setInt32(0, a0, true);
    ov.setInt32(4, b0, true);
    ov.setInt32(8, c0, true);
    ov.setInt32(12, d0, true);
    let hex = '';
    for (let i = 0; i < 16; i++) hex += out[i].toString(16).padStart(2, '0');
    return hex;
  }

  /* ------------------------------------------------------------------ wbi */
  const MIXIN_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
  ];

  function mixinKey(raw) {
    let out = '';
    for (let i = 0; i < MIXIN_TAB.length; i++) out += raw[MIXIN_TAB[i]] || '';
    return out.slice(0, 32);
  }

  async function getWbiKey() {
    if (wbiCache.key && Date.now() - wbiCache.ts < 10 * 60 * 1000) return wbiCache.key;
    const j = await apiJson(`${API}/x/web-interface/nav`, { auth: false });
    const img = j && j.data && j.data.wbi_img;
    if (!img || !img.img_url || !img.sub_url) return '';
    const file = (u) => String(u).split('/').pop().split('.')[0];
    const key = mixinKey(file(img.img_url) + file(img.sub_url));
    wbiCache = { key, ts: Date.now() };
    return key;
  }

  /**
   * 组装查询串；给了 key 就追加 w_rid（wbi 签名）。
   * 签名规则：参数按 key 排序 → 去掉 !'()* → encodeURIComponent → 拼成 query，
   *           再对 query + mixinKey 取 MD5。
   */
  function buildQuery(params, key, wts) {
    const all = Object.assign({ wts: wts || Math.round(Date.now() / 1000) }, params);
    const query = Object.keys(all)
      .filter((k) => all[k] !== undefined && all[k] !== null && all[k] !== '')
      .sort()
      .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(all[k]).replace(/[!'()*]/g, '')))
      .join('&');
    if (!key) return { query, signed: false };
    return { query: query + '&w_rid=' + md5(query + key), signed: true };
  }

  /* -------------------------------------------------------------- request */
  async function rawFetchJson(url, credentials) {
    const resp = await fetch(url, { credentials, cache: 'no-store' });
    if (!resp.ok) throw new Error(`请求失败（HTTP ${resp.status}）`);
    return resp.json();
  }

  /**
   * 调 B 站接口。默认带 cookie（音质/权限都依赖登录态）；
   * 若接口不允许凭据（CORS 的 ACAO 为 *），自动退回无凭据再试一次。
   */
  async function apiJson(url, opts) {
    const auth = !opts || opts.auth !== false;
    if (!auth) return rawFetchJson(url, 'omit');
    try {
      return await rawFetchJson(url, 'include');
    } catch (e) {
      if (e instanceof TypeError) return rawFetchJson(url, 'omit');
      throw e;
    }
  }

  function apiError(j) {
    const code = String((j && j.code) !== undefined ? j.code : '');
    const map = {
      '-101': '账号未登录：请先登录 B 站再试',
      '-400': '请求参数错误',
      '-403': '访问权限不足，请确认账号已登录且有观看权限',
      '-404': '视频不存在 / 已下架，或当前账号没有观看权限（版权剧集请确认已登录且有会员）',
      '-10403': '该视频存在地区限制',
      '-352': '触发风控校验，请刷新页面后重试',
      '87007': '该视频为充电专属，当前账号无权限',
      '87008': '该视频为大会员专享，当前账号无权限',
      '87009': '该视频为付费内容，当前账号无权限'
    };
    if (map[code]) return map[code];
    const msg = (j && j.message) ? `：${j.message}` : '';
    return `接口返回错误（${code || '未知'}${msg}）`;
  }

  function friendly(err) {
    const msg = (err && err.message) || String(err || '未知错误');
    if (/HTTP 403/.test(msg)) return '音轨地址被拒绝（403）：地址可能已过期，刷新页面后重试';
    if (/HTTP 404/.test(msg)) return '音轨地址已失效（404）：刷新页面后重试';
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return '网络请求失败：检查网络 / 代理，或稍后重试';
    return msg;
  }

  /* ---------------------------------------------------------------- meta */
  async function resolveMeta(probe) {
    const info = probe || {};
    const href = info.href || location.href;
    const u = new URL(href);
    const meta = {
      bvid: '', aid: 0, cid: 0, page: 1,
      title: info.videoTitle || info.seasonTitle || '',
      part: info.epTitle || '',
      epId: 0, seasonId: 0,
      duration: 0, cover: '', kind: 'video'
    };

    const bvFromUrl = (u.pathname.match(/\/video\/(BV[0-9A-Za-z]{6,})/) || [])[1] || '';
    const avFromUrl = Number((u.pathname.match(/\/video\/av(\d+)/i) || [])[1] || 0);
    const bvFromQuery = u.searchParams.get('bvid') || '';
    // 路径里的 BV 永远优先：合集页偶尔会带着上一条视频的 ?bvid= 留在地址栏里
    let bvid = bvFromUrl || (/^BV[0-9A-Za-z]{6,}$/.test(bvFromQuery) ? bvFromQuery : '');

    const epFromUrl = Number((u.pathname.match(/\/bangumi\/play\/ep(\d+)/) || [])[1] || 0);
    const ssFromUrl = Number((u.pathname.match(/\/bangumi\/play\/ss(\d+)/) || [])[1] || 0);
    const epId = epFromUrl || Number(info.epId) || 0;
    const seasonId = ssFromUrl || Number(info.seasonId) || 0;

    /* ---- 番剧 / 影视 ---- */
    if (epId || seasonId) {
      const q = epId ? `ep_id=${epId}` : `season_id=${seasonId}`;
      const j = await apiJson(`${API}/pgc/view/web/season?${q}`, { auth: false });
      if (j.code !== 0) throw new Error(apiError(j));
      const season = j.result || {};
      const eps = season.episodes || [];
      if (!eps.length) throw new Error('该剧集暂无可解析的播放列表');
      const ep = eps.find((e) => Number(e.id) === epId) ||
                 eps.find((e) => Number(e.id) === Number(info.epId)) ||
                 eps[0];
      meta.kind = 'bangumi';
      meta.epId = Number(ep.id) || epId;
      meta.seasonId = Number(season.season_id) || seasonId;
      meta.bvid = ep.bvid || '';
      meta.aid = Number(ep.aid) || Number(season.aid) || 0;
      meta.cid = Number(ep.cid) || 0;
      meta.title = season.title || info.seasonTitle || '';
      meta.part = [ep.title, ep.long_title].filter(Boolean).join(' · ') || info.epTitle || '';
      meta.cover = season.cover || '';
      meta.duration = Number(ep.duration) ? Math.round(Number(ep.duration) / 1000) : 0;
      if (!meta.cid) throw new Error('没能拿到该剧集的 cid（可能未解锁或存在地区限制）');
      return meta;
    }

    /* ---- 普通稿件 ---- */
    if (!bvid && !avFromUrl && info.cid && (info.bvid || info.aid)) {
      meta.bvid = info.bvid || '';
      meta.aid = Number(info.aid) || 0;
      meta.cid = Number(info.cid) || 0;
      meta.page = Number(info.pageNo) || 1;
      meta.duration = Number(info.duration) || 0;
      return meta;
    }

    const idQuery = bvid
      ? `bvid=${encodeURIComponent(bvid)}`
      : (avFromUrl || Number(info.aid)) ? `aid=${avFromUrl || Number(info.aid)}` : '';
    if (!idQuery) {
      throw new Error('当前页面不是可识别的视频播放页');
    }

    const j = await apiJson(`${API}/x/web-interface/view?${idQuery}`, { auth: false });
    if (j.code !== 0) throw new Error(apiError(j));
    const d = j.data || {};
    const pages = Array.isArray(d.pages) ? d.pages : [];
    // 分 P 号同样以地址栏为准：SPA 换 P 时 __INITIAL_STATE__ 里的 p 还停在旧值
    let p = Number(u.searchParams.get('p')) || Number(u.searchParams.get('page')) || Number(info.pageNo) || 1;
    if (!pages.length) p = 1;
    p = Math.min(Math.max(p, 1), Math.max(pages.length, 1));

    meta.kind = 'video';
    meta.bvid = d.bvid || bvid;
    meta.aid = Number(d.aid) || 0;
    meta.page = p;
    meta.cid = Number((pages[p - 1] && pages[p - 1].cid) || d.cid) || 0;
    meta.title = d.title || meta.title;
    meta.part = pages.length > 1 ? (pages[p - 1] && pages[p - 1].part) || '' : '';
    meta.cover = d.pic || '';
    meta.duration = Number(d.duration) || 0;
    if (!meta.cid) throw new Error('没能拿到视频的 cid');
    return meta;
  }

  /* ------------------------------------------------------------- playurl */

  /**
   * playurl 的返回结构在不同端点之间不一样，统一挖到「含 dash / durl 的那一层」：
   *   /x/player/...      → { data: { dash } }
   *   /pgc/player/web/…  → { result: { dash } }
   *   /pgc/…/v2/…        → { result: { video_info: { dash } } }
   */
  function unwrapPlayurl(j) {
    const r = (j && j.result) || (j && j.data) || {};
    if (!r || typeof r !== 'object') return {};
    if (r.dash || r.durl) return r;
    if (r.result && typeof r.result === 'object' && (r.result.dash || r.result.durl)) return r.result;
    if (r.video_info && (r.video_info.dash || r.video_info.durl)) return r.video_info;
    return r;
  }

  async function fetchPlayurl(meta) {
    const params = {
      fnval: FNVAL,
      fnver: 0,
      fourk: 1,
      cid: meta.cid
    };
    if (meta.kind === 'bangumi' && meta.epId) {
      // 番剧必须走 pgc 端点：/x/player/wbi/playurl 对版权剧集一律 -404
      params.ep_id = meta.epId;
      if (meta.aid) params.avid = meta.aid;
    } else if (meta.bvid) {
      params.bvid = meta.bvid;
    } else if (meta.aid) {
      params.avid = meta.aid;
    }

    let key = '';
    try {
      key = await getWbiKey();
    } catch (e) {
      key = '';
    }

    const endpoints = meta.kind === 'bangumi'
      ? ['/pgc/player/web/playurl', '/pgc/player/web/v2/playurl', '/x/player/wbi/playurl']
      : ['/x/player/wbi/playurl', '/x/player/playurl'];

    let firstError = null;
    let preview = null;

    for (const path of endpoints) {
      // 先带签名，被拒再去掉签名试一次（部分端点不验签）
      const tries = key ? [buildQuery(params, key).query, buildQuery(params, '').query] : [buildQuery(params, '').query];
      for (const q of tries) {
        let j;
        try {
          j = await apiJson(`${API}${path}?${q}`, { auth: true });
        } catch (e) {
          if (!firstError) firstError = e;
          continue;
        }
        if (j.code !== 0) {
          if (!firstError) firstError = new Error(apiError(j));
          continue;
        }
        const data = unwrapPlayurl(j);
        if (data.dash) return data;
        // 只有 durl = 未解锁的试看片段，记下来，继续换端点找 dash
        if (data.durl && !preview) preview = data;
      }
    }

    if (preview) {
      throw new Error('只拿到试看片段（没有 DASH 音轨）：这个视频/剧集的音轨需要登录、大会员或购买后才能解锁');
    }
    throw firstError || new Error('接口没有返回可用的播放信息');
  }

  /* -------------------------------------------------------------- tracks */
  function parseTracks(data) {
    const dash = (data && data.dash) || null;
    const out = [];
    const urlOf = (o) => (o && (o.baseUrl || o.base_url)) || '';
    const backupsOf = (o) => ((o && (o.backupUrl || o.backup_url)) || []).slice(0, 3);

    if (!dash) {
      throw new Error('该视频没有 DASH 音轨（可能是直播 / 互动视频 / 版权限制）');
    }

    const flac = dash.flac && dash.flac.audio;
    if (flac && urlOf(flac)) {
      const detail = [];
      if (flac.display) detail.push(flac.display);
      if (!flac.display) {
        const bits = [];
        if (flac.sr) bits.push(Math.round(flac.sr / 1000) + ' kHz');
        detail.push(bits.join(' ') || '真·无损音轨');
      }
      out.push({
        key: 'flac',
        kind: 'flac',
        lossless: true,
        badge: '无损',
        label: 'Hi-Res 无损 FLAC',
        detail: detail.join(' · '),
        bandwidth: Number(flac.bandwidth) || 0,
        mime: 'audio/flac',
        url: urlOf(flac),
        backups: backupsOf(flac)
      });
    }

    const dolby = (dash.dolby && dash.dolby.audio) || [];
    dolby.forEach((a, i) => {
      if (!urlOf(a)) return;
      out.push({
        key: 'dolby' + i,
        kind: 'dolby',
        lossless: false,
        badge: '杜比',
        label: '杜比全景声',
        detail: Math.round((Number(a.bandwidth) || 0) / 1000) + ' kbps · E-AC-3',
        bandwidth: Number(a.bandwidth) || 0,
        mime: 'audio/mp4',
        url: urlOf(a),
        backups: backupsOf(a)
      });
    });

    const audios = (dash.audio || []).filter((a) => urlOf(a));
    audios.sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0));
    audios.forEach((a, i) => {
      const kbps = Math.round((Number(a.bandwidth) || 0) / 1000);
      out.push({
        key: 'aac' + i,
        kind: 'aac',
        lossless: false,
        badge: '有损',
        label: 'AAC ' + (kbps || '未知') + ' kbps',
        detail: (a.codecs || 'mp4a.40.2') + ' · 兼容性最好',
        bandwidth: Number(a.bandwidth) || 0,
        mime: 'audio/mp4',
        url: urlOf(a),
        backups: backupsOf(a)
      });
    });

    if (!out.length) throw new Error('接口没有返回任何可用音轨（可能需要大会员 / 已下架）');

    const lossless = out.some((t) => t.lossless);
    return {
      tracks: out,
      duration: Number(dash.duration) || 0,
      note: lossless ? '' : '该视频没有 Hi-Res 无损音轨，已列出可用的最高音质'
    };
  }

  /* ------------------------------------------------------------ filename */
  function buildFilename(meta, track, ext) {
    const title = (meta.title || '').trim();
    const part = (meta.part || '').trim();
    let base;
    if (part && (!title || part.indexOf(title) >= 0)) {
      // 分 P 标题里已经含了稿件标题（"英-《某某》"），再用标题拼就会重复
      base = part;
    } else if (title && part) {
      base = title + ' - ' + part;
    } else {
      base = title || part || 'bilibili-audio';
    }

    const id = meta.bvid || (meta.aid ? 'av' + meta.aid : '');
    const tail = [];
    if (id) tail.push(id + (meta.page > 1 ? '-P' + meta.page : ''));
    if (track.kind === 'flac') tail.push('FLAC');
    else if (track.kind === 'dolby') tail.push('Dolby');
    else tail.push(Math.round((track.bandwidth || 0) / 1000) + 'k');

    base = (base + ' [' + tail.join(' ') + ']')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[. ]+|[. ]+$/g, '')
      .slice(0, 150);
    return base + '.' + ext;
  }

  /* ------------------------------------------------------------ sniffing */
  async function sniffExt(blob, fallback) {
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const tag = (start, n) => {
      let s = '';
      for (let i = start; i < start + n && i < head.length; i++) s += String.fromCharCode(head[i]);
      return s;
    };
    if (tag(0, 4) === 'fLaC') return 'flac';
    if (tag(4, 4) === 'ftyp') return 'm4a';
    if (tag(0, 3) === 'ID3') return 'mp3';
    if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mp3';
    if (tag(0, 4) === 'OggS') return 'ogg';
    return fallback || 'm4a';
  }

  /* ------------------------------------------------------------- saving */
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }

  async function fetchAudio(url, track) {
    const resp = await fetch(url, { credentials: 'omit', cache: 'no-store', signal: abortCtl.signal });
    if (!resp.ok) throw new Error(`音轨下载失败（HTTP ${resp.status}）`);

    state.total = Number(resp.headers.get('content-length')) || 0;
    if (!resp.body) {
      const blob = await resp.blob();
      state.received = blob.size;
      return blob;
    }

    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      state.received = received;
    }
    return new Blob(chunks, { type: track.mime || 'application/octet-stream' });
  }

  /* ----------------------------------------------------------- download */
  async function startDownload(index) {
    if (state.phase === 'downloading') return { ok: false, error: '正在下载中' };
    const track = state.tracks[index];
    if (!track) return { ok: false, error: '音轨不存在' };

    abortCtl = new AbortController();
    state.phase = 'downloading';
    state.received = 0;
    state.total = 0;
    state.error = '';
    state.note = '';
    state.filename = '';
    state.startedAt = Date.now();

    const urls = [track.url].concat(track.backups || []).filter(Boolean);
    let lastErr = null;

    for (let i = 0; i < urls.length; i++) {
      try {
        const blob = await fetchAudio(urls[i], track);
        const ext = await sniffExt(blob, track.kind === 'flac' ? 'flac' : 'm4a');
        const name = buildFilename(state.meta, track, ext);
        state.filename = name;
        if (track.kind === 'flac' && ext === 'm4a') {
          state.note = '这条无损音轨是 MP4 封装的 FLAC；用 ffmpeg -i 文件 -c copy 输出.flac 可转成标准 .flac';
        }
        saveBlob(blob, name);
        state.phase = 'done';
        return { ok: true };
      } catch (e) {
        if (e && e.name === 'AbortError') {
          state.phase = 'idle';
          state.note = '已取消';
          return { ok: false, error: '已取消' };
        }
        lastErr = e;
      }
    }

    state.phase = 'error';
    state.error = friendly(lastErr);
    return { ok: false, error: state.error };
  }

  /* ------------------------------------------------------------- bridge */
  function snapshot() {
    return {
      phase: state.phase,
      meta: state.meta,
      tracks: state.tracks,
      duration: state.duration,
      received: state.received,
      total: state.total,
      filename: state.filename,
      error: state.error,
      note: state.note,
      startedAt: state.startedAt,
      pageKey: state.pageKey
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('BAG_') !== 0) return;

    if (msg.type === 'BAG_PREPARE') {
      syncPage();
      // 正在下载时不要重置状态，避免打断 / 丢掉进度
      if (state.phase === 'downloading') {
        sendResponse({ ok: true, snapshot: snapshot() });
        return false;
      }
      clearVideoState();
      state.pageKey = pageKey();
      const keyAtStart = state.pageKey;
      state.phase = 'preparing';
      (async () => {
        try {
          const meta = await resolveMeta(msg.probe || {});
          const data = await fetchPlayurl(meta);
          const parsed = parseTracks(data);
          // 解析途中页面可能又换视频了：这份结果是上一条的，不能拿来显示
          if (pageKey() !== keyAtStart) {
            clearVideoState();
            state.pageKey = pageKey();
            sendResponse({ ok: true, snapshot: snapshot() });
            return;
          }
          state.meta = meta;
          state.tracks = parsed.tracks;
          state.duration = parsed.duration || meta.duration || 0;
          state.note = parsed.note || '';
          state.phase = 'ready';
          sendResponse({ ok: true, snapshot: snapshot() });
        } catch (e) {
          if (pageKey() !== keyAtStart) {
            clearVideoState();
            state.pageKey = pageKey();
            sendResponse({ ok: true, snapshot: snapshot() });
            return;
          }
          state.phase = 'error';
          state.error = friendly(e);
          sendResponse({ ok: false, error: state.error, snapshot: snapshot() });
        }
      })();
      return true;
    }

    if (msg.type === 'BAG_DOWNLOAD') {
      // 状态是上一条视频的（页面已经换了），宁可不下载，也不要下错文件
      if (syncPage() || (state.pageKey && state.pageKey !== pageKey())) {
        sendResponse({ ok: false, error: '页面里的视频已经换了，请重新打开插件' });
        return false;
      }
      startDownload(Number(msg.index) || 0);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'BAG_CANCEL') {
      if (abortCtl) abortCtl.abort();
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'BAG_STATUS') {
      syncPage();
      sendResponse(snapshot());
      return false;
    }

    if (msg.type === 'BAG_PING') {
      sendResponse({ ok: true });
      return false;
    }
  });

  /* 本地自测钩子（只在隔离世界可见，页面拿不到） */
  window.__bagTest = {
    md5, mixinKey, buildQuery, parseTracks, buildFilename,
    resolveMeta, fetchPlayurl, unwrapPlayurl, sniffExt, state,
    pageKey, syncPage, clearVideoState
  };
})();
