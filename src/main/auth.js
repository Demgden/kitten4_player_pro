'use strict';
/**
 * 登录态（可选功能）
 *
 * 目标：让「拉作品信息 / 拉作品数据 / 播放器自己的接口请求」都以登录用户的身份发出。
 * 这样私有或未公开的作品也能打开，播放器里的用户信息也是真实的。
 *
 * 登录走编程猫官方的账号接口（社区网页版用的同一个）：
 *   POST https://api.codemao.cn/tiger/v3/web/accounts/login
 *   body { identity, password, pid, agreement_ids: [-1] }
 *   → { auth: { token: <JWT> }, user_info: { id, nickname, avatar_url } }
 *
 * 关键点：
 *   - 密码是**明文**提交的（官方客户端也没做前端加密），所以这里绝不留存密码，
 *     只把返回的 JWT 存到 userData/account.json。
 *   - 之后所有请求用 `Authorization: Bearer <JWT>`，这也是 /web/users/details 认可的方式。
 *   - pid 是「产品线 ID」，社区网页版会把它写进首页；这里做三级兜底
 *     （缓存 → 现抓首页 → 内置常量），避免对方改值时整个功能失效。
 */
const { app, net } = require('electron');
const fs = require('fs');
const path = require('path');

const API = 'https://api.codemao.cn';
const SHEQU = 'https://shequ.codemao.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Kitten4Player';
const TIMEOUT = 20000;

/** 社区网页版的 pid；抓不到首页时用它兜底（2026-11 有效） */
const FALLBACK_PID = '65edCTyg';

const ERR_TEXT = {
  AC_0: '账号或密码错误',
  AC_1: '账号或密码错误',
  AC_45: '账号或密码错误',
  AC3_53: '密码格式不合法',
  ACCOUNT_HAS_BLOCKED: '账号已被封禁',
};

function request(url, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = net.request({ method: o.method || 'GET', url, redirect: 'follow' });
      req.setHeader('User-Agent', UA);
      req.setHeader('Accept', 'application/json, */*');
      const headers = o.headers || {};
      for (const k of Object.keys(headers)) {
        if (headers[k] != null) req.setHeader(k, String(headers[k]));
      }
    } catch (e) {
      return reject(new Error('请求初始化失败：' + e.message));
    }

    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { req.abort(); } catch (_) {}
      reject(new Error('网络请求超时'));
    }, o.timeoutMs || TIMEOUT);
    const done = (fn, arg) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      fn(arg);
    };

    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done(resolve, {
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', (e) => done(reject, new Error(e.message || '下载中断')));
    });
    req.on('error', (e) => done(reject, new Error(e.message || '网络请求失败')));

    if (o.body != null) req.write(o.body);
    req.end();
  });
}

class Auth {
  constructor() {
    this._file = null;
    this._pid = null;
    this.data = null; // { token, details, at }
  }

  get file() {
    if (!this._file) this._file = path.join(app.getPath('userData'), 'account.json');
    return this._file;
  }

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (d && d.token && d.details && d.details.id) this.data = d;
    } catch (_) {}
    return this.state();
  }

  save(d) {
    this.data = d;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(d, null, 2), { mode: 0o600 });
    } catch (e) {
      console.log('[k4p] 保存登录信息失败:', e.message);
    }
  }

  get loggedIn() { return !!(this.data && this.data.token); }

  /** 请求头：登录后带 Bearer */
  get headers() {
    return this.loggedIn ? { Authorization: 'Bearer ' + this.data.token } : {};
  }

  /** 播放器要的用户信息（就是官方 /web/users/details 的返回体） */
  get details() { return this.loggedIn ? this.data.details : null; }

  /** 给界面用，别把 token 送出去 */
  state() {
    if (!this.loggedIn) return { loggedIn: false };
    const d = this.data.details || {};
    return {
      loggedIn: true,
      id: String(d.id || ''),
      nickname: d.nickname || '',
      avatar: d.avatar_url || d.avatar || '',
      at: this.data.at || 0,
    };
  }

  /** pid 三级兜底 */
  async resolvePid() {
    if (this._pid) return this._pid;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'iris.json'), 'utf8'));
      if (d && d.pid) { this._pid = d.pid; return this._pid; }
    } catch (_) {}
    try {
      const r = await request(SHEQU + '/', { timeoutMs: 8000 });
      const m = r.body.match(/"pid"\s*:\s*"([A-Za-z0-9]+)"/);
      if (m) {
        this._pid = m[1];
        try { fs.writeFileSync(path.join(app.getPath('userData'), 'iris.json'), JSON.stringify({ pid: m[1] })); } catch (_) {}
        return this._pid;
      }
    } catch (_) {}
    this._pid = FALLBACK_PID;
    return this._pid;
  }

  /**
   * 账号密码登录。只返回登录结果，不缓存密码。
   * @returns {{ok:true, state:object} | {ok:false, message:string}}
   */
  async login(identity, password) {
    const id = String(identity == null ? '' : identity).trim();
    const pwd = String(password == null ? '' : password);
    if (!id) return { ok: false, message: '请输入账号（手机号或邮箱）' };
    if (!pwd) return { ok: false, message: '请输入密码' };

    const pid = await this.resolvePid();
    let r;
    try {
      r = await request(API + '/tiger/v3/web/accounts/login', {
        method: 'POST',
        timeoutMs: TIMEOUT,
        headers: {
          'Content-Type': 'application/json;charset=utf-8',
          'Product-Code': 'kitten',
          Platform: 'web',
          pid,
          Origin: SHEQU,
          Referer: SHEQU + '/',
        },
        body: JSON.stringify({ identity: id, password: pwd, pid, agreement_ids: [-1] }),
      });
    } catch (e) {
      return { ok: false, message: '登录请求失败：' + (e.message || '网络错误') };
    }

    let d = null;
    try { d = JSON.parse(r.body); } catch (_) {}
    const token = d && d.auth && d.auth.token;
    if (r.status !== 200 || !token) {
      const code = (d && d.error_code) || '';
      const msg = ERR_TEXT[code] || (d && d.error_message) || ('登录失败（HTTP ' + r.status + '）');
      return { ok: false, message: String(msg).slice(0, 120) };
    }

    // 拿播放器真正需要的用户对象（结构必须和官方一致，否则播放器读属性会崩）
    let details = null;
    try {
      const u = await request(API + '/web/users/details', {
        timeoutMs: TIMEOUT,
        headers: { Authorization: 'Bearer ' + token, Origin: SHEQU, Referer: SHEQU + '/' },
      });
      if (u.status === 200) details = JSON.parse(u.body);
    } catch (_) {}

    if (!details) {
      // 兜底：用登录返回的 user_info 拼一个最小可用结构
      const ui = (d && d.user_info) || {};
      details = {
        id: String(ui.id || ''),
        nickname: ui.nickname || '',
        avatar_url: ui.avatar_url || '',
        phone_number: (d.auth && d.auth.phone_number) || '',
      };
    }

    this.save({ token, details, at: Date.now() });
    return { ok: true, state: this.state() };
  }

  logout() {
    this.data = null;
    try { fs.unlinkSync(this.file); } catch (_) {}
    return { loggedIn: false };
  }
}

/** 需要带登录 cookie 的域（云数据走 socketcv，作品接口走 api-creation） */
const COOKIE_HOSTS = [
  'https://api.codemao.cn',
  'https://api-creation.codemao.cn',
  'https://socketcv.codemao.cn',
];

/**
 * 把登录态写进 session cookie。
 *
 * 官方播放器自己在 USER_LOGIN 消息里也是写 `authorization` 这个 cookie，
 * 云数据的 WebSocket 握手就靠它。这里用 SameSite=None 是因为我们的页面跑在
 * 127.0.0.1，对 codemao 域来说是第三方来源。
 */
async function applyCookies(ses, auth) {
  if (!auth) return;
  const token = auth.loggedIn ? auth.data.token : null;
  for (const url of COOKIE_HOSTS) {
    try {
      if (token) {
        await ses.cookies.set({
          url,
          name: 'authorization',
          value: token,
          secure: true,
          httpOnly: true,
          sameSite: 'no_restriction',
        });
      } else {
        await ses.cookies.remove(url, 'authorization');
      }
    } catch (e) {
      console.log('[k4p] cookie 写入失败', url, e.message);
    }
  }
}

module.exports = { Auth, applyCookies };
