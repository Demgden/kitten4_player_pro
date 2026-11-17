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
 *   3. index.html：注入 k4p-perf.js（workspace_to_json 单遍序列化）与 k4p-cull.js（积木视口裁剪）
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

const MARK = { sel: '[k4p] 工作区加载失败', html: './k4p-perf.js', cull: './k4p-cull.js', main: '/* k4p-perf-bootstrap' };

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

const MUT_HEAD = 'generate_mutate_op=function(e,t,n){';
const MUT_TAIL = '},e.prototype.generate_edit_field_op=';

/**
 * 撤销栈的 op 生成：原来是「整棵子树全删 + 全插」。
 * 点一次 if 的 +/- 时子树有 520 块，于是生成 1041 个 op，每个都过一遍 CRDT 文档 —— 实测 15.9 秒。
 * 实际变化只有「if 块自己的条目 + 1 个新 shadow 块 + 1 条连接」，所以改成子树 diff：
 * 只对消失/新增/变化的块与连接生成 op，op 数从 1041 降到个位数。
 */
const MUT_NEW =
  MUT_HEAD +
  '/*k4p-mut: 子树 diff，op 数从 O(子树) 降到 O(实际变化)*/' +
  'var r=n||this.get_current_ws_json(),' +
  'a=this.Blink.json.get_block_data_by_id(r,e),' +
  's=t,c=[];' +
  'try{if(window.__k4pDocOn){window.__k4pDoc=r;window.__k4pNew=s}}catch(_){}' +
  'var okOld=!!(a&&a.blocks&&a.blocks[e]&&s&&s.blocks);' +
  'var eq=function(a,b){' +
  'if(a===b)return!0;' +
  'if(a===null||b===null||typeof a!=="object"||typeof b!=="object")return!1;' +
  'if(Array.isArray(a)!==Array.isArray(b))return!1;' +
  'if(Array.isArray(a)){if(a.length!==b.length)return!1;' +
  'for(var i=0;i<a.length;i++)if(!eq(a[i],b[i]))return!1;return!0}' +
  'var ka=Object.keys(a);' +
  'for(var i=0;i<ka.length;i++){var kk=ka[i];if(!(kk in b)||!eq(a[kk],b[kk]))return!1}return!0};' +
  'var canon=function(v){' +
  'if(v===null||v===void 0)return "";' +
  'if(typeof v!=="object")return v;' +
  'if(Array.isArray(v)){var ar=[];for(var i=0;i<v.length;i++){var x=canon(v[i]);if(x!=="")ar.push(x)}return ar.length?ar:""}' +
  'var o={},ks=Object.keys(v);' +
  'for(var i=0;i<ks.length;i++){var kk=ks[i];' +
  'if(kk==="location"||kk==="field_constraints"||kk==="field_extra_attr")continue;' +
  'var y=canon(v[kk]);if(y!=="")o[kk]=y}' +
  'return Object.keys(o).length?o:""};' +
  'var same=function(a,b){return eq(canon(a),canon(b))};' +
  // 兜底：doc 里查不到这个块（极罕见），按官方做法整棵子树全删全插，绝不丢事件
  'if(!okOld){' +
  'if(a&&a.blocks){' +
  'var pl=a.blocks[e]&&a.blocks[e].parent_id;' +
  'if(pl&&r.connections&&r.connections[pl]&&r.connections[pl][e]){' +
  'c.push((0,i.removeOp)(["connections",pl,e]));' +
  '(pend[pl]=pend[pl]||{})[e]=r.connections[pl][e]}' +
  'for(k in a.blocks)if(a.blocks.hasOwnProperty(k)){' +
  'c.push((0,i.removeOp)(["connections",k]));c.push((0,i.removeOp)(["blocks",k]))}' +
  'var ac=a.comments||{};for(k in ac)if(ac.hasOwnProperty(k))c.push((0,i.removeOp)(["comments",k]))}' +
  'if(s&&s.blocks){' +
  'for(k in s.blocks)if(s.blocks.hasOwnProperty(k))c.push((0,i.insertOp)(["blocks",k],s.blocks[k]));' +
  'var sc=s.connections||{};' +
  'for(k in sc)if(sc.hasOwnProperty(k)){c.push((0,i.insertOp)(["connections",k],{}));' +
  'for(ch in sc[k])if(sc[k].hasOwnProperty(ch))c.push((0,i.insertOp)(["connections",k,ch],sc[k][ch]))}' +
  'var sk=s.comments||{};for(k in sk)if(sk.hasOwnProperty(k))c.push((0,i.insertOp)(["comments",k],sk[k]))}' +
  'for(p in pend)if(pend.hasOwnProperty(p))for(ch in pend[p])if(pend[p].hasOwnProperty(ch))' +
  'c.push((0,i.insertOp)(["connections",p,ch],pend[p][ch]));' +
  'return c.length?c.reduce(o.type.compose,null):null}' +
  'var ob=a.blocks,nb=s.blocks,oc=a.connections||{},nc=s.connections||{},' +
  'ocm=a.comments||{},ncm=s.comments||{},rmo=[],rset={},pend={},k,p,ch,ov,nv,id,pid,isNew,tt;' +
  'for(k in ob)if(ob.hasOwnProperty(k)&&(!nb[k]||!same(ob[k],nb[k])))rmo.push(k);' +
  'for(k=0;k<rmo.length;k++)rset[rmo[k]]=1;' +
  'for(k=0;k<rmo.length;k++){' +
  'id=rmo[k],pid=ob[id].parent_id;' +
  'if(pid&&!rset[pid]&&oc[pid]&&oc[pid][id]){' +
  'c.push((0,i.removeOp)(["connections",pid,id]));' +
  '(pend[pid]=pend[pid]||{})[id]=oc[pid][id]}}' +
  'for(k=0;k<rmo.length;k++){' +
  'c.push((0,i.removeOp)(["connections",rmo[k]]));' +
  'c.push((0,i.removeOp)(["blocks",rmo[k]]))}' +
  'for(k in ocm)if(ocm.hasOwnProperty(k)&&(!ncm[k]||rset[k]))c.push((0,i.removeOp)(["comments",k]));' +
  'for(k in nb)if(nb.hasOwnProperty(k)&&(!ob[k]||rset[k]))c.push((0,i.insertOp)(["blocks",k],nb[k]));' +
  'for(k in nb)if(nb.hasOwnProperty(k)){' +
  'isNew=!ob[k]||rset[k],tt=nc[k];' +
  'if(isNew){' +
  'c.push((0,i.insertOp)(["connections",k],{}));' +
  'if(tt)for(ch in tt)if(tt.hasOwnProperty(ch))c.push((0,i.insertOp)(["connections",k,ch],tt[ch]));' +
  'continue}' +
  'if(tt)for(ch in tt)if(tt.hasOwnProperty(ch)){' +
  'ov=oc[k]?oc[k][ch]:void 0,nv=tt[ch];' +
  'if(!ov)c.push((0,i.insertOp)(["connections",k,ch],nv));' +
  'else if(!same(ov,nv))c.push((0,i.removeOp)(["connections",k,ch])),c.push((0,i.insertOp)(["connections",k,ch],nv))}}' +
  'for(p in oc)if(oc.hasOwnProperty(p)&&!rset[p])' +
  'for(ch in oc[p])if(oc[p].hasOwnProperty(ch)&&(!nc[p]||!nc[p][ch]))c.push((0,i.removeOp)(["connections",p,ch]));' +
  'for(k in ncm)if(ncm.hasOwnProperty(k)&&(!ocm[k]||rset[k]))c.push((0,i.insertOp)(["comments",k],ncm[k]));' +
  'for(p in pend)if(pend.hasOwnProperty(p))' +
  'for(ch in pend[p])if(pend[p].hasOwnProperty(ch))c.push((0,i.insertOp)(["connections",p,ch],pend[p][ch]));' +
  'try{window.__k4pMut&&(window.__k4pMut.n++,window.__k4pMut.ops+=c.length)}catch(_){}' +
  'return c.length?c.reduce(o.type.compose,null):null' +
  '}';

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
  const cullDst = path.join(root, 'resources', 'app', 'build', 'k4p-cull.js');

  if (opt.restore) {
    for (const f of [bundle, html, mainJs].filter(Boolean)) {
      if (fs.existsSync(f)) console.log('restore ' + path.basename(f) + ' → ' + restoreFile(f));
    }
    if (fs.existsSync(perfDst)) fs.unlinkSync(perfDst);
    if (fs.existsSync(cullDst)) fs.unlinkSync(cullDst);
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
    {
      skip: !want('mut'),
      name: '撤销栈子树 diff（if 加减层 15.9s → 亚秒）',
      already: (s) => s.includes('/*k4p-mut:'),
      apply: (s) => {
        const i0 = s.indexOf(MUT_HEAD);
        if (i0 < 0) return null;
        const i1 = s.indexOf(MUT_TAIL, i0);
        if (i1 < 0) return null;
        // MUT_TAIL 开头的 } 是原函数体的收尾，MUT_NEW 自带，跳过它
        return s.slice(0, i0) + MUT_NEW + s.slice(i1 + 1);
      },
    },
  ]);

  const perfSrc = path.join(__dirname, '..', 'src', 'editor', 'perf.js');
  const cullSrc = path.join(__dirname, '..', 'src', 'editor', 'cull.js');
  if (!opt.check && want('perf')) fs.copyFileSync(perfSrc, perfDst);
  if (!opt.check && want('cull')) fs.copyFileSync(cullSrc, cullDst);
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
    {
      skip: !want('cull'),
      name: 'index.html 注入 k4p-cull.js',
      already: (s) => s.includes(MARK.cull),
      apply: (s) => {
        if (s.includes('<script src="./k4p-perf.js"></script>')) {
          return s.replace('<script src="./k4p-perf.js"></script>',
            '<script src="./k4p-perf.js"></script><script src="./k4p-cull.js"></script>');
        }
        const m = s.match(/<script src="\.\/kitten\.[0-9a-f]+\.js"><\/script>/);
        return m ? s.replace(m[0], m[0] + '<script src="./k4p-cull.js"></script>') : null;
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
