// src/main/main.js
// 辰曦音乐主进程入口
// 性能要点：音频引擎独立优先、争渡读屏先于UI初始化、单实例锁

const { app, BrowserWindow, globalShortcut, Menu, ipcMain, autoUpdater } = require('electron');
const path = require('path');
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
  // ALT+P 播放面板
  globalShortcut.register('Alt+P', () => {
    mainWindow?.webContents.send('menu:open', 'play');
  });
  // ALT+L 歌单
  globalShortcut.register('Alt+L', () => {
    mainWindow?.webContents.send('menu:open', 'playlist');
  });
  // ALT+C 排行榜
  globalShortcut.register('Alt+C', () => {
    mainWindow?.webContents.send('menu:open', 'charts');
  });
  // ALT+S 设置
  globalShortcut.register('Alt+S', () => {
    mainWindow?.webContents.send('menu:open', 'settings');
  });
  // ALT+H 帮助
  globalShortcut.register('Alt+H', () => {
    mainWindow?.webContents.send('menu:open', 'help');
  });
  // Alt+Esc 关闭菜单
  globalShortcut.register('Alt+Escape', () => {
    mainWindow?.webContents.send('menu:close');
  });
  // 媒体键
  globalShortcut.register('MediaPlayPause', () => {
    if (audio.playing) audio.pause(); else audio.resume();
  });
  globalShortcut.register('MediaNextTrack', () => {
    mainWindow?.webContents.send('audio:next');
  });
  globalShortcut.register('MediaPreviousTrack', () => {
    mainWindow?.webContents.send('audio:prev');
  });
}

// ---------- 自动更新 ----------
function registerUpdater() {
  // 更新源配置（打包后替换为真实地址）
  autoUpdater.setFeedURL('https://releases.example.com/chenxi-music');

  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('app:update-available', info);
  });
  autoUpdater.on('update-not-available', () => {
    mainWindow?.webContents.send('app:update-not-available');
  });
  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('app:update-progress', progress);
  });
  autoUpdater.on('update-downloaded', () => {
    mainWindow?.webContents.send('app:update-downloaded');
  });
  autoUpdater.on('error', (err) => {
    mainWindow?.webContents.send('app:update-error', err.message);
  });

  ipcMain.handle('app:check-update', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (result) {
        return { ok: true, updateAvailable: false, version: app.getVersion() };
      }
      return { ok: true, updateAvailable: false, version: app.getVersion() };
    } catch (e) {
      // 未配置更新源时返回当前版本
      return { ok: true, updateAvailable: false, version: app.getVersion() };
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
