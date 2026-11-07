'use strict';
/**
 * 通用探针：启动播放器 + 在页面上下文执行一段 JS，打印结果。
 * 用于调试播放器内核（拿 webpack 模块、调内置编译器、读运行时状态）。
 *
 * 用法：
 *   node tools/probe.js <作品.bcm4> [--dev] [--port=9360] [--wait=14000]
 *                       [--expr="..."] [--file=path/to.js] [--frame=0]
 *                       [--inject=path/to.js] [--reload]
 *
 * 说明：--file 里的代码会被包成 `(async()=>{ ... })()` 执行，支持 await。
 *      --inject 的代码在「每个新文档创建前」执行（用于 hook XHR / 打时序日志），
 *      配合 --reload 可以观察播放器从零加载的完整过程。
 *      --frame=N 选择第 N 个 page 目标（0 = 主框架）。
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'Kitten4播放器', 'Kitten4播放器.exe');

const args = process.argv.slice(2);
const opt = { port: 9360, wait: 14000, dev: false, frame: 0 };
let project = '';
for (const a of args) {
  if (a.startsWith('--port=')) opt.port = Number(a.slice(7));
  else if (a.startsWith('--wait=')) opt.wait = Number(a.slice(7));
  else if (a.startsWith('--expr=')) opt.expr = a.slice(7);
  else if (a.startsWith('--file=')) opt.file = a.slice(7);
  else if (a.startsWith('--inject=')) opt.inject = a.slice(9);
  else if (a === '--reload') opt.reload = true;
  else if (a === '--attach') opt.attach = true;
  else if (a.startsWith('--frame=')) opt.frame = Number(a.slice(8));
  else if (a.startsWith('--shot=')) opt.shot = a.slice(7);
  else if (a.startsWith('--out=')) opt.out = a.slice(6);
  else if (a === '--dev') opt.dev = true;
  else if (!a.startsWith('--')) project = a;
}
if (!opt.expr && !opt.file) {
  console.error('需要 --expr= 或 --file=');
  process.exit(1);
}
const code = opt.file ? fs.readFileSync(path.resolve(opt.file), 'utf8') : opt.expr;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(p) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port: opt.port, path: p }, (r) => {
      let b = '';
      r.on('data', (d) => (b += d));
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    });
    req.on('error', rej);
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
  });
}

function rpc(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pend = new Map();
  ws.onmessage = (ev) => {
    const d = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
    if (d.method && onEvent) { try { onEvent(d); } catch (_) {} }
  };
  const ready = new Promise((r) => (ws.onopen = r));
  return {
    ready,
    send: (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); }),
    close: () => { try { ws.close(); } catch (_) {} },
  };
}

async function waitTargets() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await httpJson('/json/list');
      const pages = list.filter((x) => x.type === 'page');
      if (pages.length) return pages;
    } catch (_) { /* 端口还没起来 */ }
    await sleep(300);
  }
  throw new Error('等不到 CDP 目标');
}

(async () => {
  let child = null;
  try {
    const cur = await httpJson('/json/list').catch(() => null);
    if (!cur) throw new Error('no-instance');
  } catch (_) { /* 没有在跑的实例，自己起一个 */ }

  const argv = opt.dev
    ? [path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', project || '', '--remote-debugging-port=' + opt.port]]
    : [EXE, [project || '', '--remote-debugging-port=' + opt.port]];

  if (!opt.attach) {
    child = spawn(argv[0], argv[1], {
      cwd: opt.dev ? ROOT : path.dirname(EXE),
      env,
      stdio: 'ignore',
      detached: false,
    });
  }

  const pages = await waitTargets();
  const target = pages[Math.min(opt.frame, pages.length - 1)];
  const consEvents = [];
  const c = rpc(target.webSocketDebuggerUrl, (d) => {
    if (d.method === 'Runtime.consoleAPICalled') {
      const p = d.params || {};
      const txt = (p.args || []).map((a) => {
        if (a.value !== undefined) return String(a.value);
        if (a.description) return String(a.description).split('\n').slice(0, 3).join(' | ');
        return '<' + a.type + '>';
      }).join(' ').slice(0, 700);
      consEvents.push(p.type + ': ' + txt);
    } else if (d.method === 'Runtime.exceptionThrown') {
      const ex = (d.params || {}).exceptionDetails || {};
      const desc = (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text || '';
      consEvents.push('EXCEPTION: ' + String(desc).split('\n').slice(0, 4).join(' | ').slice(0, 700));
    }
  });
  await c.ready;
  await c.send('Runtime.enable');
  await c.send('Log.enable').catch(() => {});
  if (opt.inject) {
    await c.send('Page.enable');
    const injectCode = fs.readFileSync(path.resolve(opt.inject), 'utf8');
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: injectCode });
    await c.send('Page.reload', { ignoreCache: true });
  }
  await sleep(opt.wait);

  const res = await c.send('Runtime.evaluate', {
    expression: `(async()=>{${code}})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const v = res.result && res.result.result;
  if (opt.out) {
    const txt = v && v.value !== undefined ? (typeof v.value === 'string' ? v.value : JSON.stringify(v.value)) : '';
    const outPath = path.resolve(opt.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, txt, 'utf8');
    console.log('已写入 ' + txt.length + ' 字节 ->', outPath);
  } else if (v && v.subtype === 'error') {
    console.log('页面内异常：', JSON.stringify(res.result).slice(0, 2000));
  } else if (v && v.value !== undefined) {
    console.log(typeof v.value === 'string' ? v.value : JSON.stringify(v.value, null, 1));
  } else {
    console.log(JSON.stringify(res.result).slice(0, 2000));
  }

  if (consEvents.length) {
    const seen = new Set();
    const uniq = [];
    for (const l of consEvents) {
      if (seen.has(l)) continue;
      seen.add(l);
      uniq.push(l);
    }
    console.log('-- 浏览器控制台（' + consEvents.length + ' 条，去重后 ' + uniq.length + '）--');
    for (const l of uniq.slice(-45)) console.log('  ' + l);
  }

  if (opt.shot) {
    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    const b64 = shot.result && shot.result.data;
    if (b64) {
      const out = path.join(ROOT, '_bench', opt.shot + '.png');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(b64, 'base64'));
      console.log('截图:', out);
    }
  }
  c.close();
  try { child.kill(); } catch (_) {}
  process.exit(0);
})().catch((e) => {
  console.error('探针失败：', e.message);
  process.exit(1);
});
