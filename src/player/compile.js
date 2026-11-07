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

  /** 包一层 OptiCompiler.prototype.compile：首次调用时先建出 state 拿到生成器原型 */
  function installCodegenPatch(compilerInst) {
    if (CG.installed || !compilerInst) return;
    var proto = compilerInst.constructor && compilerInst.constructor.prototype;
    if (!proto || typeof proto.compile !== 'function' || typeof proto.wrap_with_top_level !== 'function') return;
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
