'use strict';
/**
 * 本地资源 + 作品服务
 * 官方播放器（player_v2）在非数字路径下会用 location.pathname 直接拉取 bcm4，
 * 因此这里用 /new/<token> 同时承担「页面」与「作品数据」两个角色：
 *   - 浏览器导航请求（Sec-Fetch-Dest: document）→ 返回播放器页面
 *   - XHR 请求 → 返回当前作品的 bcm4 JSON
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 官方云数据（云变量 / 排行榜）服务地址，取自 player.codemao.cn/new/client_config.json
const OFFICIAL_CLOUD_API = 'https://socketcv.codemao.cn';
const OFFICIAL_CLOUD_WSS = 'wss://socketcv.codemao.cn:9096';

const MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.bcm4': 'application/json; charset=utf-8',
};

class PlayerServer {
  constructor(playerDir) {
    this.playerDir = playerDir;
    this.port = 0;
    this.token = crypto.randomBytes(8).toString('hex');
    this.project = null; // { path, name }
    this.server = null;
    this.allowCdnFallback = false;
    this.user = null;    // 登录用户（官方 /web/users/details 的返回体）
    this.workId = '';    // 在线作品号：播放器靠它跑「云数据」相关积木
  }

  get origin() {
    return `http://127.0.0.1:${this.port}`;
  }

  get playerUrl() {
    return `${this.origin}/new/${this.token}`;
  }

  setProject(filePath, meta, workId) {
    this.project = filePath ? { path: filePath, name: path.basename(filePath), meta: meta || null } : null;
    this.workId = /^\d{3,12}$/.test(String(workId == null ? '' : workId)) ? String(workId) : '';
    this.token = crypto.randomBytes(8).toString('hex');
    this.compileCache = null;
    this._prep = undefined;   // 预处理结果按作品缓存，换作品要清掉
    return this.playerUrl;
  }

  /** 设置/清除登录用户；播放器下一次加载时会拿到真实昵称与头像 */
  setUser(user) {
    this.user = user || null;
  }

  async start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
    return this.port;
  }

  stop() {
    if (this.server) {
      try { this.server.close(); } catch (_) {}
      this.server = null;
    }
  }

  cors(req) {
    const origin = (req && req.headers && req.headers.origin) || '*';
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Cache-Control': 'no-store',
    };
  }

  handle(req, res) {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (process.env.K4P_LOG) {
      console.log('[srv]', req.method, url, 'dest=' + (req.headers['sec-fetch-dest'] || ''), 'acc=' + String(req.headers['accept'] || '').slice(0, 30), 'origin=' + (req.headers.origin || ''), 'cookie=' + (req.headers.cookie ? 'y' : 'n'));
    }
    const cors = this.cors(req);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }

    // 客户端配置：把接口域名改到本地，避免任何联网依赖
    if (url === '/new/client_config.json') {
      return this.sendJson(res, this.clientConfig(), cors);
    }

    // 作品元信息（部分加载分支会请求，返回最小可用结构）
    if (url.startsWith('/api/work/info/')) {
      const id = url.slice('/api/work/info/'.length);
      return this.sendJson(res, this.workInfo(id), cors);
    }

    // 用户信息：登录后返回真实数据，游客态明确 401（回 200 会让播放器读空昵称崩掉）
    if (url.startsWith('/web/users/details')) {
      if (this.user) return this.sendJson(res, this.user, cors);
      res.writeHead(401, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
      return res.end('{"status":401,"error":"unauthorized"}');
    }

    // 播放器静态资源
    if (url.startsWith('/kn/build/')) {
      const file = path.join(this.playerDir, url.slice('/kn/'.length));
      if (ff(file)) return this.sendFile(res, file, cors);
      return this.fallback(url, cors, res);
    }

    // 本地作品预编译器（页面侧，见 src/player/compile.js）
    if (url === '/k4p/compile.js') {
      const file = path.join(this.playerDir, 'compile.js');
      if (ff(file)) {
        return this.sendFile(res, file, cors, { 'Content-Type': 'application/javascript; charset=utf-8' });
      }
      res.writeHead(404, { ...cors, 'Content-Type': 'application/javascript' });
      return res.end('// missing');
    }

    // 云数据身份注入（页面侧，见 src/player/cloud.js）
    if (url === '/k4p/cloud.js') {
      const file = path.join(this.playerDir, 'cloud.js');
      if (ff(file)) {
        return this.sendFile(res, file, cors, { 'Content-Type': 'application/javascript; charset=utf-8' });
      }
      res.writeHead(404, { ...cors, 'Content-Type': 'application/javascript' });
      return res.end('// missing');
    }

    // 页面侧编译结果回传：接到后拼装成「完整作品」，下一次加载走原生路径
    if (url === '/k4p/compile-result' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const crJson = Buffer.concat(chunks).toString('utf8');
          if (!this.project || !crJson.trim().startsWith('[')) throw new Error('bad payload');
          const raw = fs.readFileSync(this.project.path, 'utf8');
          const parsed = JSON.parse(raw);
          this.normalizeProject(parsed);
          // 编辑器字段体积巨大（florr 有 10 万+ 积木），运行时不需要，删掉能省一半以上
          const th = parsed.theatre;
          if (th) {
            for (const e of Object.values(th.scenes || {})) delete e.block_data_json;
            for (const e of Object.values(th.actors || {})) delete e.block_data_json;
          }
          parsed.compile_result = JSON.parse(crJson);
          this.compileCache = { token: this.token, buf: Buffer.from(JSON.stringify(parsed), 'utf8') };
          console.log('[k4p] 已缓存编译结果', (this.compileCache.buf.length / 1048576).toFixed(1) + 'MB');
          // K4P_DUMP=1 时把拼装结果落盘，方便离线分析「产物到底长什么样」
          if (process.env.K4P_DUMP) {
            try {
              const dir = path.join(__dirname, '..', '..', '_probe');
              fs.mkdirSync(dir, { recursive: true });
              const out = path.join(dir, '_assembled.bcm4');
              fs.writeFileSync(out, this.compileCache.buf);
              console.log('[k4p] 拼装结果已落盘', out);
            } catch (e) {
              console.warn('[k4p] 落盘失败', e && e.message);
            }
          }
          res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (e) {
          res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e && e.message) }));
        }
      });
      return;
    }

    // 调试用：把页面侧的数据（例如编译结果）落盘，便于离线比对
    if (url === '/k4p/dump' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const dir = path.join(__dirname, '..', '..', '_probe');
          fs.mkdirSync(dir, { recursive: true });
          const name = (new URL('http://x' + (req.url || '')).searchParams.get('name') || 'dump').replace(/[^\w.-]/g, '_');
          fs.writeFileSync(path.join(dir, name), Buffer.concat(chunks));
          res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (e) {
          res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e && e.message) }));
        }
      });
      return;
    }

    // 作品页面 / 作品数据
    if (url.startsWith('/new/')) {
      const dest = String(req.headers['sec-fetch-dest'] || '');
      const accept = String(req.headers['accept'] || '');
      const isDocument = dest === 'document' || dest === '' && accept.includes('text/html');
      if (isDocument) {
        return this.sendPlayerPage(res, cors);
      }
      if (!this.project) {
        res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 404, error: 'no project loaded' }));
      }
      // HEAD：只回报可达性，不给 body
      if (req.method === 'HEAD') {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
        return res.end();
      }
      // 已经有页面侧编译结果：直接给完整作品（播放器走原生路径，不再需要任何改写）
      if (this.compileCache && this.compileCache.token === this.token) {
        res.writeHead(200, {
          ...cors,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': this.compileCache.buf.length,
        });
        return res.end(this.compileCache.buf);
      }
      // 文件自带 compile_result、但 scenes[].actors 还是空的（编辑器导出的半成品）：
      // 页面侧不会再编译，这里必须先把运行时格式补齐，否则场景里没有角色层
      const prep = this.prepareProject();
      if (prep) {
        res.writeHead(200, {
          ...cors,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': prep.length,
        });
        return res.end(prep);
      }
      // 否则返回原始文件，由页面侧负责编译
      const stream = fs.createReadStream(this.project.path);
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
      stream.on('error', () => { try { res.destroy(); } catch (_) {} });
      return stream.pipe(res);
    }

    // WebSocket 云变量等：直接拒绝，避免挂起
    if (url.startsWith('/socket') || url.startsWith('/cloudstorage')) {
      res.writeHead(204, cors);
      return res.end();
    }

    return this.fallback(url, cors, res);
  }

  sendJson(res, obj, cors) {
    const buf = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
    res.end(buf);
  }

  /**
   * 首次请求作品数据时的预处理：只处理「自带 compile_result 但场景缺 actors」的文件。
   * 返回拼装好的 Buffer，或 null（表示原样输出，交给页面侧编译）。
   */
  prepareProject() {
    if (this._prep !== undefined) return this._prep;
    this._prep = null;
    try {
      const st = fs.statSync(this.project.path);
      if (st.size > 64 * 1024 * 1024) return null;
      const obj = JSON.parse(fs.readFileSync(this.project.path, 'utf8'));
      if (!Array.isArray(obj.compile_result)) return null;      // 没有编译产物 → 交给页面侧
      const th = obj.theatre;
      if (!th || !th.scenes || !th.actors) return null;
      let need = false;
      for (const sid of Object.keys(th.scenes)) {
        const sc = th.scenes[sid];
        if (sc && (!Array.isArray(sc.actors) || !sc.actors.length)) { need = true; break; }
      }
      if (!need) return null;                                   // 已经是运行时格式
      this.normalizeProject(obj);
      for (const e of Object.values(th.scenes)) delete e.block_data_json;
      for (const e of Object.values(th.actors)) delete e.block_data_json;
      this._prep = Buffer.from(JSON.stringify(obj), 'utf8');
      console.log('[k4p] 补齐场景角色层', (st.size / 1048576).toFixed(1) + 'MB → ' + (this._prep.length / 1048576).toFixed(1) + 'MB');
      return this._prep;
    } catch (e) {
      console.warn('[k4p] 作品预处理跳过', e && e.message);
      this._prep = null;
      return null;
    }
  }

  /**
   * 把「编辑器工作区格式」的作品补成运行时格式。
   *
   * 本地导出的 .bcm4 里 `theatre.scenes[].actors` 是空数组 —— 编辑器保存成线上作品时
   * 会按图层顺序填进去，运行时靠它建每个场景的角色层。缺了这一项，场景里没有角色，
   * 于是「克隆」这类按 id 找角色的积木会抛 `throw_block_type_error`（表现为「作品积木
   * 还有点小问题」并停在初始化）。
   *
   * 图层顺序来源：`scene.group_order`（图层从上到下）+ `theatre.groups[id].actors`，
   * 运行时数组是自底向上，所以整体反转一次（已用线上版本逐项验证一致）。
   */
  normalizeProject(obj) {
    const th = obj && obj.theatre;
    if (!th || !th.scenes || !th.actors) return obj;
    const groups = th.groups || {};
    for (const sid of Object.keys(th.scenes)) {
      const sc = th.scenes[sid];
      if (!sc) continue;
      if (Array.isArray(sc.actors) && sc.actors.length) continue; // 已经是运行时格式
      const order = [];
      const seen = new Set();
      const walk = (gid) => {
        const g = groups[gid];
        if (!g) return;
        if (g.is_group) {
          for (const c of g.group_order || g.groups || []) walk(c);
          return;
        }
        for (const a of g.actors || []) {
          if (!seen.has(a)) {
            seen.add(a);
            order.push(a);
          }
        }
      };
      for (const gid of sc.group_order || []) walk(gid);
      order.reverse();
      // 兜底：没进任何图层的角色也要留在场景里，否则运行时根本看不见它
      for (const [aid, a] of Object.entries(th.actors)) {
        if (a && a.scene === sid && !seen.has(aid)) order.push(aid);
      }
      sc.actors = order;
    }
    if (!th.current_scene) {
      th.current_scene = (th.scenes_order && th.scenes_order[0]) || Object.keys(th.scenes)[0] || '';
    }
    if (!th.current_entity) th.current_entity = Object.keys(th.actors)[0] || '';
    if (!th.style_collections) th.style_collections = {};
    return obj;
  }

  /** 播放器客户端配置：接口域名全部指向本地服务 */
  clientConfig() {
    if (!this._cfg) {
      try {
        this._cfg = JSON.parse(fs.readFileSync(path.join(this.playerDir, 'client_config.json'), 'utf8'));
      } catch (_) {
        this._cfg = {};
      }
    }
    const cfg = JSON.parse(JSON.stringify(this._cfg));
    cfg.creation_api = this.origin;
    cfg.api = { ...(cfg.api || {}), host: this.origin, port: '' };
    cfg.open_service_api = this.origin;

    // 云数据：只有登录后才接真实服务。
    // 未登录时指向本地（请求会被 204 掉），播放器就按「本地形式运行」，不会卡住作品。
    if (this.user) {
      cfg.cloud_storage_api = cfg.cloud_storage_api || OFFICIAL_CLOUD_API;
      cfg.wss_cloud_storage_api = cfg.wss_cloud_storage_api || OFFICIAL_CLOUD_WSS;
    } else {
      cfg.cloud_storage_api = this.origin;
      cfg.wss_cloud_storage_api = '';
    }
    return cfg;
  }

  /**
   * 返回播放器页面，并把「当前作品号 / 是否登录」注入进去。
   * 页面侧靠这两个值把云数据积木接到真实服务（见 src/player/cloud.js）。
   */
  sendPlayerPage(res, cors) {
    let html;
    try {
      html = fs.readFileSync(path.join(this.playerDir, 'page.html'), 'utf8');
    } catch (_) {
      res.writeHead(404, cors);
      return res.end('not found');
    }
    const boot = '<script>window.__K4P_WORK_ID=' + JSON.stringify(this.workId || '')
      + ';window.__K4P_LOGGED_IN=' + (this.user ? 'true' : 'false') + ';</script>';
    html = html.replace('<!--K4P_INJECT-->', boot);
    res.writeHead(200, { ...cors, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  workInfo(id) {
    const p = this.project;
    const meta = { ...(p && p.meta ? p.meta : {}) };
    return {
      id: Number(id) || id,
      name: meta.title || (p ? p.name : '作品'),
      preview: '',
      author_nickname: '',
      author_id: 0,
      work_name: meta.title || (p ? p.name : '作品'),
      source_urls: [this.playerUrl],
      is_bcmc: true,
      ide_type: 'KITTEN',
      version: '4.11.20',
      updated_time: Math.floor(Date.now() / 1000),
      extra_info: { author_nickname: '', author_id: 0, preview: '' },
    };
  }

  sendFile(res, file, cors, extra) {
    let stat;
    try { stat = fs.statSync(file); } catch (_) {
      res.writeHead(404, cors);
      return res.end('not found');
    }
    res.writeHead(200, {
      ...cors,
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      // 本地资源一律不缓存：改一下 bundle 做实验时必须立即生效
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      ...(extra || {}),
    });
    if (extra && extra['Content-Type'] && extra['Content-Type'].includes('html')) {
      return res.end(fs.readFileSync(file));
    }
    fs.createReadStream(file).pipe(res);
  }

  /** 本地缺失资源回源到官方 CDN（联网时保持图标/字体正常） */
  fallback(url, cors, res) {
    if (!this.allowCdnFallback) {
      res.writeHead(404, cors);
      return res.end('not found');
    }
    const target = 'https://kn-cdn.codemao.cn' + url;
    const lib = target.startsWith('https') ? require('https') : require('http');
    const req = lib.get(target, { headers: { 'User-Agent': 'kitten4-player' }, timeout: 3000 }, (r) => {
      if (!r.statusCode || r.statusCode >= 400) {
        res.writeHead(404, cors);
        return res.end('not found');
      }
      res.writeHead(200, {
        ...cors,
        'Content-Type': r.headers['content-type'] || 'application/octet-stream',
      });
      r.pipe(res);
    });
    req.on('error', () => {
      res.writeHead(404, cors);
      res.end('not found');
    });
    req.on('timeout', () => { req.destroy(); });
  }
}

function ff(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

module.exports = { PlayerServer };
