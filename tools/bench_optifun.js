'use strict';
/**
 * optifun 骨架微基准
 *
 * 生成代码的主循环 `optifun` 不干游戏的事，只做 switch 派发和 pc 写回。这个脚本用
 * 真实生成代码的形态合成源码，量出几种骨架改写的每次遍历耗时——**不带游戏负载，
 * 因此可以跨运行比较**（端到端 fps 在 florr 上每次启动都不同，没法用来衡量）。
 *
 * 用法：
 *   node tools/bench_optifun.js [块数=300] [每轮次数=30000] [轮数=5]
 *
 * 形态来源：`src/player/compile.js` 的 transformOptifun()（阶段 3b）。
 * 官方原始形态来自 player_v2 的 compile_repeat_forever 代码路径。
 */

const N = Number(process.argv[2] || 300);
const ROUNDS = Number(process.argv[3] || 30000);
const REPS = Number(process.argv[4] || 5);

const ID = 'Nx6Iw8koiIbMK3ILVkhQ';
const RB = 'b5e60282-a2d1-478b-802d-a30e77d67e6b';
const ENT = 'zL4vpEYv3iH8iYeeys1M';

/** 官方原始形态：EB/ED 还是方法调用 */
function buildRaw(n) {
  const out = ['return function optifun(X) {switch (X.DB[0]) {', 'case 0: '];
  let pc = 0;
  for (let i = 0; i < n; i++) {
    const d = 'X.DA[' + (i + 1) + ']';
    pc++;
    out.push("if (X.EB('" + ID + "', '" + RB + "', '" + ENT + "', 0, " + pc + ')) { return; }case ' + pc + ': ');
    pc++;
    out.push(d + ' = {};');
    out.push("X.ED('" + RB + "', '" + ENT + "', 0, " + pc + '); case ' + pc + ': ');
    pc++;
    out.push(d + "['state'] = \"hide\";");
    out.push("X.ED('" + RB + "', '" + ENT + "', 0, " + pc + '); case ' + pc + ': ');
    pc++;
    out.push(d + "['color'] = X.BC[1];");
    pc++;
    out.push("X.ED('" + RB + "', '" + ENT + "', 0, " + pc + '); case ' + pc + ': ');
    pc++;
    out.push("X.AB('10', 161, '" + ID + "', " + d + ', X.BA);');
    out.push("if (X.EC('" + ID + "', '" + RB + "', '" + ENT + "', 0, " + pc + ')) { return; }case ' + pc + ': ');
    pc++;
    out.push(d + ';');
    pc++;
    out.push('X.DB[0]=' + pc + ';case ' + pc + ': ');
  }
  out.push('X.EG();}}');
  return out.join('');
}

/** 改写后的形态：o = { collapse, dropDa, hoist } */
function buildPatched(n, o) {
  const body = [];
  const dref = o.hoist ? 'DB' : 'X.DB';
  const aref = o.hoist ? 'DA' : 'X.DA';
  const cref = o.hoist ? 'BC' : 'X.BC';
  const bref = o.hoist ? 'BA' : 'X.BA';
  body.push('case 0: ');
  let pc = 0;
  const pcw = (m) => body.push(dref + '[0]=' + m + ';case ' + m + ': ');
  for (let i = 0; i < n; i++) {
    const d = aref + '[' + (i + 1) + ']';
    if (o.collapse) {
      pc += 3;
      pcw(pc);
    } else {
      pcw(pc + 1); pc++;
      pcw(pc + 1); pc++;
      pcw(pc + 1); pc++;
    }
    body.push(d + ' = {};');
    pcw(pc + 1); pc++;
    body.push(d + "['state'] = \"hide\";");
    pcw(pc + 1); pc++;
    body.push(d + "['color'] = " + cref + '[1];');
    if (o.collapse) { pc++; pcw(pc); } else { pcw(pc + 1); pc++; }
    body.push("X.AB('10', 161, '" + ID + "', " + d + ', ' + bref + ');');
    body.push("if (X.EC('" + ID + "', '" + RB + "', '" + ENT + "', 0, " + pc + ')) { return; }case ' + pc + ': ');
    pc++;
    if (!o.dropDa) body.push(d + ';');
    pcw(pc + 1); pc++;
  }
  const head = 'return function optifun(X) {' + (o.hoist ? 'var DB=X.DB,DA=X.DA,BC=X.BC,BA=X.BA;' : '') + 'switch (X.DB[0]) {';
  body.push('X.EG();}}');
  return head + body.join('');
}

function makeX() {
  return {
    DB: [0],
    DA: new Array(64).fill(0),
    BC: [1, 2, 3, 4],
    BA: ENT,
    AB: function () {},
    EC: function () { return false; },
    EB: function () { return false; },
    ED: function () {},
    EG: function () { this.done = 1; },
  };
}

function benchOnce(fn) {
  const X = makeX();
  for (let i = 0; i < 300; i++) { X.DB[0] = 0; fn(X); }
  const t0 = process.hrtime.bigint();
  for (let r = 0; r < ROUNDS; r++) { X.DB[0] = 0; fn(X); }
  return Number(process.hrtime.bigint() - t0) / 1e6 / ROUNDS;
}

const variants = [
  ['官方原始', buildRaw(N)],
  ['内联 EB/ED', buildPatched(N, {})],
  ['+折叠空骨架', buildPatched(N, { collapse: true })],
  ['+折叠+提局部', buildPatched(N, { collapse: true, hoist: true })],
  ['+折叠+去裸读+提局部', buildPatched(N, { collapse: true, dropDa: true, hoist: true })],
];

const fns = variants.map(([name, src]) => {
  let fn = null;
  try { fn = new Function(src + '\n//# sourceURL=k4p-bench.js')(); }
  catch (e) { console.log(name, 'SYNTAX', e.message); }
  return { name, fn, lenKB: Math.round(src.length / 1024) };
});

const samples = fns.map(() => []);
for (let r = 0; r < REPS; r++) {
  fns.forEach((f, i) => { if (f.fn) samples[i].push(benchOnce(f.fn)); });
}

const base = Math.min.apply(null, samples[0]);
console.log('块数 ' + N + '，' + ROUNDS + ' 次 × ' + REPS + ' 轮（取最小）');
fns.forEach((f, i) => {
  const arr = samples[i].slice().sort((a, b) => a - b);
  if (!arr.length) return;
  const min = arr[0], med = arr[Math.floor(arr.length / 2)];
  console.log(
    f.name.padEnd(22),
    'min ' + min.toFixed(3) + 'ms  中位 ' + med.toFixed(3) + 'ms  ' +
    '相对官方 ' + (((base / min) - 1) * 100).toFixed(1) + '%  ' + f.lenKB + 'KB'
  );
});
