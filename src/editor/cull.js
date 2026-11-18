/* k4p-cull：积木视口裁剪
 *
 * 只在「一个角色积木特别多」时生效（默认 >= 300 块）。
 * 积木的 <g> 是按堆叠嵌套的：一个顶层块的 <g> 里装着它整条链。
 * 这里先一遍 DFS 把每块的画布坐标/宽高缓存成扁平表，之后每轮只做算术 + 必要的 display 切换，
 * 视口外（留 0.5 屏余量）的块整棵子树 display:none —— 浏览器不再为它排版/绘制。
 *
 * 不改积木对象、不改连接、不改序列化结果。
 * 关掉：?k4p_cull=0 或 localStorage.k4p_cull='0'
 */
(function () {
  'use strict';
  if (window.__k4pCull) return;

  var R = {
    applied: false,
    on: true,
    margin: 0.5,
    minBlocks: 300,
    every: 6,
    passes: 0,
    hidden: 0,
    shown: 0,
    lastMs: 0,
    buildMs: 0,
    blocks: 0,
    err: '',
  };
  R.snapshot = function () {
    return {
      on: R.on, applied: R.applied, blocks: R.blocks, hidden: R.hidden, shown: R.shown,
      passes: R.passes, lastMs: R.lastMs, buildMs: R.buildMs, every: R.every, err: R.err,
    };
  };
  R.off = function () { R.on = false; showAll(); };
  R.kick = function () { dirty = true; };
  window.__k4pCull = R;

  try {
    if (/[?&]k4p_cull=0/.test(String(location.search || ''))) R.on = false;
    if (localStorage.getItem('k4p_cull') === '0') R.on = false;
  } catch (e) {}

  var ws = null, canvas = null, svg = null;
  var flat = null;
  var count = -1;
  var sig = '';
  var tick = 0;
  var dirty = true;

  var RE_M = /matrix\(\s*(-?[\d.eE+-]+)[ ,]+(-?[\d.eE+-]+)[ ,]+(-?[\d.eE+-]+)[ ,]+(-?[\d.eE+-]+)[ ,]+(-?[\d.eE+-]+)[ ,]+(-?[\d.eE+-]+)\s*\)/;
  var RE_T = /translate\(\s*(-?[\d.eE+-]+)[ ,]+(-?[\d.eE+-]+)/;

  function pick() {
    var B = window.Blockly;
    if (!B || !B.mainWorkspace) return false;
    var w = B.mainWorkspace;
    if (ws === w && canvas) return true;
    if (!w.get_canvas || !w.get_parent_svg) return false;
    var c = null;
    try { c = w.get_canvas(); } catch (e) { return false; }
    if (!c) return false;
    ws = w;
    canvas = c;
    svg = w.get_parent_svg();
    count = -1;
    sig = '';
    dirty = true;
    return true;
  }

  function isBlockEl(el) {
    if (el.__k4pB) return true;
    var cl = el.getAttribute && el.getAttribute('class');
    return !!(cl && cl.indexOf('blocklyDraggable') >= 0);
  }

  function showAll() {
    if (!canvas) return;
    var els = canvas.querySelectorAll('[data-k4pcull]');
    for (var i = 0; i < els.length; i++) {
      els[i].style.display = '';
      els[i].removeAttribute('data-k4pcull');
    }
    if (flat) for (var j = 0; j < flat.length; j++) { flat[j].hid = false; flat[j].pruned = false; }
    R.hidden = 0;
  }

  function build() {
    var all = null;
    try { all = ws.get_all_blocks(); } catch (e) { return false; }
    if (!all) return false;
    for (var i = 0; i < all.length; i++) {
      var el = all[i].svg_group;
      if (el) el.__k4pB = all[i];
    }
    count = all.length;
    R.blocks = count;

    var t0 = performance.now();
    flat = [];
    var roots = canvas.children;
    for (var r = 0; r < roots.length; r++) walkBuild(roots[r], 0, 0, -1);
    R.buildMs = +(performance.now() - t0).toFixed(1);
    return true;
  }

  function walkBuild(el, x, y, pid) {
    var t = el.getAttribute('transform');
    if (t) {
      var mm = RE_M.exec(t);
      if (mm) { x += +mm[5]; y += +mm[6]; }
      else {
        var tt = RE_T.exec(t);
        if (tt) { x += +tt[1]; y += +tt[2]; }
      }
    }
    var b = el.__k4pB;
    var i = flat.length;
    flat.push({
      el: el, x: x, y: y, pid: pid,
      w: (b && b.width) || 0,
      h: (b && b.height) || 0,
      hid: el.style.display === 'none' && el.getAttribute('data-k4pcull') === '1',
      pruned: false,
    });
    var ks = el.children;
    for (var k = 0; k < ks.length; k++) if (isBlockEl(ks[k])) walkBuild(ks[k], x, y, i);
  }

  function run() {
    var m = canvas.getScreenCTM();
    if (!m) return;
    var box = svg.getBoundingClientRect();
    if (!box.width || !box.height) return;
    var padX = box.width * R.margin;
    var padY = box.height * R.margin;
    var L = box.left - padX, Rt = box.right + padX;
    var T = box.top - padY, Bt = box.bottom + padY;
    var hidden = 0, shown = 0;
    var n = flat.length;

    for (var i = 0; i < n; i++) {
      var it = flat[i];
      // 父级已经整枝收掉，子节点不用再看
      if (it.pid >= 0 && flat[it.pid].pruned) continue;

      var sx = m.a * it.x + m.c * it.y + m.e;
      var sy = m.b * it.x + m.d * it.y + m.f;
      var sw = it.w * m.a, sh = it.h * m.d;
      var el = it.el;

      // 在视口上方/左侧：自己看不见，但子树（往下/往右长）可能还在视口里 → 不能收，继续往下走
      if (sy + sh < T || sx + sw < L) {
        if (it.hid) {
          el.style.display = '';
          el.removeAttribute('data-k4pcull');
          it.hid = false;
          shown++;
        }
        it.pruned = false;
        continue;
      }

      // 在视口下方/右侧：子树只会更远 → 整枝收掉
      if (sy > Bt || sx > Rt) {
        if (!it.hid) {
          el.style.display = 'none';
          el.setAttribute('data-k4pcull', '1');
          it.hid = true;
        }
        it.pruned = true;
        hidden++;
        continue;
      }

      if (it.hid) {
        el.style.display = '';
        el.removeAttribute('data-k4pcull');
        it.hid = false;
        shown++;
      }
      it.pruned = false;
    }
    R.hidden = hidden;
    R.shown = shown;
  }

  function step() {
    if (!R.on) return;
    if (!pick()) return;

    if (dirty || !flat) {
      dirty = false;
      if (!build()) return;
    } else if (tick % 30 === 0) {
      var now = 0;
      try { now = ws.get_all_blocks().length; } catch (e) {}
      if (now !== count) dirty = true;
    }
    tick++;

    if (count < R.minBlocks) {
      if (count > 0) showAll();
      return;
    }

    // 平移可能落在 CSS transform 上（k4p 平移补丁），attribute 不再变化 → 两者都取
    var t = (canvas.style.transform || '') + '/' + (canvas.getAttribute('transform') || '');
    var s = t + '|' + (ws.scrollX | 0) + ',' + (ws.scrollY | 0) + '|' + count + '|' + (ws.scale || 1) + '|' + R.margin;
    if (s === sig && R.passes % 20 !== 0) return;
    // 平移节流：每次 toggle display 都会让 SVG 子树重新 layout，
    // 逐帧跟着平移反而拖慢（实测每帧更新 64ms/帧，每 6 帧 44ms）。留 0.5 屏余量，够缓冲。
    if (s !== sig && R.every > 1 && tick % R.every !== 0) return;
    sig = s;

    var t0 = performance.now();
    try {
      run();
      R.err = '';
    } catch (e) {
      R.err = String((e && e.message) || e).slice(0, 140);
    }
    R.lastMs = +(performance.now() - t0).toFixed(1);
    R.passes++;
    R.applied = true;
  }

  function loop() {
    try { step(); } catch (e) { R.err = String((e && e.message) || e).slice(0, 140); }
    requestAnimationFrame(loop);
  }

  // 拖拽/编辑之后结构或位置会变，重建一次（约 20ms，只在操作结束后发生一次）
  function poke() { dirty = true; }
  window.addEventListener('pointerup', poke, true);
  window.addEventListener('keyup', poke, true);

  requestAnimationFrame(loop);
  console.log('[k4p] cull 已装载');
})();
