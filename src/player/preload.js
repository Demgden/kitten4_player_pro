'use strict';
/**
 * 播放器视图的预加载脚本。
 * 官方播放器页面本身不认识桌面壳，这里只做两件事：
 *  1. 播放中把作品文件拖进窗口，可以换作品
 *  2. 播放中也能用 F11 / Ctrl+O
 */
const { ipcRenderer, webUtils } = require('electron');

window.addEventListener(
  'dragover',
  (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  },
  true
);

window.addEventListener(
  'drop',
  (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    e.preventDefault();
    e.stopPropagation();
    let p = '';
    try {
      p = webUtils.getPathForFile(files[0]);
    } catch (_) {
      p = '';
    }
    if (p) ipcRenderer.send('player-drop-path', p);
  },
  true
);

window.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'F11') {
      e.preventDefault();
      ipcRenderer.send('player-key', 'fullscreen');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'o') {
      e.preventDefault();
      ipcRenderer.send('player-key', 'open');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'l') {
      e.preventDefault();
      ipcRenderer.send('player-key', 'workid');
    }
  },
  true
);
