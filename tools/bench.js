'use strict';
/**
 * 阶段 0 基准工具：跑一个 .bcm4，采 5~15 秒，输出「脚本 / 渲染 / GC / 其它」占比 + 帧率 + 热点函数。
 *
 * 用法：
 *   node tools/bench.js <作品.bcm4> [--ms=12000] [--port=9351] [--dev]
 *
 * 产物：_bench/last.json（原始数据） + _bench/last.txt（可读报告）
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE_DIR = path.join(ROOT, 'dist', 'Kitten4播放器');
const EXE = path.join(EXE_DIR, 'Kitten4播放器.exe');

const args = process.argv.slice(2);
const opt = { ms: 12000, port: 9351, dev: false, out: 'last' };
let project = '';
for (const a of args) {
  if (a.startsWith('--ms=')) opt.ms = Number(a.slice(5));
  else if (a.startsWith('--port=')) opt.port = Number(a.slice(7));
  else if (a.startsWith('--out=')) opt.out = a.slice(6);
  else if (a.startsWith('--eval=')) opt.evalStr = a.slice(7);
  else if (a.startsWith('--shot=')) opt.shot = a.slice(7);
  else if (a.startsWith('--inject=')) opt.inject = a.slice(9);
  else if (a === '--dev') opt.dev = true;
  else if (a.startsWith('--')) { /* ignore */ }
  else project = a;
}
if (!project) {
  console.error('用法: node tools/bench.js <作品.bcm4> [--ms=12000] [--dev]');
  process.exit(1);
}
project = path.resolve(project);
if (!fs.existsSync(project)) { console.error('文件不存在:', project); process.exit(1); }

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

function rpcClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pend = new Map();
  ws.onmessage = (ev) => {
    const d = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  };
  const ready = new Promise((r) => (ws.onopen = r));
  return {
    ready,
    send: (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); }),
    close: () => { try { ws.close(); } catch (_) {} },
  };
}

const INJECT = `(() => {
  const b = window.__k4bench = window.__k4bench || { frames: [], last: 0, long: 0 };
  if (!b.hooked) {
    b.hooked = true;
    const loop = (t) => {
      if (b.last) b.frames.push(t - b.last);
      b.last = t;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) b.long += e.duration; }).observe({ entryTypes: ['longtask'] });
    } catch (e) {}
  }
  return true;
})()`;

const SUMMARY = `(() => {
  const b = window.__k4bench || { frames: [] };
  const f = (b.frames || []).slice().sort((x, y) => x - y);
  const q = (p) => f.length ? f[Math.min(f.length - 1, Math.floor(f.length * p))] : 0;
  return JSON.stringify({
    frames: f.length,
    p50: q(0.5), p95: q(0.95), max: f.length ? f[f.length - 1] : 0,
    longtask_ms: b.long || 0
  });
})()`;

function classify(frame) {
  const fn = frame.functionName || '';
  const url = frame.url || '';
  if (fn === '(garbage collector)') return 'gc';
  if (fn === '(idle)' || fn === '(root)') return 'idle';
  if (/optifun|step_|do_step|interpreter|compile_/i.test(fn)) return 'script';
  if (/pixi|webgl|draw|render|batch|shader|texture|sprite|canvas|measuretext|filltext|stroketext|drawimage|getcontext|putimagedata|updatetext|^scale$/i.test(fn)) return 'render';
  return null; // 未知：继续往调用栈上面找归属
}

function aggregate(profile) {
  const byNodeId = new Map();
  for (const n of profile.nodes) byNodeId.set(n.id, n);

  // 调用栈父子关系（CDP 用 children 表达）
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);

  const catCache = new Map();
  const catOf = (nid) => {
    if (catCache.has(nid)) return catCache.get(nid);
    let cur = nid;
    let hops = 0;
    let out = null;
    while (cur != null && hops++ < 400) {
      const n = byNodeId.get(cur);
      if (!n) break;
      const c = classify(n.callFrame);
      if (c && c !== 'other') { out = c; break; }
      cur = parent.get(cur);
    }
    catCache.set(nid, out);
    return out;
  };

  const self = new Map();
  const sampleCat = new Map();
  const deltas = profile.timeDeltas || [];
  for (let i = 0; i < profile.samples.length; i++) {
    const nid = profile.samples[i];
    const dt = deltas[i] || 0;
    self.set(nid, (self.get(nid) || 0) + dt);
    sampleCat.set(nid, (sampleCat.get(nid) || 0) + dt);
  }

  // 按调用栈归属：样本算在最靠近的已知祖先（脚本 / 渲染 / GC / 空闲）名下
  const buckets = {};
  for (const [nid, us] of sampleCat) {
    const k = catOf(nid) || 'other';
    buckets[k] = (buckets[k] || 0) + us / 1000;
  }

  const rows = [];
  let total = 0;
  for (const [nid, us] of self) {
    const n = byNodeId.get(nid);
    if (!n) continue;
    const cf = n.callFrame;
    const ms = us / 1000;
    total += ms;
    rows.push({
      fn: cf.functionName || '(anonymous)',
      url: (cf.url || '').replace(/^.*\//, ''),
      line: cf.lineNumber,
      ms,
      bucket: catOf(nid) || 'other',
    });
  }

  const byKey = new Map();
  for (const r of rows) {
    const k = r.fn + ' @ ' + r.url + ':' + r.line;
    const cur = byKey.get(k) || { ...r, ms: 0 };
    cur.ms += r.ms;
    byKey.set(k, cur);
  }
  const merged = [...byKey.values()].sort((a, b) => b.ms - a.ms);
  return { merged, buckets, total };
}

(async () => {
  let child;
  if (opt.dev) {
    child = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
      [ROOT, project, '--remote-debugging-port=' + opt.port], { cwd: ROOT, env, stdio: 'ignore' });
  } else {
    if (!fs.existsSync(EXE)) throw new Error('未找到打包版，先跑 node tools/build_portable.js，或加 --dev');
    child = spawn(EXE, [project, '--remote-debugging-port=' + opt.port], { cwd: EXE_DIR, env, stdio: 'ignore' });
  }
  console.log('启动 pid=' + child.pid + (opt.dev ? '（dev）' : '（打包版）'));

  let page = null;
  for (let k = 0; k < 120; k++) {
    await sleep(500);
    let list;
    try { list = await httpJson('/json/list'); } catch (e) { continue; }
    page = (list || []).find((t) => t.type === 'page' && /127\.0\.0\.1|player/i.test(t.url));
    if (page) break;
  }
  if (!page) throw new Error('播放器页面没起来');
  console.log('播放器页面:', page.url.slice(0, 90));

  const c = rpcClient(page.webSocketDebuggerUrl);
  await c.ready;

  // 编译后页面会 reload 一次，所以钩子必须用 addScriptToEvaluateOnNewDocument 注入，
  // 否则重载后 window.__k4bench 丢失、采到 0 帧。注入后主动重载一次让钩子生效。
  await c.send('Page.enable');
  let early = INJECT;
  if (opt.inject) early = fs.readFileSync(path.resolve(opt.inject), 'utf8') + '\n' + early;
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: early });
  await c.send('Page.reload');
  await sleep(2000);

  // 等真正开跑：帧率稳定下来（作品首帧要加载图片资源，可能 10~20s）
  await c.send('Runtime.evaluate', { expression: INJECT });
  let warm = 0;
  for (let k = 0; k < 90; k++) {
    await sleep(1000);
    const s = await c.send('Runtime.evaluate', { expression: SUMMARY, returnByValue: true });
    const o = JSON.parse((s.result && s.result.result && s.result.result.value) || '{}');
    process.stdout.write('  预热 ' + (k + 1) + 's  frames=' + o.frames + ' p50=' + (o.p50 || 0).toFixed(1) + 'ms\r');
    if (o.frames > 60) { warm++; if (warm >= 3) break; } else warm = 0;
  }
  console.log('\n开始采样 ' + opt.ms + 'ms');

  await c.send('Performance.enable');
  await c.send('Profiler.enable');
  await c.send('Profiler.setSamplingInterval', { interval: 200 });
  await c.send('Runtime.evaluate', { expression: 'window.__k4bench.frames = []; window.__k4bench.long = 0; true' });
  const m0 = await c.send('Performance.getMetrics');
  await c.send('Profiler.start');
  await sleep(opt.ms);
  const prof = await c.send('Profiler.stop');
  const m1 = await c.send('Performance.getMetrics');
  const sum = await c.send('Runtime.evaluate', { expression: SUMMARY, returnByValue: true });

  const frames = JSON.parse(sum.result.result.value || '{}');
  const met = (m) => Object.fromEntries(((m.result && m.result.metrics) || []).map((x) => [x.name, x.value]));
  const a = met(m0), b = met(m1);
  const delta = (k) => ((b[k] || 0) - (a[k] || 0)) * 1000; // ms

  const agg = aggregate(prof.result.profile);
  const dur = agg.total || 1;
  const pct = (x) => ((x / dur) * 100).toFixed(1) + '%';

  const lines = [];
  lines.push('== Kitten4 播放器基准 ==');
  lines.push('作品: ' + project);
  lines.push('采样: ' + opt.ms + 'ms   有效帧: ' + (frames.frames || 0) + '   ≈' + ((frames.frames || 0) / (opt.ms / 1000)).toFixed(1) + ' fps');
  lines.push('帧间隔: p50 ' + (frames.p50 || 0).toFixed(1) + 'ms   p95 ' + (frames.p95 || 0).toFixed(1) + 'ms   max ' + (frames.max || 0).toFixed(1) + 'ms');
  lines.push('');
  lines.push('-- 主线程时间构成（按调用栈归属，总计 ' + dur.toFixed(0) + 'ms）--');
  const order = ['script', 'render', 'gc', 'other', 'idle'];
  const label = { script: '积木脚本执行', render: '渲染相关', gc: 'GC', other: '未归类', idle: '空闲' };
  for (const k of order) {
    const v = agg.buckets[k] || 0;
    lines.push('  ' + (label[k] + '            ').slice(0, 14) + pad(v.toFixed(0), 7) + 'ms  ' + pad(pct(v), 7));
  }
  const nf = frames.frames || 1;
  lines.push('  每帧脚本耗时 ≈ ' + ((agg.buckets.script || 0) / nf).toFixed(2) + 'ms   每帧总耗时 ≈ ' + (dur / nf).toFixed(2) + 'ms');
  lines.push('');
  lines.push('-- 浏览器计数器（同一时间段）--');
  lines.push('  TaskDuration        ' + pad(delta('TaskDuration').toFixed(0), 8) + 'ms');
  lines.push('  ScriptDuration      ' + pad(delta('ScriptDuration').toFixed(0), 8) + 'ms');
  lines.push('  LayoutDuration      ' + pad(delta('LayoutDuration').toFixed(2), 8) + 'ms');
  lines.push('  RecalcStyleDuration ' + pad(delta('RecalcStyleDuration').toFixed(2), 8) + 'ms');
  lines.push('  脚本/Task 占比       ' + (delta('TaskDuration') > 0 ? (delta('ScriptDuration') / delta('TaskDuration') * 100).toFixed(1) + '%' : 'n/a'));
  lines.push('  脚本负载(每秒)       ' + (delta('ScriptDuration') / (opt.ms / 1000)).toFixed(3) + '   ← 1.000 = 主线程 100% 在跑 JS，跨运行最稳的比较指标');
  lines.push('');
  lines.push('-- 热点函数 Top 25 --');
  for (const r of agg.merged.slice(0, 25)) {
    lines.push('  ' + pad(r.ms.toFixed(0) + 'ms', 8) + pad(pct(r.ms), 7) + '  ' + ('[' + r.bucket + ']').padEnd(10) + r.fn + '  @ ' + r.url + ':' + r.line);
  }

  let probe = null;
  if (opt.shot) {
    const s = await c.send('Page.captureScreenshot', { format: 'png' });
    const b64 = s.result && s.result.data;
    if (b64) {
      const p = path.join(ROOT, '_bench', opt.shot + '.png');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, Buffer.from(b64, 'base64'));
      lines.push('');
      lines.push('-- 截图 --');
      lines.push('  ' + p);
    }
  }
  if (opt.evalStr) {
    const r = await c.send('Runtime.evaluate', { expression: opt.evalStr, returnByValue: true });
    probe = (r.result && r.result.result && r.result.result.value) || (r.result && r.result.exceptionDetails ? 'ERR ' + JSON.stringify(r.result.exceptionDetails).slice(0, 200) : null);
    lines.push('');
    lines.push('-- 自定义探针 --');
    lines.push('  ' + String(probe).slice(0, 3000));
  }

  const outDir = path.join(ROOT, '_bench');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, opt.out + '.txt'), lines.join('\n'), 'utf8');
  fs.writeFileSync(path.join(outDir, opt.out + '.cpuprofile'), JSON.stringify(prof.result.profile), 'utf8');
  fs.writeFileSync(path.join(outDir, opt.out + '.json'), JSON.stringify({
    project, ms: opt.ms, frames, counters: { m0: a, m1: b }, buckets: agg.buckets, total: agg.total, hot: agg.merged.slice(0, 80),
  }, null, 2), 'utf8');

  console.log('\n' + lines.join('\n'));
  console.log('\n报告已写入 _bench/' + opt.out + '.txt');

  try { child.kill(); } catch (e) {}
  setTimeout(() => process.exit(0), 300);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });

function pad(s, n) { s = String(s); while (s.length < n) s = ' ' + s; return s; }
