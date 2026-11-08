'use strict';
/**
 * 在线作品拉取
 *
 * 输入「作品号」→ 拿到作品数据 → 落到本地缓存 → 之后的播放链路和本地文件完全一致。
 *
 * 用到的官方接口（播放器内核自己也在用同一个）：
 *   GET https://api-creation.codemao.cn/kitten/r2/work/player/load/<id>
 *   → { name, preview, source_urls: [...], is_bcmc, updated_time, version }
 *
 * source_urls 是同一作品的多个历史版本（第一项最新）。线上的作品数据是**运行时格式**：
 * 已经带 compile_result、scenes[].actors 也按图层排好了，所以不需要本地再编译一次。
 *
 * 请求走 Electron 的 net 模块而不是 Node 的 https —— net 用 Chromium 网络栈，
 * 能跟随系统的代理/证书设置，在受限网络下更容易成功。
 */
const { app, net } = require('electron');
const fs = require('fs');
const path = require('path');
const assets = require('./assets');

const API = 'https://api-creation.codemao.cn';
const PICKCAT_API = 'https://pickcat.dao3.fun/api/v1/works/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Kitten4Player';
const INFO_TIMEOUT = 20000;
const FILE_TIMEOUT = 120000;

// PICKCAT（pickcat.dao3.fun）不是独立的作品站，它只是把 codemao 作品包了一层：
// /api/v1/works/<uuid> 里的 sourceWorkId 就是原作品号，前端最终也是拼
// https://player.codemao.cn/new/<sourceWorkId>。所以这里先解析出原作品号即可。
const PICKCAT_RE = /pickcat[^/\s]*\/works\/([0-9a-f-]{20,})/i;

/** 从「作品号 / 播放链接 / 社区链接」里提取数字作品号 */
function parseWorkId(input) {
  const s = String(input == null ? '' : input).trim();
  if (!s) return null;
  if (/^\d{3,12}$/.test(s)) return s;
  let m = s.match(/\/new\/(\d{3,12})/) || s.match(/\/work\/(\d{3,12})/) || s.match(/\/preview\/(\d{3,12})/);
  if (m) return m[1];
  m = s.match(/(?:^|\D)(\d{5,12})(?:\D|$)/);
  return m ? m[1] : null;
}

/** PICKCAT 作品 UUID → 原 codemao 作品号 */
async function resolvePickcat(uuid) {
  const r = await request(PICKCAT_API + encodeURIComponent(uuid), { timeoutMs: INFO_TIMEOUT });
  let d = null;
  try { d = JSON.parse(r.body.toString('utf8')); } catch (_) {}
  if (r.status === 404 || !d || !d.id) throw new Error('PICKCAT 上找不到这个作品');
  if (d.type && d.type !== 'KITTEN4') throw new Error('这个作品是 ' + d.type + '，本播放器只能运行 Kitten4 作品');
  if (!d.sourceWorkId) throw new Error('这个 PICKCAT 作品没有关联到源码作品号，无法播放');
  return {
    id: String(d.sourceWorkId),
    name: d.workName || '',
    via: 'pickcat',
    uuid,
    author: (d.author && d.author.username) || '',
  };
}

/** 把用户输入（作品号 / codemao 链接 / PICKCAT 链接）统一解析成作品号 */
async function resolveInput(input) {
  const s = String(input == null ? '' : input).trim();
  if (!s) throw new Error('请输入作品号');
  const pm = s.match(PICKCAT_RE);
  if (pm) return await resolvePickcat(pm[1]);
  const id = parseWorkId(s);
  if (!id) throw new Error('无法识别作品号，请输入数字作品号，或粘贴作品页链接');
  return { id, via: 'codemao' };
}

/** 基础 GET，跟随重定向，带超时与下载进度 */
function request(url, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || INFO_TIMEOUT;
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = net.request({ method: 'GET', url, redirect: 'follow' });
      req.setHeader('User-Agent', UA);
      req.setHeader('Accept', 'application/json, */*');
      // 登录后带上 Bearer：私有 / 未公开的作品只有作者本人（或登录用户）能拉到
      const h = o.headers || {};
      for (const k of Object.keys(h)) {
        if (h[k] != null) req.setHeader(k, String(h[k]));
      }
    } catch (e) {
      return reject(new Error('请求初始化失败：' + e.message));
    }

    let finished = false;
    let timer = null;
    const fail = (err) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      try { req.abort(); } catch (_) {}
      reject(err);
    };
    timer = setTimeout(() => fail(new Error('网络请求超时，请检查网络后重试')), timeoutMs);

    req.on('response', (res) => {
      const chunks = [];
      const total = Number(res.headers['content-length'] || 0) || 0;
      let loaded = 0;
      if (o.onProgress) o.onProgress(loaded, total);
      res.on('data', (c) => {
        chunks.push(c);
        loaded += c.length;
        if (o.onProgress) o.onProgress(loaded, total);
      });
      res.on('end', () => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
      res.on('error', (e) => fail(new Error(e && e.message ? e.message : '下载中断')));
    });
    req.on('error', (e) => fail(new Error(e && e.message ? e.message : '网络请求失败')));
    req.end();
  });
}

/** 造型图也走同一个下载通道（Chromium 网络栈，跟随系统代理） */
assets.useRequester((url, opts) => request(url, { timeoutMs: (opts && opts.timeoutMs) || 30000 }));

/** 作品信息；作品不存在/未公开时抛出带 code 的错误 */async function fetchWorkInfo(id, headers) {
  const r = await request(API + '/kitten/r2/work/player/load/' + encodeURIComponent(id), {
    timeoutMs: INFO_TIMEOUT,
    headers: headers || undefined,
  });
  let data = null;
  try { data = JSON.parse(r.body.toString('utf8')); } catch (_) {}

  if (data && data.error_message) {
    const err = new Error(data.error_message === '作品不存在' ? '作品不存在或未公开' : data.error_message);
    err.code = data.error_code;
    throw err;
  }
  if (r.status === 404 || r.status === 422) {
    const err = new Error('作品不存在或未公开');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (r.status !== 200 || !data) throw new Error('获取作品信息失败（HTTP ' + r.status + '）');
  if (!Array.isArray(data.source_urls) || !data.source_urls.length) {
    throw new Error('这个作品没有可下载的数据');
  }
  return data;
}

/**
 * 依次尝试 source_urls，拿到第一份可解析的作品数据
 *
 * 公开作品的 CDN 直链不需要身份；但私有作品的数据地址可能要带登录态。
 * 所以先按游客拉，遇到 401/403 再带 Authorization 重试一次 —— 公开作品完全不受影响。
 */
async function fetchProject(info, onProgress, headers) {
  const urls = info.source_urls || [];
  let lastErr = null;
  for (let i = 0; i < urls.length; i++) {
    try {
      let r = await request(urls[i], { timeoutMs: FILE_TIMEOUT, onProgress });
      if ((r.status === 401 || r.status === 403) && headers) {
        r = await request(urls[i], { timeoutMs: FILE_TIMEOUT, onProgress, headers });
      }
      if (r.status !== 200) { lastErr = new Error('下载失败（HTTP ' + r.status + '）'); continue; }
      const text = r.body.toString('utf8');
      let obj = null;
      try { obj = JSON.parse(text); } catch (_) {}
      if (!obj || !obj.theatre) { lastErr = new Error('作品数据不完整'); continue; }
      return { buf: r.body, obj, url: urls[i] };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('作品下载失败');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

class OnlineWorks {
  constructor() {
    this._dir = null;
    this.auth = null;   // 由 main.js 注入（Auth 实例），可为 null
  }

  /** 登录后所有作品接口请求都带 Bearer */
  get authHeaders() {
    return this.auth && this.auth.loggedIn ? this.auth.headers : undefined;
  }

  get dir() {
    if (!this._dir) {
      this._dir = path.join(app.getPath('userData'), 'online');
      fs.mkdirSync(this._dir, { recursive: true });
    }
    return this._dir;
  }

  filePath(id) { return path.join(this.dir, id + '.bcm4'); }
  metaPath(id) { return path.join(this.dir, id + '.meta.json'); }

  /** 已缓存的元信息（没有则 null） */
  getMeta(id) {
    const m = readJson(this.metaPath(id));
    if (!m || !fs.existsSync(this.filePath(id))) return null;
    return m;
  }

  /**
   * 造型离线化：把 CDN 造型图内联成 data URI，只做一次。
   * 做完之后云端作品和本地 .bcm4 完全等价 —— 启动不用等 155 张图、不依赖 CDN。
   */
  async localize(id, meta, send) {
    if (meta && meta.stylesLocal) return meta;
    const file = this.filePath(id);
    send({ phase: 'localize', id, loaded: 0, total: 0 });
    let r = { changed: false, ok: 0, fail: 0, total: 0 };
    try {
      r = await assets.localizeProjectFile(file, (done, total) => {
        if (done === total || done % 20 === 0) send({ phase: 'localize', id, loaded: done, total });
      });
    } catch (_) {}
    // 一张都没下成功就别标记，下次打开再试
    const next = {
      ...(meta || {}),
      stylesLocal: r.changed || (r.total > 0 && r.ok > 0),
      stylesFail: r.fail || 0,
    };
    try {
      if (fs.existsSync(file)) next.size = fs.statSync(file).size;
      fs.writeFileSync(this.metaPath(id), JSON.stringify(next, null, 2));
    } catch (_) {}
    return next;
  }

  /**
   * 拉一个在线作品到本地缓存。
   * @param {string} input 作品号或作品链接
   * @param {(ev:object)=>void} emit 进度回调
   * @returns {{ path, meta, cached }}
   */
  async fetch(input, emit) {
    const send = (o) => { if (emit) { try { emit(o); } catch (_) {} } };

    send({ phase: 'resolve' });
    const src = await resolveInput(input);
    const id = src.id;

    send({ phase: 'info', id, name: src.name, via: src.via });
    let info = null;
    try {
      info = await fetchWorkInfo(id, this.authHeaders);
    } catch (e) {
      // 网络不通/接口抽风时，退回上次下载的副本 —— 断网也能重玩打开过的作品
      const fallback = this.getMeta(id);
      if (fallback) {
        send({ phase: 'cached', id, name: fallback.name, offline: true, reason: e.message });
        return { path: this.filePath(id), meta: fallback, cached: true, offline: true };
      }
      // 作品确实不存在时才提示登录 —— 已经登录了就别误导
      if (e.code === 'NOT_FOUND' && !this.authHeaders) {
        e.message = '作品不存在或未公开（如果这是你自己的未公开作品，登录后可以打开）';
      }
      throw e;
    }
    const latest = info.source_urls[0];
    const meta = this.getMeta(id);

    // 版本没变就直接用缓存：作品数据通常几 MB，网络差时这一下能省掉大半等待
    if (meta && meta.sourceUrl === latest) {
      send({ phase: 'cached', id, name: info.name || meta.name });
      const merged = { ...meta, name: info.name || meta.name, via: src.via, pickcatUuid: src.uuid || meta.pickcatUuid || '' };
      // 老缓存里造型还是 CDN 链接：顺手离线化一次（只做一次）
      const done = await this.localize(id, merged, send);
      return { path: this.filePath(id), meta: done, cached: true };
    }

    send({ phase: 'download', id, name: info.name, loaded: 0, total: 0 });
    let lastTick = 0;
    let got = null;
    try {
      got = await fetchProject(info, (loaded, total) => {
        const now = Date.now();
        if (now - lastTick < 120 && loaded !== total) return;
        lastTick = now;
        send({ phase: 'download', id, name: info.name, loaded, total });
      }, this.authHeaders);
    } catch (e) {
      // 下载失败也回退到旧副本，总比什么都播不了好
      if (meta) {
        send({ phase: 'cached', id, name: meta.name, offline: true, reason: e.message });
        return { path: this.filePath(id), meta, cached: true, offline: true };
      }
      throw e;
    }

    send({ phase: 'save', id, name: info.name });
    const file = this.filePath(id);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, got.buf);
    fs.renameSync(tmp, file);

    const next = {
      id,
      name: info.name || src.name || '',
      preview: info.preview || '',
      sourceUrl: got.url,
      updatedTime: info.updated_time || 0,
      fetchedAt: Date.now(),
      size: got.buf.length,
      projectName: String(got.obj.project_name || info.name || ''),
      size2: got.obj.size || null,
      via: src.via,
      pickcatUuid: src.uuid || '',
    };
    fs.writeFileSync(this.metaPath(id), JSON.stringify(next, null, 2));

    // 造型图内联（走本地磁盘缓存，第二次打开就不再联网）
    const done = await this.localize(id, next, send);
    send({ phase: 'done', id, name: done.name, size: done.size });
    return { path: file, meta: done, cached: false };
  }
}

module.exports = { OnlineWorks, parseWorkId, resolveInput, fetchWorkInfo };
