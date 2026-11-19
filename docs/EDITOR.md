# 编辑器性能副本：实现笔记

播放器是另一个项目，见 [PLAYER.md](PLAYER.md)。

这个项目不重写编辑器，而是**对官方桌面版打补丁**：从 `C:\Program Files\kitten4-desktop`
整份复制到 `dist/Kitten4编辑器/`，再用 `tools/patch_editor.js` 改掉几个热点。
**功能与安装版完全一致**，安装版本身一行不动。

产物目录里还有一份面向使用者的 `【优化说明】.txt`（9 条，含怎么关掉每一项）。

---

## 基线：官方编辑器（4.11.20）

- Electron 33 + 一条 webpack bundle（`resources/app/build/kitten.<hash>.js`，约 12 MB）
- 编程猫改版 Blockly：`init_svg` / `block_to_dom` / `render` / `update_shape_` /
  `get_all_blocks` / `get_descendants` / `get_relative_to_surface_xy`
- 积木的 `<g>` **按堆叠嵌套**：一个顶层块里装着整条链，`canvas.children` 只有 19 个，
  而 SVG 节点 37814 个（5513 块的测试作品 chipmunk2d）
- 与安装版**共用** `%APPDATA%\electron_for_kitten4`，两边不能同时开（单实例锁会切回先开的那个）

---

## 阶段 6a：三处慢路径

触发问题是「一个角色里积木特别多」时的卡顿 + 改值后出现「神秘状态」。定位下来是三处：

| # | 位置 | 原实现 | 代价 |
|---|---|---|---|
| 1 | `Block.prototype.get_descendants` | 递归 + 每层 `push.apply` 拷贝子数组 | 5000 块链 ≈ 1250 万次 push |
| 2 | `Block.prototype.block_to_json` / `workspace_to_json` | 每层递归 `merge_workspace_data` 把**整棵子树**并进父对象 | 5532 块一次 **395 ms**（改一个值就会触发） |
| 3 | 切角色加载 | `if(块数>=1e3) setTimeout(...,200) else select_workspace()` | 加载与编辑抢同一工作区；异常被 `console.log` 吞 → 值错乱 / 工作区空白 |

补法（`tools/patch_editor.js`，幂等，自动留 `.k4p.bak`）：

- `get_descendants` 改**显式栈迭代**，同级顺序不变（这棵树是 Blockly 的位置基准，顺序错了整块会错位）。
- 序列化走 `src/editor/perf.js`（运行时注入成 `build/k4p-perf.js`）：用 `Object.create(Block.prototype)` 造一个 stub，
  让 `block_to_json` 只吐「自己这一层」，再用 `ws.get_block_by_id()` 迭代拼 connections —— 单遍收集。
- 切工作区 `200` → `0`（只让出一帧把加载提示画出来）；失败重试一次并 `console.error`，不再静默。
- `main/index.js` 头部补四个启动开关（`disable-renderer-backgrounding` / `disable-background-timer-throttling` /
  `enable-gpu-rasterization` / `ignore-gpu-blocklist`）。

> **绝对不要加 `--js-flags=--max-old-space-size=4096`**：这个 Electron 版本（33）加了这个开关页面会直接卡死
> （`alive` eval 一直超时、GPU/Network Service 一起崩）。试过，排除。

实测（5513 块的 chipmunk2d「物理」角色）：

| 指标 | 官方 | 副本 |
|---|---|---|
| 一次 `workspace_to_json` | 395 ms | **100 ms** |
| 输出差异 | — | **0**（`block/conn/cmt` 逐字节一致） |
| 合成 `json_to_workspace` | 7.4 s | 6.0 s |
| 连续改 5 个值 | `[12598, 268, 105, 186, 217]` ms，>40ms 卡顿 60 次 | `[11500, 147, 135, 133, 165]` ms，卡顿 36 次 |
| 渲染像素 | — | 与官方截图**逐像素一致** |

第一次改值仍要 11~14 s，profile 里 **97.6% 是 `(program)` / `(none)`**（非 JS：layout/style/IPC），
也就是「第一次把整个工程写回磁盘」+ 全量重排，不是 JS 能救的。

### 「是不是渲染了太多不必要的积木」——是

`render_blocks_and_comments` 对每个顶层块做 `get_descendants()` 然后：

```js
for (…) init_svg();          // 建 DOM
for (…) update_collapsed(), render(false);   // 全部排版
```

5513 块 → **37814 个 SVG 节点全部建出来并排版**，而视口里同时可见的只有几十块。

测量数据（`_probe/ed_pan*.js`，chipmunk2d 5513 块 / 19 个顶层链 / 37814 节点）：

| 状态 | 每帧 |
|---|---|
| 静止（全渲染） | 39~45 ms（≈22 fps） |
| 静止，画布 `display:none` | **16.7 ms** |
| 静止，工作区清空（0 块） | **16.7 ms** |
| 拖视角（全渲染） | 110~145 ms |
| 拖视角（全部隐藏） | 41 ms |

结论：**静止也在 22 fps**——文档里有个 44×44 的小图标在 JS 里持续写 `transform`（实测 586 次/秒），
它在同一合成层里，把整张 37814 节点的 SVG 一起带进每帧重绘。`will-change` 提升画布层反而更糟
（155 ms，超大纹理）；提升那些小图标无效（SVG 子元素提升到线程合成在 Blink 里不生效）。
所以只能减少「被重绘的节点数」。

---

## 阶段 6b：积木视口裁剪（`src/editor/cull.js` → `build/k4p-cull.js`）

关键结构：**积木的 `<g>` 是按堆叠嵌套的**——一个顶层块的 `<g>` 里装着它整条链（`canvas.children` 只有 19 个），
所以裁剪必须按树走，`display:none` 一个父块会连同整棵子树一起收掉。

做法：

1. 一遍 DFS 把每块的画布坐标/宽高缓存成扁平表（`walkBuild`，20ms，只在结构变化后重建）；
2. 之后每轮只用 `canvas.getScreenCTM()` + 缓存坐标做算术（**1~4ms**），
   比逐块 `getBoundingClientRect` 快两个数量级（后者 5513 块要 390~660ms）；
3. 视口外留 0.5 屏余量，`display:none` + `data-k4pcull` 标记（不和引擎自己的 `display` 语义打架）。

**一个坑**：不能「父块在视口外就整枝收掉」。子树只往**下/往右**长，所以

- 父块在视口**下方/右侧** → 子树只会更远，可以整枝收（`pruned`，子节点直接跳过）；
- 父块在视口**上方/左侧** → 子树可能还在视口里，必须继续往下走。

最初忽略这条，把 19 条链全收了，帧率好看但屏幕上该显示的块被藏了（`badHide=1`）。

实测（5513 块）：

| | 官方 | 副本 + 裁剪 |
|---|---|---|
| 静止每帧 | 39~45 ms | **26~27 ms** |
| 拖视角每帧 | 110~145 ms | 100~110 ms |
| 裁剪单轮 | — | 1~7 ms（重建 20 ms） |
| 截图 | — | 与官方逐像素一致 |

拖视角提升有限，原因：只要可见区里有内容，改画布 `transform` 就得重画可见区；
把整块画布都藏起来才有 41ms 的地板。试过拖拽时连文字一起藏（`102 → 80 ms`，约 22%），
视觉代价太大，没采用。

---

## 阶段 6c：if 加减层卡死（`generate_mutate_op` 子树 diff）

症状：一条很长的 if（`如果[]那么[]` 带两层以上 else if，内部积木多）点一次 **+ / −** 就卡十几秒。

根因不在渲染，而在**撤销栈的 op 生成**：`generate_mutate_op` 收到 mutate 事件后，
把 `get_block_data_by_id()` 拿到的**整棵子树**先全删、再全插：

```js
Object.keys(a.blocks).forEach(k => { removeOp(["connections",k]); removeOp(["blocks",k]) })
Object.keys(s.blocks).forEach(k => { insertOp(["blocks",k], s.blocks[k]) ... })
```

520 块的子树 → 1041 个 op（实测 chipmunk2d 的 `物理` 角色，`desc=520`）→ 13 秒。
而实际变化只有：**if 块自己的 `mutation` 串、1 个新 shadow 块、1 条连接**。

实测一次 `addMutation` 前后，doc 切片与新切片的逐键差异：

| 差异键 | 块数 | 性质 |
|---|---|---|
| `shadows` | 76 | 既有表示差异（XML 属性序），不是这次改的 |
| `is_output` | 102 | 同上 |
| `location` | 36 | 同上 |
| `fields.TYPE` | 74（仅新侧有） | doc 不存默认值 |
| **`mutation`** | **1** | **真正的变化** |

所以按「内容等价」判定（`canon` 归一化掉 `location` / `field_constraints` / `field_extra_attr` /
空值 / 缺键，再做键序无关的深比较），把 1041 个 op 压到个位数。

**三个必须照官方写法来的地方**（否则 op 会被静默丢掉，且不报错）：

1. `TransformToIde.decompose_and_sort_op()` 把 op 拆成 pick/drop，再经 `analyze_path()` 认路
   —— **认不出的路径直接返回 undefined，那一条 op 就没了**。
   所以不能自己发明路径形态（最先想用 `replaceOp(["blocks", id], old, new)` 整体替换，不行）。
2. 只允许官方用过的形状：`removeOp(["connections", p, c])` → `removeOp(["connections", k])` →
   `removeOp(["blocks", k])` → `insertOp(["blocks", k], json)` → `insertOp(["connections", k], {})` →
   `insertOp(["connections", k, ch], v)` → 最后把父连接挂回去。
3. **被重建的块，它到父块的那条连接必须先删再插**（父块不在重建集里时），
   否则整批 op 全废。这是最难发现的一条：op 生成成功、`apply_op_to_doc` 不抛异常、
   `undo_stack_` 也正常，**只有 doc 不变**。所以验证必须读 doc，不能只看 UI。

调试口：`window.__k4pDocOn = 1` 后，`generate_mutate_op` 会把 `r`（doc 切片）和 `s`（新切片）
挂到 `window.__k4pDoc` / `window.__k4pNew`。读 doc 的正路是**在下一次 mutate 调用里取**
（`get_current_ws_json()` 返回的是上一次提交后的状态）；连续两次 mutation 中间判断 doc 有没有跟上，
是唯一能发现「op 被静默丢弃」的办法。

兜底：`okOld` 为假（doc 里查不到该块）时退回官方的全删全插，绝不丢事件。

实测（chipmunk2d，`desc=520`）：

| | 官方 | 副本 |
|---|---|---|
| 加一层 | 13.4 s | **0.22 s** |
| 删一层 | 13.0 s | **0.11 s** |
| 连续加 4 层 | 52.3 s | **0.84 s** |
| 连续删 4 层 | 52.1 s | **0.42 s** |

正确性：加完再删，子树 521 块的 JSON **逐字节回到原样**（`diffBlocks: 0`）；
doc 块数 5513→5514、`mutation` 里的 `elseif` 与工作区一致；
`undo/redo` 序列 `[2,1,2,1]`；加层后 `Blockly.mainWorkspace` 引用不变（没有触发 refresh）。

---

## 阶段 6d：拖视角（平移）与不可见控件

阶段 6b 之后静止帧率好看了，**但拖视角还是每帧 100ms 上下**。

### 合成层是死路（别重复试）

| 平移方式 | 每帧（5513 块，同位置同轨迹） |
|---|---|
| `transform` 属性（官方） | 96 ms |
| `style.transform`（CSS，无提升） | 94 ms |
| `style.transform` + `will-change:transform` | **217 ms** |
| `translate3d(...)` + `will-change:transform` | **210 ms** |

`will-change` 会让 Chrome 把整个 block canvas（逻辑尺寸 4766×20487）raster 成一张层纹理，
远超 GPU 单边限制，每帧都在丢弃/重建 tile，比直接重绘还慢一倍。

**但属性 → CSS 本身仍有价值**：改 `transform` 属性会让整棵 SVG（37814 节点）layout 脏，
`cull` 每帧读 `getScreenCTM()` 会把它 flush 出来；CSS transform 不触发 layout。

### 落地写法（`patch_editor.js` 的 `pan` 步骤，4 处）

```js
// attribute 只留 scale（get_scale() 还要读它），平移写进 style
a = "translate(0, 0) scale(" + this.scale + ")"
n = "translate(" + e + "px," + t + "px) scale(" + this.scale + ")"
c.getAttribute("transform") !== a && c.setAttribute("transform", a);
c.style.transform = n;
```

要点：

1. **CSS transform 覆盖 attribute**（不是叠加），所以 style 里必须写完整的 translate + scale。
2. attribute 的 translate **必须归零**。`utils.get_relative_xy()` 会把 attribute 的 translate
   和 style 里的 translate **都加上**，留着旧值就是双倍偏移。
3. 另外两处同源代码要一起改：`reset_drag_surface()`（拖积木结束写回画布）、
   `set_scale()` 里那个 `replace(/scale\([0-9\.]+\)/)` 的正则（style 也要跟着改）。
4. 不要给画布加 `will-change`。

正确性（chipmunk2d，与官方逐项比对）：`getScreenCTM` / `getBoundingClientRect` /
`utils.get_relative_xy` / 每个积木的 rect / `get_svg_xy` **差异全为 0**；
平移 400px 后 CTM 与积木 rect 同步 +400；`set_scale(1.15)` 后 attribute 与 style 的 scale
一致、`get_scale()` 读到 1.15；截图与官方逐像素一致。

### 真正的两个瓶颈

**一、隐藏控件还在跑动画**（`src/editor/quiet.js` → `build/k4p-quiet.js`）

左侧「页面/图层」按钮切走后是 `opacity:0 + translateY(-20px)`，但仍在渲染树里。
每个按钮里有一个 44×44 的 `<svg>`，里面 12~45 个 `<g>` **每秒写 8500 次 `transform`**
（MutationObserver 实测 1.2s 内 10274 次）。这些写入让整页每帧重绘。

| 处理方式 | 静止每帧 |
|---|---|
| 原样 | 30 ms |
| `visibility:hidden`（本来就 hidden） | 38 ms |
| 按钮 `will-change` | 32 ms |
| `contain:paint` | 37 ms |
| **`content-visibility:hidden`** | **16.7 ms** |

`content-visibility:hidden` 跳过子树的 style/layout/paint，**元素框和 CSS 过渡都保留**，
所以切页面时的淡入淡出不受影响。规则：

```css
[class*="page_btn_item"][class*="hidden"]{content-visibility:hidden}
```

**二、裁剪自己把拖视角拖慢了**

cull 每帧重算并 toggle `display`，每次 toggle 都让 SVG 子树重新 layout：

| cull 更新频率 | 拖视角每帧 |
|---|---|
| 每帧 | 64~98 ms |
| 每 3 帧 | 47~52 ms |
| **每 6 帧** | **44 ms** |
| 冻结（不更新） | 44 ms |

所以 `cull.js` 加了 `R.every = 6` 的节流：`sig` 变了也要等到 `tick % every === 0` 才跑
（`sig` 不提前更新，否则下一帧就 `s === sig` 直接 return，永远等不到）。
留 0.5 屏余量，100ms 内的拖动距离远小于缓冲，看不出差别。

顺带否掉一个方向：**把 margin 调小反而更慢**（0.5 → 33ms，0.1 → 42ms，0.02 → 46ms）——
余量越小，边缘积木进出视口越频繁，`display` 切换次数反而变多。

### 踩坑：拖拽层搬家时 style 没清零（「按下鼠标视角猛跳一下」）

平移改到 CSS 之后，`attribute` 恒为 `translate(0, 0)`，真实位置只在 `style` 里。
但拖动画布时官方会把整块画布搬进 **workspace drag surface**（`set_contents_and_show()`），
搬家用的是：

```js
i.firstElementChild.setAttribute("transform", "translate(0, 0) scale(" + r + ")")
```

它只重置 **attribute**，不管 style。于是：

- 搬进 surface 的一瞬间，style 里还留着上一个 scroll 的 `translate(-62px, -79px)`；
- CSS 覆盖 attribute → 内容多偏一个旧 scroll；
- 视觉上就是**按下鼠标跳一下、松开又跳回来**，拖动过程反而正常（偏移恒定）。

积木少时必现（几十块时 `use_workspace_drag_surface_` 走 surface 路径）；
积木多（chipmunk2d 5513 块）实测 `surf=0`，走普通 `translate()`，所以没症状 —— 这就是
「积木多没问题、积木少有问题」的来源。

修法：`set_contents_and_show()` 里连 style 一起清零（`patch_editor.js` 的 `PANSURF_*`）。

```js
i.firstElementChild.style.transform = "translate(0px, 0px) scale(" + r + ")";
```

实测（预瞄 28 块，鼠标 -100,-50）：修前按下 80ms 积木就偏 (-70,-83)；
修后按下只跟手 (-8,-3)，松手累计 (-100,-49)，停止时无二次跳动。
`set_scale(1.35)` 下同样对齐。chipmunk2d 回归不变。

### 合计（chipmunk2d 5513 块，同一初始位置、同一段拖动）

| | 官方 | 副本 |
|---|---|---|
| 静止 | 30~38 ms（26~33 fps） | **16.7 ms（60 fps）** |
| 拖视角 | 96 ms（10 fps） | **51 ms（20 fps）** |

---

## 阶段 6e：整页缩放（让 UI 密度接近网页版）

编辑器自带的缩放只作用于**积木区**（Ctrl+滚轮 / 右下角百分比），侧栏、顶部工具栏、
弹窗、角色列表都是固定像素，大屏上这些固定尺寸的 UI 占比就很大。
网页版可以整页 Ctrl+- 缩小，桌面版做不到。

做法是 Chromium 的页面缩放，`webContents.setZoomFactor(f)`：
CSS 像素整体变小、布局重新排版，跟浏览器 Ctrl+- 的表现一致。

| 项 | 值 |
|---|---|
| 快捷键 | `Ctrl+=` / `Ctrl+-` / `Ctrl+0`（复位 100%），步进 0.05 |
| 范围 | 0.5 ~ 2.0 |
| 持久化 | `userData/k4p-zoom.json`（`{factor: 0.85}`），独立文件，不影响安装版 |
| 入口 | `main/index.js` 顶部的 `MAIN_ZOOM` IIFE（`patch_editor.js` 的 `main` 步骤） |

实现要点：

1. `app.on("web-contents-created")` 里给每个 wc 绑 `before-input-event`，
   命中就在**主进程**改 factor，`ev.preventDefault()` 拦掉页面默认行为。
2. `dom-ready` + `did-finish-load` 各应用一次（赶在首屏重排前设上，避免闪一下）。
3. `setVisualZoomLevelLimits(1, 1)` 关掉触控板捏合缩放，避免两套缩放打架。
4. 每次按键写一次 json（几十字节），顺手在页面里弹一个 0.8s 的 `界面缩放 85%` 提示。

实测（预瞄，系统 DPI 125%，窗口 1280×800）：
`1.00 → 0.85` 时 `documentElement.clientWidth` 1266 → **1490**，
`clientHeight` 788 → 898，整页元素同比缩小；积木区右下角那个百分比仍是独立的 100%。

> 测试提示：CDP 的 `Input.dispatchKeyEvent` 能触发 `before-input-event`
> （`_probe/ed.js --combo=ctrl+-:3`），不用手点也能验快捷键。

---

## 补丁器：`tools/patch_editor.js`

```bash
node tools/patch_editor.js --check                 # 只检查，不写
node tools/patch_editor.js                         # 全部打上
node tools/patch_editor.js --steps=pan,cull        # 只打指定步骤
node tools/patch_editor.js --target=_tmp/k4chk     # 对另一个目录打（验证用）
node tools/patch_editor.js --restore               # 从 .k4p.bak 还原并删掉注入文件
```

**跑之前先 `--check`**。每步都是幂等的（`already` 判断），第一次改动前会留 `.k4p.bak`
（只留最早的官方原版，后续增量补丁不会覆盖它）。

| 步骤 | 改什么 | 文件 |
|---|---|---|
| `des` | `get_descendants` 递归 → 显式栈 | bundle |
| `sel` | `workspace_to_json` 单遍收集 | bundle + 注入 `k4p-perf.js` |
| `mut` | `generate_mutate_op` 子树 diff | bundle |
| `pan` | 平移改 CSS transform（4 处，含拖拽层清零） | bundle |
| `cull` | 积木视口裁剪 + 节流 | 注入 `k4p-cull.js` + index.html |
| `quiet` | 隐藏控件 `content-visibility:hidden` | 注入 `k4p-quiet.js` + index.html |
| `main` | 启动开关（perf bootstrap）+ 整页缩放（`MAIN_ZOOM`） | main/index.js |

**改动后的验收流程**（每次都做）：

```bash
# 1. 用官方原版重打一份，和 dist 逐字节比
cp "dist/Kitten4编辑器/resources/app/build/kitten.<hash>.js.k4p.bak" _tmp/k4chk/resources/app/build/...
node tools/patch_editor.js --target=_tmp/k4chk
cmp dist/.../kitten.<hash>.js _tmp/k4chk/.../kitten.<hash>.js
```

确认 dist 里没有手改残留（调试 hook 之类）。

---

## 测量方法

编辑器性能全部用 CDP 探针 `_probe/ed.js`：

```bash
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS node _probe/ed.js \
  --file=_probe/chipmunk2d.bcm4 \
  --wait=18000 \
  --inject=_probe/ed_now.js          # 注入脚本
  --profile=ed_if                    # CPU profile → _bench/ed_if.cpuprofile
  --shot=ed_cull7                    # 截图 → _bench/ed_cull7.jpg
  --drag=800,400,700,350,24[,1]      # 真实鼠标拖动（第 6 参 1=左键 2=右键，缺省中键）
  --wheel=800,400,0,-120,4,2         # 滚轮（末参是 modifiers，2=Ctrl）
  --combo=ctrl+-:3,ctrl+0:1          # 组合键
  --after=800                        # drag 之后等一会儿再执行 expr
  --expr="..."                       # 在页面里求值
  --metrics                          # Performance 指标（JS/layout/style 占比）
```

要点：

- 一律用 `ws.scroll_xy` 取基准位置（CSS 版 attribute 是 0），交替多轮取稳定值；
- 端到端 fps 会被场景负载带偏，只比微基准和「函数自时间占比」；
- 大对象别直接回传（CDP 会 SIGTERM），走 `POST /k4p/dump` 落盘；
- 截图的 frame 0 是播放器、frame 1 是壳（`window.k4p` 只在壳里）。

prof 分析脚本：`tools/prof_top.js --stacks`（调用路径总时间）、`--kids=函数名`（直接子调用），
用来定位被压缩的函数名。

---

## 调试开关（编辑器）

| 开关 | 作用 |
|---|---|
| `?k4p_cull=0` / `localStorage.k4p_cull='0'` | 关掉积木视口裁剪 |
| `?k4p_quiet=0` / `localStorage.k4p_quiet='0'` | 关掉「隐藏控件不渲染」 |
| `window.__k4pCull.every` | 裁剪跟随平移的帧间隔（默认 6） |
| `window.__k4pCull.margin` / `.kick()` | 裁剪屏余量（默认 0.5）/ 强制重建 |
| `window.__k4pCull.snapshot()` | `{applied, blocks, hidden, shown, passes, lastMs, buildMs, every}` |
| `window.__k4pPerf.snapshot()` | `{applied, serializeMs, lastBlocks}`；`[k4p]` 前缀日志都出自这一层 |
| `window.__k4pQuiet` | `{on, fired}`，`fired` 是命中的隐藏按钮数 |
| `window.__k4pDocOn = 1` | 抓 doc 切片到 `__k4pDoc` / `__k4pNew`（下一次 mutate 里读） |
| `Ctrl + = / - / 0` | 整页缩放（`userData/k4p-zoom.json`） |
| `--restore` | 整体还原官方原版 |

---

## 踩过的坑

- **共用 userData**：和安装版共用 `%APPDATA%\electron_for_kitten4`，单实例锁会切回先开的那个。
  工程数据都在里面，删副本目录不会丢工程。
- **`--js-flags=--max-old-space-size=4096` 会让页面直接卡死**（Electron 33），别加。
- **`analyze_path()` 对未知路径静默丢弃**：op 生成成功、不抛异常、undo 栈正常，只有 doc 不变。
  验证必须读 doc，不能只看 UI。
- **CSS 平移的三处连带**：attribute 必须归零（`get_relative_xy` 两边相加）、style 要写完整
  translate + scale、拖拽层搬家要连 style 一起清零。
- **cull 不能「父块出视口就整枝收」**：子树只往下/右长，方向判反了会把屏内块全藏掉。
- **cull 要节流**：逐帧 toggle `display` 比不裁剪还慢。
- **隐藏控件的动画会拖垮整页**：`visibility` / `will-change` / `contain:paint` 都无效，
  只有 `content-visibility:hidden`。
- **`patch_num.js restore` 会冲掉 `.bak`**（播放器侧），restore 后要重跑 apply。
- **截图要等 15~20s**；`_probe/ed.js` 的 frame 0 是播放器、frame 1 是壳。
- 文件被占用时先 `taskkill //IM "源码编辑器4.0.exe" //F`。

---

## 文件地图（编辑器侧）

```
src/editor/
  perf.js      workspace_to_json 单遍收集（注入 build/k4p-perf.js）
  cull.js      积木视口裁剪 + 平移节流（注入 build/k4p-cull.js）
  quiet.js     隐藏控件不渲染（注入 build/k4p-quiet.js）
tools/
  patch_editor.js   打补丁 / 检查 / 还原 / 指定目录（--steps=des,sel,mut,pan,cull,quiet,main）
  prof_top.js       profile 分析（--stacks / --kids=函数名）
dist/Kitten4编辑器/
  【优化说明】.txt   面向使用者的 9 条说明（含怎么关）
  resources/app/build/kitten.<hash>.js(.k4p.bak)   改过的 bundle
  resources/app/build/index.html(.k4p.bak)         注入 3 个 script
  resources/app/build/k4p-perf.js / k4p-cull.js / k4p-quiet.js
  resources/app/main/index.js(.k4p.bak)            启动开关 + 整页缩放
_probe/
  ed.js            编辑器探针（--file/--inject/--profile/--shot/--drag/--wheel/--combo/--after/--expr）
  ed_*.js          一次性分析脚本（pan / cull / if / doc / jump ...）
_bench/
  ed_*.cpuprofile  CPU 采样
  ed_*.jpg / v2_*.jpg  截图对比
```

测试作品：`_probe/chipmunk2d.bcm4`（5513 块，压力测试）、`examples/预瞄.bcm4`（28 块，小作品路径必须用它）。

---

## 本地开发环境注意

```bash
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS "dist/Kitten4编辑器/源码编辑器4.0.exe"
```

否则 Electron 会以 Node 模式启动，或 `NODE_OPTIONS` 注入的 shim 把 `fs.rmSync` 改成回收站操作，
导致 G: 盘路径删除报 `EBUSY`。播放器侧同样的注意事项见 [PLAYER.md](PLAYER.md#本地开发环境注意)。
