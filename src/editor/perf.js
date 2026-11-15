/* ============================================================================
 * Kitten4 编辑器性能层（k4p-perf.js）
 *
 * 由 tools/patch_editor.js 注入到 build/index.html。目标只有一个：
 * 角色里积木很多时，编辑器别卡、别把值改乱。
 *
 * 目前做三件事：
 *   1) workspace_to_json 单遍收集
 *      原实现每层递归都把整棵子树的条目合并进父对象，一条 5000 块的链就是
 *      1250 万次属性拷贝（实测一次序列化 229ms，而且每改一个值就触发一次）。
 *      这里改成「每块只序列化自己」+ 迭代遍历，一次约 20~30ms，输出完全一致。
 *   2) 不改动建块 / 渲染流程 —— 那两块的行为与官方一致，避免出现新的怪问题。
 *   3) 提供 window.__k4pPerf.snapshot() 方便自测（不影响功能）。
 * ==========================================================================*/
(function () {
  'use strict';
  if (window.__k4pPerf && window.__k4pPerf.applied) return;

  var perf = (window.__k4pPerf = window.__k4pPerf || {});
  perf.applied = false;
  perf.serializeMs = 0;
  perf.lastBlocks = 0;

  var tries = 0;
  var timer = setInterval(function () {
    if (++tries > 900) { clearInterval(timer); return; }
    if (window.Blockly && window.Blockly.json && window.Blockly.mainWorkspace) {
      clearInterval(timer);
      // 让官方先跑完自己的初始化，别和它抢同一个 tick
      setTimeout(function () {
        try { apply(); } catch (e) { console.error('[k4p] 性能层挂载失败', e); }
      }, 0);
    }
  }, 16);

  function apply() {
    var J = window.Blockly.json;
    if (J.__k4pPatched) { perf.applied = true; return; }

    var origW2J = J.workspace_to_json;
    if (typeof origW2J !== 'function') return;
    var origB2J = J.block_to_json;
    if (typeof origB2J !== 'function') return;

    // 借一个「只序列化自己」的视图：子块递归返回空壳，合并变成空操作。
    // 这样字段/约束/控制器/影子字符串这些细节仍由官方代码处理，不会走样。
    var empty = function () { return { blocks: {}, connections: {}, comments: {} }; };
    var stub = Object.create(J);
    stub.block_to_json = empty;
    stub.merge_workspace_data = function () {};

    var seen = Object.create(null);

    J.workspace_to_json = function (ws) {
      var t0 = performance.now();
      var out = { blocks: {}, connections: {}, comments: {} };
      var tops = ws.get_top_blocks(false);
      var stack = [];
      for (var i = tops.length - 1; i >= 0; i--) stack.push(tops[i]);
      for (var k in seen) delete seen[k];

      var guard = 0;
      while (stack.length) {
        var b = stack.pop();
        if (!b || seen[b.id]) continue;
        seen[b.id] = 1;

        var one;
        try {
          one = origB2J.call(stub, b);
        } catch (e) {
          // 单个块吃不下就退回官方实现，宁可慢也别丢数据
          perf.serializeMs = performance.now() - t0;
          return origW2J.call(J, ws);
        }

        var entry = one.blocks[b.id];
        if (entry) out.blocks[b.id] = entry;
        var cons = one.connections[b.id] || {};
        out.connections[b.id] = cons;
        for (var cid in one.comments) out.comments[cid] = one.comments[cid];

        for (var child in cons) {
          var cb = ws.get_block_by_id(child);
          if (cb) stack.push(cb);
        }
        if ((guard += 1) > 400000) break;
      }

      perf.serializeMs = performance.now() - t0;
      perf.lastBlocks = Object.keys(out.blocks).length;
      return out;
    };

    J.__k4pPatched = true;
    perf.applied = true;
    perf.snapshot = function () {
      var ws = window.Blockly.mainWorkspace;
      var n = 0;
      try { n = ws.get_all_blocks ? ws.get_all_blocks().length : 0; } catch (e) {}
      return { applied: true, serializeMs: Math.round(perf.serializeMs * 10) / 10, blocks: n };
    };
  }
})();
