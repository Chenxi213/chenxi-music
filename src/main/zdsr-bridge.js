// src/main/zdsr-bridge.js
// 争渡读屏 ZDSRAPI 桥接 - 完全适配争渡读屏
// 通过 ffi-napi 调用 ZDSRAPI_x64.dll，提供独立语音通道
// 不影响外观：纯后台进程，无任何UI

const path = require('path');
const fs = require('fs');
const { ipcMain } = require('electron');
const EventEmitter = require('events');

// 尝试加载 ffi-napi（仅 Windows 生产环境）
let ffi = null, ref = null;
try {
  ffi = require('ffi-napi');
  ref = require('ref-napi');
} catch (e) {
  console.warn('[zdsr] ffi-napi unavailable, running in mock mode:', e.message);
}

// ZDSRAPI 函数签名
// int WINAPI InitTTS(int type, const WCHAR* channelName, BOOL bKeyDownInterrupt)
// int WINAPI Speak(const WCHAR* text, BOOL bInterrupt)
// int WINAPI StopSpeak()
// int WINAPI GetSpeakState()
const ZDSR_API_SIG = {
  'InitTTS': ['int', ['int', 'pointer', 'int']],
  'Speak': ['int', ['pointer', 'int']],
  'StopSpeak': ['void', []],
  'GetSpeakState': ['int', []]
};

class ZdsrBridge extends EventEmitter {
  constructor() {
    super();
    this.enabled = false;
    this.channelReady = false;
    this.interruptOnKey = true;
    this.announceTrackChange = true;
    this.rate = 1.0;
    this.volume = 0.8;
    this._lib = null;
    this._init();
  }

  _findZdsrDll() {
    // 争渡读屏默认安装路径
    const candidates = [
      'C:\\Program Files (x86)\\zdsr\\zdsr\\ZDSRAPI_x64.dll',
      'C:\\Program Files\\zdsr\\zdsr\\ZDSRAPI_x64.dll',
      'C:\\Program Files (x86)\\zdsr\\zdsr\\ZDSRAPI.dll',
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'zdsr', 'zdsr', 'ZDSRAPI_x64.dll')
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  _init() {
    if (!ffi) { console.warn('[zdsr] ffi not loaded'); return; }
    const dllPath = this._findZdsrDll();
    if (!dllPath) { console.warn('[zdsr] ZDSRAPI.dll not found'); return; }
    try {
      this._lib = new ffi.Library(dllPath, ZDSR_API_SIG);
      console.log('[zdsr] ZDSRAPI loaded from', dllPath);
    } catch (e) {
      console.warn('[zdsr] failed to load library:', e.message);
    }
  }

  /**
   * 开通独立语音通道（type=1）
   * 不与争渡读屏主通道冲突
   */
  initChannel(channelName = 'ChenXi') {
    if (!this._lib) return false;
    try {
      const nameBuf = Buffer.from(channelName + '\0', 'ucs2');
      const ret = this._lib.InitTTS(1, nameBuf, this.interruptOnKey ? 1 : 0);
      if (ret === 0) {
        this.channelReady = true;
        this.enabled = true;
        console.log('[zdsr] channel initialized:', channelName);
        return true;
      }
      console.warn('[zdsr] InitTTS returned', ret);
      return false;
    } catch (e) {
      console.error('[zdsr] InitTTS error:', e.message);
      return false;
    }
  }

  /**
   * 主动播报文本（经独立通道，不打断读屏主通道）
   * @param {string} text - 要朗读的文本
   * @param {boolean} interrupt - 是否打断当前播报
   */
  speak(text, interrupt = false) {
    if (!this.enabled || !this._lib || !this.channelReady) return false;
    try {
      const textBuf = Buffer.from(text + '\0', 'ucs2');
      const ret = this._lib.Speak(textBuf, interrupt ? 1 : 0);
      return ret === 0;
    } catch (e) {
      console.error('[zdsr] Speak error:', e.message);
      return false;
    }
  }

  stopSpeak() {
    if (!this._lib) return;
    try { this._lib.StopSpeak(); } catch (e) {}
  }

  getState() {
    if (!this._lib) return 4;
    try { return this._lib.GetSpeakState(); } catch (e) { return 4; }
  }

  isSpeaking() { return this.getState() === 3; }

  /**
   * 切歌播报 - 视障用户核心反馈
   */
  announceTrackChange(song, quality) {
    if (!this.announceTrackChange) return;
    const parts = [];
    parts.push(song.name || '');
    if (song.artist) parts.push(song.artist);
    if (quality && quality.label) parts.push(quality.label);
    const text = parts.join('，');
    this.speak(text, true);
  }

  announceProgress(position, duration) {
    const fmt = (s) => {
      const m = Math.floor(s / 60);
      const ss = Math.floor(s % 60);
      return `${m}分${ss}秒`;
    };
    this.speak(`进度 ${fmt(position)}，共 ${fmt(duration)}`, true);
  }

  announceError(message) {
    this.speak(`错误：${message}`, true);
  }

  setEnabled(on) {
    this.enabled = on;
    if (on && !this.channelReady) this.initChannel();
    if (!on) this.stopSpeak();
  }

  registerIpc() {
    ipcMain.handle('zdsr:speak', (e, { text, interrupt }) => {
      return { ok: this.speak(text, interrupt) };
    });
    ipcMain.handle('zdsr:stop', () => { this.stopSpeak(); return { ok: true }; });
    ipcMain.handle('zdsr:announce-track', (e, { song, quality }) => {
      this.announceTrackChange(song, quality);
      return { ok: true };
    });
    ipcMain.handle('zdsr:announce-progress', (e, { position, duration }) => {
      this.announceProgress(position, duration);
      return { ok: true };
    });
    ipcMain.handle('zdsr:set-enabled', (e, on) => { this.setEnabled(on); return { ok: true }; });
    ipcMain.handle('zdsr:set-interrupt', (e, on) => { this.interruptOnKey = on; return { ok: true }; });
    ipcMain.handle('zdsr:set-announce', (e, on) => { this.announceTrackChange = on; return { ok: true }; });
    ipcMain.handle('zdsr:state', () => ({
      enabled: this.enabled,
      channelReady: this.channelReady,
      speaking: this.isSpeaking()
    }));
  }
}

module.exports = { ZdsrBridge };