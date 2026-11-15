'use strict';
/**
 * 运行信息面板（页面侧）
 *
 * 右侧浮层，实时显示：
 *   - 帧率、每帧脚本运行时间、每帧执行积木数
 *   - 角色（按 typeclass 归并，克隆体算同一个角色）耗时占比
 *   - 点开角色 → 角色内部各函数（自定义积木）的自身耗时 / 含子调用 / 调用次数
 *
 * 数据全部取运行时自己的对象，不解析生成代码：
 *   - run_mgr.update            → 一帧的脚本时间（含调度）
 *   - OptiRunner.do_step        → 一次「执行栈顶函数的一段脚本」，据此计时：
 *                                 进入前读栈顶 proc_id 归「自身耗时」，
 *                                 栈上每个 proc 都累加 → 「含子调用」
 *   - interpreter.step_outputs.after_potential_blocker（生成代码里的 X.EC）
 *                               → 每个积木执行一次，用来数「执行积木数」
 *   - step_outputs.proc_call    → 函数调用次数
 *   - programs[*].static_data   → 静态积木数（作参考，显示在 hover 里）
 *
 * 只在面板打开时挂计时器（关闭即还原原型方法、解除 step_outputs 包装），
 * 不开面板零开销。入口：window.__k4pProf.toggle() / .show() / .hide()。
 */
(function () {
  if (window.__k4pProf) return;

  var now = performance.now.bind(performance);

  var S = {
    on: false,
    hookedProto: null,
    origUpdate: null,
    origStep: null,
    origDo: null,
    acc: null,              // tc -> { ms, blk, procs: Map<pid, {self,inc,n}> }
    accTotal: 0,
    accFrames: 0,
    maxFrame: 0,
    lastFrames: -1,
    blocks: null,           // 静态积木数（参考）
    host: null,
    root: null,
    listEl: null,
    timer: null,
    winStart: 0,
    open: null,             // tc -> 1，展开的角色
    autoOpened: false,
  };

  S.acc = Object.create(null);
  S.open = Object.create(null);

  /* ---------------- 运行时访问 ---------------- */

  function getRm() {
    try {
      var B = window.__k4b;
      var C = window.__k4c;
      if (!B || !C) return null;
      var fac = C.get(B.RuntimeManagerFacade);
      return (fac && fac.run_mgr) || null;
    } catch (e) {
      return null;
    }
  }

  function bucket(tc) {
    var b = S.acc[tc];
    if (!b) {
      b = S.acc[tc] = { ms: 0, blk: 0, procs: new Map() };
    }
    return b;
  }

  function procRec(b, pid) {
    var p = b.procs.get(pid);
    if (!p) {
      p = { self: 0, inc: 0, n: 0 };
      b.procs.set(pid, p);
    }
    return p;
  }

  function resetAcc() {
    for (var tc in S.acc) {
      var b = S.acc[tc];
      b.ms = 0;
      b.blk = 0;
      b.procs.clear();
    }
    S.accTotal = 0;
    S.accFrames = 0;
    S.maxFrame = 0;
  }

  /* -------- 每个解释器：给生成代码里的 X.EC / X.EA 挂计数（构造时已 bind，必须逐实例替换） -------- */

  function patchInterp(it) {
    if (!it || it.__k4pPatched) return;
    var so = it.step_outputs;
    if (!so || typeof so.after_potential_blocker !== 'function') return;
    var tc;
    try {
      tc = (it.metadata && it.metadata.typeclass_id) || '?';
    } catch (e) { return; }
    var b = bucket(tc);
    it.__k4pTc = tc;
    it.__k4pPatched = 1;

    // X.EC：每个积木执行一次
    var oEC = so.after_potential_blocker;
    it.__k4pOrigEC = oEC;
    so.after_potential_blocker = so.EC = function () {
      b.blk++;
      return oEC.apply(null, arguments);
    };

    // X.EA：函数调用一次（第一个参数是被调用函数的 proc_id）
    if (typeof so.proc_call === 'function') {
      var oCall = so.proc_call;
      it.__k4pOrigCall = oCall;
      so.proc_call = so.EA = function (pid) {
        var p = b.procs.get(pid);
        if (p) p.n++;
        else procRec(b, pid).n++;
        return oCall.apply(null, arguments);
      };
    }
  }

  function hook(rm) {
    var proto;
    try {
      proto = Object.getPrototypeOf(rm);
    } catch (e) {
      return;
    }
    if (proto && proto.__k4pProfProto) { S.hookedProto = proto; return; }

    var interps = rm.interpreters || {};
    for (var k in interps) patchInterp(interps[k]);

    if (!proto || typeof proto.update !== 'function' || typeof proto._step !== 'function') return;
    var itProto = null;
    for (var q in interps) {
      try { itProto = Object.getPrototypeOf(interps[q]); } catch (e) { itProto = null; }
      if (itProto && typeof itProto.do_step === 'function') break;
      itProto = null;
    }
    if (!itProto) return;

    unhook();
    S.hookedProto = proto;
    proto.__k4pProfProto = 1;
    S.origUpdate = proto.update;
    S.origStep = proto._step;
    S.itProto = itProto;
    S.origDo = itProto.do_step;

    var origUpdate = S.origUpdate;
    proto.update = function () {
      var t0 = now();
      try {
        return origUpdate.apply(this, arguments);
      } finally {
        var dt = now() - t0;
        // 运行时重启后 frames 归零，统计窗口跟着重来
        if (typeof this.frames === 'number' && this.frames < S.lastFrames) resetAcc();
        if (typeof this.frames === 'number') S.lastFrames = this.frames;
        S.accTotal += dt;
        S.accFrames++;
        if (dt > S.maxFrame) S.maxFrame = dt;
      }
    };

    var origStep = S.origStep;
    // _step：一帧里某个解释器连续跑一段。
    // 这里负责给新建的解释器补上计数包装，并在段的首尾开合计时窗口。
    proto._step = function (id, it) {
      if (it) {
        if (!it.__k4pPatched) patchInterp(it);
        it.__k4pSegT = undefined;
        it.__k4pTop = undefined;
      }
      var r;
      try {
        r = origStep.apply(this, arguments);
      } finally {
        if (it) settle(it, now());
      }
      return r;
    };

    // 核心：do_step 一次只执行「栈顶函数的一段脚本」。
    // 计时用「切换结算」：栈顶变化或 _step 结束时才取一次时间，
    // 把这段区间记给当时正在执行的函数（自身）和它所有祖先（含子调用）。
    // 这样每次 do_step 只是一次字符串比较，不会把运行时拖慢。
    var origDo = S.origDo;
    itProto.do_step = function () {
      var st = this.program_state.proc_stack;
      var d = st.length;
      var top = d ? st[d - 1].proc_id : null;
      if (top !== this.__k4pTop) {
        var t = now();
        if (this.__k4pTop !== undefined) settle(this, t);
        this.__k4pTop = top;
        this.__k4pSegT = t;

        var tc = this.__k4pTc;
        if (tc === undefined) {
          tc = (this.metadata && this.metadata.typeclass_id) || '?';
          this.__k4pTc = tc;
        }
        var b = S.acc[tc];
        if (!b) b = bucket(tc);
        this.__k4pB = b;

        var path = new Array(d);
        for (var i = 0; i < d; i++) path[i] = procRec(b, st[i].proc_id);
        this.__k4pPath = path;
      }
      return origDo.apply(this, arguments);
    };
  }

  /** 结算解释器上一段：记给当前函数（自身）与栈上全部祖先（含子调用） */
  function settle(it, t) {
    var path = it.__k4pPath;
    var b = it.__k4pB;
    if (!path || !b || it.__k4pSegT === undefined) return;
    var dt = t - it.__k4pSegT;
    it.__k4pSegT = t;
    if (!(dt > 0)) return;
    b.ms += dt;
    for (var i = 0; i < path.length; i++) path[i].inc += dt;
    path[path.length - 1].self += dt;
  }

  function unhook() {
    var proto = S.hookedProto;
    if (proto) {
      try {
        if (S.origUpdate) proto.update = S.origUpdate;
        if (S.origStep) proto._step = S.origStep;
        delete proto.__k4pProfProto;
      } catch (e) { /* ignore */ }
    }
    if (S.itProto && S.origDo) {
      try { S.itProto.do_step = S.origDo; } catch (e) { /* ignore */ }
    }
    S.hookedProto = null;
    S.itProto = null;
    S.origUpdate = null;
    S.origStep = null;
    S.origDo = null;
  }

  /** 解除 step_outputs 包装（面板关闭时） */
  function unpatchInterps(rm) {
    var interps = (rm && rm.interpreters) || {};
    for (var k in interps) {
      var it = interps[k];
      if (!it || !it.__k4pPatched) continue;
      var so = it.step_outputs;
      if (so) {
        try {
          if (it.__k4pOrigEC) {
            so.after_potential_blocker = it.__k4pOrigEC;
            if ('EC' in so) so.EC = it.__k4pOrigEC;
          }
          if (it.__k4pOrigCall) {
            so.proc_call = it.__k4pOrigCall;
            if ('EA' in so) so.EA = it.__k4pOrigCall;
          }
        } catch (e) { /* ignore */ }
      }
      delete it.__k4pOrigEC;
      delete it.__k4pOrigCall;
      delete it.__k4pPatched;
    }
  }

  /* ---------------- 角色名 / 静态积木数 ---------------- */

  var sceneIds = Object.create(null);

  function actorNames() {
    var out = Object.create(null);
    sceneIds = Object.create(null);
    try {
      var req = window.__k4wreq;
      if (typeof req !== 'function') return out;
      var store = req('dqaR').a;
      var st = store.get_state();
      var th = st.theatre_states || {};
      var acts = th.actors || {};
      for (var id in acts) {
        var a = acts[id];
        if (a && a.name) out[a.id || id] = a.name;
      }
      var scs = th.scenes || {};
      for (var sid in scs) {
        var s = scs[sid];
        sceneIds[(s && s.id) || sid] = 1;
        if (s && s.name) out[s.id || sid] = s.name;
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  function countBlocks(rm) {
    if (!rm) return null;
    var byTc = Object.create(null);
    var total = 0;
    var nInterp = 0;
    var interps = rm.interpreters || {};
    for (var k in interps) {
      var it = interps[k];
      if (!it) continue;
      nInterp++;
      var tc = (it.metadata && it.metadata.typeclass_id) || '?';
      var n = 0;
      var pr = it.programs || {};
      for (var q in pr) {
        var sd = pr[q] && pr[q].static_data;
        if (!sd) continue;
        n += sd.length !== undefined ? sd.length : Object.keys(sd).length;
      }
      byTc[tc] = (byTc[tc] || 0) + n;
      total += n;
    }
    return { total: total, byTc: byTc, nInterp: nInterp };
  }

  /* ---------------- 面板 ---------------- */

  var CSS = [
    ':host{all:initial}',
    '.panel{position:absolute;top:8px;right:8px;width:372px;max-height:calc(100% - 16px);',
    'display:flex;flex-direction:column;border-radius:12px;overflow:hidden;',
    'background:rgba(13,16,21,.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);',
    'border:1px solid rgba(255,255,255,.1);box-shadow:0 14px 44px rgba(0,0,0,.55);',
    'color:#dfe6ef;font:12px/1.45 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;',
    'pointer-events:auto;letter-spacing:.01em}',
    '.hd{display:flex;align-items:center;gap:7px;padding:9px 10px 8px;border-bottom:1px solid rgba(255,255,255,.07)}',
    '.dot{width:6px;height:6px;border-radius:50%;background:#4ade80;box-shadow:0 0 8px #4ade80;flex:none}',
    '.hd b{font-weight:600;font-size:12px;flex:none}',
    '.sub{margin-left:2px;color:#7b8798;font-size:11px;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
    '.x{flex:none;width:18px;height:18px;border:0;border-radius:5px;background:transparent;color:#8b97a8;',
    'font-size:15px;line-height:1;cursor:pointer;padding:0}',
    '.x:hover{background:rgba(255,255,255,.1);color:#fff}',
    '.kpi{display:flex;gap:1px;background:rgba(255,255,255,.06);border-bottom:1px solid rgba(255,255,255,.07)}',
    '.k{flex:1;background:rgba(13,16,21,.92);padding:8px 10px 7px;min-width:0}',
    '.k i{display:block;color:#78859a;font-style:normal;font-size:10px;letter-spacing:.06em;white-space:nowrap}',
    '.k b{display:inline-block;font-size:17px;font-weight:600;font-variant-numeric:tabular-nums;color:#f2f6fb;line-height:1.25}',
    '.k em{font-style:normal;font-size:10px;color:#6d7a8c;margin-left:2px}',
    '.k.hot b{color:#ffb170}',
    '.bar{display:flex;justify-content:space-between;align-items:baseline;padding:9px 10px 5px;color:#8b97a8;font-size:10.5px;letter-spacing:.05em}',
    '.bar span:last-child{color:#5f6b7d;font-variant-numeric:tabular-nums}',
    '.list{overflow:auto;padding:0 10px 2px;min-height:0}',
    '.list::-webkit-scrollbar{width:7px}',
    '.list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border-radius:4px}',
    '.row{display:grid;align-items:center;gap:7px}',
    '.row.actor{grid-template-columns:10px 80px 1fr 46px;height:20px;cursor:pointer;border-radius:4px}',
    '.row.actor:hover{background:rgba(255,255,255,.05)}',
    '.ar{color:#6d7a8c;font-size:8px;text-align:center;line-height:1}',
    '.nm{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#c3ccda;font-size:11px}',
    '.tr{height:5px;border-radius:3px;background:rgba(255,255,255,.07);overflow:hidden}',
    '.tr i{display:block;height:100%;border-radius:3px;transition:width .18s linear}',
    '.pc{text-align:right;font-variant-numeric:tabular-nums;color:#9aa7b8;font-size:10.5px}',
    '.row.actor.top .nm{color:#fff}',
    '.row.actor.top .pc{color:#ffc08a}',
    '.row.fn{grid-template-columns:10px 80px 1fr 82px;height:18px}',
    '.row.fn .nm{padding-left:6px;color:#8e9aab;font-size:10.5px}',
    '.row.fn .tr{height:4px}',
    '.row.fn .pc{font-size:9.5px;color:#7d8a9b}',
    '.row.fn .pc b{color:#aab6c6;font-weight:500}',
    '.row.fn .pc s{text-decoration:none;color:#5f6b7d;margin-left:6px}',
    '.row.sum{grid-template-columns:10px 1fr 82px;height:17px}',
    '.row.sum .nm{padding-left:6px;color:#5f6b7d;font-size:9.5px}',
    '.row.sum .pc{font-size:9.5px;color:#6f7c8e}',
    '.ft{padding:7px 10px 9px;border-top:1px solid rgba(255,255,255,.07);color:#6f7c8e;font-size:10.5px;',
    'display:flex;justify-content:space-between;gap:8px}',
    '.ft b{color:#98a5b6;font-weight:500;font-variant-numeric:tabular-nums}',
  ].join('');

  function build() {
    if (S.host) return;
    var host = document.createElement('div');
    host.id = 'k4p-prof';
    host.style.cssText = 'position:fixed;top:0;right:0;bottom:0;width:388px;z-index:2147483000;pointer-events:none;';
    var sr = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    sr.innerHTML =
      '<style>' + CSS + '</style>' +
      '<div class="panel">' +
      '<div class="hd"><span class="dot"></span><b>运行信息</b><span class="sub" id="sub">采样中…</span>' +
      '<button class="x" id="close" title="关闭 (F9)">×</button></div>' +
      '<div class="kpi">' +
      '<div class="k"><i>帧率</i><b id="kFps">--</b><em>fps</em></div>' +
      '<div class="k hot"><i>脚本 / 帧</i><b id="kMs">--</b><em>ms</em></div>' +
      '<div class="k"><i>执行积木</i><b id="kBlk">--</b><em>块/帧</em></div>' +
      '</div>' +
      '<div class="bar"><span>角色脚本耗时占比</span><span id="kMeta"></span></div>' +
      '<div class="list" id="list"></div>' +
      '<div class="ft"><span>其中 · 引擎与调度开销</span><b id="kOther">--</b></div>' +
      '</div>';
    S.host = host;
    S.root = sr;
    document.documentElement.appendChild(host);
    sr.getElementById('close').addEventListener('click', hide);
    S.listEl = sr.getElementById('list');
    S.el = {
      sub: sr.getElementById('sub'),
      fps: sr.getElementById('kFps'),
      ms: sr.getElementById('kMs'),
      blk: sr.getElementById('kBlk'),
      meta: sr.getElementById('kMeta'),
      other: sr.getElementById('kOther'),
    };
  }

  function nameOf(tc, names) {
    var n = names[tc];
    if (n) return n;
    if (sceneIds[tc]) return '场景脚本';
    return String(tc).slice(0, 8);
  }

  function colorFor(pct) {
    // 按绝对占比上色：越高越暖（≥25% 红，20% 橙，10% 绿，<3% 青蓝）
    var t = Math.max(0, Math.min(1, pct / 25));
    var h = 8 + 192 * Math.pow(1 - t, 1.15);
    return 'hsl(' + h.toFixed(0) + ',86%,60%)';
  }

  function fnName(pid) {
    if (pid === '__main__') return '主脚本';
    return String(pid);
  }

  function fmtInt(n) {
    return n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n));
  }

  /* ---------- 行复用 ---------- */

  function ensureRow(i, kind) {
    var list = S.listEl;
    var row = list.children[i];
    if (row && row.dataset.kind === kind) return row;
    if (!row) {
      row = document.createElement('div');
      list.appendChild(row);
    }
    row.dataset.kind = kind;
    row.className = 'row ' + kind;
    if (kind === 'actor') {
      row.innerHTML = '<span class="ar"></span><span class="nm"></span><span class="tr"><i></i></span><span class="pc"></span>';
      row.addEventListener('click', function () {
        var tc = row.dataset.tc;
        if (!tc) return;
        if (S.open[tc]) delete S.open[tc];
        else S.open[tc] = 1;
        renderLast();
      });
    } else if (kind === 'fn') {
      row.innerHTML = '<span class="ar"></span><span class="nm"></span><span class="tr"><i></i></span>' +
        '<span class="pc"><b></b><s></s></span>';
    } else {
      row.innerHTML = '<span class="ar"></span><span class="nm"></span><span class="pc"></span>';
    }
    return row;
  }

  function trimRows(n) {
    var list = S.listEl;
    while (list.children.length > n) list.removeChild(list.lastChild);
  }

  /* ---------- 渲染 ---------- */

  var lastPaint = null;

  function renderLast() {
    if (lastPaint) paint(lastPaint);
  }

  function paint(ctx) {
    var names = ctx.names;
    var list = S.listEl;
    var acts = ctx.acts;
    var denom = ctx.denom;

    var idx = 0;
    var i, j;

    // 首次采样自动展开最耗时的角色，方便一眼看到函数分布
    if (!S.autoOpened && acts.length) {
      S.autoOpened = true;
      if (!Object.keys(S.open).length) S.open[acts[0][0]] = 1;
    }

    for (i = 0; i < acts.length; i++) {
      var tc = acts[i][0];
      var ms = acts[i][1];
      var b = acts[i][3];
      var pct = ms / denom * 100;
      var open = !!S.open[tc];

      var row = ensureRow(idx, 'actor');
      row.dataset.tc = tc;
      row.firstChild.textContent = open ? '▾' : '▸';
      row.children[1].textContent = tc === '__rest' ? ('其余 ' + acts[i][2] + ' 个角色') : nameOf(tc, names);
      var bar = row.children[2].firstChild;
      bar.style.width = Math.max(1.5, Math.min(100, pct)).toFixed(1) + '%';
      bar.style.background = colorFor(pct);
      row.children[3].textContent = pct >= 10 ? pct.toFixed(1) + '%' : pct.toFixed(2) + '%';
      row.classList.toggle('top', i === 0);
      if (tc === '__rest') {
        row.title = '其余 ' + acts[i][2] + ' 个角色合计 ' + ms.toFixed(2) + ' ms/帧';
        row.firstChild.textContent = '';
      } else {
        var sblk = S.blocks && S.blocks.byTc[tc] ? '，静态积木 ' + S.blocks.byTc[tc] + ' 块' : '';
        row.title = nameOf(tc, names) + '：' + ms.toFixed(2) + ' ms/帧，占脚本时间 ' + pct.toFixed(1) +
          '%，执行积木 ' + fmtInt(b.blk / Math.max(1, ctx.frames)) + ' 块/帧' + sblk;
      }
      idx++;

      if (!open || !b) continue;

      var fns = ctx.fnCache.get(tc);
      if (!fns) {
        fns = [];
        b.procs.forEach(function (v, k) { fns.push([k, v]); });
        fns.sort(function (a, c) { return c[1].self - a[1].self; });
        ctx.fnCache.set(tc, fns);
      }

      var nShow = fns.length > 8 ? 8 : fns.length;
      var sumN = 0;
      for (j = 0; j < nShow; j++) {
        var f = fns[j];
        var fms = f[1].self / ctx.frames;
        var fpct = fms / denom * 100;
        sumN += f[1].n;
        var fr = ensureRow(idx, 'fn');
        fr.children[1].textContent = fnName(f[0]);
        var fb = fr.children[2].firstChild;
        fb.style.width = Math.max(1.5, Math.min(100, fpct)).toFixed(1) + '%';
        fb.style.background = colorFor(fpct);
        fr.children[3].firstChild.textContent = fms.toFixed(fms < 10 ? 2 : 1) + 'ms';
        fr.children[3].lastChild.textContent = fpct >= 10 ? fpct.toFixed(0) + '%' : fpct.toFixed(1) + '%';
        fr.title = fnName(f[0]) + '\n自身 ' + fms.toFixed(2) + ' ms/帧（占 ' + fpct.toFixed(1) + '%）' +
          '\n含子调用 ' + (f[1].inc / ctx.frames).toFixed(2) + ' ms/帧' +
          '\n调用 ' + fmtInt(f[1].n / Math.max(1, ctx.frames)) + ' 次/帧';
        idx++;
      }
      if (fns.length > nShow) {
        var restMs = 0;
        for (j = nShow; j < fns.length; j++) { restMs += fns[j][1].self / ctx.frames; sumN += fns[j][1].n; }
        var rr = ensureRow(idx, 'fn');
        rr.children[1].textContent = '其余 ' + (fns.length - nShow) + ' 个函数';
        var rb = rr.children[2].firstChild;
        rb.style.width = Math.max(1.5, Math.min(100, restMs / denom * 100)).toFixed(1) + '%';
        rb.style.background = '#4b5768';
        rr.children[3].firstChild.textContent = restMs.toFixed(restMs < 10 ? 2 : 1) + 'ms';
        rr.children[3].lastChild.textContent = (restMs / denom * 100).toFixed(1) + '%';
        rr.title = '其余 ' + (fns.length - nShow) + ' 个函数合计 ' + restMs.toFixed(2) + ' ms/帧';
        idx++;
      }

      // 合计：该角色全部函数自身耗时之和（= 角色脚本时间），以及调用次数
      var sr2 = ensureRow(idx, 'sum');
      sr2.children[1].textContent = '合计 ' + fns.length + ' 函数 · ' + fmtInt(sumN / Math.max(1, ctx.frames)) + ' 次/帧';
      sr2.children[2].textContent = ms.toFixed(2) + ' ms · ' + pct.toFixed(1) + '%';
      idx++;
    }

    trimRows(idx);
    void list;
  }

  function render(frameAvg, fps, blocks, nInterp, frames) {
    var names = actorNames();

    var acts = [];
    var sum = 0;
    for (var tc in S.acc) {
      var b = S.acc[tc];
      if (!(b.ms > 0.0005)) continue;
      acts.push([tc, b.ms / frames, 0, b]);
      sum += b.ms / frames;
    }
    acts.sort(function (a, c) { return c[1] - a[1]; });

    var nAll = acts.length;
    if (nAll > 10) {
      var restMs = 0;
      var rb = null;
      for (var j = 10; j < nAll; j++) {
        restMs += acts[j][1];
        if (!rb) rb = { ms: 0, blk: 0, procs: new Map() };
        rb.ms += acts[j][1];
        rb.blk += acts[j][3].blk;
      }
      acts = acts.slice(0, 10);
      acts.push(['__rest', restMs, nAll - 10, rb]);
    }

    var denom = frameAvg > 0 ? frameAvg : 1;
    var other = frameAvg - sum;

    lastPaint = { names: names, acts: acts, denom: denom, frames: frames, fnCache: new Map() };
    paint(lastPaint);

    S.el.ms.textContent = frameAvg.toFixed(frameAvg < 10 ? 2 : 1);
    S.el.ms.title = '脚本每帧耗时（上一窗口峰值 ' + S.maxFrame.toFixed(1) + ' ms）';
    S.el.fps.textContent = fps ? fps.toFixed(0) : '--';
    S.el.blk.textContent = frames > 0 ? fmtInt(sumBlk() / frames) : '--';
    S.el.blk.title = '每帧执行的积木次数（生成代码里每个积木经过一次让出检查算一次）\n' +
      '静态积木 ' + (blocks && blocks.total ? blocks.total.toLocaleString('en-US') : '--') + ' 块';
    S.el.meta.textContent = nAll + ' 角色·' + (nInterp || 0) + ' 解释器';
    S.el.other.textContent = (other < 0 ? 0 : other).toFixed(1) + ' ms · ' +
      (denom > 0 ? Math.max(0, other) / denom * 100 : 0).toFixed(0) + '%';
    var idle = fps > 0 ? Math.max(0, 1000 / fps - frameAvg) : 0;
    S.el.sub.textContent = idle > 0 ? '帧内空转 ' + idle.toFixed(1) + ' ms' : '';
  }

  function sumBlk() {
    var n = 0;
    for (var tc in S.acc) n += S.acc[tc].blk;
    return n;
  }

  /* ---------------- 采样 ---------------- */

  function sample() {
    if (!S.on) return;
    var t = now();
    var rm = getRm();
    if (rm) {
      hook(rm);
      // 静态积木数只在解释器数量变化或隔 5 秒后重算
      var f = rm.frames || 0;
      if (!S.blocks || !S.blocksAt || f < S.blocksAt || f - S.blocksAt > 300) {
        var b = countBlocks(rm);
        if (b) { S.blocks = b; S.blocksAt = f; }
      }
    }

    var frames = S.accFrames;
    if (frames < 1) {
      S.el.sub.textContent = '等待运行时…';
      S.winStart = t;
      return;
    }
    var frameAvg = S.accTotal / frames;
    var elapsed = t - S.winStart;
    var fps = elapsed > 50 ? (frames * 1000) / elapsed : 0;

    render(frameAvg, fps, S.blocks, S.blocks && S.blocks.nInterp, frames);

    resetAcc();
    S.winStart = t;
  }

  function show() {
    build();
    if (S.on) return;
    S.on = true;
    S.host.style.display = '';
    resetAcc();
    S.winStart = now();
    var rm = getRm();
    if (rm) {
      hook(rm);
      S.blocks = countBlocks(rm);
    }
    S.timer = setInterval(sample, 400);
    sample();
  }

  function hide() {
    if (!S.on) return;
    S.on = false;
    clearInterval(S.timer);
    S.timer = null;
    if (S.host) S.host.style.display = 'none';
    unpatchInterps(getRm());
    unhook();
  }

  window.__k4pProf = {
    show: show,
    hide: hide,
    toggle: function () { if (S.on) hide(); else show(); },
    isOn: function () { return S.on; },
    // 调试：直接取一次原始快照（不依赖面板）
    snapshot: function () {
      var rm = getRm();
      var out = { frame: S.accFrames ? S.accTotal / S.accFrames : 0, blocks: countBlocks(rm), roles: {} };
      for (var tc in S.acc) {
        var b = S.acc[tc];
        var fns = {};
        b.procs.forEach(function (v, k) { fns[k] = { self: +v.self.toFixed(3), inc: +v.inc.toFixed(3), n: v.n }; });
        out.roles[tc] = { ms: +b.ms.toFixed(3), blk: b.blk, fns: fns };
      }
      return out;
    },
  };

  // 外壳按钮 / 快捷键
  window.addEventListener('keydown', function (e) {
    if (e.key === 'F9') {
      e.preventDefault();
      window.__k4pProf.toggle();
    }
  }, true);
})();
