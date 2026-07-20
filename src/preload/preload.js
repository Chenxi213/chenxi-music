// src/preload/preload.js
// 辰曦音乐 preload - 安全IPC桥接，渲染层通过contextBridge访问

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chenxi', {
  // 音频
  audio: {
    play: (song, candidates) => ipcRenderer.invoke('audio:play', { song, candidates }),
    pause: () => ipcRenderer.invoke('audio:pause'),
    resume: () => ipcRenderer.invoke('audio:resume'),
    stop: () => ipcRenderer.invoke('audio:stop'),
    seek: (sec) => ipcRenderer.invoke('audio:seek', sec),
    setVolume: (v) => ipcRenderer.invoke('audio:set-volume', v),
    setMode: (m) => ipcRenderer.invoke('audio:set-mode', m),
    setGapless: (g) => ipcRenderer.invoke('audio:set-gapless', g),
    state: () => ipcRenderer.invoke('audio:state'),
    preloadNext: (song, candidates) => ipcRenderer.invoke('audio:preload-next', { song, candidates }),
    onTrackChanged: (cb) => ipcRenderer.on('audio:track-changed', (e, d) => cb(d)),
    onStateChanged: (cb) => ipcRenderer.on('audio:state-changed', (e, s) => cb(s)),
    onPosition: (cb) => ipcRenderer.on('audio:position', (e, p) => cb(p)),
    onError: (cb) => ipcRenderer.on('audio:error', (e, m) => cb(m)),
    onNext: (cb) => ipcRenderer.on('audio:next', () => cb()),
    onPrev: (cb) => ipcRenderer.on('audio:prev', () => cb())
  },
  // 争渡读屏
  zdsr: {
    speak: (text, interrupt = false) => ipcRenderer.invoke('zdsr:speak', { text, interrupt }),
    stop: () => ipcRenderer.invoke('zdsr:stop'),
    announceTrack: (song, quality) => ipcRenderer.invoke('zdsr:announce-track', { song, quality }),
    announceProgress: (pos, dur) => ipcRenderer.invoke('zdsr:announce-progress', { position: pos, duration: dur }),
    setEnabled: (on) => ipcRenderer.invoke('zdsr:set-enabled', on),
    setInterrupt: (on) => ipcRenderer.invoke('zdsr:set-interrupt', on),
    setAnnounce: (on) => ipcRenderer.invoke('zdsr:set-announce', on),
    state: () => ipcRenderer.invoke('zdsr:state')
  },
  // 音源
  source: {
    importFile: (filePath) => ipcRenderer.invoke('src:import-file', { filePath }),
    importUrl: (url) => ipcRenderer.invoke('src:import-url', { url }),
    importFolder: (folderPath, depth, formats) => ipcRenderer.invoke('src:import-folder', { folderPath, depth, formats }),
    parseScript: (code) => ipcRenderer.invoke('src:parse-script', { code }),
    list: () => ipcRenderer.invoke('src:list'),
    setEnabled: (id, on) => ipcRenderer.invoke('src:set-enabled', { id, on }),
    remove: (id) => ipcRenderer.invoke('src:remove', { id }),
    getUrl: (sourceId, platform, musicInfo, quality) => ipcRenderer.invoke('src:get-url', { sourceId, platform, musicInfo, quality }),
    check: (id) => ipcRenderer.invoke('src:check', { id }),
    onAdded: (cb) => ipcRenderer.on('src:added', (e, s) => cb(s))
  },
  // 搜索
  search: {
    query: (keyword, platforms, types, limit) => ipcRenderer.invoke('search:query', { keyword, platforms, types, limit })
  },
  // 右键菜单
  contextMenu: {
    show: (song, context) => ipcRenderer.invoke('ctx:show', { song, context }),
    setPlaylists: (playlists) => ipcRenderer.invoke('ctx:set-playlists', { playlists }),
    onAction: (cb) => ipcRenderer.on('context-menu:action', (e, d) => cb(d))
  },
  // ALT菜单事件
  menu: {
    onOpen: (cb) => ipcRenderer.on('menu:open', (e, panel) => cb(panel)),
    onClose: (cb) => ipcRenderer.on('menu:close', () => cb())
  },
  // 应用（关于/更新）
  app: {
    checkUpdate: () => ipcRenderer.invoke('app:check-update'),
    downloadUpdate: () => ipcRenderer.invoke('app:download-update'),
    getVersion: () => ipcRenderer.invoke('app:get-version')
  }
});
