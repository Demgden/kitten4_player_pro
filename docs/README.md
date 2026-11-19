# 文档索引

这个仓库里有两个**并列**的项目，共用一个 Electron 工具链，但不共用代码：

| 项目 | 是什么 | 产物 | 实现笔记 |
|---|---|---|---|
| **Kitten4 播放器** | 官方 `player_v2` 的本地壳：本地 `.bcm4` 双击就开、作品号直接玩、可选登录、带运行信息面板 | `dist/Kitten4播放器/` | [PLAYER.md](PLAYER.md) |
| **Kitten4 编辑器（性能副本）** | 官方桌面编辑器整份复制后打补丁，功能不变，只修积木多时的卡顿 | `dist/Kitten4编辑器/` | [EDITOR.md](EDITOR.md) |

两份文档互不依赖：读播放器不需要看编辑器，反之亦然。

---

## 怎么选

| 你手上的问题 | 去哪 |
|---|---|
| 作品打不开 / 卡在「初始化」/ 云数据不连 | [PLAYER.md](PLAYER.md)（阶段 1、5） |
| 想让它跑得更快（数值、代码生成、解释器） | [PLAYER.md](PLAYER.md)（阶段 2、3） |
| 想加/改运行信息面板 | [PLAYER.md](PLAYER.md)（运行信息面板） |
| 编辑器里积木多就卡、拖视角卡、改值卡 | [EDITOR.md](EDITOR.md)（阶段 6a~6d） |
| if 块 +/- 加层卡十几秒 | [EDITOR.md](EDITOR.md)（阶段 6c） |
| 编辑器界面在大屏上太小 / 想整页缩放 | [EDITOR.md](EDITOR.md)（阶段 6e） |
| 想重新给官方编辑器打补丁 | [EDITOR.md](EDITOR.md)（补丁器） |
| 忘了某个开关叫什么 | 各自文档末尾的「调试开关」 |
| 环境起不来（`ELECTRON_RUN_AS_NODE` / `EBUSY`） | 两份文档末尾的「本地开发环境注意」 |

---

## 共用约定

- **Electron 33**，两个产物各自打包，互不引用。
- **编辑器副本与安装版共用** `%APPDATA%\electron_for_kitten4`（单实例锁 → 不能同时开）；
  播放器用自己的 `%APPDATA%\kitten4-player`。
- 命令行起 Electron 一律加 `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS`，
  否则会以 Node 模式启动，或删除文件时报 `EBUSY`。
- 调试都走 CDP：播放器用 `tools/probe.js`，编辑器用 `_probe/ed.js`；
  大对象别直接回传（会被 SIGTERM），走 `POST /k4p/dump` 落盘。

---

## 目录

```
docs/
  README.md    本文件（索引）
  PLAYER.md    播放器：实现笔记
  EDITOR.md    编辑器性能副本：实现笔记
  screenshots/ README 用的截图
```

代码侧的边界（`src/main`、`src/player`、`src/shell`、`tools/*.js` 属于播放器；
`src/editor`、`tools/patch_editor.js` 属于编辑器）在各自文档的「文件地图」里列全。
