'use strict';
/**
 * 运行信息面板（页面侧）
 *
 * 右侧浮层，两个页签：
 *   - 进程：角色总消耗（按 typeclass 归并，克隆体算同一角色）
 *   - 详细信息：分列调用树。根列是角色，点一行就在**左侧**展开一列它的子调用，
 *     每列按消耗从大到小排；整条可拖动 / Shift+滚轮横向平移，列内滚轮竖向滚动。
 *
 * 数据全部取运行时自己的对象，不解析生成代码：
 *   - run_mgr.update            → 一帧的脚本时间（含调度）
 *   - OptiRunner.do_step        → 一次「执行栈顶函数的一段脚本」，据此计时：
 *                                 进入前读栈顶 proc_id 归「自身耗时」，
 *                                 栈上每个 proc 都累加 → 「含子调用」，
 *                                 栈顶换人时记一条 父 → 子 的调用边
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
  var COLW = 176;              // 详细信息每列宽度（与 CSS 保持一致）

  var S = {
    on: false,
    hookedProto: null,
    itProto: null,
    origUpdate: null,
    origStep: null,
    origDo: null,
    acc: null,                 // tc -> { ms, blk, procs: Map<pid,{pid,self,inc,n}>, edges: Map<parent,Map<child,{ms,n}>> }
    accTotal: 0,
    accFrames: 0,
    maxFrame: 0,
    lastFrames: -1,
    blocks: null,              // 静态积木数（参考）
    blocksAt: 0,
    host: null,
    root: null,
    el: null,
    procList: null,
    stripEl: null,
    timer: null,
    winStart: 0,
    tab: 'proc',               // 'proc' | 'det'
    dsel: { actor: null, path: [] },
    detSig: '',
    detNodes: [],
    detHeads: [],
    animCol: -1,
    detFresh: false,
    dragged: false,
    lastFps: 0,
    lastCtx: null,
  };

  S.acc = Object.create(null);

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
      b = S.acc[tc] = { ms: 0, blk: 0, procs: new Map(), edges: new Map() };
    }
    return b;
  }

  function procRec(b, pid) {
    var p = b.procs.get(pid);
    if (!p) {
      p = { pid: pid, self: 0, inc: 0, n: 0 };
      b.procs.set(pid, p);
    }
    return p;
  }

  function edgeRec(b, parent, child) {
    var m = b.edges.get(parent);
    if (!m) {
      m = new Map();
      b.edges.set(parent, m);
    }
    var e = m.get(child);
    if (!e) {
      e = { ms: 0, n: 0 };
      m.set(child, e);
    }
    return e;
  }

  function resetAcc() {
    for (var tc in S.acc) {
      var b = S.acc[tc];
      b.ms = 0;
      b.blk = 0;
      b.procs.clear();
      b.edges.clear();
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
        it.__k4pD = undefined;
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
    // 把这段区间记给当时正在执行的函数（自身）、它所有祖先（含子调用）以及
    // 一条「父 → 子」的调用边（详细信息页的调用树就是靠这些边长出来的）。
    // 这样每次 do_step 只是一次字符串比较，不会把运行时拖慢。
    var origDo = S.origDo;
    itProto.do_step = function () {
      var st = this.program_state.proc_stack;
      var d = st.length;
      var top = d ? st[d - 1].proc_id : null;
      var prevD = this.__k4pD;
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

        var parent = d >= 2 ? st[d - 2].proc_id : '__root__';
        var e = edgeRec(b, parent, top);
        // 栈变深 = 一次进入调用；进入段首也算一次
        if (prevD === undefined || d > prevD) e.n++;
        this.__k4pEdge = e;
      }
      this.__k4pD = d;
      return origDo.apply(this, arguments);
    };
  }

  /** 结算解释器上一段：记给当前函数（自身）、栈上全部祖先（含子调用）和它所处的调用边 */
  function settle(it, t) {
    var path = it.__k4pPath;
    var b = it.__k4pB;
    if (!path || !b || it.__k4pSegT === undefined) return;
    var dt = t - it.__k4pSegT;
    it.__k4pSegT = t;
    if (!(dt > 0)) return;
    b.ms += dt;
    for (var i = 0; i < path.length; i++) path[i].inc += dt;
    if (path.length) path[path.length - 1].self += dt;
    if (it.__k4pEdge) it.__k4pEdge.ms += dt;
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
    '.panel{position:absolute;top:8px;right:8px;width:376px;max-height:calc(100% - 16px);',
    'display:flex;flex-direction:column;border-radius:12px;overflow:hidden;',
    'background:rgba(13,16,21,.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);',
    'border:1px solid rgba(255,255,255,.1);box-shadow:0 14px 44px rgba(0,0,0,.55);',
    'color:#dfe6ef;font:12px/1.45 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;',
    'pointer-events:auto;letter-spacing:.01em;transition:width .2s ease}',
    '.panel.det{width:min(70vw,548px)}',

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

    '.tabs{display:flex;gap:4px;padding:6px 8px 5px;border-bottom:1px solid rgba(255,255,255,.07)}',
    '.tab{border:0;background:transparent;color:#8b97a8;font:inherit;font-size:11px;padding:4px 12px;',
    'border-radius:7px;cursor:pointer;transition:background .12s,color .12s}',
    '.tab:hover{background:rgba(255,255,255,.06);color:#cfd8e4}',
    '.tab.on{background:rgba(255,255,255,.13);color:#fff;font-weight:600}',

    '.pane{flex:1;min-height:0;display:flex;flex-direction:column}',
    '.pane[hidden]{display:none}',

    '.thead{display:grid;grid-template-columns:minmax(52px,1fr) 96px 42px 52px;gap:6px;',
    'padding:7px 10px 5px;color:#6f7c8e;font-size:9.5px;letter-spacing:.05em}',
    '.thead span:nth-child(n+2){text-align:right}',
    '.rows{overflow-y:auto;overflow-x:hidden;padding:0 10px 3px;min-height:0;flex:1}',
    '.rows::-webkit-scrollbar{width:7px}',
    '.rows::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border-radius:4px}',

    '.row.actor{display:grid;align-items:center;grid-template-columns:minmax(52px,1fr) 96px 42px 52px;',
    'gap:6px;height:22px;border-radius:4px;padding:0 0}',
    '.row.actor:hover{background:rgba(255,255,255,.05)}',
    '.nm{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#c3ccda;font-size:11px}',
    '.tr{height:5px;border-radius:3px;background:rgba(255,255,255,.07);overflow:hidden}',
    '.tr i{display:block;height:100%;border-radius:3px;transition:width .18s linear}',
    '.pc{text-align:right;font-variant-numeric:tabular-nums;color:#9aa7b8;font-size:10.5px}',
    '.ms{text-align:right;font-variant-numeric:tabular-nums;color:#8e9aab;font-size:10px}',
    '.row.actor.top .nm{color:#fff}',
    '.row.actor.top .pc{color:#ffc08a}',
    '.row.actor.top .ms{color:#c8a58a}',

    /* ---- 详细信息：分列调用树 ---- */
    '.strip{flex:1;min-height:0;display:flex;overflow-x:auto;overflow-y:hidden;cursor:grab}',
    '.strip.drag{cursor:grabbing}',
    '.strip::-webkit-scrollbar{height:7px}',
    '.strip::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border-radius:4px}',
    '.strip::-webkit-scrollbar-track{background:rgba(255,255,255,.03)}',
    '.col{flex:none;width:176px;display:flex;flex-direction:column;min-height:0;',
    'border-right:1px solid rgba(255,255,255,.06)}',
    '.col:last-child{border-right:0}',
    '.col.in{animation:slideL .22s cubic-bezier(.2,.8,.3,1)}',
    '@keyframes slideL{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:none}}',
    '.ch{padding:6px 8px 5px;border-bottom:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.025)}',
    '.ch b{display:block;font-size:11px;font-weight:600;color:#e7edf5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.ch s{text-decoration:none;display:block;font-size:9.5px;color:#6f7c8e;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.cl{flex:1;overflow-y:auto;overflow-x:hidden;min-height:0;padding-bottom:4px}',
    '.cl::-webkit-scrollbar{width:6px}',
    '.cl::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:3px}',
    '.drow{padding:5px 8px 4px;cursor:pointer;border-left:2px solid transparent}',
    '.drow:hover{background:rgba(255,255,255,.06)}',
    '.dl{display:flex;justify-content:space-between;gap:6px;align-items:baseline}',
    '.dn{font-size:10.5px;color:#c3ccda;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
    '.dm{font-size:9.5px;color:#8e9aab;font-variant-numeric:tabular-nums;flex:none}',
    '.drow.sel{background:rgba(96,165,250,.13);border-left-color:#60a5fa}',
    '.drow.top .dn{color:#fff}',
    '.drow.top .dm{color:#ffc08a}',
    '.db{height:2px;border-radius:2px;background:rgba(255,255,255,.07);margin-top:4px;overflow:hidden}',
    '.db i{display:block;height:100%;border-radius:2px;transition:width .2s linear}',
    '.empty{padding:14px 10px;color:#5f6b7d;font-size:10px;line-height:1.6}',

    '.ft{padding:7px 10px 9px;border-top:1px solid rgba(255,255,255,.07);color:#6f7c8e;font-size:10.5px;',
    'display:flex;justify-content:space-between;gap:8px}',
    '.ft span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
    '.ft b{color:#98a5b6;font-weight:500;font-variant-numeric:tabular-nums;flex:none}',
  ].join('');

  function build() {
    if (S.host) return;
    var host = document.createElement('div');
    host.id = 'k4p-prof';
    host.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483000;pointer-events:none;';
    var sr = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    sr.innerHTML =
      '<style>' + CSS + '</style>' +
      '<div class="panel" id="panel">' +
      '<div class="hd"><span class="dot"></span><b>运行信息</b><span class="sub" id="sub"></span>' +
      '<button class="x" id="close" title="关闭 (F9)">×</button></div>' +
      '<div class="kpi">' +
      '<div class="k"><i>帧率</i><b id="kFps">--</b><em>fps</em></div>' +
      '<div class="k hot"><i>脚本 / 帧</i><b id="kMs">--</b><em>ms</em></div>' +
      '<div class="k"><i>执行积木</i><b id="kBlk">--</b><em>块/帧</em></div>' +
      '</div>' +
      '<div class="tabs"><button class="tab on" id="tbProc">进程</button>' +
      '<button class="tab" id="tbDet">详细信息</button></div>' +
      '<div class="pane" id="paneProc">' +
      '<div class="thead"><span>角色</span><span>耗时占比</span><span>占比</span><span>ms/帧</span></div>' +
      '<div class="rows" id="procList"></div>' +
      '</div>' +
      '<div class="pane" id="paneDet" hidden><div class="strip" id="strip"></div></div>' +
      '<div class="ft"><span id="ftL">其中 · 引擎与调度</span><b id="kOther">--</b></div>' +
      '</div>';
    S.host = host;
    S.root = sr;
    document.documentElement.appendChild(host);
    S.procList = sr.getElementById('procList');
    S.stripEl = sr.getElementById('strip');
    S.panelEl = sr.getElementById('panel');
    S.el = {
      sub: sr.getElementById('sub'),
      fps: sr.getElementById('kFps'),
      ms: sr.getElementById('kMs'),
      blk: sr.getElementById('kBlk'),
      other: sr.getElementById('kOther'),
      ftL: sr.getElementById('ftL'),
    };
    sr.getElementById('close').addEventListener('click', hide);
    sr.getElementById('tbProc').addEventListener('click', function () { setTab('proc'); });
    sr.getElementById('tbDet').addEventListener('click', function () { setTab('det'); });
    bindStrip();
  }

  function setTab(t) {
    if (S.tab === t) return;
    S.tab = t;
    var on = t === 'det';
    S.root.getElementById('tbProc').classList.toggle('on', !on);
    S.root.getElementById('tbDet').classList.toggle('on', on);
    S.root.getElementById('paneProc').hidden = on;
    S.root.getElementById('paneDet').hidden = !on;
    S.panelEl.classList.toggle('det', on);
    S.el.ftL.textContent = on ? '拖动 / Shift+滚轮 横向平移 · 点一行向左展开' : '其中 · 引擎与调度';
    if (on) { S.detSig = ''; S.animCol = -1; S.detFresh = true; }
    if (S.lastCtx) paint(S.lastCtx, S.lastFps);
  }

  /* ---------------- 拖动 / 滚轮 ---------------- */

  function bindStrip() {
    var strip = S.stripEl;
    var down = false, moved = false, sx = 0, sl = 0;

    strip.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      down = true; moved = false; sx = e.clientX; sl = strip.scrollLeft;
    });
    window.addEventListener('pointermove', function (e) {
      if (!down) return;
      var dx = e.clientX - sx;
      if (!moved && Math.abs(dx) > 4) { moved = true; strip.classList.add('drag'); }
      if (moved) strip.scrollLeft = sl - dx;
    });
    window.addEventListener('pointerup', function () {
      if (!down) return;
      down = false;
      strip.classList.remove('drag');
      if (moved) {
        S.dragged = true;
        setTimeout(function () { S.dragged = false; }, 0);
      }
    });
    // 竖向滚轮交给列自己；Shift 或横向滚轮平移整条
    strip.addEventListener('wheel', function (e) {
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        strip.scrollLeft += (e.deltaX || e.deltaY);
        e.preventDefault();
      }
    }, { passive: false });

    strip.addEventListener('click', function (e) {
      if (S.dragged) return;
      var el = e.target;
      while (el && el !== strip && !(el.classList && el.classList.contains('drow'))) el = el.parentNode;
      if (!el || el === strip) return;
      var lvl = +el.dataset.lvl;
      var pid = el.dataset.pid;
      if (!pid) return;
      if (lvl === 0) {
        if (S.dsel.actor === pid) return;
        S.dsel.actor = pid;
        S.dsel.path = [];
      } else {
        var cur = S.dsel.path[lvl - 1];
        if (cur === pid && S.dsel.path.length === lvl) return;
        S.dsel.path = S.dsel.path.slice(0, lvl - 1).concat(pid);
      }
      S.detSig = '';
      S.animCol = -2;          // 动画给最深的一列
      if (S.lastCtx) paint(S.lastCtx, S.lastFps);
    });
  }

  /* ---------------- 文本工具 ---------------- */

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

  function fmtMs(v) {
    if (!(v > 0)) return '0';
    return v < 10 ? v.toFixed(2) : v.toFixed(1);
  }

  /* ---------------- 进程页 ---------------- */

  function ensureActRow(i) {
    var list = S.procList;
    var row = list.children[i];
    if (row) return row;
    row = document.createElement('div');
    row.className = 'row actor';
    row.innerHTML = '<span class="nm"></span><span class="tr"><i></i></span>' +
      '<span class="pc"></span><span class="ms"></span>';
    row.style.cursor = 'pointer';
    // 点角色 → 直接跳到详细信息页看它的调用树
    row.addEventListener('click', function () {
      var tc = row.dataset.tc;
      if (!tc || tc === '__rest') return;
      S.dsel.actor = tc;
      S.dsel.path = [];
      setTab('det');
    });
    list.appendChild(row);
    return row;
  }

  function trimTo(list, n) {
    while (list.children.length > n) list.removeChild(list.lastChild);
  }

  function paintProc(ctx) {
    var acts = ctx.acts;
    var denom = ctx.denom;
    var names = ctx.names;
    var idx = 0;

    for (var i = 0; i < acts.length; i++) {
      var tc = acts[i][0];
      var ms = acts[i][1];
      var b = acts[i][3];
      var pct = ms / denom * 100;

      var row = ensureActRow(idx);
      row.dataset.tc = tc;
      row.children[0].textContent = tc === '__rest' ? ('其余 ' + acts[i][2] + ' 个角色') : nameOf(tc, names);
      var bar = row.children[1].firstChild;
      bar.style.width = Math.max(1.5, Math.min(100, pct)).toFixed(1) + '%';
      bar.style.background = colorFor(pct);
      row.children[2].textContent = pct >= 10 ? pct.toFixed(1) + '%' : pct.toFixed(2) + '%';
      row.children[3].textContent = fmtMs(ms);
      row.classList.toggle('top', i === 0);

      if (tc === '__rest') {
        row.title = '其余 ' + acts[i][2] + ' 个角色合计 ' + fmtMs(ms) + ' ms/帧';
      } else {
        var sblk = S.blocks && S.blocks.byTc[tc] ? '，静态积木 ' + S.blocks.byTc[tc] + ' 块' : '';
        row.title = nameOf(tc, names) + '：' + fmtMs(ms) + ' ms/帧，占脚本时间 ' + pct.toFixed(1) +
          '%，执行积木 ' + fmtInt(b.blk / Math.max(1, ctx.frames)) + ' 块/帧' + sblk +
          '\n点一下 → 到「详细信息」看它内部的函数';
      }
      idx++;
    }
    trimTo(S.procList, idx);
  }

  /* ---------------- 详细信息页：分列调用树 ---------------- */

  /** 某个父函数下面挂的子调用，按累计耗时降序 */
  function childrenOf(b, parent) {
    var out = [];
    var m = b.edges.get(parent);
    if (m) {
      m.forEach(function (e, child) {
        var cm = b.edges.get(child);
        out.push({ pid: child, ms: e.ms, n: e.n, kids: !!(cm && cm.size) });
      });
    }
    return out.sort(function (a, c) { return c.ms - a.ms; });
  }

  function detCols(ctx) {
    var cols = [];
    var denom = ctx.denom;
    var all = ctx.actsAll;

    var rows0 = [];
    for (var i = 0; i < all.length; i++) {
      var tc = all[i][0];
      var ms = all[i][1];
      rows0.push({
        key: 'a:' + tc, pid: tc, lvl: 0, label: nameOf(tc, ctx.names),
        ms: ms, pct: ms / denom * 100, hot: i === 0, calls: 0, sel: tc === S.dsel.actor,
      });
    }
    cols.push({
      id: 'actors',
      title: '角色',
      sub: all.length + ' 个 · 合计 ' + fmtMs(ctx.sum) + ' ms/帧',
      rows: rows0,
      maxMs: rows0.length ? rows0[0].ms : 1,
    });

    var actor = S.dsel.actor;
    if (!actor || !S.acc[actor]) actor = all.length ? all[0][0] : null;
    if (!actor) return cols;
    S.dsel.actor = actor;
    var b = S.acc[actor];

    var parent = '__main__';
    var path = [];
    var d = 0;
    while (d <= S.dsel.path.length) {
      var kids = childrenOf(b, parent);
      if (!kids.length && d === 0) {
        // 没有调用边（极少数作品主栈不是 __main__）：退化成一层的函数清单
        b.procs.forEach(function (v, k) {
          if (k === '__main__') return;
          kids.push({ pid: k, ms: v.inc, n: v.n, kids: false });
        });
        kids.sort(function (a, c) { return c.ms - a.ms; });
      }
      if (!kids.length) {
        cols.push({
          id: 'empty:' + parent + ':' + d,
          title: d === 0 ? nameOf(actor, ctx.names) : fnName(parent),
          sub: d === 0 ? '无函数级数据' : '叶子',
          rows: [], maxMs: 1,
          empty: d === 0
            ? '这个角色没有可统计的函数（空脚本 / 只跑克隆体）'
            : '没有更深的自定义积木调用',
        });
        break;
      }

      var prow = b.procs.get(parent);
      var krows = kids.map(function (k, j) {
        var v = k.ms / ctx.frames;
        return {
          key: 'k:' + k.pid, pid: k.pid, lvl: d + 1, label: fnName(k.pid),
          ms: v, pct: v / denom * 100, calls: k.n / ctx.frames,
          hot: j === 0, kids: k.kids,
        };
      });
      cols.push({
        id: 'n:' + parent + ':' + d,
        title: fnName(parent),
        sub: prow
          ? '自身 ' + fmtMs(prow.self / ctx.frames) + ' · 累计 ' + fmtMs(prow.inc / ctx.frames) + ' ms'
          : '',
        rows: krows,
        maxMs: krows.length ? krows[0].ms : 1,
      });

      if (d >= S.dsel.path.length) break;
      var want = S.dsel.path[d];
      var ok = false;
      for (var q = 0; q < kids.length; q++) if (kids[q].pid === want) { ok = true; break; }
      if (!ok) break;
      path.push(want);
      parent = want;
      d++;
    }
    S.dsel.path = path;
    return cols;
  }

  function rowTitle(r, ctx) {
    var s = r.label + '\n' + fmtMs(r.ms) + ' ms/帧 · 占脚本时间 ' + r.pct.toFixed(1) + '%';
    if (r.calls > 0) s += '\n调用 ' + fmtInt(r.calls) + ' 次/帧';
    if (r.kids === false) s += '\n（没有更深的调用）';
    return s;
  }

  function detSigOf(cols) {
    var parts = [];
    for (var i = 0; i < cols.length; i++) {
      var c = cols[i];
      var ks = [];
      for (var j = 0; j < c.rows.length; j++) ks.push(c.rows[j].key);
      parts.push(c.id + '#' + ks.join(','));
    }
    return parts.join('|');
  }

  function buildDet(cols, ctx) {
    var strip = S.stripEl;
    var animIdx = S.animCol === -2 ? cols.length - 1 : S.animCol;
    S.animCol = -1;
    var keepLeft = strip.scrollLeft;
    strip.innerHTML = '';
    S.detNodes = new Array(cols.length);
    S.detHeads = new Array(cols.length);

    // 反着放：最深的一列在最左，根列贴右 → 视觉上「向左展开」
    for (var i = cols.length - 1; i >= 0; i--) {
      var c = cols[i];
      var colEl = document.createElement('div');
      colEl.className = 'col' + (i === animIdx ? ' in' : '');

      var ch = document.createElement('div');
      ch.className = 'ch';
      var cb = document.createElement('b');
      var cs = document.createElement('s');
      cb.textContent = c.title;
      cs.textContent = c.sub;
      ch.appendChild(cb);
      ch.appendChild(cs);

      var cl = document.createElement('div');
      cl.className = 'cl';
      var refs = [];
      var cMax = c.maxMs > 0 ? c.maxMs : 1;
      if (c.empty) {
        var emp = document.createElement('div');
        emp.className = 'empty';
        emp.textContent = c.empty;
        cl.appendChild(emp);
      }
      for (var j = 0; j < c.rows.length; j++) {
        var r = c.rows[j];
        var row = document.createElement('div');
        row.className = 'drow' + (r.hot ? ' top' : '') + (r.sel ? ' sel' : '');
        row.dataset.lvl = r.lvl;
        row.dataset.pid = r.pid;

        var dl = document.createElement('div');
        dl.className = 'dl';
        var dn = document.createElement('span');
        dn.className = 'dn';
        dn.textContent = r.label;
        var dm = document.createElement('span');
        dm.className = 'dm';
        dm.textContent = fmtMs(r.ms);
        dl.appendChild(dn);
        dl.appendChild(dm);

        var db = document.createElement('div');
        db.className = 'db';
        var dbi = document.createElement('i');
        dbi.style.width = Math.max(2, Math.min(100, r.ms / cMax * 100)).toFixed(1) + '%';
        dbi.style.background = colorFor(r.pct);
        db.appendChild(dbi);

        row.appendChild(dl);
        row.appendChild(db);
        row.title = rowTitle(r, ctx);
        cl.appendChild(row);
        refs.push({ el: row, msEl: dm, barEl: dbi });
      }

      colEl.appendChild(ch);
      colEl.appendChild(cl);
      strip.appendChild(colEl);
      S.detNodes[i] = refs;
      S.detHeads[i] = cs;
    }

    // 新展开的列在最左，滚过去让它露出来；其余情况保持用户自己的平移位置
    if (animIdx >= 0) {
      try { strip.scrollTo({ left: 0, behavior: 'smooth' }); } catch (e) { strip.scrollLeft = 0; }
    }
    else if (S.detFresh) {
      strip.scrollLeft = strip.scrollWidth - strip.clientWidth;
      S.detFresh = false;
    } else {
      strip.scrollLeft = keepLeft;
    }
  }

  function updateDet(cols, ctx) {
    for (var i = 0; i < cols.length; i++) {
      var refs = S.detNodes[i];
      var rows = cols[i].rows;
      if (!refs || refs.length !== rows.length) return false;
      var cMax = cols[i].maxMs > 0 ? cols[i].maxMs : 1;
      for (var j = 0; j < rows.length; j++) {
        var r = rows[j];
        var ref = refs[j];
        ref.msEl.textContent = fmtMs(r.ms);
        ref.barEl.style.width = Math.max(2, Math.min(100, r.ms / cMax * 100)).toFixed(1) + '%';
        ref.barEl.style.background = colorFor(r.pct);
        ref.el.title = rowTitle(r, ctx);
      }
      if (S.detHeads[i]) S.detHeads[i].textContent = cols[i].sub;
    }
    return true;
  }

  function paintDet(ctx) {
    var cols = detCols(ctx);
    var sig = detSigOf(cols);
    if (sig !== S.detSig || !S.detNodes.length) {
      S.detSig = sig;
      buildDet(cols, ctx);
    } else if (!updateDet(cols, ctx)) {
      S.detSig = sig;
      buildDet(cols, ctx);
    }
  }

  /* ---------------- 采样与汇总 ---------------- */

  function makeCtx(frameAvg, frames) {
    var names = actorNames();
    var all = [];
    var sum = 0;
    for (var tc in S.acc) {
      var b = S.acc[tc];
      if (!(b.ms > 0.0005)) continue;
      var ms = b.ms / frames;
      all.push([tc, ms, 0, b]);
      sum += ms;
    }
    all.sort(function (a, c) { return c[1] - a[1]; });

    var acts = all;
    if (all.length > 10) {
      var restMs = 0;
      var rb = { ms: 0, blk: 0, procs: new Map(), edges: new Map() };
      for (var j = 10; j < all.length; j++) {
        restMs += all[j][1];
        rb.blk += all[j][3].blk;
      }
      acts = all.slice(0, 10);
      acts.push(['__rest', restMs, all.length - 10, rb]);
    }

    return {
      names: names, acts: acts, actsAll: all, sum: sum,
      denom: frameAvg > 0 ? frameAvg : 1, frames: frames,
    };
  }

  function paint(ctx, fps) {
    var frameAvg = ctx.denom;
    var frames = ctx.frames;
    var other = frameAvg - ctx.sum;

    if (S.tab === 'proc') paintProc(ctx);
    else paintDet(ctx);

    S.el.fps.textContent = fps ? fps.toFixed(0) : '--';
    S.el.ms.textContent = fmtMs(frameAvg);
    S.el.ms.title = '脚本每帧耗时（上一窗口峰值 ' + fmtMs(S.maxFrame) + ' ms）';
    S.el.blk.textContent = frames > 0 ? fmtInt(sumBlk() / frames) : '--';
    S.el.blk.title = '每帧执行的积木次数（生成代码里每个积木经过一次让出检查算一次）\n' +
      '静态积木 ' + (S.blocks && S.blocks.total ? S.blocks.total.toLocaleString('en-US') : '--') + ' 块';
    S.el.other.textContent = (other < 0 ? 0 : other).toFixed(1) + ' ms · ' +
      (frameAvg > 0 ? Math.max(0, other) / frameAvg * 100 : 0).toFixed(0) + '%';
  }

  function sumBlk() {
    var n = 0;
    for (var tc in S.acc) n += S.acc[tc].blk;
    return n;
  }

  function sample() {
    if (!S.on) return;
    var t = now();
    var rm = getRm();
    if (rm) {
      hook(rm);
      // 静态积木数只在解释器数量变化或隔一段时间后重算
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

    var ctx = makeCtx(frameAvg, frames);
    S.lastCtx = ctx;
    S.lastFps = fps;
    paint(ctx, fps);

    var nInterp = S.blocks && S.blocks.nInterp;
    var idle = fps > 0 ? Math.max(0, 1000 / fps - frameAvg) : 0;
    S.el.sub.textContent = (ctx.actsAll.length + ' 角色 · ' + (nInterp || 0) + ' 解释器') +
      (idle > 0 ? ' · 空转 ' + idle.toFixed(1) + ' ms' : '');

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
    tab: function (t) { if (t === 'proc' || t === 'det') setTab(t); return S.tab; },
    // 调试：直接取一次原始快照（不依赖面板）
    snapshot: function () {
      var rm = getRm();
      var out = { frame: S.accFrames ? S.accTotal / S.accFrames : 0, blocks: countBlocks(rm), roles: {} };
      for (var tc in S.acc) {
        var b = S.acc[tc];
        var fns = {};
        b.procs.forEach(function (v, k) { fns[k] = { self: +v.self.toFixed(3), inc: +v.inc.toFixed(3), n: v.n }; });
        var ed = {};
        b.edges.forEach(function (m, p) {
          var o = {};
          m.forEach(function (e, c) { o[c] = { ms: +e.ms.toFixed(3), n: e.n }; });
          ed[p] = o;
        });
        out.roles[tc] = { ms: +b.ms.toFixed(3), blk: b.blk, fns: fns, edges: ed };
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
