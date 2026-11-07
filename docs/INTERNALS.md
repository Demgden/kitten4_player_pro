# 实现笔记

给想改这个项目的人看的东西。README 讲的是「怎么用」，这里讲的是「它内部长什么样、哪些地方一碰就炸」。

按开发阶段的编号记录（阶段 3 是从 profile 里挑剩下的运行时热点——`step_call_domain_function` 7.7%、`get_list_id` 4.1%——目前没做）。

---

## 总线：一个本地 HTTP 服务，伪装成官网

播放器是纯前端产物。它需要 `client_config.json` 告诉它接口在哪、需要一个路径拿到作品、需要 `/web/users/details` 拿用户。`src/main/server.js` 起一个单端口服务把这些全接下来：

```
/kn/build/*              官方静态资源（原样托管）
/new/client_config.json  把 creation_api / api / open_service_api 全指向本地
/new/<token>             文档请求 → 播放器宿主页；数据请求 → 作品 JSON
/api/work/info/<id>      作品元信息
/web/users/details       未登录回 401，登录后透传官方用户对象
/k4p/compile.js, cloud.js  页面侧注入脚本
/k4p/compile-result      POST 编译结果回传
```

`/new/<token>` 一个路径担两个角色，靠 `Sec-Fetch-Dest` 和 `Accept` 区分是「请求页面」还是「请求作品数据」——播放器加载非数字路径时会直接把 `location.pathname` 当数据地址拉。

有几个必须踩准的点：`/web/users/details` 回 200 空对象会让播放器 `reading 'nickname'` 崩掉，所以只能用 401；CORS 必须回显 Origin 加 `Allow-Credentials`，不能用 `*`；`HEAD /new/<token>` 不能带 `Content-Length`，否则注入后长度不符会让播放器提前断开连接。

---

## 阶段 1：让缺编译产物的作品能播

本地 `.bcm4` 是**编辑器工作区格式**，不是运行时格式。两处关键差异：

1. 积木参数在 `blocks[id].fields` / `shadows` 里，还有 `connections` 映射，而运行时只认 `params`
2. `theatre.scenes[].actors` 是空数组

第二点是致命伤。运行时按 `scenes[].actors` 建场景角色层，空数组会让 `o.actors` 只有 3 项，克隆类积木按 id 找角色失败 → 抛 `throw_block_type_error('mirror')` → 界面卡在「初始化」并提示「作品积木还有点小问题」。

修复分两步：

- **编译**：`src/player/compile.js` 在页面侧拦下作品 XHR，调用内核自带的 `JSONEntityCompiler` 补出 `compile_result`，再按编辑器保存流水线补全（去循环引用 → `params.NUM` 转字符串 → 建 `running_group_id` → 删 `block_data_json`）
- **排版**：`server.js` 的 `normalizeProject()` 按 `scene.group_order`（图层从上到下）+ `theatre.groups[id].actors` 展平，然后**整体反转**（运行时数组是自底向上），已用线上同作品逐项比对验证一致

结果：florr 这类 4.72 MB / 15 个实体的作品，编译耗时 136~185 ms，补全后产物 22.7 MB 压到 10.1 MB。

> 内存里改 XHR 的 `responseText` 对这类作品无效——播放器读完就 `open_default` 了。有效做法是页面编译完 POST 回服务端，服务端拼成完整作品缓存，再 `location.reload()` 走原生加载路径。

---

## 阶段 2：让它跑快一点

### 数值层

数学积木的分派器最终都 `.toNumber()`，所以不存在「decimal 保证精度」的实际收益，只有代价。微基准（ns/次）：

| 实现 | 耗时 | 覆盖 |
|---|---|---|
| 原版 decimal.js | 1337 | 100% |
| 仅整数快路径 | 1159（−18%） | 42.7% |
| **全原生** | **21.7（60×）** | 100% |

代价是浮点会长尾（`0.030000000000001137`），用 `Math.round(x * 1e12) / 1e12` 收拾掉，开销约 2 ns。`tools/patch_num.js apply` 应用，`window.__k4pNative(0)` 运行时可回退，`restore` 还原。

florr 实测「每帧用时」0.16 → 0~0.09。

### 代码生成器

真正生成 JS 的是 `BINDING.OptiCompiler`（不是 `Compiler`，后者只有 `compile` / `compile_entity`）。它在每个表达式前插一句 `X.EB(...)` 只为编辑器高亮当前积木，永不 yield，纯开销。页面侧替换掉让出点的生成逻辑，把 `X.EB` / `X.ED` 内联成 `X.DB[g] = n`：

- `X.EB` 15924 → 0，`X.ED` 52624 → 0
- 生成源码 9.86 MB → 4.59 MB（−53%）
- 性能只提升 0.5%（本来占比就小，主要收益是体积和解析时间）

**`case n:` 不能删。** 它是层级恢复点：内层 yield group 恢复时，外层 `switch` 必须先跳回「正在执行这条语句」才能再进内层 switch。删掉之后作品会卡在「加载图片资源(0/174)」。

---

## 阶段 3：解释器自身的开销

阶段 2 解决了「积木做什么」的成本（数值、调度），阶段 3 转而处理「解释器怎么调积木」的成本——每次都发生的通用路径。florr 采样里排名靠前的自时间：

| 函数 | 占比 | 干什么 |
|---|---|---|
| `optifun` | 16.9% | 生成代码主循环，switch 派发 + `pc` 写回 |
| `step_call_domain_function` | 11.1% | 每次积木调用都走的转发层 |
| `get_list_id` | 8.0% | 列表积木每次改动都要反查「这个数组是哪个变量」 |
| `do_step` | 7.6% | 每 tick 一次，含 `get_step_args` 的对象分配 |
| `current_interpreter_must_yield` | 2.6% | 让出判定，连查 3 张表 |
| `_wall_clock_now` | 2.0% | warp 循环每轮取时间 |

`tools/patch_rt.js` 一共改 8 处，全部是解释器自身的方法，不碰生成代码、不碰作品数据：

| 改动 | 做法 |
|---|---|
| `get_list_id` | 线性遍历全部变量（232 个）找数组引用 → `WeakMap` 反查缓存，命中后再校验 id 仍指向该数组 |
| `_wall_clock_now` | 每次都查 `typeof performance` 和 `performance.now` → 首次绑定后直接调用 |
| warp 时钟 | 每次迭代查一次 `performance.now()` → 每 64 次查一次（时间片 5 ms，损失可忽略） |
| 数值分派 `f` | 快路径提到 `try` 外、字符串键查表换成三元链；NaN / ±Infinity 直接返回，不再 new 两个 Decimal |
| `step_call_domain_function` | `Promise.resolve(o) === o` 每次都建一个 Promise → `o instanceof Promise` |
| `must_yield` | 内联判定，`running_interpreter_was_blocked` / `running_group_changed` 都没变时直接短路 |
| `step_after_potential_blocker` | 同上，省掉一次函数调用 + 两张表查询 |
| `get_var_or_list` | 变量读两次 `this.variables[t]` → 读一次 |

微基准（同一页面、同一变量表，10 万次平均）：

| 函数 | 改前 | 改后 | 倍数 |
|---|---|---|---|
| `get_list_id`（常态，命中） | 5915 ns | **30 ns** | **197×** |
| `wall_clock_now` | 609 ns | **83 ns** | 7.3× |
| `get_var_or_list` | 38 ns | 32 ns | 1.2× |

profile 里 `get_list_id`、`_wall_clock_now`、数值分派 `f`、`new Decimal` 全部从 Top 榜上消失。

**一个顺带修掉的 bug**：`f` 里原来写着 `var r = Math.round(...)`，而 `r` 正是外面 Decimal 构造器的名字——`var` 提升把整个函数作用域的 `r` 都变成了局部变量，于是 `new r.Decimal(t)` 必然抛 `TypeError`，被 `catch` 吞掉后退回原生运算。也就是说**慢路径（decimal）从来没有生效过**。改名成 `rr` 之后才真正按语义走：只有结果为 NaN / ±Infinity 或操作数不是数字时才进 decimal。

> 端到端 fps 不能用来衡量这一阶段：florr 的场景负载每次启动都不同（一局里敌人数量、刷新区块数都在变），同一份代码能跑出 23 fps 也能跑出 60 fps。只有微基准和「函数自时间占比」这两类指标跨运行可比。

### 阶段 3b：生成代码的骨架（`optifun`）

`optifun` 是 profile 里自时间最大的一项（16.9%），它本身不干游戏的事，只做 `switch` 派发和 `pc` 写回。看完实际生成的源码后，骨架里有三块可以砍：

**一、循环体里还留着 `X.EB` 调用。** 阶段 2 只替换了 `state` 上的两个方法，而 `compile_repeat_forever` 那条路径是直接吐字符串的，压根没走它们：

```js
if (X.EB('bid', 'rbid', 'ent', 0, 23)) { return; }case 23:
```

`EB` 的实现是：

```js
step_before_expression(t, e, n, i, r) {
  return this.should_report_current_running_block && this.run_mgr.set_running_block(n, t),
         this.current_frame.program_counter[i] = r,
         false
}
```

播放器里 `should_report_current_running_block` 默认 `false`，`set_running_block` 只是给编辑器发 `block_running` 事件（播放器没有订阅者）。所以它**等价于一次纯 pc 写入 + 返回 false**，`if (...) return;` 是死分支。

**二、嵌套语句连出一串空骨架。** 每层语句都会压一段 `pc` 写入，中间什么都不干：

```js
case 0: X.DB[0]=1;case 1: X.DB[0]=2;case 2: X.DB[0]=3;case 3: X.DA[1] = {};
```

只有最后一段可能被命中：中间没有让出点，跳转也只可能是「跳到该 case 然后立刻被下一段覆盖」。删掉前两段对语义没有影响（真跳到被删的 case，也只是顺势落到下一段、pc 重新对齐）。

**三、`X.DB[0]=n` 每次都要查一次 `X` 的属性表。** 把帧字段提成函数局部变量即可：

```js
return function optifun(X) {var DB=X.DB,DA=X.DA,BC=X.BC,BA=X.BA;switch (DB[0]) {
```

帧对象是池化的：`frame.reset()` 会给 `program_counter` / `dynamic_data` 换新数组，但那发生在**调用开始前**（`interpreter.reset()` 建帧时），单次 `optifun` 执行期间这些引用不变，所以按调用取值是安全的。

三条都实现在 `src/player/compile.js` 的 `transformOptifun()` 里，通过包住 `OptiCompiler.prototype.wrap_with_top_level` 拿到「拼好的整段源码」再改写（这是唯一能拿到全文的位置）。`?k4p_opt=0` 或 `localStorage.k4p_opt='0'` 可关闭，方便 A/B。

测量（骨架是纯 CPU 循环，没有场景方差）：

| 形态 | 每次遍历 300 块 | 相对官方 |
|---|---|---|
| 官方生成 | 0.170 ms | — |
| 阶段 2（EB/ED 内联） | 0.187 ms | −8.9% |
| ＋折叠空骨架 | 0.179 ms | −4.8% |
| ＋折叠＋帧字段提局部 | 0.118 ms | **+44%** |
| ＋再删裸 `X.DA[n]` 读 | 0.124 ms | +37%（无收益，已放弃这条） |

再拿**真实生成代码**（不是合成）在页面里跑全量遍历，`new Function` 两份对比，`?k4p_opt=0` 时抓原始源码：

| 函数大小 | 原始 | 改写后 | 提升 |
|---|---|---|---|
| 587 KB | 16.6 µs | 9.7 µs | +71% |
| 305 KB | 1.75 µs | 1.20 µs | +46% |
| 223 KB | 0.50 µs | 0.35 µs | +43% |

结论：**收益几乎全来自「帧字段提局部」**，折叠骨架只占几个百分点，EB/ED 内联本身甚至是负的（函数调用被 V8 内联后比手写 store 还便宜），但它是折叠的前提（统一成 `X.DB[g]=n` 后才好扫），所以留着。

一个副产品是生成源码小了约 12%（587 KB → 516 KB），`new Function` 的解析开销也跟着降。

---

## 阶段 4：在线作品

官方有个匿名可用的接口：

```
GET https://api-creation.codemao.cn/kitten/r2/work/player/load/<id>
→ { name, preview, source_urls[], is_bcm4, updated_time, version }
```

- `source_urls` 是同一作品的多个历史版本，`[0]` 最新
- 不存在 → HTTP 422 + `{ error_code: "40204002" }`
- 线上产物**已经是运行时格式**（带 `compile_result`、`actors` 已排好），下载完不用再编译

PICKCAT 链接要先多解析一步：`GET pickcat.dao3.fun/api/v1/works/<uuid>` → `sourceWorkId` 就是原作品号。

实现上用 Electron 的 `net` 模块发请求（走 Chromium 网络栈，自动跟随系统代理和证书），下载先写 `.tmp` 再 rename，每次打开都比对 `source_urls[0]` 与本地记录的 `sourceUrl` 决定是否重下。

---

## 阶段 5：登录与云数据

登录本身很简单——`POST /tiger/v3/web/accounts/login`，密码明文提交，官方客户端也没有前端加密，拿回来的 JWT 存 `userData/account.json`。

麻烦的是云数据。播放器里的判定是：

```js
work_id && is_login && 作品声明了云变量 && auth_type
  → 连 wss://socketcv.codemao.cn:9096
否则
  → 「预览模式下，云数据会以本地形式运行」
```

我们直接把 `/new/<token>` 当顶层文档加载，没有父页面替它 postMessage，作品又是从本地 JSON 读的，所以 **`work_id` 恒为空**——登录了也没用。`is_login` / `auth_type` 播放器自己请求 `/web/users/details` 就有了，不用管。

补法：`src/player/cloud.js` 轮询到内核就绪后 `dispatch(set_work_id)`，登录状态下再补一次云变量初始化。同时 `client_config.json` 里的 `cloud_storage_api` 在登录时指回官方域名（未登录仍指本地，否则会卡住）。

验证到 `CmCloud.socket.is_connected === true`、WS 地址里 `session_id` 等于作品号，就算真连上了。

---

## 性能数据

florr（335327306，7.6 MB，15 个实体），12 秒采样：

| 指标 | 数值 |
|---|---|
| 帧间隔 p50 | 66.7 ms（≈15 fps，官方有自动锁帧） |
| 脚本 / 渲染 / GC 占比 | 85.6% / 6.9% / 1.9% |
| 调度与状态机税 | ≈31%（optifun、do_step、increment_pc 等） |
| 积木函数 | ≈38%（其中 decimal 链约 40%） |

结论是脚本是唯一瓶颈，渲染只占 7%，所以优化全打在代码生成和数值层上。

> 注意：fps 和 ScriptDuration 占比都不可靠（fps 随场景剧烈波动，主线程本就 100% 饱和）。只有受控微基准可信，`tools/bench.js` 用来定位热点、不用来比分数。

---

## 目录结构

```
src/
  main/
    main.js      窗口、WebContentsView 布局、IPC、文件关联、最近打开
    server.js    本地 HTTP 服务；normalizeProject() 做工作区→运行时格式转换
    online.js    作品号解析、官方接口、缓存与断网降级
    auth.js      账号登录、令牌持久化、cookie / Authorization 注入
  player/
    page.html    播放器宿主页（遮罩、自动点播放、隐藏登录条）
    compile.js   页面侧预编译器 + OptiCompiler 代码生成补丁
    cloud.js     注入 work_id，让云数据从模拟切到真实 socket
    build/       官方 player_v2 全套构建产物（已打补丁）
  shell/         自绘标题栏 + 欢迎页 + 登录弹窗
tools/
  build_portable.js  生成绿色版 dist/Kitten4播放器/
  bench.js           CPU 采样剖面 + 帧率
  probe.js           CDP 调试（执行 / 注入 / 截图 / 控制台捕获）
  patch_num.js       数值层改全原生，restore 可还原
  patch_decimal.js   decimal 分派实验（count / stat / native / hybrid / int）
  instrument.js      给 bundle 埋运行时错误点，trace / restore
```

应用代码约 3000 行，`build/` 是官方产物约 11 MB，不含在内。

---

## 调试开关

| 开关 | 作用 |
|---|---|
| `K4P_LOG=1` | 把播放器页面的 console 转发到终端，排查加载失败必开 |
| `K4P_DUMP=1` | 把页面编译拼装后的作品落盘到 `_probe/_assembled.bcm4`，可离线分析产物 |
| `?k4p_debug=1` | 保留 WebGL 绘制缓冲，便于外部截图读画面 |
| `?k4p_debug=2` | 把被吞掉的 Promise 拒绝打到控制台 |
| `?k4p_debug=3` | 打印所有 XHR 目标地址 |
| `?k4p_debug=4` | 记录每次 `Error` 构造，定位被吞的异常 |
| `?k4p_cg=0` / `localStorage.k4p_cg='0'` | 关掉代码生成器补丁，用于 A/B 对比 |
| `window.__k4pNative(0)` | 数值层回退到 decimal 原实现（`1` 切回全原生） |

---

## 踩过的坑（省得重踩）

- **仓库不含 `.bak` / `.orig` / `.num_orig` 备份**（`.gitignore` 排除了），`patch_num.js restore` 在全新 clone 上会找不到源文件。要还原就先自己备份一份未打补丁的 bundle
- **`Compiler` 不是代码生成器**，`OptiCompiler` 才是。而且补丁必须容器就绪后立刻装，不能挂在 `compileProject` 里（第二次加载会跳过编译）
- **`instrument.js restore` 会冲掉数值补丁**（它用 `.bak` 覆盖 bundle），restore 之后要重跑 `patch_num.js apply`
- **自带 `compile_result` 但 `scenes[].actors` 为空的作品会卡在「初始化」**：页面侧看到有编译产物就跳过编译，`normalizeProject` 也就没机会补角色层。修法在 `server.js prepareProject()`——首次取作品数据时判断「有 compile_result 且哪个场景 actors 为空」，就地补齐后再返回（florr 21.7 MB → 10.5 MB）
- **CDP 回传 MB 级对象会被 SIGTERM**，大对象一律 `POST /k4p/dump` 落盘
- **截图要等 15~20 秒**，首帧加载图片资源慢，9 秒时可能还停在 `正在加载图片资源(0/174)`
- 文件被占用时先 `taskkill //IM "Kitten4播放器.exe" //F`
- `lists_get_value` 的下标是 1-based，传 0 会抛 `lists_get_value_bad_index`（jelly car 就栽在这，属于作品自身问题）

---

## 本地开发环境注意

Windows 上启动 Electron 和跑打包脚本建议加：

```bash
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/electron/dist/electron.exe .
```

否则 Electron 会以 Node 模式启动（`ELECTRON_RUN_AS_NODE` 被继承），且某些环境下 `NODE_OPTIONS` 注入的 shim 会把 `fs.rmSync` 改成回收站操作，导致 G: 盘等路径删除报 `EBUSY`。
