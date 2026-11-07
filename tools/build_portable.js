'use strict';
/**
 * 生成免安装绿色版：把 Electron 运行时 + 应用代码打包到 dist/Kitten4播放器
 * 用法：node tools/build_portable.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const TARGET = path.join(DIST, 'Kitten4播放器');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const EXE_NAME = 'Kitten4播放器.exe';

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(from, to, filter) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const s = path.join(from, name);
    const d = path.join(to, name);
    if (filter && !filter(s, name)) continue;
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d, filter);
    else fs.copyFileSync(s, d);
  }
}

function main() {
  if (!fs.existsSync(ELECTRON_DIST)) {
    console.error('未找到 Electron 运行时，请先执行 npm install');
    process.exit(1);
  }
  console.log('清理目标目录…');
  rmrf(TARGET);
  fs.mkdirSync(TARGET, { recursive: true });

  console.log('复制 Electron 运行时…');
  copyDir(ELECTRON_DIST, TARGET, (_s, name) => name !== 'electron.exe');

  // 精简语言包，只保留中英文
  const locDir = path.join(TARGET, 'locales');
  if (fs.existsSync(locDir)) {
    for (const f of fs.readdirSync(locDir)) {
      if (!/^(zh-CN|en-US)\.pak$/.test(f)) fs.rmSync(path.join(locDir, f), { force: true });
    }
  }

  const srcExe = path.join(ELECTRON_DIST, 'electron.exe');
  fs.copyFileSync(srcExe, path.join(TARGET, EXE_NAME));

  // 我们自带 resources/app，Electron 自带的默认应用不再需要
  rmrf(path.join(TARGET, 'resources', 'default_app.asar'));

  console.log('写入应用代码…');
  const appDir = path.join(TARGET, 'resources', 'app');
  fs.mkdirSync(appDir, { recursive: true });

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  delete pkg.devDependencies;
  delete pkg.build;
  delete pkg.scripts;
  pkg.name = 'kitten4-player';
  pkg.description = 'Kitten4 纯播放器';
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');

  copyDir(path.join(ROOT, 'src'), path.join(appDir, 'src'));
  copyDir(path.join(ROOT, 'assets'), path.join(appDir, 'assets'));

  console.log('写入使用说明…');
  fs.writeFileSync(path.join(TARGET, '使用说明.txt'), [
    'Kitten4 播放器（免安装版）',
    '========================',
    '',
    '怎么用',
    '  1. 双击 ' + EXE_NAME + ' 启动。',
    '  2. 把 .bcm4 作品拖进窗口，或点「选择文件」。',
    '  3. 也可以把作品文件直接拖到 ' + EXE_NAME + ' 图标上打开。',
    '  4. 想玩网上的作品：在首页输入框里填作品号（如 335327306），',
    '     或直接粘贴作品页链接，点「在线播放」。',
    '',
    '在线播放（按作品号）',
    '  能识别的输入：',
    '    · 作品号          335327306',
    '    · codemao 播放页  player.codemao.cn/new/335327306',
    '    · 社区作品页      shequ.codemao.cn/work/335327306',
    '    · PICKCAT 作品页  pickcat.dao3.fun/works/<uuid>（自动换成源作品号）',
    '  第一次打开要下载作品数据（通常几 MB），完成后缓存到',
    '  %APPDATA%\\kitten4-player\\online\\，再打开就是秒开；',
    '  断网时只要之前打开过，仍可用缓存继续玩。',
    '',
    '登录（可选）',
    '  首页点「登录编程猫账号」，填手机号/邮箱 + 密码即可。登录后：',
    '    · 作品请求会以你的账号身份发出，自己的未公开作品也能打开；',
    '    · 作品里的「云数据」积木（云变量、排行榜）会连官方服务器真实读写，',
    '      而不是停在“预览模式下云数据以本地形式运行”的模拟状态。',
    '  密码只在登录那一刻用一次，不会保存。本地只留一个登录令牌，',
    '  存在 %APPDATA%\\kitten4-player\\account.json，点「退出」即清除。',
    '  不登录也能玩，只是云数据相关积木按本地模拟跑。',
    '',
    '双击 .bcm4 直接播放',
    '  运行一次「安装文件关联.bat」即可；不想用了运行「卸载文件关联.bat」。',
    '  （只写入当前用户注册表，不改系统目录。）',
    '',
    '键盘',
    '  Ctrl+O  打开作品',
    '  Ctrl+L  输入作品号（回到首页）',
    '  Ctrl+R  重新开始当前作品',
    '  F11     全屏 / 退出全屏',
    '',
    '关于没有编译产物的作品',
    '  编辑器里没运行过、或被脚本裁剪过的 .bcm4 缺少编译产物（compile_result），',
    '  官方播放器会直接报「打开作品失败」。本播放器会先用内核自带的编译器现场补上，',
    '  所以这类文件也能直接播——第一次打开会多花 0.2~0.5 秒，之后走缓存。',
    '',
    '  如果你的作品积木本身有错（播放器会提示「作品积木还有点小问题」），',
    '  那仍然是作品自身的问题，需要回编辑器修。',
    '',
    '其它',
    '  最近打开记录保存在 %APPDATA%\\kitten4-player\\state.json，可随时清空。',
    '  在线作品缓存在 %APPDATA%\\kitten4-player\\online\\，删掉即可释放空间（会重新下载）。',
  ].join('\r\n'), 'utf8');

  fs.writeFileSync(path.join(TARGET, '安装文件关联.bat'), [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    'set EXE=%~dp0' + EXE_NAME,
    'reg add "HKCU\\Software\\Classes\\Kitten4Player.bcm4" /ve /d "Kitten4 作品" /f >nul',
    'reg add "HKCU\\Software\\Classes\\Kitten4Player.bcm4\\DefaultIcon" /ve /d "\\"%EXE%\\",0" /f >nul',
    'reg add "HKCU\\Software\\Classes\\Kitten4Player.bcm4\\shell\\open\\command" /ve /d "\\"%EXE%\\" \\"%%1\\"" /f >nul',
    'reg add "HKCU\\Software\\Classes\\.bcm4" /ve /d "Kitten4Player.bcm4" /f >nul',
    'echo 已安装 .bcm4 文件关联。',
    'pause',
  ].join('\r\n'), 'utf8');

  fs.writeFileSync(path.join(TARGET, '卸载文件关联.bat'), [
    '@echo off',
    'chcp 65001 >nul',
    'reg delete "HKCU\\Software\\Classes\\.bcm4" /f >nul 2>nul',
    'reg delete "HKCU\\Software\\Classes\\Kitten4Player.bcm4" /f >nul 2>nul',
    'echo 已移除 .bcm4 文件关联。',
    'pause',
  ].join('\r\n'), 'utf8');

  const size = dirSize(TARGET);
  console.log(`\n完成：${TARGET}`);
  console.log(`体积：${(size / 1024 / 1024).toFixed(1)} MB`);
}

function dirSize(dir) {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    total += st.isDirectory() ? dirSize(p) : st.size;
  }
  return total;
}

main();
