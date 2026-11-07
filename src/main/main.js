'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, Menu, nativeTheme, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { PlayerServer } = require('./server');
const { OnlineWorks, resolveInput } = require('./online');
const { Auth, applyCookies } = require('./auth');

const PLAYER_DIR = path.join(__dirname, '..', 'player');
const SHELL_PAGE = path.join(__dirname, '..', 'shell', 'index.html');
const CHROME_H = 38;

let win = null;
let playerView = null;
let server = null;
let online = null;
let auth = null;
let current = null;   // { path, name, title, width, height, size, online? }
let chromeVisible = true;

const stateFile = () => path.join(app.getPath('userData'), 'state.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (_) { return { recent: [] }; }
}
function writeState(s) {
  try { fs.mkdirSync(path.dirname(stateFile()), { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2)); } catch (_) {}
}

function argvProjectPath(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  for (const a of args) {
    if (!/\.(bcm4|bcm)$/i.test(a)) continue;
    const abs = path.resolve(a);
    if (fs.existsSync(abs)) return abs;
    // 相对路径按「当前工作目录」解析，命令行里 cwd 常常不是作品目录；
    // 找不到也照样把它当作目标路径返回，让上层报「文件不存在」，
    // 而不是静默停在欢迎页（用户会以为播放器坏了）。
    return abs;
  }
  return null;
}

/** 分块扫描文件是否包含指定字节串（避免整体 JSON.parse 大文件） */
function bufferContains(file, needle) {
  const nb = Buffer.from(needle, 'utf8');
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const CHUNK = 1 << 20;
    let carry = Buffer.alloc(0);
    let pos = 0;
    while (pos < size) {
      const buf = Buffer.alloc(CHUNK);
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (!n) break;
      const view = Buffer.concat([carry, buf.subarray(0, n)]);
      if (view.indexOf(nb) !== -1) return true;
      carry = Buffer.from(view.subarray(Math.max(0, view.length - nb.length + 1)));
      pos += n;
    }
    return false;
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
}

/** 轻量读取作品元信息：不整体解析大文件 */
function readMeta(file) {
  const out = { name: path.basename(file), title: '', width: 0, height: 0, size: 0, hasCompile: false };
  try {
    out.size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(out.size, 64 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8');
    if (!head.trimStart().startsWith('{')) throw new Error('不是有效的 .bcm4 文件');
    const pn = head.match(/"project_name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (pn) out.title = JSON.parse('"' + pn[1] + '"');
    const sz = head.match(/"size"\s*:\s*\{\s*"width"\s*:\s*(\d+)\s*,\s*"height"\s*:\s*(\d+)/);
    if (sz) { out.width = Number(sz[1]); out.height = Number(sz[2]); }
    out.hasCompile = bufferContains(file, '"compile_result"');
  } catch (e) {
    out.error = e.code === 'ENOENT' ? '找不到文件：' + file : e.message;
  }
  return out;
}

function layout() {
  if (!win || !playerView) return;
  const [w, h] = win.getContentSize();
  const y = chromeVisible ? CHROME_H : 0;
  playerView.setBounds({ x: 0, y, width: w, height: Math.max(0, h - y) });
  playerView.setVisible(!!current);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 680,
    minHeight: 460,
    show: false,
    frame: false,
    backgroundColor: '#0b0d11',
    title: 'Kitten4 播放器',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'shell', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  win.loadFile(SHELL_PAGE);

  playerView = new WebContentsView({
    webPreferences: {
      preload: path.join(PLAYER_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });
  playerView.setBackgroundColor('#000000');
  // 页面控制台转发到主进程（K4P_LOG=1 时可见）：排查作品加载失败时必需，
  // 因为播放器早期日志早于任何调试器连接
  playerView.webContents.on('console-message', (_e, level, message) => {
    if (!process.env.K4P_LOG) return;
    const tag = ['LOG', 'WARN', 'ERROR', 'DEBUG'][level] || 'LOG';
    console.log('[player:' + tag + ']', String(message).slice(0, 900));
  });
  win.contentView.addChildView(playerView);
  playerView.setVisible(false);
  layout();

  win.on('resize', layout);
  win.on('enter-full-screen', () => { setChrome(false); layout(); });
  win.on('leave-full-screen', () => { setChrome(true); layout(); });
  win.on('closed', () => { win = null; playerView = null; });

  win.webContents.on('did-finish-load', () => {
    win.show();
    const p = argvProjectPath(process.argv);
    if (p) openProject(p);
    else pushState();
  });

  // 崩溃/加载失败兜底
  playerView.webContents.on('render-process-gone', (_e, details) => {
    sendToShell('player-crashed', details);
  });
  playerView.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) sendToShell('player-log', message);
  });
}

function setChrome(v) {
  chromeVisible = v;
  if (win) win.webContents.send('chrome-visible', v);
}

function sendToShell(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * 让播放器发出的、直连编程猫域名的请求也带上登录态。
 *
 * 绝大多数接口都被本地 server 接走了（见 server.js 的 clientConfig），
 * 但播放器里仍有一些硬编码域名（云变量、静态资源等）。这里统一加 Authorization，
 * 保证「以登录状态请求」在页面侧也成立，游客态则完全不动。
 */
function installAuthNetwork() {
  const ses = session.defaultSession;
  const setHeader = (headers, name, value) => {
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === name.toLowerCase()) delete headers[k];
    }
    headers[name] = value;
  };
  ses.webRequest.onBeforeSendHeaders({
    urls: [
      'https://api.codemao.cn/*',
      'https://api-creation.codemao.cn/*',
      'https://socketcv.codemao.cn/*',
      'https://*.codemao.cn/*',
    ],
  }, (details, cb) => {
    if (!auth || !auth.loggedIn) return cb({});
    let host = '';
    try { host = new URL(details.url).hostname; } catch (_) { return cb({}); }
    if (host === 'codemao.cn' || host.endsWith('.codemao.cn')) {
      setHeader(details.requestHeaders, 'Authorization', 'Bearer ' + auth.data.token);
    }
    cb({ requestHeaders: details.requestHeaders });
  });
}

function pushState() {
  sendToShell('state', { current, recent: readState().recent || [], auth: auth ? auth.state() : { loggedIn: false } });
}

async function openProject(file, extra) {
  const meta = readMeta(file);
  if (meta.error) {
    sendToShell('error', { message: meta.error });
    return false;
  }

  // 缺 compile_result 的作品不阻断：页面侧的预编译器（src/player/compile.js）
  // 会用播放器内核自带的编译器现场补出来。这里只做记录，便于排查。
  if (!meta.hasCompile) {
    console.log('[k4p] 作品缺少 compile_result，将由页面侧编译器补全:', file);
  }

  // 在线作品：标题优先用接口给的作品名（缓存文件名只是一串数字，没有意义）
  const on = (extra && extra.online) || null;
  current = {
    path: file,
    name: meta.name,
    title: (on && on.name) || meta.title || meta.name,
    width: meta.width,
    height: meta.height,
    size: meta.size,
  };
  if (on) {
    current.online = { id: String(on.id), name: on.name || '', preview: on.preview || '' };
    if (on.size2 && on.size2.width) {
      current.width = on.size2.width;
      current.height = on.size2.height;
    }
  }

  const url = server.setProject(file, meta, on ? on.id : null);
  setChrome(true);
  layout();
  playerView.setVisible(true);
  await playerView.webContents.loadURL(url + '?t=' + Date.now());
  playerView.webContents.focus();

  const st = readState();
  const recent = [current, ...(st.recent || []).filter((r) => r.path !== file)].slice(0, 12)
    .map((r) => ({
      path: r.path,
      name: r.name,
      title: r.title || r.name,
      at: r.at || Date.now(),
      ...(r.online ? { online: r.online } : {}),
    }));

  if (recent[0]) recent[0].at = Date.now();
  writeState({ ...st, recent });

  sendToShell('project-opened', current);
  pushState();
  win.setTitle(`${current.title} — Kitten4 播放器`);
  return true;
}

function closeProject() {
  current = null;
  server.setProject(null);
  if (playerView) {
    playerView.setVisible(false);
    playerView.webContents.loadURL('about:blank').catch(() => {});
  }
  layout();
  sendToShell('project-closed');
  pushState();
  win.setTitle('Kitten4 播放器');
}

function registerIpc() {
  ipcMain.handle('open-in-editor', async (_e, p) => {
    const { spawn } = require('child_process');
    const cands = [
      process.env.K4P_EDITOR_PATH,
      'C:\\Program Files\\kitten4-desktop\\源码编辑器4.0.exe',
      'C:\\Program Files (x86)\\kitten4-desktop\\源码编辑器4.0.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'kitten4-desktop', '源码编辑器4.0.exe'),
    ].filter(Boolean);
    const exe = cands.find((c) => fs.existsSync(c));
    if (!exe) return { ok: false, message: '未找到 Kitten4 编辑器安装路径' };
    try {
      const child = spawn(exe, p && fs.existsSync(p) ? [p] : [], { detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true, exe };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle('open-dialog', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '打开作品',
      filters: [{ name: 'Kitten4 作品', extensions: ['bcm4', 'bcm'] }, { name: '所有文件', extensions: ['*'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    const ok = await openProject(r.filePaths[0]);
    return ok ? r.filePaths[0] : null;
  });

  ipcMain.handle('open-path', async (_e, p) => {
    if (!p || !fs.existsSync(p)) return { ok: false, message: '文件不存在' };
    const ok = await openProject(p);
    return { ok, current };
  });

  // 输入作品号 → 拉取官方作品数据 → 播放
  ipcMain.handle('open-online', async (_e, input) => {
    try {
      const res = await online.fetch(input, (ev) => sendToShell('online-progress', ev));
      const ok = await openProject(res.path, { online: res.meta, cached: res.cached });
      if (!ok) return { ok: false, message: '作品打开失败' };
      return { ok: true, current, cached: !!res.cached, offline: !!res.offline };
    } catch (e) {
      return { ok: false, message: (e && e.message) || '获取在线作品失败' };
    }
  });

  // 只解析作品号、不下载（用于输入框即时校验/取作品名）
  ipcMain.handle('resolve-work', async (_e, input) => {
    try {
      const src = await resolveInput(input);
      const meta = online.getMeta(src.id);
      return { ok: true, id: src.id, cached: !!meta, name: (meta && meta.name) || src.name || '', via: src.via };
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('reload-player', async () => {
    if (!current) return false;
    const url = server.playerUrl + '?t=' + Date.now();
    await playerView.webContents.loadURL(url);
    return true;
  });

  ipcMain.handle('close-project', () => { closeProject(); return true; });

  ipcMain.handle('toggle-fullscreen', () => {
    const v = !win.isFullScreen();
    win.setFullScreen(v);
    return v;
  });

  ipcMain.handle('set-chrome', (_e, v) => { setChrome(!!v); layout(); return v; });

  ipcMain.handle('win-minimize', () => win.minimize());
  ipcMain.handle('win-maximize', () => {
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('win-close', () => win.close());

  ipcMain.handle('get-state', () => ({ current, recent: readState().recent || [], auth: auth.state() }));

  /* ---------- 登录态 ---------- */
  ipcMain.handle('auth-login', async (_e, payload) => {
    const p = payload || {};
    const r = await auth.login(p.identity, p.password);
    if (!r.ok) return r;
    server.setUser(auth.details);
    await applyCookies(session.defaultSession, auth);
    sendToShell('auth-changed', auth.state());
    // 已登录后用户信息换了：有正在播放的作品就重新载入，让标题栏/头像立刻生效
    if (current) {
      try { await playerView.webContents.loadURL(server.playerUrl + '?t=' + Date.now()); } catch (_) {}
    }
    return r;
  });

  ipcMain.handle('auth-logout', () => {
    auth.logout();
    server.setUser(null);
    applyCookies(session.defaultSession, auth).catch(() => {});
    const st = auth.state();
    sendToShell('auth-changed', st);
    if (current) {
      playerView.webContents.loadURL(server.playerUrl + '?t=' + Date.now()).catch(() => {});
    }
    return st;
  });

  ipcMain.handle('auth-state', () => auth.state());

  // 播放器视图里的拖放 / 快捷键
  ipcMain.on('player-drop-path', (_e, p) => {
    if (!p || !/\.(bcm4|bcm)$/i.test(p)) return;
    if (!fs.existsSync(p)) { sendToShell('error', { message: '文件不存在' }); return; }
    openProject(p);
  });
  ipcMain.on('player-key', (_e, action) => {
    if (action === 'fullscreen') { win.setFullScreen(!win.isFullScreen()); return; }
    if (action === 'workid') { sendToShell('goto-workid'); return; }
    if (action === 'open') dialog.showOpenDialog(win, {
      title: '打开作品',
      filters: [{ name: 'Kitten4 作品', extensions: ['bcm4', 'bcm'] }, { name: '所有文件', extensions: ['*'] }],
      properties: ['openFile'],
    }).then((r) => { if (!r.canceled && r.filePaths.length) openProject(r.filePaths[0]); });
  });

  ipcMain.handle('clear-recent', () => { writeState({ recent: [] }); pushState(); return true; });

  ipcMain.handle('reveal', (_e, p) => { if (p) shell.showItemInFolder(p); });

  ipcMain.handle('remove-recent', (_e, p) => {
    const st = readState();
    st.recent = (st.recent || []).filter((r) => r.path !== p);
    writeState(st);
    pushState();
    return true;
  });
}

const single = app.requestSingleInstanceLock();
if (!single) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    const p = argvProjectPath(argv);
    if (p) openProject(p);
  });
}

app.setAppUserModelId('cn.kitten4.player');

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  Menu.setApplicationMenu(null);
  server = new PlayerServer(PLAYER_DIR);
  await server.start();
  auth = new Auth();
  auth.load();
  server.setUser(auth.details);
  online = new OnlineWorks();
  online.auth = auth;
  installAuthNetwork();
  await applyCookies(session.defaultSession, auth);
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (server) server.stop(); });
