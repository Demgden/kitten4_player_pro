'use strict';
/**
 * 云数据身份注入
 *
 * 播放器判断「能不能用云数据」的入口（player_v2 里的 Ct()，模块 TL4g 导出 d）：
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
 *
 * ⚠️ 两个坑，都踩过：
 *
 * 1. 光在启动时 dispatch 一次不够。播放器加载作品时会把 project_states
 *    整个重置一遍（实测 t≈680ms 写进去，t≈713ms 就被覆盖成 undefined），
 *    之后 Ct() 才第一次跑，读到空值 → 判成预览模式，且不会自己重试。
 *    所以在 store.dispatch 外面包一层：任何 action 落地后 work_id 若被清掉，
 *    立刻补回去。这样 Ct() 无论何时被调用都能读到正确的值。
 *
 * 2. 千万别在作品跑起来之后再去「重初始化」云变量
 *    （`__k4wreq('vxpV').m(true)` 会重跑整条 run 流程）。那一下会重建
 *    运行时/渲染容器，把已经「盖章（图章）」画到画笔层上的内容全部擦掉，
 *    而作品只在进入时盖一次章、不会重画 —— florr 的花瓣卡槽
 *    （克隆体 + 图像印章）就是这么「开播时还在、几秒后整排变灰白空格」的。
 *    只要 work_id 在 run 之前就位，播放器自己的云初始化就会正常连上。
 */
(function () {
  var wid = window.__K4P_WORK_ID;
  if (!wid) return;
  wid = String(wid);
  // ?k4p_cloud=0 关掉这一步（排查用：用来分辨「云数据链路」和「作品本身」）
  if (/[?&]k4p_cloud=0/.test(location.search)) return;

  var LOG = /[?&]k4p_debug=/.test(location.search);
  var t0 = Date.now();

  // 本脚本先于 player_v2 / runtime 加载，此时 window.__k4wreq 还不存在，只能轮询等。
  // 间隔压到 60ms：要赶在作品 run 之前把 work_id 放进去，越早越稳。
  var timer = setInterval(function () {
    if (Date.now() - t0 > 15000) {
      clearInterval(timer);
      if (LOG) console.log('[k4p:cloud] 等待播放器内核超时，跳过');
      return;
    }
    try {
      var req = window.__k4wreq;
      if (typeof req !== 'function') return;
      var store = req('dqaR').a;   // redux store
      var mod = req('H4Wo');       // project_states，d = set_work_id
      if (!store || typeof store.dispatch !== 'function' || !mod || typeof mod.d !== 'function') return;

      clearInterval(timer);
      if (LOG) console.log('[k4p:cloud] 就绪，作品号', wid);

      // 首次：直接写一遍
      var cur = String((((store.get_state() || {}).project_states) || {}).work_id || '');
      if (cur !== wid) store.dispatch(mod.d(wid));

      // 之后：钉住。播放器加载作品时会重置 project_states，把 work_id 清掉。
      if (!store.__k4pPinned) {
        store.__k4pPinned = true;
        var orig = store.dispatch;
        store.dispatch = function (action) {
          var r = orig.apply(this, arguments);
          try {
            var now = String((((store.get_state() || {}).project_states) || {}).work_id || '');
            if (now !== wid) {
              orig.call(store, mod.d(wid));
              if (LOG) console.log('[k4p:cloud] work_id 被重置，已补回', wid, '原因 action:', action && action.type);
            }
          } catch (e) {
            if (LOG) console.log('[k4p:cloud] pin fail', e && e.message);
          }
          return r;
        };
      }

      if (LOG) console.log('[k4p:cloud] work_id ->', wid);
    } catch (e) {
      if (LOG) console.log('[k4p:cloud] fail', e && e.message);
    }
  }, 60);
})();
