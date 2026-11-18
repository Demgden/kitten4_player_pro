/* k4p-quiet：隐藏控件不参与渲染
 *
 * 左侧「页面/图层」按钮（.page_btn_item）切走后是 opacity:0 + translateY(-20px)、
 * 但仍然 display:flex 留在渲染树里。它们内部各有一个 44×44 的 <svg>，里面 45 个 <g>
 * 每帧写 transform=matrix(...)（实测 8500 次/秒）。
 *
 * 这些写入让整个文档每帧重绘：静止帧时间 29.6ms（33fps），而这 4 个 svg 一藏就回到 16.7ms（60fps）。
 * visibility:hidden 没用（照样重绘），will-change 也没用（31.8ms）。
 * content-visibility:hidden 才是对的：跳过子树的 style/layout/paint，元素框与 CSS 过渡都保留，
 * 所以切页面时的淡入淡出动画不受影响。
 *
 * 纯 CSS，不改 DOM、不改行为。
 * 关掉：?k4p_quiet=0 或 localStorage.k4p_quiet='0'
 */
(function () {
  'use strict';
  if (window.__k4pQuiet) return;

  var on = true;
  try {
    if (/[?&]k4p_quiet=0/.test(String(location.search || ''))) on = false;
    if (localStorage.getItem('k4p_quiet') === '0') on = false;
  } catch (e) {}

  var R = { on: on, el: null, fired: 0 };
  R.off = function () {
    on = false;
    R.on = false;
    if (R.el && R.el.parentNode) R.el.parentNode.removeChild(R.el);
    R.el = null;
  };
  R.enable = function () { on = true; R.on = true; mount(); };
  window.__k4pQuiet = R;

  var SEL = '[class*="page_btn_item"][class*="hidden"]';
  var CSS =
    '/* k4p-quiet：隐藏的页面按钮子树不渲染，避免不可见动画拖垮整页重绘 */\n' +
    SEL + '{content-visibility:hidden}\n';

  function mount() {
    if (!on || R.el) return;
    var d = document.head || document.documentElement;
    if (!d) { setTimeout(mount, 50); return; }
    var el = document.createElement('style');
    el.id = 'k4p-quiet';
    el.textContent = CSS;
    d.appendChild(el);
    R.el = el;
    // 命中统计（只用于确认规则真的套上了；界面渲染出来才有，所以延迟数）
    setTimeout(function () {
      try { R.fired = document.querySelectorAll(SEL).length; } catch (e) {}
    }, 3000);
  }

  mount();
  console.log('[k4p] quiet 已装载');
})();
