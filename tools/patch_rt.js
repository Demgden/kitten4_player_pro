'use strict';
/**
 * 阶段 3：运行时热点补丁。
 *
 * 全部针对 `src/player/build/player_v2.*.js` 里**解释器自身**的开销，
 * 不改生成代码、不改作品数据。改动点：
 *
 *   1. get_list_id        线性遍历所有变量找数组 id  → WeakMap 反查缓存
 *   2. step_call_domain_function  每次 new 一个 Promise 判断 thenable → instanceof
 *   3. _wall_clock_now    performance.now 绑定一次
 *   4. step_iteration_yield  warp 每次迭代查一次时钟 → 每 64 次查一次
 *   5. 数值分派 f         原生快路径提前 + 修掉 `var r` 遮蔽 Decimal 的老 bug
 *
 * 用法：
 *   node tools/patch_rt.js apply      应用（首次会备份 .rt_orig）
 *   node tools/patch_rt.js restore    从 .rt_orig 还原
 *   node tools/patch_rt.js status     查看当前状态
 *
 * 注意：本工具作用于「已打过 patch_num」的文件；.rt_orig 保存的就是那个状态。
 */
const fs = require('fs');
const path = require('path');

const BUILD = path.join(__dirname, '..', 'src', 'player', 'build');

function findBundle() {
  const f = fs.readdirSync(BUILD).find((x) => /^player_v2\..*\.js$/.test(x));
  if (!f) throw new Error('找不到 player_v2.*.js');
  return path.join(BUILD, f);
}

const OLD_GLI =
  't.prototype.get_list_id=function(t,e){var n=this.variables;for(var i in n){if(n[i]===t&&void 0!==this.variable_specs[i]&&void 0!==this.variable_specs[i].type&&"list"==this.variable_specs[i].type)return i}var r=this.entity_variables[e];for(var i in r){if(r[i]===t&&void 0!==this.variable_specs[i]&&void 0!==this.variable_specs[i].type&&"list"==this.variable_specs[i].type)return i}}';

const NEW_GLI =
  't.prototype.get_list_id=function(t,e){' +
  // 缓存查询：命中后必须校验该 id 当前确实还指向这个数组，否则重扫（保证语义一致）
  'var C=this.__k4lidC;' +
  'if(void 0===C)this.__k4lidC=C=new WeakMap;' +
  'else if(null!=t&&"object"==typeof t){' +
  'var hk=C.get(t);' +
  'if(void 0!==hk){if(this.variables[hk]===t)return hk;var EV=this.entity_variables[e];if(EV&&EV[hk]===t)return hk}' +
  '}' +
  'var n=this.variables;for(var i in n){if(n[i]===t&&void 0!==this.variable_specs[i]&&void 0!==this.variable_specs[i].type&&"list"==this.variable_specs[i].type){if(null!=t&&"object"==typeof t)C.set(t,i);return i}}' +
  'var r=this.entity_variables[e];for(var i in r){if(r[i]===t&&void 0!==this.variable_specs[i]&&void 0!==this.variable_specs[i].type&&"list"==this.variable_specs[i].type){if(null!=t&&"object"==typeof t)C.set(t,i);return i}}}';

const OLD_PROMISE = 'if(null!=o){if(Promise.resolve(o)===o){';
const NEW_PROMISE = 'if(null!=o){if(o instanceof Promise){';

const OLD_CLOCK =
  't.prototype._wall_clock_now=function(){return"undefined"!=typeof performance&&void 0!==performance.now?performance.now():(new Date).getTime()}';
const NEW_CLOCK =
  't.prototype._wall_clock_now=window.__k4now||(window.__k4now="undefined"!=typeof performance&&void 0!==performance.now?performance.now.bind(performance):function(){return(new Date).getTime()})';

const OLD_ITER =
  'this.deterministic_mode||e||(e=this.warp_tick_start+this.warp_interpreter_millisecond_time_limit<this.run_mgr.wall_clock_now());';
const NEW_ITER =
  // 时间片精度从「每次迭代」降到「每 64 次迭代」，64 次通常远小于 0.1ms，对 5ms 时间片无感
  'this.deterministic_mode||e||0!==(this.n_warp_iterations&63)||(e=this.warp_tick_start+this.warp_interpreter_millisecond_time_limit<this.run_mgr.wall_clock_now());';

const OLD_NUM =
  'function f(t,e,n){try{if(__k4native){var w=p[n](t,e);if("number"==typeof w&&isFinite(w)){if(w>-8e3&&w<8e3){var r=Math.round(w*1e12)/1e12;if(r!==w)return r}return w}}if("DIVIDE"!==n&&"POWER"!==n&&t===(t|0)&&e===(e|0)){var q=p[n](t,e);if(q===(q|0))return q}if("DIVIDE"===n&&t===(t|0)&&e===(e|0)&&0!==e&&0===t%e)return t/e;return("ADD"!==n||i.isNumber(t)&&i.isNumber(e))&&("DIVIDE"!==n||0!==e&&"0"!==e)?_[n](new r.Decimal(t),new r.Decimal(e)):p[n](t,e)}catch(i){return p[n](t,e)}}';

const NEW_NUM =
  'function f(t,e,n){' +
  // 快路径提到 try 外面：字符串/数值运算不会抛异常，省掉 try 对内联的限制
  'if(__k4native){' +
  'var w="ADD"===n?t+e:"MINUS"===n?t-e:"MULTIPLY"===n?t*e:"DIVIDE"===n?t/e:Math.pow(t,e);' +
  'if("number"==typeof w&&w===w&&w!==1/0&&w!==-1/0){if(w>-8e3&&w<8e3){var rr=Math.round(w*1e12)/1e12;if(rr!==w)return rr}return w}' +
  // NaN / ±Infinity：decimal 算出来也是同一个值，直接返回，别为它 new 两个 Decimal
  'if("number"==typeof w)return w;' +
  '}' +
  // 慢路径仅剩 NaN / ±Infinity / 非 number 操作数。注意变量名不能再用 r —— 原来那个 var r 把
  // Decimal 构造器 r 遮蔽了，导致 decimal 分支永远抛 TypeError 走 catch，等于从未生效。
  'try{' +
  'if("DIVIDE"!==n&&"POWER"!==n&&t===(t|0)&&e===(e|0)){var q=p[n](t,e);if(q===(q|0))return q}' +
  'if("DIVIDE"===n&&t===(t|0)&&e===(e|0)&&0!==e&&0===t%e)return t/e;' +
  'return("ADD"!==n||i.isNumber(t)&&i.isNumber(e))&&("DIVIDE"!==n||0!==e&&"0"!==e)?_[n](new r.Decimal(t),new r.Decimal(e)):p[n](t,e)' +
  '}catch(x){return p[n](t,e)}}';

// --- 让出判定：绝大多数 tick 都是「没被 block、running group 没变」，直接短路 ---

const OLD_MY =
  't.prototype.must_yield=function(){return this.run_mgr.current_interpreter_must_yield(this.original_identities.interpreter_id,this.metadata.group_id)}';
const NEW_MY =
  't.prototype.must_yield=function(){' +
  'var M=this.run_mgr,G=this.original_identities.interpreter_id;' +
  'if(M.running_interpreter_was_blocked||M.running_group_changed)return M.current_interpreter_must_yield(G,this.metadata.group_id);' +
  'return M.interpreters_needing_dispose[G]!=null||!0===M.interpreters_needing_dispose_force[G]}';

const OLD_APB =
  't.prototype.step_after_potential_blocker=function(t,e,n,i,r){return this.current_frame.program_counter[i]=r,this.run_mgr.current_interpreter_must_yield(this.root_block_id,this.metadata.group_id)||this.program_state.did_proc_yield}';
const NEW_APB =
  't.prototype.step_after_potential_blocker=function(t,e,n,i,r){' +
  'this.current_frame.program_counter[i]=r;' +
  'var M=this.run_mgr;' +
  'if(M.running_interpreter_was_blocked||M.running_group_changed)return M.current_interpreter_must_yield(this.root_block_id,this.metadata.group_id)||this.program_state.did_proc_yield;' +
  'var G=this.root_block_id;' +
  'if(M.interpreters_needing_dispose[G]!=null||!0===M.interpreters_needing_dispose_force[G])return!0;' +
  'return this.program_state.did_proc_yield}';

const OLD_GVL_TAIL = 'return null==this.variables[t]&&(this.variables[t]=e),this.variables[t]}';
const NEW_GVL_TAIL = 'var K=this.variables[t];return null==K&&(K=e,this.variables[t]=e),K}';

const PATCHES = [
  { name: 'get_list_id 缓存反查', old: OLD_GLI, new: NEW_GLI, tag: '__k4lidC' },
  { name: '域函数调用去 Promise 分配', old: OLD_PROMISE, new: NEW_PROMISE, tag: 'o instanceof Promise' },
  { name: '时钟绑定一次', old: OLD_CLOCK, new: NEW_CLOCK, tag: '__k4now' },
  { name: 'warp 时钟降频 1/64', old: OLD_ITER, new: NEW_ITER, tag: 'this.n_warp_iterations&63' },
  { name: '数值分派快路径', old: OLD_NUM, new: NEW_NUM, tag: 'w!==1/0' },
  { name: '让出判定短路（must_yield）', old: OLD_MY, new: NEW_MY, tag: 'M.interpreters_needing_dispose[G]' },
  { name: '让出判定短路（after_potential_blocker）', old: OLD_APB, new: NEW_APB, tag: 'var G=this.root_block_id' },
  { name: '变量读取去重复查表', old: OLD_GVL_TAIL, new: NEW_GVL_TAIL, tag: 'var K=this.variables[t]' },
];

function status() {
  const file = findBundle();
  const src = fs.readFileSync(file, 'utf8');
  const rows = PATCHES.map((p) => ({
    name: p.name,
    applied: src.includes(p.tag),
  }));
  const exists = fs.existsSync(file + '.rt_orig');
  return { file: path.basename(file), backup: exists, rows };
}

function apply() {
  const file = findBundle();
  if (!fs.existsSync(file + '.rt_orig')) fs.copyFileSync(file, file + '.rt_orig');
  let src = fs.readFileSync(file, 'utf8');
  const done = [];
  const skipped = [];
  for (const p of PATCHES) {
    if (src.includes(p.tag)) { skipped.push(p.name); continue; }
    const n = src.split(p.old).length - 1;
    if (n !== 1) throw new Error(`锚点不唯一：${p.name}（命中 ${n} 次）`);
    src = src.replace(p.old, p.new);
    done.push(p.name);
  }
  fs.writeFileSync(file, src, 'utf8');
  return { done, skipped, size: src.length };
}

function restore() {
  const file = findBundle();
  if (!fs.existsSync(file + '.rt_orig')) throw new Error('没有 .rt_orig 备份，无需还原');
  fs.copyFileSync(file + '.rt_orig', file);
  return { restored: true, size: fs.statSync(file).size };
}

const cmd = process.argv[2] || 'status';
try {
  if (cmd === 'apply') {
    const r = apply();
    console.log('已应用:', r.done.length ? r.done.join('、') : '（无）');
    if (r.skipped.length) console.log('已存在跳过:', r.skipped.join('、'));
    console.log('文件大小:', (r.size / 1048576).toFixed(2), 'MB');
  } else if (cmd === 'restore') {
    console.log('已还原', JSON.stringify(restore()));
  } else {
    const st = status();
    console.log('文件:', st.file, '| 备份:', st.backup ? '有' : '无');
    for (const r of st.rows) console.log(' ', r.applied ? '✓' : '✗', r.name);
  }
} catch (e) {
  console.error('失败:', e.message);
  process.exit(1);
}
