'use strict';
/**
 * 实验用：改写播放器里数学积木的数值实现，验证 decimal 到底走没走。
 *   node tools/patch_decimal.js count     # 两套实现都埋计数器
 *   node tools/patch_decimal.js native    # MINUS/MULTIPLY 也走原生 number（A/B 测速，语义不等价）
 *   node tools/patch_decimal.js restore   # 还原
 *
 * 原文件备份为 <bundle>.orig，restore 时覆盖回去。
 */
const fs = require('fs');
const path = require('path');

const BUILD = path.join(__dirname, '..', 'src', 'player', 'build');

// 1) decimal 分派器：ADD 且两操作数都是 number 才走原生，其余走 Decimal
const DEC_ORIG =
  'function f(t,e,n){try{return("ADD"!==n||i.isNumber(t)&&i.isNumber(e))&&("DIVIDE"!==n||0!==e&&"0"!==e)?_[n](new r.Decimal(t),new r.Decimal(e)):p[n](t,e)}catch(i){return p[n](t,e)}}';
const DEC_COUNT =
  'function f(t,e,n){try{var C=(window.__k4dec=window.__k4dec||{dec:0,nat:0,ops:{}});C.ops[n]=C.ops[n]||{dec:0,nat:0};if(("ADD"!==n||i.isNumber(t)&&i.isNumber(e))&&("DIVIDE"!==n||0!==e&&"0"!==e)){C.dec++;C.ops[n].dec++;return _[n](new r.Decimal(t),new r.Decimal(e))}else{C.nat++;C.ops[n].nat++;return p[n](t,e)}}catch(i){return p[n](t,e)}}';
const DEC_NATIVE =
  'function f(t,e,n){try{if("ADD"!==n&&"DIVIDE"!==n&&i.isNumber(t)&&i.isNumber(e)){var q=p[n](t,e);if("number"==typeof q&&isFinite(q)&&Math.abs(q)<9007199254740992)return q}return("ADD"!==n||i.isNumber(t)&&i.isNumber(e))&&("DIVIDE"!==n||0!==e&&"0"!==e)?_[n](new r.Decimal(t),new r.Decimal(e)):p[n](t,e)}catch(i){return p[n](t,e)}}';

// 全原生：语义会变（0.1+0.2、1/3），只用来量 decimal 的成本上限
const DEC_NONE = 'function f(t,e,n){try{return p[n](t,e)}catch(i){return p[n](t,e)}}';

// 保守混合：两边都是整数且结果也在整数安全区 → 原生（语义完全等价），否则仍走 decimal
const DEC_HYBRID =
  'function f(t,e,n){try{if("ADD"===n||"MINUS"===n||"MULTIPLY"===n){if("number"==typeof t&&"number"==typeof e&&t===Math.floor(t)&&e===Math.floor(e)){var q=p[n](t,e);if("number"==typeof q&&Math.abs(q)<9007199254740992)return q}}if(i.isNumber(t)&&i.isNumber(e)&&"ADD"===n)return p[n](t,e);return _[n](new r.Decimal(t),new r.Decimal(e))}catch(i){return p[n](t,e)}}';

// 整数快路径：两边都是 32 位整数、且结果也是 32 位整数时用原生运算。
// double 对整数加减乘在 int32 范围内完全精确，与 decimal 结果逐位一致，零语义风险。
// 除法只在整除时走原生（否则交给 decimal 保精度）。
const DEC_INT =
  'function f(t,e,n){try{if("DIVIDE"!==n&&"POWER"!==n&&t===(t|0)&&e===(e|0)){var q=p[n](t,e);if(q===(q|0))return q}if("DIVIDE"===n&&t===(t|0)&&e===(e|0)&&0!==e&&0===t%e)return t/e;return("ADD"!==n||i.isNumber(t)&&i.isNumber(e))&&("DIVIDE"!==n||0!==e&&"0"!==e)?_[n](new r.Decimal(t),new r.Decimal(e)):p[n](t,e)}catch(i){return p[n](t,e)}}';

// 统计操作数类型分布：决定整数快路径值不值得做
const DEC_STAT =
  'function f(t,e,n){try{var C=window.__k4dec=window.__k4dec||{tot:0,int:0,flt:0,oth:0,ops:{}};C.tot++;var D=C.ops[n]=C.ops[n]||{int:0,flt:0,oth:0};if("number"==typeof t&&"number"==typeof e){if(t===(t|0)&&e===(e|0)){C.int++;D.int++}else{C.flt++;D.flt++}}else{C.oth++;D.oth++}return("ADD"!==n||i.isNumber(t)&&i.isNumber(e))&&("DIVIDE"!==n||0!==e&&"0"!==e)?_[n](new r.Decimal(t),new r.Decimal(e)):p[n](t,e)}catch(i){return p[n](t,e)}}';

// 2) 纯原生那一套：m[t.OP](t)
const NAT_ORIG =
  'ADD:function(t){return t.A+t.B},MINUS:function(t){return t.A-t.B},MULTIPLY:function(t){return t.A*t.B},DIVIDE:function(t){return t.A/t.B},POWER:function(t){return Math.pow(t.A,t.B)}';
const NAT_COUNT =
  'ADD:function(t){var C=window.__k4nat=window.__k4nat||{};C.ADD=(C.ADD|0)+1;return t.A+t.B},MINUS:function(t){var C=window.__k4nat=window.__k4nat||{};C.MINUS=(C.MINUS|0)+1;return t.A-t.B},MULTIPLY:function(t){var C=window.__k4nat=window.__k4nat||{};C.MULTIPLY=(C.MULTIPLY|0)+1;return t.A*t.B},DIVIDE:function(t){var C=window.__k4nat=window.__k4nat||{};C.DIVIDE=(C.DIVIDE|0)+1;return t.A/t.B},POWER:function(t){return Math.pow(t.A,t.B)}';

function bundle() {
  const f = fs.readdirSync(BUILD).find((x) => /^player_v2\..*\.js$/.test(x));
  if (!f) throw new Error('找不到 player_v2 bundle');
  return path.join(BUILD, f);
}

const mode = process.argv[2] || 'count';
const file = bundle();
const bak = file + '.orig';

if (mode === 'restore') {
  if (!fs.existsSync(bak)) { console.log('没有备份，无需还原'); process.exit(0); }
  fs.copyFileSync(bak, file);
  console.log('已还原:', path.basename(file));
  process.exit(0);
}

if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
let src = fs.readFileSync(bak, 'utf8'); // 永远从干净副本出发，保证幂等

if (src.indexOf(DEC_ORIG) === -1) { console.error('没找到 decimal 分派器，bundle 版本可能变了'); process.exit(1); }

let out = src;
if (mode === 'count') {
  out = out.replace(DEC_ORIG, DEC_COUNT);
  if (out.indexOf(NAT_ORIG) === -1) console.warn('警告：没找到纯原生那一套，只埋了 decimal 计数器');
  else out = out.replace(NAT_ORIG, NAT_COUNT);
} else if (mode === 'native') {
  out = out.replace(DEC_ORIG, DEC_NATIVE);
} else if (mode === 'nondecimal') {
  out = out.replace(DEC_ORIG, DEC_NONE);
} else if (mode === 'hybrid') {
  out = out.replace(DEC_ORIG, DEC_HYBRID);
} else if (mode === 'stat') {
  out = out.replace(DEC_ORIG, DEC_STAT);
} else if (mode === 'int') {
  out = out.replace(DEC_ORIG, DEC_INT);
} else {
  console.error('未知模式:', mode);
  process.exit(1);
}

fs.writeFileSync(file, out, 'utf8');
console.log('已应用补丁:', mode, '→', path.basename(file));
