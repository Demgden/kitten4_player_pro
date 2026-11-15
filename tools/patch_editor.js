'use strict';
/**
 * 给「Kitten4 桌面编辑器」打性能补丁（可重复执行，幂等）。
 *
 * 用法：
 *   node tools/patch_editor.js                # 默认改 dist/Kitten4编辑器
 *   node tools/patch_editor.js --target=路径   # 改指定目录（必须是含 resources/app 的安装目录）
 *   node tools/patch_editor.js --check         # 只检查，不改
 *   node tools/patch_editor.js --restore       # 用 .k4p.bak 还原
 *
 * 打的东西：
 *   1. bundle：get_descendants 由「递归 + 每层数组拷贝」改成显式栈迭代
 *      （一条 5000 块的链原本是 1250 万次 push，实测是打开作品时 7.9s 卡顿的主因之一）
 *   2. bundle：切换工作区不再「超 1000 块就等 200ms 再加载」
 *      —— 这段延迟让加载和编辑抢同一个工作区，异常还被 console.log 吞掉；
 *      改为等一帧（0ms）让加载提示画出来，失败时重试一次并把错误打到 console.error
 *   3. index.html：注入 k4p-perf.js（workspace_to_json 单遍序列化）
 *   4. main/index.js：禁用后台节流、开 GPU 光栅（「开始」预览同受益）
 *      注意别加 --js-flags=--max-old-space-size=4096：这个 Electron 版本加了会直接卡死页面
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = { check: false, restore: false, steps: null, target: path.join(__dirname, '..', 'dist', 'Kitten4编辑器') };
for (const a of args) {
  if (a === '--check') opt.check = true;
  else if (a === '--restore') opt.restore = true;
  else if (a.startsWith('--target=')) opt.target = a.slice(9);
  else if (a.startsWith('--steps=')) opt.steps = a.slice(8).split(',');
}

const MARK = { sel: '[k4p] 工作区加载失败', html: './k4p-perf.js', main: '/* k4p-perf-bootstrap' };

function findBundle(root) {
  const dir = path.join(root, 'resources', 'app', 'build');
  const f = fs.readdirSync(dir).find((x) => /^kitten\.[0-9a-f]+\.js$/.test(x));
  return f ? path.join(dir, f) : null;
}

const DES_OLD =
  'get_descendants=function(e,t){void 0===e&&(e=!1),void 0===t&&(t=!1);for(var n=[this],r=this.get_children(e),i=0;i<r.length;i++){var o=r[i];t&&o.is_shadow()||n.push.apply(n,o.get_descendants(e,t))}return n}';

const DES_NEW =
  'get_descendants=function(e,t){void 0===e&&(e=!1),void 0===t&&(t=!1);' +
  'var n=[this],k=this.get_children(e),st=[];' +
  'for(var i=k.length-1;i>=0;i--)st.push(k[i]);' +
  'for(;st.length;){var o=st.pop();if(t&&o.is_shadow())continue;n.push(o);' +
  'var k2=o.get_children(e);for(var q=k2.length-1;q>=0;q--)st.push(k2[q])}return n}';

const SEL_OLD_200 = ',200)}else this.select_workspace(a,s)';
const SEL_NEW_0 = ',0)}else this.select_workspace(a,s)';

const SEL_OLD_ERR = 'catch(e){console.log(e)}finally{l&&(l.style.display="none")}';
const SEL_NEW_ERR =
  'catch(e){console.error("[k4p] 工作区加载失败",e);' +
  'try{r.select_workspace(a,s)}catch(e2){console.error("[k4p] 工作区加载仍失败",e2)}}' +
  'finally{l&&(l.style.display="none")}';

const MAIN_BOOT =
  '/* k4p-perf-bootstrap：渲染/编辑共用，等价于播放器里的同款开关 */\n' +
  '(function(){try{var e=require("electron"),a=e&&e.app;if(!a||!a.commandLine)return;' +
  'a.commandLine.appendSwitch("disable-renderer-backgrounding");' +
  'a.commandLine.appendSwitch("disable-background-timer-throttling");' +
  'a.commandLine.appendSwitch("enable-gpu-rasterization");' +
  'a.commandLine.appendSwitch("ignore-gpu-blocklist");}catch(_){}})();\n';

function backup(file) {
  const bak = file + '.k4p.bak';
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
}

function patchFile(file, edits) {
  const src = fs.readFileSync(file, 'utf8');
  let out = src;
  const report = [];
  for (const e of edits) {
    if (e.skip) { report.push([e.name, 'skip(未选)']); continue; }
    if (e.already(out)) { report.push([e.name, 'skip(已打)']); continue; }
    const r = e.apply(out);
    if (r === null) { report.push([e.name, 'FAIL(没找到目标)']); continue; }
    out = r;
    report.push([e.name, 'ok']);
  }
  const changed = out !== src;
  if (changed && !opt.check) { backup(file); fs.writeFileSync(file, out); }
  return { report, changed };
}

function restoreFile(file) {
  const bak = file + '.k4p.bak';
  if (!fs.existsSync(bak)) return false;
  fs.copyFileSync(bak, file);
  fs.unlinkSync(bak);
  return true;
}

function main() {
  const root = opt.target;
  if (!fs.existsSync(path.join(root, 'resources', 'app'))) {
    console.error('不是编辑器目录（缺 resources/app）：' + root);
    process.exit(2);
  }
  const bundle = findBundle(root);
  const html = path.join(root, 'resources', 'app', 'build', 'index.html');
  const mainJs = path.join(root, 'resources', 'app', 'main', 'index.js');
  const perfDst = path.join(root, 'resources', 'app', 'build', 'k4p-perf.js');

  if (opt.restore) {
    for (const f of [bundle, html, mainJs].filter(Boolean)) {
      if (fs.existsSync(f)) console.log('restore ' + path.basename(f) + ' → ' + restoreFile(f));
    }
    if (fs.existsSync(perfDst)) fs.unlinkSync(perfDst);
    return;
  }

  const want = (n) => !opt.steps || opt.steps.includes(n);
  const b = patchFile(bundle, [
    {
      skip: !want('des'),
      name: 'get_descendants 迭代化',
      already: (s) => s.includes(DES_NEW),
      apply: (s) => (s.includes(DES_OLD) ? s.replace(DES_OLD, DES_NEW) : null),
    },
    {
      skip: !want('sel'),
      name: '切工作区 200ms → 0ms',
      already: (s) => s.includes(SEL_NEW_0),
      apply: (s) => (s.includes(SEL_OLD_200) ? s.replace(SEL_OLD_200, SEL_NEW_0) : null),
    },
    {
      skip: !want('sel'),
      name: '加载失败不再静默',
      already: (s) => s.includes(MARK.sel),
      apply: (s) => (s.includes(SEL_OLD_ERR) ? s.replace(SEL_OLD_ERR, SEL_NEW_ERR) : null),
    },
  ]);

  const perfSrc = path.join(__dirname, '..', 'src', 'editor', 'perf.js');
  if (!opt.check && want('perf')) fs.copyFileSync(perfSrc, perfDst);
  const h = patchFile(html, [
    {
      skip: !want('perf'),
      name: 'index.html 注入 k4p-perf.js',
      already: (s) => s.includes(MARK.html),
      apply: (s) => {
        const m = s.match(/<script src="\.\/kitten\.[0-9a-f]+\.js"><\/script>/);
        if (!m) return null;
        return s.replace(m[0], m[0] + '<script src="./k4p-perf.js"></script>');
      },
    },
  ]);

  const mainSrc = fs.readFileSync(mainJs, 'utf8');
  let mainRep = 'skip(已打)';
  if (want('main') && !mainSrc.includes(MARK.main)) {
    mainRep = 'ok';
    if (!opt.check) { backup(mainJs); fs.writeFileSync(mainJs, MAIN_BOOT + mainSrc); }
  }

  console.log('目标：' + root);
  for (const [n, r] of b.report) console.log('  bundle  ' + n + ' → ' + r);
  for (const [n, r] of h.report) console.log('  html    ' + n + ' → ' + r);
  console.log('  main    启动开关 → ' + mainRep);
  console.log(opt.check ? '(只检查，未写入)' : '完成');
}

main();
