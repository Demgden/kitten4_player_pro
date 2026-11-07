'use strict';
/**
 * 云数据身份注入
 *
 * 播放器判断「能不能用云数据」的入口（player_v2 里的 Ct()）：
 *
 *   work_id 非空 && is_login && 作品里声明了云变量 && auth_type 非空
 *     → 连 wss://socketcv.codemao.cn:9096，读写真实云变量
 *   否则 → 提示「预览模式下，云数据会以本地形式运行」，一切本地模拟
 *
 * 我们直接加载 /new/<token> 当顶层文档，没有父页面替它 postMessage，
 * 作品又是从本地 JSON 读的 —— 所以 work_id 一直是空的：哪怕登录了、
 * auth_type 也对，仍然走本地模式。这里补的就是这一个值。
 *
 * is_login / auth_type 由播放器自己请求 /web/users/details 得出，不用我们管。
 * 模块 id 跟着当前 bundle，取不到就安静退出 —— 播放本身不依赖这里。
 */
(function () {
  var wid = window.__K4P_WORK_ID;
  if (!wid) return;

  var LOG = /[?&]k4p_debug=/.test(location.search);
  var t0 = Date.now();
  var ctx = null;   // { req, store, mod }

  // 本脚本先于 player_v2 / runtime 加载，此时 window.__k4wreq 还不存在，只能轮询等
  var timer = setInterval(function () {
    if (Date.now() - t0 > 15000) {
      clearInterval(timer);
      if (LOG && !ctx) console.log('[k4p:cloud] 等待播放器内核超时，跳过');
      return;
    }
    if (!ctx) {
      try {
        var req = window.__k4wreq;
        if (typeof req !== 'function') return;
        var store = req('dqaR').a;   // redux store
        var mod = req('H4Wo');       // project_states，d = set_work_id
        if (!store || typeof store.dispatch !== 'function' || !mod || typeof mod.d !== 'function') return;
        ctx = { req: req, store: store, mod: mod };
        if (LOG) console.log('[k4p:cloud] 就绪，作品号', wid);
        // 作品跑起来之后再补一次云变量初始化：dispatch 晚于 run 时它已经按本地模式跑过了
        if (window.__K4P_LOGGED_IN) setTimeout(refreshCloud, 2500);
      } catch (_) {
        return;
      }
    }
    try {
      var cur = (ctx.store.get_state() || {}).project_states || {};
      if (String(cur.work_id || '') !== String(wid)) {
        ctx.store.dispatch(ctx.mod.d(String(wid)));
        if (LOG) console.log('[k4p:cloud] work_id ->', wid);
      }
    } catch (e) {
      if (LOG) console.log('[k4p:cloud] fail', e && e.message);
    }
  }, 120);

  function refreshCloud() {
    try {
      var vx = ctx && ctx.req('vxpV');
      if (vx && typeof vx.m === 'function') {
        vx.m(true);
        if (LOG) console.log('[k4p:cloud] 重新初始化云变量');
      }
    } catch (e) {
      if (LOG) console.warn('[k4p:cloud] refresh fail', e && e.message);
    }
  }
})();
