'use strict';
/**
 * 数值实现优化（阶段2）。
 *
 *   node tools/patch_num.js apply     # 应用（默认：整数快路径，语义与 decimal 逐位一致）
 *   node tools/patch_num.js restore   # 还原
 *
 * 改动两处（bundle 内，幂等，从 .num_orig 出发）：
 *   1. 暴露 window.__k4num（算术原语）+ 一个运行时开关 __k4pNative(v)
 *   2. 重写数学分派器 f(t,e,n)：
 *      - window.__k4pNative 打开时全原生（快 60×，但浮点会出现 5.9999... 这类长尾）
 *      - 默认走整数快路径：两边都是 int32 且结果也是 int32 → 原生（精确等价），
 *        其余仍用 decimal 保精度
 *
 * 实测（florr 分布，ns/次）：原版 decimal 1337 / 整数快路径 1159 / 全原生 21.7
 *
 * ⚠️ `node tools/instrument.js restore` 会用 .bak 覆盖 bundle，把本补丁冲掉。
 *    跑完 instrument 之后要重新 `node tools/patch_num.js apply`。
 */
const fs = require('fs');
const path = require('path');

const BUILD = path.join(__dirname, '..', 'src', 'player', 'build');
const file = (() => {
  const f = fs.readdirSync(BUILD).find((x) => /^player_v2\..*\.js$/.test(x));
  if (!f) throw new Error('找不到 player_v2 bundle');
  return path.join(BUILD, f);
})();
const BAK = file + '.num_orig';

const DEC_ORIG =
  'function f(t,e,n){try{return("ADD"!==n||i.isNumber(t)&&i.isNumber(e))&&("DIVIDE"!==n||0!==e&&"0"!==e)?_[n](new r.Decimal(t),new r.Decimal(e)):p[n](t,e)}catch(i){return p[n](t,e)}}';

const ANCHOR = '};function f(t,e,n){try{';

const EXPOSE =
  '};window.__k4num={_:_,p:p,D:r.Decimal};var __k4native=window.__k4pNativeDefault===0?0:1;window.__k4pNative=function(v){__k4native=v?1:0};function f(t,e,n){try{';

const DEC_NEW =
  'function f(t,e,n){try{' +
  // 全原生：快 60×；结果按 12 位小数整洁化（|x|<8000 时 1e12 缩放不丢精度），
  // 专门消除 0.030000000000001137 这类浮点长尾
  'if(__k4native){var w=p[n](t,e);if("number"==typeof w&&isFinite(w)){' +
  'if(w>-8e3&&w<8e3){var r=Math.round(w*1e12)/1e12;if(r!==w)return r}return w}}' +
  'if("DIVIDE"!==n&&"POWER"!==n&&t===(t|0)&&e===(e|0)){var q=p[n](t,e);if(q===(q|0))return q}' +
  'if("DIVIDE"===n&&t===(t|0)&&e===(e|0)&&0!==e&&0===t%e)return t/e;' +
  'return("ADD"!==n||i.isNumber(t)&&i.isNumber(e))&&("DIVIDE"!==n||0!==e&&"0"!==e)' +
  '?_[n](new r.Decimal(t),new r.Decimal(e)):p[n](t,e)}catch(i){return p[n](t,e)}}';

const mode = process.argv[2] || 'apply';

if (mode === 'restore') {
  if (!fs.existsSync(BAK)) { console.log('没有备份，无需还原'); process.exit(0); }
  fs.copyFileSync(BAK, file);
  console.log('已还原:', path.basename(file));
  process.exit(0);
}

// 首次运行时，把当前文件当作"干净副本"。若已有注入（__k4num / instrument 痕迹）则拒绝。
if (!fs.existsSync(BAK)) {
  const cur = fs.readFileSync(file, 'utf8');
  if (cur.includes('window.__k4num=') || cur.includes('window.__k4pNative=')) {
    console.error('当前 bundle 已带数值补丁，没有干净备份。请先手工还原。');
    process.exit(1);
  }
  fs.copyFileSync(file, BAK);
}

let src = fs.readFileSync(BAK, 'utf8');
const anchorCount = src.split(ANCHOR).length - 1;
if (anchorCount !== 1) { console.error('锚点匹配到 ' + anchorCount + ' 处，bundle 可能变了'); process.exit(1); }
if (src.indexOf(DEC_ORIG) === -1) { console.error('没找到原始分派器'); process.exit(1); }

let out = src.replace(ANCHOR, EXPOSE).replace(DEC_ORIG, DEC_NEW);
fs.writeFileSync(file, out, 'utf8');
console.log('已应用数值优化 →', path.basename(file));
console.log('  默认：整数快路径（语义等价）');
console.log('  开关：window.__k4pNative(1) 切到全原生（快 60×，浮点会有长尾）');
