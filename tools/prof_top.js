'use strict';
/**
 * cpuprofile 自时间汇总。
 * 用法：node tools/prof_top.js _bench/x.cpuprofile [topN] [--filter=正则]
 */
const fs = require('fs');

const file = process.argv[2];
const topN = Number(process.argv[3] || 25);
const filt = (process.argv.find((a) => a.startsWith('--filter=')) || '').slice(9);
const re = filt ? new RegExp(filt) : null;

const p = JSON.parse(fs.readFileSync(file, 'utf8'));
const byId = new Map();
for (const n of p.nodes) byId.set(n.id, n);

// 自时间：按 samples/timeDeltas 累计到 sample 所属节点
const self = new Map();
const total = new Map();
let sum = 0;
const dt = p.timeDeltas || [];
for (let i = 0; i < p.samples.length; i++) {
  const id = p.samples[i];
  const d = dt[i] || 0;
  sum += d;
  self.set(id, (self.get(id) || 0) + d);
}

const label = (n) => {
  const f = n.callFrame || {};
  let u = f.url || '';
  u = u.replace(/^file:.*?\/build\//, '').replace(/^https?:.*?\//, '');
  return (f.functionName || '(anon)') + ' @ ' + (u || '(v8)') + ':' + (f.lineNumber >= 0 ? f.lineNumber : '?');
};

const agg = new Map();
for (const [id, us] of self) {
  const n = byId.get(id);
  if (!n) continue;
  const k = label(n);
  if (re && !re.test(k)) continue;
  agg.set(k, (agg.get(k) || 0) + us);
}

const rows = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
const ms = (us) => (us / 1000).toFixed(1);
console.log('总采样 ' + (sum / 1000).toFixed(0) + ' ms，' + p.samples.length + ' samples，' + p.nodes.length + ' nodes');
console.log('');
console.log('自时间 Top ' + topN + (filt ? '（过滤 ' + filt + '）' : ''));
for (const [k, us] of rows) {
  console.log(String(ms(us)).padStart(9) + ' ms  ' + ((us / sum) * 100).toFixed(1).padStart(5) + '%  ' + k);
}

// 按 url 归类
const byUrl = new Map();
for (const [k, us] of agg) {
  const u = k.split(' @ ')[1] || '';
  byUrl.set(u, (byUrl.get(u) || 0) + us);
}
console.log('');
console.log('按文件');
for (const [u, us] of [...byUrl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(String(ms(us)).padStart(9) + ' ms  ' + u);
}

// --stacks：按「包括子调用」的总时间输出调用路径
if (process.argv.includes('--stacks')) {
  const parent = new Map();
  for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const tot = new Map();
  for (const [id, us] of self) {
    let cur = id;
    const seen = new Set();
    while (cur != null && !seen.has(cur)) {
      seen.add(cur);
      tot.set(cur, (tot.get(cur) || 0) + us);
      cur = parent.get(cur);
    }
  }
  const top = [...tot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  console.log('\n== 调用路径（总时间）==');
  for (const [id, us] of top) {
    const chain = [];
    let cur = id;
    for (let i = 0; i < 7 && cur != null; i++, cur = parent.get(cur)) {
      const n = byId.get(cur);
      if (n) chain.push((n.callFrame.functionName || '(anon)') + ':' + (n.callFrame.lineNumber >= 0 ? n.callFrame.lineNumber : '?'));
    }
    console.log(String(ms(us)).padStart(9) + ' ms  ' + chain.join('  <  '));
  }
}

// --kids=函数名：列出该函数各直接子调用的总时间
{
  const target = (process.argv.find((a) => a.startsWith('--kids=')) || '').slice(7);
  if (target) {
    const parent = new Map();
    for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
    const tot = new Map();
    for (const [id, us] of self) {
      let cur = id; const seen = new Set();
      while (cur != null && !seen.has(cur)) { seen.add(cur); tot.set(cur, (tot.get(cur) || 0) + us); cur = parent.get(cur); }
    }
    const targets = p.nodes.filter((n) => (n.callFrame.functionName || '') === target);
    console.log('\n== ' + target + ' 的子调用（总 ' + targets.length + ' 个实例）==');
    const merged = new Map();
    for (const t of targets) {
      for (const cid of t.children || []) {
        const c = byId.get(cid); if (!c) continue;
        const k = (c.callFrame.functionName || '(anon)');
        merged.set(k, (merged.get(k) || 0) + (tot.get(cid) || 0));
      }
      merged.set('<self>', (merged.get('<self>') || 0) + (self.get(t.id) || 0));
    }
    for (const [k, us] of [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(String(ms(us)).padStart(9) + ' ms  ' + k);
    }
  }
}
