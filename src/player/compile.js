/**
 * 本地作品预编译器（页面侧）
 *
 * 背景：官方播放器内核只认作品里的 `compile_result`（积木树），而编辑器保存的
 * .bcm4 只有在"运行过一次"之后才会带上它。很多本地作品没有这个字段，播放器
 * 就会直接报「打开作品失败」。
 *
 * 做法：player_v2 内核自带完整编译器（JSONEntityCompilerImpl）。本脚本在页面
 * 层拦住作品 JSON 的响应，用内核自己的编译器把 `block_data_json` 编译成
 * `compile_result`，补进作品对象后再交给播放器 —— 对播放器完全透明。
 *
 * 编译规则与编辑器保存时一致（逆向自 build/kitten.*.js 的保存流程）：
 *   1. JSONEntityCompiler.compile({id, blocksJSON})
 *   2. Util.misc.ce_without_cyclical_references()  去掉 parent_block 循环引用
 *   3. Util.block.ast_for_each -> params.NUM 转字符串
 *   4. running_group_id[blockId] = 实体所属场景 id（start_on_click / start_as_a_mirror 除外）
 */
(function () {
  'use strict';
  if (window.__k4pCompileInstalled) return;
  window.__k4pCompileInstalled = true;

  var LOG = [];
  function log() {
    try {
      var a = [].slice.call(arguments);
      LOG.push(a.map(function (x) { return typeof x === 'string' ? x : JSON.stringify(x); }).join(' '));
      if (LOG.length > 200) LOG.shift();
      if (window.__K4P__) window.__K4P__.compileLog = LOG;
      console.log('[k4p:compile]', a.join(' '));
    } catch (_) {}
  }

  // 作品数据地址：绝对或相对都算（播放器两次请求里，一次用绝对 URL、一次用相对路径）
  var PROJECT_RE = /^(?:(?:https?:)?\/\/[^/]+)?\/new\/[0-9a-f]{16}(?:\?|$)/;
  function isProjectUrl(url) {
    return !!url && PROJECT_RE.test(String(url));
  }

  // 容器就绪（player_v2 的 DI 容器在启动早期创建，见 runtime 注入的 window.__k4c）
  function containerReady() {
    return !!(window.__k4c && window.__k4b && window.__k4b.JSONEntityCompiler);
  }

  function setBootText(t) {
    var el = document.querySelector('#k4p-boot span');
    if (el) el.textContent = t;
  }

  // ---------- 生成代码优化（阶段2） ----------
  /**
   * 官方生成的 optifun 里有两类纯开销：
   *   a) 每条语句前 `if (X.EB('blk','ent','rbid',g,n)) { return; }case n:`
   *      —— EB（step_before_expression）只会写一次 program_counter 再返回 false，
   *         永不 yield。它存在的意义是让编辑器点亮"当前运行积木"，播放器不需要。
   *   b) 每条语句后 `X.ED('ent','rbid',g,n); case n:`
   *      —— ED 只做 program_counter[g]=n，完全可以内联。
   *
   * 两者都由生成器状态（Compiler 内部的 state 对象）的方法产出，这里直接替换
   * 这两个方法，不动官方 bundle。case 编号只用于 switch 跳转表，program_counter
   * 数组的长度由 yield group 数量决定，所以缩编号不影响分配。
   */
  var CG = { enabled: true, patched: false, installed: false, mode: 'both' };

  function patchState(sp) {
    if (typeof sp.create_before_expression_yield_point !== 'function' ||
        typeof sp.create_yield_point !== 'function') {
      return false;
    }
    var origBefore = sp.create_before_expression_yield_point;
    var origYield = sp.create_yield_point;

    // a) before_expression：EB 的全部副作用就是 program_counter[g]=n，直接内联。
    //    注意 case 标签必须保留 —— 内层 yield group（warp/条件/循环）恢复时，
    //    外层要先回到"正在执行这条语句"才能再进内层 switch，靠的就是这个 pc 值。
    sp.create_before_expression_yield_point = function () {
      var g = this.current_yield_group;
      this.top_yield_ids[g]++;
      var n = this.top_yield_ids[g];
      var pc = this.keyword && this.keyword.program_counter;
      if (typeof pc !== 'string') { this.top_yield_ids[g]--; return origBefore.apply(this, arguments); }
      var s = n.toString();
      return [pc, '[', g.toString(), ']=', s, ';case ', s, ': '];
    };

    // b) increment_program_counter 同样内联（ED 只做 program_counter[g]=n）
    sp.create_yield_point = function () {
      if (CG.mode === 'eb') return origYield.apply(this, arguments);
      var g = this.current_yield_group;
      this.top_yield_ids[g]++;
      var n = this.top_yield_ids[g];
      var pc = this.keyword && this.keyword.program_counter;
      if (typeof pc !== 'string') { this.top_yield_ids[g]--; return origYield.apply(this, arguments); }
      var s = n.toString();
      return [pc, '[', g.toString(), ']=', s, ';case ', s, ': '];
    };
    return true;
  }

  // ---------- 生成代码骨架优化（阶段3·optifun） ----------
  /**
   * 阶段2 只处理了 `X.EB` / `X.ED` 这两类"让出点"，但生成的 optifun 骨架里还有三块
   * 纯开销，且只在源码层面才看得见：
   *
   *  1) 循环体（compile_repeat_forever 那条代码路径）压根没走 state 的方法，
   *     直接吐 `if (X.EB('bid','rbid','ent',g,n)) { return; }case n:`。
   *     EB 的实现是 `should_report_current_running_block && set_running_block(...),
   *     program_counter[i]=r, false` —— 播放器里这个开关默认 false，等价于一次
   *     纯 pc 写入。所以整段可以换成 `X.DB[g]=n;`。
   *  2) 嵌套语句会连出好几段 `X.DB[g]=n;case n:` 中间什么都不干。只有最后一段
   *     可能被命中（中间没有让出点，也没有别的跳转能到），前面的全是死写。
   *  3) `X.DB[0]=n` 每次都先查一次 `X` 的属性表。把帧字段提到函数局部变量里，
   *     写入就变成局部数组的写入。这是本轮最大的一头。
   *
   * 三条都只动"调度骨架"，不碰任何积木语义；case 标签只在确认无人跳转时才删。
   */
  var OPT = { enabled: true, fns: 0, saved: 0 };

  /** 收集所有会跳到的 pc 号（X.EC 的最后一个参数就是让出后恢复的位置） */
  function collectTargets(s) {
    var refs = {};
    var re = /X\.EC\([^()]*?,\s*(\d+),\s*(\d+)\)/g;
    var m;
    while ((m = re.exec(s))) {
      (refs[m[1]] || (refs[m[1]] = {}))[m[2]] = 1;
    }
    return refs;
  }

  /** 折叠连续的纯 pc 写入：只保留最后一段（前面那些没有任何路径能到达） */
  function collapseSkeleton(s, refs) {
    var re = /X\.DB\[(\d+)\]=(\d+);case \2:[ \t]*/g;
    for (var round = 0; round < 8; round++) {
      var out = '';
      var last = 0;
      var m;
      var changed = false;
      re.lastIndex = 0;
      while ((m = re.exec(s))) {
        var g = m[1];
        var n = +m[2];
        var end = m.index + m[0].length;
        // 紧跟其后的必须还是同一组的 pc 写入，才说明这段写进去马上就被覆盖
        var next = /^X\.DB\[(\d+)\]=(\d+);case \2:/.exec(s.slice(end, end + 40));
        if (!next || next[1] !== g) continue;
        if (n === 0) continue;                          // 0 是 EE / reset 的入口，不能删
        if (refs[g] && refs[g][n]) continue;            // 别处会跳到这个 case
        out += s.slice(last, m.index);
        last = end;
        changed = true;
      }
      if (!changed) break;
      s = out + s.slice(last);
    }
    return s;
  }

  /** 帧字段（X.DB / X.DA / X.BC / X.BA）提为函数局部变量 */
  function hoistFrameFields(s) {
    var used = [];
    var t = s.replace(/\bX\.(DB|DA|BC|BA)\b/g, function (all, f) {
      if (used.indexOf(f) < 0) used.push(f);
      return f;
    });
    if (!used.length) return s;
    var decl = used.map(function (f) { return f + '=X.' + f; }).join(',') + ';';
    // 插在函数体最前面：optifun 的参数名固定是 X
    var i = t.indexOf('function optifun(X) {');
    if (i < 0) return s;
    var at = i + 'function optifun(X) {'.length;
    return t.slice(0, at) + 'var ' + decl + t.slice(at);
  }

  /** statements 是嵌套数组，官方用 lodash 的 flatten 再 join('')；这里等价实现 */
  function flatJoin(x) {
    if (typeof x === 'string') return x;
    if (x == null) return '';
    if (typeof x === 'object' && typeof x.length === 'number') {
      var out = '';
      for (var i = 0; i < x.length; i++) out += flatJoin(x[i]);
      return out;
    }
    return String(x);
  }

  function transformOptifun(src) {
    if (!OPT.enabled || typeof src !== 'string') return src;
    if (src.indexOf('function optifun(X)') < 0) return src;
    var s = src;

    // 1) 循环体里的 EB 调用点 → 纯 pc 写入（EB 永不 yield）
    s = s.replace(
      /\bif \(X\.EB\([^()]*?,\s*(\d+),\s*(\d+)\)\) \{ return; \}/g,
      function (all, g, n) { return 'X.DB[' + g + ']=' + n + ';'; }
    );
    // 2) ED 调用点 → 纯 pc 写入
    s = s.replace(
      /X\.ED\([^()]*?,\s*(\d+),\s*(\d+)\);/g,
      function (all, g, n) { return 'X.DB[' + g + ']=' + n + ';'; }
    );
    // 3) 折叠死写（要在提局部之前做，正则只认 X.DB[ 这个写法）
    if (s.indexOf('X.DB[') >= 0) s = collapseSkeleton(s, collectTargets(s));
    // 4) 帧字段提局部
    s = hoistFrameFields(s);

    if (OPT.fns === 0) log('optifun 骨架改写已启用');
    OPT.fns++;
    OPT.saved += src.length - s.length;
    return s;
  }
  // 供 A/B 对比用（不影响正常流程）
  window.__k4pTransformOpt = transformOptifun;
  window.__k4pOptSet = function (v) { OPT.enabled = !!v; return OPT.enabled; };

  /** 包一层 OptiCompiler.prototype.compile：首次调用时先建出 state 拿到生成器原型 */
  function installCodegenPatch(compilerInst) {
    if (CG.installed || !compilerInst) return;
    var proto = compilerInst.constructor && compilerInst.constructor.prototype;
    if (!proto || typeof proto.compile !== 'function' || typeof proto.wrap_with_top_level !== 'function') return;

    // 挂到 wrap_with_top_level：这里是唯一能拿到「拼好的整段源码」的地方
    var origWrap = proto.wrap_with_top_level;
    proto.wrap_with_top_level = function () {
      var r = origWrap.apply(this, arguments);
      if (!OPT.enabled || !r || !r.statements) return r;
      try {
        var src = flatJoin(r.statements);
        var out = transformOptifun(src);
        if (out === src) return r;
        return { statements: [out] };
      } catch (e) {
        log('骨架改写异常（保留官方生成）', (e && e.message) + '');
        return r;
      }
    };

    var origCompile = proto.compile;
    proto.compile = function () {
      if (!CG.patched) {
        CG.patched = true;
        try { origCompile.apply(this, arguments); } catch (_) {}   // 只为拿到 this.state
        var sp = this.state && this.state.constructor && this.state.constructor.prototype;
        var ok = sp && patchState(sp);
        log('生成器补丁', ok ? '已安装' : '失败（保留官方生成器）');
      }
      return origCompile.apply(this, arguments);
    };
    CG.installed = true;
  }

  /** 把一个实体的积木编译成 compile_result 的一项；失败返回 null */
  function compileEntity(comp, util, id, bdj, sceneId) {
    var r;
    try {
      r = comp.compile({ id: id, blocksJSON: bdj });
    } catch (e) {
      log('compile fail', id, (e && (e.message || e)) + '');
      return null;
    }
    var clean = util.misc.ce_without_cyclical_references(r);

    // params.NUM 只在它本身是数字时转成字符串（与编辑器保存时一致）。
    // 注意：NUM 也可能是「一个积木」（如四舍五入的输入），那种绝不能动。
    var fixNum = function (b) {
      var p = b && b.params;
      if (p && typeof p.NUM === 'number') p.NUM = String(p.NUM);
    };
    for (var k in clean.compiled_block_map) util.block.ast_for_each(clean.compiled_block_map[k], fixNum);
    for (var k2 in clean.procedures) util.block.ast_for_each(clean.procedures[k2], fixNum);

    // 运行组归属：角色积木归它所在场景，点击启动类帽子块独立运行
    var rg = {};
    if (sceneId) {
      for (var bid in clean.compiled_block_map) {
        var t = clean.compiled_block_map[bid].type;
        if (t !== 'start_on_click' && t !== 'start_as_a_mirror') rg[bid] = sceneId;
      }
    }
    clean.running_group_id = rg;
    return clean;
  }

  /** 给整个作品算 compile_result；任何一步失败都返回 null（交回播放器自己报错） */
  function compileProject(json) {
    if (!containerReady()) {
      log('container 未就绪，放弃编译');
      return null;
    }
    var c = window.__k4c;
    var B = window.__k4b;
    var comp = c.get(B.JSONEntityCompiler);
    var util = c.get(B.Util);
    if (!comp || !util || !util.misc) {
      log('编译器不可用');
      return null;
    }

    // 阶段2：换成更精简的代码生成器（?k4p_cg=0 可关闭，用于 A/B 对比）
    if (CG.enabled) {
      try { installCodegenPatch(c.get(B.OptiCompiler)); } catch (e) { log('生成器补丁异常', (e && e.message) + ''); }
    }

    var theatre = json.theatre || {};
    var scenes = theatre.scenes || {};
    var actors = theatre.actors || {};
    var out = [];
    var t0 = performance.now();
    var total = 0;

    for (var sid in scenes) {
      var s = scenes[sid] || {};
      var sb = s.block_data_json;
      total++;
      if (sb && sb.blocks) {
        var r1 = compileEntity(comp, util, sid, sb, null);
        if (r1) out.push(r1);
        else return null;
      } else {
        out.push({ id: sid, procedures: {}, compiled_block_map: {}, running_group_id: {} });
      }
    }

    for (var aid in actors) {
      var a = actors[aid] || {};
      var ab = a.block_data_json;
      total++;
      if (ab && ab.blocks) {
        var r2 = compileEntity(comp, util, aid, ab, a.scene || null);
        if (r2) out.push(r2);
        else return null;
      } else {
        out.push({ id: aid, procedures: {}, compiled_block_map: {}, running_group_id: {} });
      }
    }

    log('编译完成', total + ' 个实体', Math.round(performance.now() - t0) + 'ms');
    return out;
  }

  /**
   * 把编译结果交给本地服务，然后重新加载页面。
   * 重新加载后服务返回的就是「完整作品」，播放器走原生路径 —— 不再依赖任何响应改写。
   */
  function submitAndReload(cr) {
    var token = (location.pathname.split('/').pop() || '').split('?')[0];
    var KEY = 'k4p:tried:' + token;
    var tried = false;
    try { tried = sessionStorage.getItem(KEY) === '1'; } catch (_) {}
    if (tried) {
      log('此前已尝试过提交，本轮回退到内存注入');
      return false;
    }
    try { sessionStorage.setItem(KEY, '1'); } catch (_) {}
    setBootText('正在编译作品…');
    log('提交编译结果并重新加载', cr.length + ' 项');
    fetch('/k4p/compile-result', { method: 'POST', body: JSON.stringify(cr) })
      .then(function (r) {
        if (!r.ok) throw new Error('status ' + r.status);
        location.reload();
      })
      .catch(function (e) {
        log('提交失败，回退到内存注入', String(e && e.message));
      });
    return true;
  }

  // ---------- XHR 拦截面 ----------
  var XHR = window.XMLHttpRequest;
  var origOpen = XHR.prototype.open;
  var origSend = XHR.prototype.send;

  XHR.prototype.open = function (m, u) {
    this.__k4pUrl = u;
    return origOpen.apply(this, arguments);
  };

  XHR.prototype.send = function () {
    var self = this;
    var args = arguments;
    if (!isProjectUrl(this.__k4pUrl)) return origSend.apply(this, arguments);

    // 编译器还没就绪：先把请求压住，等容器起来再发（避免响应先到、无法编译）
    if (!containerReady()) {
      var waited = 0;
      log('等待编译器就绪后再请求作品数据');
      var iv = setInterval(function () {
        waited += 20;
        if (containerReady() || waited > 6000) {
          clearInterval(iv);
          sendAndPatch(self, args);
        }
      }, 20);
      return;
    }
    return sendAndPatch(self, args);
  };

  function sendAndPatch(xhr, originalArgs) {
    xhr.addEventListener('readystatechange', function () {
      if (xhr.readyState !== 4 || xhr.__k4pPatched) return;
      xhr.__k4pPatched = true;
      try {
        patchResponse(xhr);
      } catch (e) {
        log('patch 失败', (e && e.message) + '');
      }
    });
    return origSend.apply(xhr, originalArgs);
  }

  function patchResponse(xhr) {
    if (xhr.status !== 200) return;
    var rt = xhr.responseType;
    var data;

    if (rt === 'json') {
      data = xhr.response;
      if (!data || typeof data !== 'object') return;
      if (data.compile_result) { log('已有 compile_result，跳过'); return; }
      setBootText('正在编译作品…');
      var cr = compileProject(data);
      if (!cr) { log('编译失败，交回播放器'); return; }
      // 首选：交给服务端拼装后重载（播放器完全走原生路径）
      if (submitAndReload(cr)) return;
      // 兜底：直接在内存里改响应
      data.compile_result = cr;
      try {
        var txt = JSON.stringify(data);
        Object.defineProperty(xhr, 'responseText', { configurable: true, get: function () { return txt; } });
      } catch (e) { log('responseText 覆盖失败', (e && e.message) + ''); }
      log('注入 compile_result', cr.length + ' 项');
      setBootText('正在载入作品…');
      return; // json 模式下 response 就是同一个对象，改它就等于改了响应
    }

    // 文本模式：解析 -> 编译 -> 覆盖 getter
    var text = xhr.responseText;
    if (!text || text.charAt(0) !== '{') return;
    try { data = JSON.parse(text); } catch (e) { return; }
    if (!data || !data.theatre || data.compile_result) return;
    setBootText('正在编译作品…');
    var cr2 = compileProject(data);
    if (!cr2) return;
    data.compile_result = cr2;
    var newText = JSON.stringify(data);
    Object.defineProperty(xhr, 'responseText', { configurable: true, get: function () { return newText; } });
    Object.defineProperty(xhr, 'response', {
      configurable: true,
      get: function () { return rt === 'json' ? JSON.parse(newText) : newText; },
    });
    log('注入 compile_result（文本模式）', cr2.length + ' 项');
    setBootText('正在载入作品…');
  }

  // fetch 分支（当前播放器走 XHR，留个兜底）
  if (window.fetch) {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url);
      if (!isProjectUrl(url)) return origFetch.apply(this, arguments);
      return origFetch.apply(this, arguments).then(function (resp) {
        if (!resp.ok || resp.__k4pPatched) return resp;
        return resp.clone().json().then(function (data) {
          if (!data || !data.theatre || data.compile_result) return resp;
          setBootText('正在编译作品…');
          var cr = compileProject(data);
          if (!cr) return resp;
          data.compile_result = cr;
          log('注入 compile_result（fetch）', cr.length + ' 项');
          setBootText('正在载入作品…');
          var headers = new Headers(resp.headers);
          headers.delete('content-length');
          return new Response(JSON.stringify(data), { status: resp.status, statusText: resp.statusText, headers: headers });
        }).catch(function () { return resp; });
      });
    };
  }

  // 生成器补丁必须在任何 interpreter 创建之前装好 —— 脚本是运行时按 procedure
  // 生成的（OptiCompiler.compile），而第二次加载已带 compile_result 时
  // compileProject 根本不会跑，所以不能只挂在编译流程里。
  (function autoInstallCodegen() {
    // 骨架改写单独一个开关，方便和阶段2 分开做 A/B
    var optOff = !!window.__k4pOptOff || /[?&]k4p_opt=0/.test(location.search);
    if (!optOff) { try { optOff = localStorage.getItem('k4p_opt') === '0'; } catch (_) {} }
    if (optOff) { OPT.enabled = false; log('optifun 骨架改写已关闭（k4p_opt=0）'); }

    var off = !!window.__k4pCGOff || /[?&]k4p_cg=0/.test(location.search);
    if (!off) { try { off = localStorage.getItem('k4p_cg') === '0'; } catch (_) {} }
    if (off) { CG.enabled = false; log('生成器补丁已关闭（k4p_cg=0）'); return; }
    if (window.__k4pCGMode) CG.mode = String(window.__k4pCGMode);
    var tries = 0;
    var iv = setInterval(function () {
      if (++tries > 600) { clearInterval(iv); return; }
      if (!containerReady() || !window.__k4b.OptiCompiler) return;
      clearInterval(iv);
      try { installCodegenPatch(window.__k4c.get(window.__k4b.OptiCompiler)); }
      catch (e) { log('生成器补丁异常', (e && e.message) + ''); }
    }, 10);
  })();
})();
