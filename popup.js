/* ============================================================================
 * B站音频提取器 · Popup
 * 流程：校验页面 → 注入页面执行器 → 读取页面状态（bvid/cid/ep）→ 解析音轨
 *       → 展示列表 → 自动下载最高音质 → 轮询进度
 * ==========================================================================*/
'use strict';

const $ = (id) => document.getElementById(id);

const ui = {
  loading: $('loading'),
  unsupported: $('unsupported'),
  errorPane: $('errorPane'),
  errorText: $('errorText'),
  retryBtn: $('retryBtn'),
  content: $('content'),
  cover: $('cover'),
  title: $('title'),
  metaId: $('metaId'),
  losslessHint: $('losslessHint'),
  trackList: $('trackList'),
  downloadBtn: $('downloadBtn'),
  progressWrap: $('progressWrap'),
  barFill: $('barFill'),
  progText: $('progText'),
  progSize: $('progSize'),
  note: $('note'),
  autoToggle: $('autoToggle')
};

let tabId = null;
let snap = null;
let selected = 0;
let trackSig = '';
let timer = null;
let auto = true;

/* ------------------------------------------------------------------ 启动 */
(async function boot() {
  bind();
  await readPrefs();

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || !tab.id) return showPane('unsupported');
  tabId = tab.id;

  if (!isBiliVideoUrl(tab.url)) return showPane('unsupported');

  try {
    await ensureInjected(tabId);

    // 若上一次下载还在进行（弹窗被关掉又打开），直接接着显示进度；
    // 「已完成」也直接显示 —— 但页面里换了视频时必须重新解析，所以先对一下身份
    const status = await send({ type: 'BAG_STATUS' });
    let probe = await runProbe(tabId);
    const sameVideo = !status || !status.meta || (
      (!probe.bvid || !status.meta.bvid || probe.bvid === status.meta.bvid) &&
      (!Number(probe.cid) || !Number(status.meta.cid) || Number(probe.cid) === Number(status.meta.cid))
    );
    if (status && sameVideo && status.tracks && status.tracks.length &&
        (status.phase === 'downloading' || status.phase === 'done')) {
      snap = status;
      enterContent();
      render();
      if (status.phase === 'downloading') startPolling();
      return;
    }

    let res = await send({ type: 'BAG_PREPARE', probe });
    if (!res) throw new Error('页面没有响应，请刷新页面后重试');
    // 解析途中页面被切到别的视频时，执行器会丢掉过期结果并回一份空状态：重试一次拿到新的
    if (res.ok && res.snapshot && res.snapshot.phase === 'idle' &&
        !(res.snapshot.tracks || []).length) {
      probe = await runProbe(tabId);
      res = await send({ type: 'BAG_PREPARE', probe });
      if (!res) throw new Error('页面没有响应，请刷新页面后重试');
    }

    snap = res.snapshot || null;
    if (!res.ok) return showError(res.error || '解析失败');

    enterContent();
    render();
    startPolling();

    if (auto && snap.phase === 'ready' && snap.tracks && snap.tracks.length) {
      doDownload(0);
    }
  } catch (e) {
    showError(friendlyError(e));
  }
})();

function bind() {
  ui.autoToggle.addEventListener('change', () => {
    auto = ui.autoToggle.checked;
    chrome.storage.local.set({ autoDownload: auto }).catch(() => {});
  });
  ui.retryBtn.addEventListener('click', () => location.reload());
  ui.downloadBtn.addEventListener('click', onDownloadClick);
  ui.trackList.addEventListener('click', (e) => {
    const li = e.target.closest('.track-item');
    if (!li) return;
    selected = Number(li.dataset.index) || 0;
    render();
  });
}

async function readPrefs() {
  try {
    const p = await chrome.storage.local.get({ autoDownload: true });
    auto = p.autoDownload !== false;
    ui.autoToggle.checked = auto;
  } catch (e) { /* 忽略 */ }
}

/* -------------------------------------------------------------- 页面探测 */
async function ensureInjected(id) {
  await chrome.scripting.executeScript({ target: { tabId: id }, files: ['grabber.js'] });
}

async function runProbe(id) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: id },
      world: 'MAIN',
      func: probeMain
    });
    return (r && r.result) || {};
  } catch (e) {
    return {};
  }
}

/** 在页面主世界执行：读 __INITIAL_STATE__ / __playinfo__（不依赖 DOM 结构） */
function probeMain() {
  const out = { href: location.href };
  try {
    const s = window.__INITIAL_STATE__ || {};
    const vd = s.videoData || {};
    out.bvid = s.bvid || vd.bvid || '';
    out.aid = Number(s.aid || vd.aid || 0);
    out.cid = Number(s.cid || vd.cid || 0);
    out.pageNo = Number(s.p || 0);
    out.videoTitle = vd.title || '';
    out.duration = Number(vd.duration || 0);

    const ep = s.epInfo || null;
    if (ep) {
      out.epId = Number(ep.id || ep.ep_id || 0);
      out.epTitle = ep.long_title || ep.title || '';
      out.cid = out.cid || Number(ep.cid || 0);
      out.aid = out.aid || Number(ep.aid || 0);
      out.bvid = out.bvid || ep.bvid || '';
      out.duration = out.duration || Number(ep.duration ? ep.duration / 1000 : 0) || 0;
    }

    const season = s.seasonInfo || null;
    if (season) {
      out.seasonId = Number(season.season_id || 0);
      out.seasonTitle = season.title || '';
    }
  } catch (e) { /* 页面结构变化时静默降级到 URL/API */ }

  try {
    if (window.__playinfo__) {
      const txt = JSON.stringify(window.__playinfo__);
      if (txt && txt.length < 300000) out.playinfo = JSON.parse(txt);
    }
  } catch (e) { /* 忽略 */ }

  return out;
}

function isBiliVideoUrl(url) {
  if (!url) return false;
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  if (!/(^|\.)bilibili\.com$/i.test(u.hostname)) return false;
  if (/\/video\/(BV[0-9A-Za-z]{6,}|av\d+)/i.test(u.pathname)) return true;
  if (/\/bangumi\/play\/(ep|ss)\d+/i.test(u.pathname)) return true;
  if (/^BV[0-9A-Za-z]{6,}$/.test(u.searchParams.get('bvid') || '')) return true;
  return false;
}

async function send(msg) {
  return chrome.tabs.sendMessage(tabId, msg);
}

/* ------------------------------------------------------------------ 渲染 */
function showPane(name) {
  ['loading', 'unsupported', 'errorPane', 'content'].forEach((k) => {
    ui[k].classList.toggle('hidden', k !== name);
  });
}

function enterContent() {
  showPane('content');
}

function showError(msg) {
  ui.errorText.textContent = msg;
  showPane('errorPane');
}

function render() {
  if (!snap) return;
  const meta = snap.meta || {};

  ui.title.textContent = meta.title || '未知视频';
  ui.title.title = meta.title || '';

  const bits = [];
  if (meta.bvid) bits.push(meta.bvid + (meta.page > 1 ? ' · P' + meta.page : ''));
  else if (meta.aid) bits.push('av' + meta.aid);
  if (snap.duration) bits.push(fmtDur(snap.duration));
  ui.metaId.textContent = bits.join('   ·   ');

  if (meta.cover) {
    const src = String(meta.cover).replace(/^http:/, 'https:');
    if (ui.cover.dataset.src !== src) {
      ui.cover.dataset.src = src;
      ui.cover.onload = () => ui.cover.classList.add('ready');
      ui.cover.onerror = () => ui.cover.classList.remove('ready');
      ui.cover.src = src;
    }
  }

  const tracks = snap.tracks || [];
  const sig = tracks.map((t) => t.key).join('|');
  if (sig !== trackSig) {
    trackSig = sig;
    buildTrackList(tracks);
  }
  if (!tracks[selected]) selected = 0;
  markSelected(tracks.length);

  if (tracks.length && tracks[0].lossless) {
    ui.losslessHint.textContent = '已找到无损音轨';
    ui.losslessHint.className = 'hint good';
  } else if (tracks.length) {
    ui.losslessHint.textContent = '无无损音轨 · 按码率排序';
    ui.losslessHint.className = 'hint';
  } else {
    ui.losslessHint.textContent = '';
  }

  renderAction(tracks);
}

function buildTrackList(tracks) {
  ui.trackList.textContent = '';
  tracks.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'track-item';
    li.dataset.index = String(i);

    const dot = document.createElement('span');
    dot.className = 'dot';

    const body = document.createElement('div');
    body.className = 'track-body';

    const label = document.createElement('div');
    label.className = 'track-label';
    const name = document.createElement('span');
    name.textContent = t.label || '音轨';
    const badge = document.createElement('span');
    badge.className = 'badge ' + (t.lossless ? 'lossless' : (t.kind === 'dolby' ? 'dolby' : 'lossy'));
    badge.textContent = t.badge || (t.lossless ? '无损' : '有损');
    label.append(name, badge);

    const detail = document.createElement('div');
    detail.className = 'track-detail';
    detail.textContent = t.detail || '';

    body.append(label, detail);

    const size = document.createElement('span');
    size.className = 'track-size';
    if (t.bandwidth && snap.duration) {
      size.textContent = '≈ ' + fmtBytes(t.bandwidth / 8 * snap.duration);
    }

    li.append(dot, body, size);
    ui.trackList.appendChild(li);
  });
}

function markSelected(count) {
  const items = ui.trackList.children;
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle('selected', i === selected);
  }
}

function renderAction(tracks) {
  const phase = snap.phase;
  const has = tracks.length > 0;
  // 下载中不让换音轨（换也来不及了，只会让人以为生效）
  ui.trackList.classList.toggle('locked', phase === 'downloading');
  ui.note.classList.remove('ok', 'err');

  if (phase === 'downloading') {
    const total = Number(snap.total) || 0;
    const got = Number(snap.received) || 0;
    const pct = total ? Math.min(100, (got / total) * 100) : 0;

    ui.progressWrap.classList.remove('hidden');
    ui.barFill.style.width = total ? pct.toFixed(1) + '%' : '10%';
    ui.barFill.style.opacity = total ? '1' : '.55';
    ui.progText.textContent = total ? pct.toFixed(0) + '%' : '下载中…';

    const secs = snap.startedAt ? Math.max(0.3, (Date.now() - snap.startedAt) / 1000) : 0;
    const speed = secs ? got / secs : 0;
    ui.progSize.textContent = fmtBytes(got) +
      (total ? ' / ' + fmtBytes(total) : '') +
      (speed > 0 ? '   ·   ' + fmtBytes(speed) + '/s' : '');

    ui.downloadBtn.textContent = '取消下载';
    ui.downloadBtn.className = 'btn ghost';
    ui.downloadBtn.disabled = false;
    ui.note.classList.add('hidden');
    return;
  }

  if (phase === 'done') {
    ui.progressWrap.classList.remove('hidden');
    ui.barFill.style.width = '100%';
    ui.barFill.style.opacity = '1';
    ui.progText.textContent = '已保存';
    ui.progSize.textContent = fmtBytes(snap.total || snap.received);
    ui.downloadBtn.textContent = '再下载一次';
    ui.downloadBtn.className = 'btn ghost';
    ui.downloadBtn.disabled = !has;
    ui.note.textContent = (snap.filename ? '文件：' + snap.filename : '已交给浏览器保存') +
      (snap.note ? '\n' + snap.note : '');
    ui.note.classList.remove('hidden');
    ui.note.classList.add('ok');
    return;
  }

  if (phase === 'error') {
    ui.progressWrap.classList.add('hidden');
    ui.downloadBtn.textContent = '重试下载';
    ui.downloadBtn.className = 'btn primary';
    ui.downloadBtn.disabled = !has;
    ui.note.textContent = snap.error || '下载失败';
    ui.note.classList.remove('hidden');
    ui.note.classList.add('err');
    return;
  }

  // ready / idle
  ui.progressWrap.classList.add('hidden');
  ui.downloadBtn.textContent = '下载音频';
  ui.downloadBtn.className = 'btn primary';
  ui.downloadBtn.disabled = !has;
  if (snap.note) {
    ui.note.textContent = snap.note;
    ui.note.classList.remove('hidden');
  } else {
    ui.note.classList.add('hidden');
  }
}

/* ------------------------------------------------------------------ 操作 */
async function onDownloadClick() {
  if (snap && snap.phase === 'downloading') {
    try { await send({ type: 'BAG_CANCEL' }); } catch (e) { /* 忽略 */ }
    return;
  }
  doDownload(selected);
}

async function doDownload(index) {
  try {
    const res = await send({ type: 'BAG_DOWNLOAD', index });
    if (res && res.ok === false) {
      ui.note.textContent = res.error || '无法开始下载';
      ui.note.classList.remove('hidden');
      ui.note.classList.add('err');
    }
  } catch (e) {
    showError(friendlyError(e));
    return;
  }
  startPolling();
}

function startPolling() {
  stopPolling();
  timer = setInterval(async () => {
    let s;
    try {
      s = await send({ type: 'BAG_STATUS' });
    } catch (e) {
      stopPolling();
      return;
    }
    if (!s) return;
    snap = s;
    render();
    if (s.phase !== 'downloading') stopPolling();
  }, 500);
}

function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}

/* ------------------------------------------------------------------ 工具 */
function friendlyError(e) {
  const msg = (e && e.message) || String(e || '');
  if (/Receiving end does not exist|Could not establish connection/i.test(msg)) {
    return '无法与页面通信：请刷新 B 站页面后重试';
  }
  if (/Cannot access|extensions gallery cannot be scripted|chrome:\/\//i.test(msg)) {
    return '该页面不允许插件运行，请打开 B 站视频播放页';
  }
  return msg || '未知错误';
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  const mb = n / 1024 / 1024;
  return mb.toFixed(mb >= 100 ? 0 : 1) + ' MB';
}

function fmtDur(sec) {
  sec = Math.max(0, Number(sec) || 0);
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const pad = (x) => String(x).padStart(2, '0');
  return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}
