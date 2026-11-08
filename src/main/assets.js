'use strict';
/**
 * 造型离线化
 *
 * 在线作品的 `theatre.styles[].url` 指向 CDN（creation.bcmcdn.com），
 * 而本地 .bcm4 里是 data URI —— 这是「同一个作品，本地和云端表现不一样」的
 * 唯一运行期差异。
 *
 * 差异带来的实际代价（播放器内核里量过）：
 *   1. 播放器启动前有个硬门槛「正在加载图片资源(n/155)」，任何一张拉不下来就永远停在那；
 *   2. 155 张图并发走网络，慢的时候这一屏要等十几秒，表现就是「开播第一帧卡一下」；
 *   3. 图片解码/加载的先后顺序会变，逐帧盖章（图章）类作品偶发画不出来。
 *
 * 所以下载完就把造型图抓下来内联成 data URI，让云端作品和本地文件彻底等价：
 * 不依赖 CDN、启动不用等图、行为只由数据决定。抓过的图按 url 哈希落盘复用，
 * 同一个作品再打开一次就不联网了。
 */
const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let req = null;   // online.js 的 request()，由外部注入，避免循环依赖

/** 注入下载函数（online.js 的 request，走 Chromium 网络栈，能跟上系统代理） */
function useRequester(fn) { req = fn; }

function cacheDir() {
  const d = path.join(app.getPath('userData'), 'styles');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const keyOf = (url) => crypto.createHash('sha1').update(url).digest('hex');

function sniffMime(buf, fallback) {
  const head = buf.slice(0, 64).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'image/svg+xml';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (head.startsWith('gif8')) return 'image/gif';
  if (head.startsWith('riff')) return 'image/webp';
  return fallback || 'image/png';
}

/** 取一张造型图；磁盘有就直接用，没有就下载并写盘 */
async function fetchStyle(url) {
  const dir = cacheDir();
  const k = keyOf(url);
  const bin = path.join(dir, k);
  const ctf = path.join(dir, k + '.ct');
  try {
    const buf = fs.readFileSync(bin);
    let ct = 'image/png';
    try { ct = fs.readFileSync(ctf, 'utf8').trim() || ct; } catch (_) {}
    return { buf, mime: sniffMime(buf, ct) };
  } catch (_) { /* 未缓存 */ }

  if (!req) throw new Error('未注入下载器');
  const r = await req(url, { timeoutMs: 30000 });
  if (r.status !== 200 || !r.body || !r.body.length) {
    throw new Error('造型下载失败 HTTP ' + r.status);
  }
  const mime = sniffMime(r.body, String((r.headers && r.headers['content-type']) || '').split(';')[0]);
  try {
    fs.writeFileSync(bin, r.body);
    fs.writeFileSync(ctf, mime);
  } catch (_) { /* 缓存写不进去也无所谓 */ }
  return { buf: r.body, mime };
}

/**
 * 把作品对象里的 http(s) 造型 url 换成 data URI（就地修改）
 * @returns {Promise<{total:number, ok:number, fail:number}>}
 */
async function inlineStyles(obj, onTick) {
  const styles = obj && obj.theatre && obj.theatre.styles;
  if (!styles) return { total: 0, ok: 0, fail: 0 };
  const urls = [];
  for (const s of Object.values(styles)) {
    if (s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url) && urls.indexOf(s.url) < 0) urls.push(s.url);
  }
  const total = urls.length;
  if (!total) return { total: 0, ok: 0, fail: 0 };

  const map = new Map();
  let ok = 0;
  let fail = 0;
  let i = 0;
  const worker = async () => {
    while (i < urls.length) {
      const u = urls[i++];
      try {
        const { buf, mime } = await fetchStyle(u);
        map.set(u, 'data:' + mime + ';base64,' + buf.toString('base64'));
        ok++;
      } catch (_) {
        fail++;   // 失败的保持原样，播放器还能按原来的网络路径去拿
      }
      if (onTick) { try { onTick(ok + fail, total); } catch (_) {} }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, urls.length) }, worker));

  for (const s of Object.values(styles)) {
    if (s && map.has(s.url)) s.url = map.get(s.url);
  }
  return { total, ok, fail };
}

/**
 * 对磁盘上的 .bcm4 就地离线化
 * @returns {Promise<{changed:boolean, ok:number, fail:number, total:number}>}
 */
async function localizeProjectFile(file, onTick) {
  const none = { changed: false, ok: 0, fail: 0, total: 0 };
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return none; }
  const styles = obj && obj.theatre && obj.theatre.styles;
  if (!styles) return none;
  let hasRemote = false;
  for (const s of Object.values(styles)) {
    if (s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url)) { hasRemote = true; break; }
  }
  if (!hasRemote) return { ...none, changed: true };   // 已经是 data URI：视为已离线

  const r = await inlineStyles(obj, onTick);
  if (!r.ok) return { changed: false, ok: 0, fail: r.fail, total: r.total };   // 一张都没拿到：别写盘，留着重试
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
  return { changed: true, ok: r.ok, fail: r.fail, total: r.total };
}

module.exports = { useRequester, inlineStyles, localizeProjectFile };
