'use strict';

const $ = (id) => document.getElementById(id);
const app = document.querySelector('.app');
const welcome = $('welcome');
const dropcard = $('dropcard');
const dropOverlay = $('dropOverlay');
const toastEl = $('toast');

let toastTimer = null;
function toast(msg, isErr) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('err', !!isErr);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200);
}

function fmtSize(n) {
  if (!n) return '';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (x) => String(x).padStart(2, '0');
  if (sameDay) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const diff = (now - d) / 86400000;
  if (diff < 2) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function renderRecent(list) {
  const wrap = $('recentWrap');
  const box = $('recentList');
  box.innerHTML = '';
  if (!list || !list.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  list.forEach((r) => {
    const item = document.createElement('div');
    item.className = 'recent-item';
    item.title = r.path;
    item.innerHTML = `
      <div class="ri-icon">
        <svg viewBox="0 0 24 24" width="15" height="15"><path d="M9 6.5v11c0 .7.8 1.1 1.4.7l7.4-5.5c.5-.4.5-1.1 0-1.4L10.4 5.8c-.6-.4-1.4 0-1.4.7z" fill="currentColor"/></svg>
      </div>
      <div class="ri-body">
        <div class="ri-title"></div>
        <div class="ri-path"></div>
      </div>
      <div class="ri-meta"></div>
      <button class="ri-del" title="从列表移除">
        <svg viewBox="0 0 12 12" width="9" height="9"><path d="M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8" stroke="currentColor" stroke-width="1.2"/></svg>
      </button>`;
    item.querySelector('.ri-title').textContent = r.title || r.name || '未命名作品';
    item.querySelector('.ri-path').textContent = r.online ? `在线作品 · #${r.online.id}` : r.path;
    item.querySelector('.ri-meta').textContent = fmtTime(r.at);
    item.addEventListener('click', async (e) => {
      if (e.target.closest('.ri-del')) return;
      // 在线作品走作品号重新打开：能顺带检查更新，缓存没了也能重新下载
      const res = (r.online && r.online.id)
        ? await window.k4p.openOnline(r.online.id)
        : await window.k4p.openPath(r.path);
      if (res && !res.ok) toast(res.message || '打开失败', true);
    });
    item.querySelector('.ri-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.k4p.removeRecent(r.path);
    });
    box.appendChild(item);
  });
}

function applyState(s) {
  if (!s) return;
  renderAuth(s.auth);
  renderRecent(s.recent);
  if (s.current) enterPlaying(s.current); else enterWelcome();
}

function enterPlaying(p) {
  hideNotice();
  app.classList.add('is-playing');
  welcome.classList.add('hidden');
  $('fileChip').hidden = false;
  $('chipTitle').textContent = p.title || p.name || '作品';
  $('chipTitle').title = p.path;
  $('toolbar').hidden = false;
  $('footHint').hidden = true;
}

function enterWelcome() {
  app.classList.remove('is-playing');
  welcome.classList.remove('hidden');
  $('fileChip').hidden = true;
  $('toolbar').hidden = true;
  $('footHint').hidden = false;
}

/* ---------- 按钮 ---------- */
$('btnOpen').addEventListener('click', () => window.k4p.openDialog());
$('btnOpen2').addEventListener('click', () => window.k4p.openDialog());
$('btnReload').addEventListener('click', async () => {
  const ok = await window.k4p.reload();
  if (!ok) toast('当前没有正在播放的作品', true);
});
$('btnFull').addEventListener('click', () => window.k4p.toggleFullscreen());
$('wcMin').addEventListener('click', () => window.k4p.minimize());
$('wcMax').addEventListener('click', () => window.k4p.maximize());
$('wcClose').addEventListener('click', () => window.k4p.closeWindow());
$('btnClearRecent').addEventListener('click', () => window.k4p.clearRecent());

/* ---------- 在线作品（按作品号播放） ---------- */
const workIdEl = $('workId');
const btnOnline = $('btnOnline');
const onlineHint = $('onlineHint');
const HINT_DEFAULT = onlineHint.textContent;
let onlineBusy = false;

function setOnlineState(busy, text, kind) {
  onlineBusy = busy;
  workIdEl.disabled = busy;
  btnOnline.disabled = busy;
  onlineHint.textContent = text == null ? HINT_DEFAULT : text;
  onlineHint.classList.toggle('busy', kind === 'busy');
  onlineHint.classList.toggle('err', kind === 'err');
}

const fmtMB = (n) => (n / 1048576).toFixed(1);

async function openByWorkId() {
  if (onlineBusy) return;
  const raw = workIdEl.value.trim();
  if (!raw) {
    setOnlineState(false, '请输入作品号，例如 335327306', 'err');
    workIdEl.focus();
    return;
  }
  setOnlineState(true, '正在获取作品信息…', 'busy');
  let res;
  try {
    res = await window.k4p.openOnline(raw);
  } catch (e) {
    res = { ok: false, message: String((e && e.message) || e) };
  }
  if (!res || !res.ok) {
    // 失败时保留输入内容，方便直接改数字重试
    setOnlineState(false, (res && res.message) || '打开失败', 'err');
    workIdEl.focus();
    return;
  }
  workIdEl.value = '';
  setOnlineState(false, null);
  if (res.offline) toast('网络不可用，已用本地缓存播放', true);
  else if (res.cached) toast('已是最新版本，使用本地缓存');
}

btnOnline.addEventListener('click', openByWorkId);
workIdEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); openByWorkId(); }
  if (e.key === 'Escape') workIdEl.blur();
});

/** 回到欢迎页并聚焦作品号输入框（播放中也能直接用） */
async function gotoWorkId() {
  if (app.classList.contains('is-playing')) await window.k4p.closeProject();
  hideNotice();
  enterWelcome();
  setOnlineState(false, null);
  setTimeout(() => { workIdEl.focus(); workIdEl.select(); }, 40);
}
$('btnWorkId').addEventListener('click', gotoWorkId);

window.k4p.on('online-progress', (ev) => {
  if (!ev) return;
  if (ev.phase === 'resolve') setOnlineState(true, '正在解析作品链接…', 'busy');
  else if (ev.phase === 'info') setOnlineState(true, ev.via === 'pickcat' ? '已识别 PICKCAT 作品，正在获取源码…' : '正在获取作品信息…', 'busy');
  else if (ev.phase === 'download') {
    const name = ev.name || '作品';
    setOnlineState(true, ev.total
      ? `正在下载「${name}」… ${fmtMB(ev.loaded)} / ${fmtMB(ev.total)} MB`
      : `正在下载「${name}」… ${fmtMB(ev.loaded)} MB`, 'busy');
  } else if (ev.phase === 'save') setOnlineState(true, '正在保存到本地…', 'busy');
  else if (ev.phase === 'localize') {
    // 把造型图抓到本地（首次打开才需要），之后启动就不必再等图
    setOnlineState(true, ev.total
      ? `正在缓存造型素材… ${ev.loaded}/${ev.total}`
      : '正在缓存造型素材…', 'busy');
  } else if (ev.phase === 'cached') {
    setOnlineState(true, ev.offline ? '网络不可用，使用本地缓存…' : '已是最新版本，使用本地缓存…', 'busy');
  } else if (ev.phase === 'done') setOnlineState(true, '正在启动播放器…', 'busy');
});

/* ---------- 登录态 ---------- */
const loginModal = $('loginModal');
const loginId = $('loginId');
const loginPwd = $('loginPwd');
const loginErr = $('loginErr');
const btnLoginSubmit = $('btnLoginSubmit');
let authBusy = false;

const ICON_USER = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="8.4" r="3.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M4.8 19.6c.8-3.4 3.7-5.4 7.2-5.4s6.4 2 7.2 5.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

function renderAuth(a) {
  const bar = $('accountBar');
  if (!a || !a.loggedIn) {
    bar.className = 'accountbar';
    bar.innerHTML = '';
    const btn = document.createElement('button');
    btn.className = 'acct-btn';
    btn.innerHTML = ICON_USER + '<span>登录编程猫账号</span>';
    btn.addEventListener('click', openLogin);
    const note = document.createElement('span');
    note.className = 'acct-note';
    note.textContent = '登录后可打开自己的未公开作品';
    bar.append(btn, note);
    return;
  }
  bar.className = 'accountbar is-logged';
  bar.innerHTML = '';
  const img = document.createElement('img');
  img.className = 'acct-avatar';
  img.alt = '';
  if (a.avatar) img.src = a.avatar;
  const name = document.createElement('span');
  name.className = 'acct-name';
  name.textContent = a.nickname || ('用户 #' + a.id);
  const badge = document.createElement('span');
  badge.className = 'acct-badge';
  badge.textContent = '已登录';
  const out = document.createElement('button');
  out.className = 'link';
  out.textContent = '退出';
  out.addEventListener('click', async () => {
    const st = await window.k4p.logout();
    renderAuth(st);
    toast('已退出登录');
  });
  bar.append(img, name, badge, out);
}

function openLogin() {
  if (authBusy) return;
  loginModal.hidden = false;
  loginErr.textContent = '';
  setTimeout(() => loginId.focus(), 30);
}

function closeLogin() {
  loginModal.hidden = true;
  loginPwd.value = '';
  loginErr.textContent = '';
}

async function submitLogin() {
  if (authBusy) return;
  const id = loginId.value.trim();
  const pwd = loginPwd.value;
  if (!id) { loginErr.textContent = '请输入账号'; loginId.focus(); return; }
  if (!pwd) { loginErr.textContent = '请输入密码'; loginPwd.focus(); return; }

  authBusy = true;
  btnLoginSubmit.disabled = true;
  btnLoginSubmit.textContent = '登录中…';
  loginErr.textContent = '';
  let r;
  try {
    r = await window.k4p.login(id, pwd);
  } catch (e) {
    r = { ok: false, message: String((e && e.message) || e) };
  }
  authBusy = false;
  btnLoginSubmit.disabled = false;
  btnLoginSubmit.textContent = '登录';

  if (r && r.ok) {
    closeLogin();
    loginPwd.value = '';
    renderAuth(r.state);
    toast('已登录：' + ((r.state && r.state.nickname) || ''));
  } else {
    loginErr.textContent = (r && r.message) || '登录失败';
    loginPwd.select();
  }
}

$('btnLoginSubmit').addEventListener('click', submitLogin);
$('btnLoginCancel').addEventListener('click', closeLogin);
loginModal.addEventListener('click', (e) => { if (e.target === loginModal) closeLogin(); });
for (const el of [loginId, loginPwd]) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitLogin(); }
    if (e.key === 'Escape') closeLogin();
  });
}

window.k4p.on('auth-changed', (a) => renderAuth(a));

/* ---------- 文件拖放 ---------- */
let dragDepth = 0;
const isFileDrag = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

window.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.classList.add('on');
  dropcard.classList.add('hot');
});
window.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) { dropOverlay.classList.remove('on'); dropcard.classList.remove('hot'); }
});
window.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove('on');
  dropcard.classList.remove('hot');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  const p = window.k4p.pathForFile(file);
  if (!p) { toast('无法读取该文件路径', true); return; }
  if (!/\.(bcm4|bcm)$/i.test(p)) { toast('请选择 .bcm4 作品文件', true); return; }
  const res = await window.k4p.openPath(p);
  if (res && !res.ok) toast(res.message || '打开失败', true);
});

/* ---------- 快捷键 ---------- */
window.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); window.k4p.openDialog(); return; }
  if (ctrl && e.key.toLowerCase() === 'l') { e.preventDefault(); gotoWorkId(); return; }
  if (ctrl && e.key.toLowerCase() === 'r') { e.preventDefault(); window.k4p.reload(); return; }
  if (e.key === 'F11') { e.preventDefault(); window.k4p.toggleFullscreen(); return; }
  if (e.key === 'Escape' && app.classList.contains('is-playing')) { /* 交给系统处理全屏退出 */ }
});

/* ---------- 主进程消息 ---------- */
window.k4p.on('state', applyState);
window.k4p.on('project-opened', (p) => { hideNotice(); enterPlaying(p); renderRecentRefresh(); });
window.k4p.on('project-closed', () => { hideNotice(); enterWelcome(); setOnlineState(false, null); });
window.k4p.on('error', (e) => toast(e && e.message ? e.message : '打开失败', true));
window.k4p.on('player-crashed', () => toast('播放器进程异常退出，请重新打开作品', true));
window.k4p.on('goto-workid', () => { gotoWorkId(); });
window.k4p.on('player-log', (msg) => { if (/error|fail/i.test(String(msg))) console.warn('[player]', msg); });
window.k4p.on('chrome-visible', (v) => {
  document.documentElement.classList.toggle('chrome-hidden', !v);
  $('titlebar').style.display = v ? '' : 'none';
});

/* ---------- 不可播放提示 ---------- */
let noticePath = '';
function showNotice(info) {
  noticePath = info.path || '';
  $('noticeFile').textContent = noticePath;
  $('noticeFile').title = noticePath;
  $('notice').hidden = false;
  enterWelcome();
  welcome.classList.add('hidden');
}
function hideNotice() {
  $('notice').hidden = true;
}

$('btnEdit').addEventListener('click', async () => {
  const r = await window.k4p.openInEditor(noticePath);
  if (!r || !r.ok) toast((r && r.message) || '启动编辑器失败', true);
  else toast('已在编辑器中打开，运行并保存后即可播放');
});
$('btnNoticeOpen').addEventListener('click', () => window.k4p.openDialog());
$('btnNoticeBack').addEventListener('click', () => { hideNotice(); enterWelcome(); });

window.k4p.on('not-playable', (info) => showNotice(info));

async function renderRecentRefresh() {
  const s = await window.k4p.getState();
  renderRecent(s.recent);
}

window.k4p.getState().then(applyState);
