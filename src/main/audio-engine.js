// src/main/audio-engine.js
// 辰曦音乐音频引擎 - 默认最高音质协商 + WASAPI独占直通
// 性能要点：独立子进程托管、预加载下一曲、流式分块解码、降级链

const { ipcMain } = require('electron');
const path = require('path');
const EventEmitter = require('events');

// 音质档位优先级（从高到低）- 默认取最高可用
const QUALITY_PRIORITY = [
  { id: 'hires', label: 'Hi-Res', desc: '24bit/48-192kHz', minBitDepth: 24 },
  { id: 'master', label: 'Master', desc: 'MQA Master' },
  { id: 'atmos', label: 'Atmos', desc: '杜比全景声' },
  { id: 'flac24bit', label: 'Hi-Res FLAC', desc: '24bit FLAC' },
  { id: 'flac', label: '无损', desc: '16bit/44.1kHz FLAC' },
  { id: '320k', label: '极品', desc: '320kbps MP3' },
  { id: '192k', label: '高品', desc: '192kbps MP3' },
  { id: '128k', label: '标准', desc: '128kbps MP3' }
];

const QUALITY_MAP = {
  'hires': 'hr', 'master': 'hr', 'atmos': 'hr',
  'flac24bit': 'hr', 'flac': 'loss',
  '320k': 'ex', '128k': 'std'
};

class AudioEngine extends EventEmitter {
  constructor() {
    super();
    this.currentTrack = null;
    this.currentQuality = null;
    this.playing = false;
    this.position = 0; // seconds
    this.duration = 0;
    this.volume = 1.0;
    this.outputMode = 'wasapi-exclusive'; // wasapi-exclusive | wasapi-shared | asio | directsound
    this.gapless = true;
    this.replayGain = 'album'; // album | track | off
    this.preloadBuffer = null; // 预加载的下一曲解码数据
    this._nativeEngine = null;
    this._initNative();
  }

  /**
   * 初始化原生音频引擎
   * 真实环境通过 ffi-napi 加载 native/wasapi/chenxi_audio.dll
   * 沙箱环境降级为 Web Audio / HTMLAudioElement
   */
  _initNative() {
    try {
      // 生产环境：加载原生WASAPI引擎
      const addon = require(path.join(__dirname, '..', '..', 'native', 'wasapi', 'chenxi_audio.node'));
      this._nativeEngine = new addon.AudioEngine();
      this._nativeEngine.on('position', (pos) => this._onPosition(pos));
      this._nativeEngine.on('ended', () => this._onEnded());
      this._nativeEngine.on('error', (err) => this._onError(err));
      this._nativeEngine.setMode(this.outputMode);
      this._nativeEngine.setGapless(this.gapless);
      console.log('[audio] native WASAPI engine loaded');
    } catch (e) {
      console.warn('[audio] native engine unavailable, fallback to html-audio:', e.message);
      this._nativeEngine = null;
    }
  }

  /**
   * 默认最高音质协商
   * 给定歌曲在多个音源的可获得音质列表，返回最优档位与对应的播放URL
   * @param {Object} song - 歌曲信息
   * @param {Array} candidates - [{source, quality, getUrl}]
   * @returns {Promise<{quality, url, source}>}
   */
  async negotiateBestQuality(song, candidates) {
    // 收集所有可获得的音质档位
    const available = new Map(); // qualityId -> [{source, getUrl}]
    for (const c of candidates) {
      const qId = this._normalizeQuality(c.quality);
      if (!available.has(qId)) available.set(qId, []);
      available.get(qId).push(c);
    }

    // 按优先级从高到低尝试
    for (const q of QUALITY_PRIORITY) {
      if (!available.has(q.id)) continue;
      const options = available.get(q.id);
      // 并行尝试所有同档位音源，取首个成功
      const results = await Promise.allSettled(
        options.map(async (opt) => {
          const url = await opt.getUrl();
          if (!url) throw new Error('empty url');
          return { ...opt, url, quality: q };
        })
      );
      const ok = results.find(r => r.status === 'fulfilled');
      if (ok) {
        return ok.value;
      }
    }
    throw new Error('所有音源与音质档位均不可用');
  }

  _normalizeQuality(q) {
    // 兼容各种写法：128k/mp3_128k/standard/24bit/192k/flac24bit 等
    // 覆盖 LX 音源脚本返回的所有音质标识
    const s = String(q).toLowerCase();
    // Hi-Res / Master / Atmos（最高优先级）
    if (s.includes('hires') || s.includes('hi-res') || s.includes('hi_res')) return 'hires';
    if (s.includes('master') || s.includes('mqa')) return 'master';
    if (s.includes('atmos') || s.includes('dolby')) return 'atmos';
    // 24bit FLAC（Hi-Res FLAC 档位）
    if (s.includes('flac24') || s.includes('24bit') || s.includes('24_bit') ||
        s.includes('hires_flac') || s.includes('hi-res_flac')) return 'flac24bit';
    // 16bit 无损（FLAC/APE/ALAC/WAV）
    if (s.includes('flac') || s.includes('lossless') || s.includes('无损') ||
        s.includes('ape') || s.includes('alac') || s.includes('wav') || s.includes('dsd')) return 'flac';
    // MP3 比特率档位
    if (s.includes('320') || s.includes('exhigh') || s.includes('极品') || s.includes('ex')) return '320k';
    if (s.includes('192')) return '192k';
    if (s.includes('128') || s.includes('standard') || s.includes('标准') || s.includes('std')) return '128k';
    // 数字比特率兜底解析（如 "256k" / "320" 等）
    const numMatch = s.match(/(\d{3,})k?/);
    if (numMatch) {
      const num = parseInt(numMatch[1], 10);
      if (num >= 320) return '320k';
      if (num >= 192) return '192k';
      return '128k';
    }
    return '128k';
  }

  /**
   * 播放指定URL，以协商好的最高音质
   */
  async play(song, url, quality) {
    this.currentTrack = song;
    this.currentQuality = quality;
    this.position = 0;
    this.duration = song.duration || 0;

    if (this._nativeEngine) {
      // 原生WASAPI独占直通
      await this._nativeEngine.play(url, {
        mode: this.outputMode,
        gapless: this.gapless,
        replayGain: this.replayGain
      });
    } else {
      // 降级方案：通知渲染层使用HTMLAudio
      this.emit('play-fallback', { song, url, quality });
    }
    this.playing = true;
    this.emit('state-changed', this.getState());
    this.emit('track-changed', { song, quality });
  }

  pause() {
    if (this._nativeEngine) this._nativeEngine.pause();
    this.playing = false;
    this.emit('state-changed', this.getState());
  }

  resume() {
    if (this._nativeEngine) this._nativeEngine.resume();
    this.playing = true;
    this.emit('state-changed', this.getState());
  }

  stop() {
    if (this._nativeEngine) this._nativeEngine.stop();
    this.playing = false;
    this.position = 0;
    this.emit('state-changed', this.getState());
  }

  seek(seconds) {
    if (this._nativeEngine) this._nativeEngine.seek(seconds);
    this.position = seconds;
    this.emit('state-changed', this.getState());
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this._nativeEngine) this._nativeEngine.setVolume(this.volume);
    this.emit('state-changed', this.getState());
  }

  setOutputMode(mode) {
    this.outputMode = mode;
    if (this._nativeEngine) this._nativeEngine.setMode(mode);
  }

  /**
   * 预加载下一曲（提前8秒解码入缓冲，保证gapless无缝）
   */
  async preloadNext(song, candidates) {
    try {
      const best = await this.negotiateBestQuality(song, candidates);
      if (this._nativeEngine) {
        await this._nativeEngine.preload(best.url);
      }
      this.preloadBuffer = { song, ...best };
      this.emit('preload-ready', this.preloadBuffer);
    } catch (e) {
      this.preloadBuffer = null;
    }
  }

  _onPosition(pos) {
    this.position = pos;
    // 距结束8秒时触发预加载（如未开始）
    if (this.gapless && this.duration - pos <= 8 && !this.preloadBuffer) {
      this.emit('need-preload');
    }
    this.emit('position', pos);
  }

  _onEnded() {
    this.emit('ended');
    if (this.preloadBuffer) {
      // gapless无缝切到预加载
      this.play(this.preloadBuffer.song, this.preloadBuffer.url, this.preloadBuffer.quality);
      this.preloadBuffer = null;
    }
  }

  _onError(err) {
    this.emit('error', err);
  }

  getState() {
    return {
      track: this.currentTrack,
      quality: this.currentQuality,
      playing: this.playing,
      position: this.position,
      duration: this.duration,
      volume: this.volume,
      outputMode: this.outputMode,
      gapless: this.gapless,
      replayGain: this.replayGain
    };
  }

  registerIpc() {
    ipcMain.handle('audio:play', async (e, { song, candidates }) => {
      try {
        const best = await this.negotiateBestQuality(song, candidates);
        await this.play(song, best.url, best.quality);
        return { ok: true, quality: best.quality, source: best.source };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });
    ipcMain.handle('audio:pause', () => { this.pause(); return { ok: true }; });
    ipcMain.handle('audio:resume', () => { this.resume(); return { ok: true }; });
    ipcMain.handle('audio:stop', () => { this.stop(); return { ok: true }; });
    ipcMain.handle('audio:seek', (e, sec) => { this.seek(sec); return { ok: true }; });
    ipcMain.handle('audio:set-volume', (e, v) => { this.setVolume(v); return { ok: true }; });
    ipcMain.handle('audio:set-mode', (e, m) => { this.setOutputMode(m); return { ok: true }; });
    ipcMain.handle('audio:set-gapless', (e, g) => { this.gapless = g; if (this._nativeEngine) this._nativeEngine.setGapless(g); return { ok: true }; });
    ipcMain.handle('audio:state', () => this.getState());
    ipcMain.handle('audio:preload-next', async (e, { song, candidates }) => {
      await this.preloadNext(song, candidates);
      return { ok: true, ready: !!this.preloadBuffer };
    });
  }
}

module.exports = { AudioEngine, QUALITY_PRIORITY };
