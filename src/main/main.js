// src/main/main.js
// 辰曦音乐主进程入口
// 性能要点：音频引擎独立优先、争渡读屏先于UI初始化、单实例锁

const { app, BrowserWindow, globalShortcut, Menu, ipcMain, autoUpdater } = require('electron');
const path = require('path');
const fs = require('fs');

// ==================== 便携模式 ====================
// 所有数据（配置、缓存、音源、歌单）存储在 exe 同级的 data/ 目录
// 删除整个文件夹即可完全清除，实现"绿色免安装"
const PORTABLE_FLAG = path.join(process.resourcesPath || __dirname, 'portable.flag');
if (process.env.PORTABLE === '1' || fs.existsSync(PORTABLE_FLAG)) {
  const exeDir = path.dirname(app.getPath('exe'));
  const dataDir = path.join(exeDir, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  app.setPath('userData', dataDir);
  app.setPath('userCache', path.join(dataDir, 'cache'));
  app.setPath('logs', path.join(dataDir, 'logs'));
  process.env.PORTABLE = '1';
}
const { AudioEngine } = require('./audio-engine');
const { ZdsrBridge } = require('./zdsr-bridge');
const { SourceManager } = require('./source-manager');
const { SearchAggregator } = require('./search-aggregator');
const { ContextMenuBuilder } = require('./context-menu');

let mainWindow = null;
let audio, zdsr, srcMgr, search, ctxMenu;

// 单实例锁 - 避免重复启动占用音频设备
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  // 1. 先初始化争渡读屏桥接（视障用户需要语音反馈才能感知启动进度）
  zdsr = new ZdsrBridge();
  zdsr.initChannel('ChenXi');
  zdsr.registerIpc();

  // 2. 音频引擎（性能优先，独立初始化）
  audio = new AudioEngine();
  audio.registerIpc();
  audio.on('track-changed', ({ song, quality }) => {
    zdsr.announceTrackChange(song, quality);
    if (mainWindow) mainWindow.webContents.send('audio:track-changed', { song, quality });
  });
  audio.on('state-changed', (state) => {
    if (mainWindow) mainWindow.webContents.send('audio:state-changed', state);
  });
  audio.on('position', (pos) => {
    if (mainWindow) mainWindow.webContents.send('audio:position', pos);
  });
  audio.on('error', (err) => {
    zdsr.announceError(err.message);
    if (mainWindow) mainWindow.webContents.send('audio:error', err.message);
  });
  audio.on('need-preload', () => {
    if (mainWindow) mainWindow.webContents.send('audio:need-preload');
  });

  // 3. 音源管理
  srcMgr = new SourceManager();
  await srcMgr.loadBuiltInSources();  // 先加载内置音源
  srcMgr.registerIpc();
  srcMgr.on('source-added', (src) => {
    zdsr.speak(`已导入音源 ${src.name} ${src.version || ''}，支持 ${src.platformLabels.join('、') || '未知平台'}`, true);
    if (mainWindow) mainWindow.webContents.send('src:added', src);
    search.clearCache(); // 音源变更后清除搜索handler缓存
  });
  srcMgr.on('source-removed', () => search.clearCache());
  srcMgr.on('source-toggled', () => search.clearCache());

  // 4. 搜索聚合
  search = new SearchAggregator(srcMgr);
  search.registerIpc();

  // 5. 右键菜单
  ctxMenu = new ContextMenuBuilder();
  ctxMenu.registerIpc();

  await createWindow();
  registerShortcuts();
  registerUpdater();
});

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 560,
    backgroundColor: '#0c1018',
    show: false,
    frame: true,
    title: '辰曦音乐',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // 隐藏菜单栏（ALT仍可调出）- 不影响外观
  Menu.setApplicationMenu(null);

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    zdsr.speak('辰曦音乐已启动，主界面就绪。输入关键词搜索，按 Alt 打开功能菜单。', true);
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

/**
 * 全局快捷键 - 完全键盘可达，争渡读屏友好
 * ALT菜单体系 + 媒体键
 */
function registerShortcuts() {
  // F4 打开音源管理
  globalShortcut.register('F4', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('menu:open', 'source');
    }
  });
  // ALT+P 播放面板
  globalShortcut.register('Alt+P', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu:open', 'play');
  });
  // ALT+L 歌单
  globalShortcut.register('Alt+L', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu:open', 'playlist');
  });
  // ALT+C 排行榜
  globalShortcut.register('Alt+C', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu:open', 'charts');
  });
  // ALT+S 设置
  globalShortcut.register('Alt+S', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu:open', 'settings');
  });
  // ALT+H 帮助
  globalShortcut.register('Alt+H', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu:open', 'help');
  });
  // Alt+Esc 关闭菜单
  globalShortcut.register('Alt+Escape', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu:close');
  });
  // 媒体键
  globalShortcut.register('MediaPlayPause', () => {
    if (audio.playing) audio.pause(); else audio.resume();
  });
  globalShortcut.register('MediaNextTrack', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('audio:next');
  });
  globalShortcut.register('MediaPreviousTrack', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('audio:prev');
  });
}

// ---------- 自动更新 ----------
function registerUpdater() {
  // GitHub Releases 自动更新 + 增量更新(blockmap)
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'Chenxi213',
    repo: 'chenxi-music',
    private: false
  });
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;

  // 启动时自动检查一次更新（静默，不弹窗打扰）
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 15000);

  autoUpdater.on('update-available', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:update-available', info);
    }
  });
  autoUpdater.on('update-not-available', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:update-not-available');
    }
  });
  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:update-progress', progress);
    }
  });
  autoUpdater.on('update-downloaded', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:update-downloaded');
    }
    const { dialog } = require('electron');
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '更新就绪',
        message: '新版本已下载完成，重启后即可安装。',
        buttons: ['立即重启', '稍后'],
        defaultId: 0
      }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
    }
  });
  autoUpdater.on('error', (err) => {
    console.log('更新检查:', err.message);
  });

  ipcMain.handle('app:check-update', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      const hasUpdate = result && result.updateInfo && result.updateInfo.version !== app.getVersion();
      return {
        hasUpdate: !!hasUpdate,
        version: result?.updateInfo?.version || app.getVersion(),
        releaseNotes: result?.updateInfo?.releaseNotes || '',
        url: 'https://github.com/Chenxi213/chenxi-music/releases'
      };
    } catch (e) {
      return { hasUpdate: false, version: app.getVersion(), error: e.message };
    }
  });

  ipcMain.handle('app:download-update', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('app:get-version', () => {
    return { version: app.getVersion() };
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (zdsr) zdsr.stopSpeak();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
