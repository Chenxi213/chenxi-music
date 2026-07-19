// src/main/source-manager.js
// 辰曦音乐音源管理 - LX Music脚本沙箱 + 自动识别 + 网址/本地双导入
// 自动解析 @name @version @description 与 sources 声明，自动检测启用

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const https = require('https');
const http = require('http');
const EventEmitter = require('events');

// 内置平台 ID 映射
const PLATFORM_LABELS = {
  wy: '网易云', tx: 'QQ音乐', kg: '酷狗', kw: '酷我', mg: '咪咕',
  qsvip: '汽水VIP', git: 'Git音源', bili: 'B站',
  local: '本地', qm: '汽水音乐'
};

// 音质档位映射（LX音源格式 → 辰曦档位）
const QUALITY_LABELS = {
  '128k': '标准', '320k': '极品', 'flac': '无损',
  'flac24bit': 'Hi-Res FLAC', 'hires': 'Hi-Res',
  'master': 'MQA Master', 'atmos': '杜比全景声', 'atmos_plus': '全景声+'
};

class SourceManager extends EventEmitter {
  constructor() {
    super();
    this.sources = []; // 已导入音源列表
    this.builtin = ['wy', 'tx', 'kg', 'kw', 'mg', 'bili']; // 内置平台ID
  }

  /**
   * 自动识别 LX Music 音源脚本
   * 解析头部 @name @version @description 注释 + sources 声明
   * 支持同步声明与异步声明（混淆脚本常通过 checkUpdate().then() 异步调用 send）
   * @param {string} code - JS脚本内容
   * @returns {Promise<Object>} {name, version, author, description, sources, platforms, qualities}
   */
  async parseLxScript(code) {
    const info = {
      name: '未命名音源',
      version: '',
      author: '',
      description: '',
      sources: {},
      platforms: [],
      qualities: [],
      lxCompatible: false
    };

    // 1. 解析头部注释块 @name @version @description @author
    const headerMatch = code.match(/\/\*!?\s*([\s\S]*?)\*\//);
    if (headerMatch) {
      const header = headerMatch[1];
      const getName = (key) => {
        const m = header.match(new RegExp(`@${key}\\s+(.+)`));
        return m ? m[1].trim() : '';
      };
      info.name = getName('name') || info.name;
      info.version = getName('version');
      info.author = getName('author');
      info.description = getName('description');
    }

    // 2. 沙箱化预解析：提取 sources 声明与平台/音质列表
    // LX脚本通过 send(EVENT_NAMES.inited, { sources }) 声明能力
    // 关键：脚本用 `const { send, on, request } = globalThis.lx` 解构，所以 globalThis.lx 必须是同一个对象
    // 混淆脚本（如长青SVIP）会通过 checkUpdate().then() 异步调用 send，因此：
    //   - request 必须调用其回调（第3个参数），否则 Promise 永不 resolve
    //   - 使用真实 setTimeout 让宏任务得以执行
    //   - parseLxScript 必须是 async，等待微任务/宏任务排空
    try {
      const lxObj = {
        EVENT_NAMES: { inited: 'inited', request: 'request', updateAlert: 'updateAlert' },
        send: (event, data) => {
          if (event === 'inited' && data && data.sources) {
            info.sources = data.sources;
            info.lxCompatible = true;
            for (const [id, def] of Object.entries(data.sources)) {
              info.platforms.push(id);
              if (def && def.qualitys) {
                info.qualities = Array.from(new Set([...info.qualities, ...def.qualitys]));
              }
            }
          }
        },
        on: () => {},
        // 关键修复：request 必须调用其回调，使依赖 request 的 Promise 能 resolve
        // 返回空响应体让 checkUpdate 的 Promise resolve 为 null/空对象，
        // 从而走 else 分支调用 send(EVENT_NAMES.inited, { sources })
        request: (url, options, cb) => {
          if (typeof cb === 'function') {
            try {
              cb(null, { body: '', statusCode: 200, headers: {}, raw: '' });
            } catch (e) { /* 忽略回调异常 */ }
          }
          return undefined;
        },
        utils: {
          buffer: { from: (s) => Buffer.from(s), bufToString: (b) => b.toString() },
          crypto: {
            md5: () => '', rsaEncrypt: () => '', randomBytes: () => Buffer.alloc(0),
            aesEncrypt: () => '', decode: (s) => s
          },
          url: { encode: encodeURIComponent, decode: decodeURIComponent, parse: (u) => new URL(u) }
        },
        env: 'desktop', version: '1.0.0'
      };
      const sandbox = {
        globalThis: { lx: lxObj },  // 同一对象引用
        lx: lxObj,                   // 同一对象引用
        console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
        // 使用真实定时器以支持异步流程（混淆脚本依赖）
        setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 200)),
        clearTimeout,
        setInterval: (fn, ms) => setInterval(fn, Math.min(ms || 0, 200)),
        clearInterval,
        queueMicrotask,
        Promise, isNaN, Number, Object, Array, Error, Math, Date, JSON,
        Buffer, process: { env: {} },
        URL, URLSearchParams,
        TextEncoder, TextDecoder
      };
      sandbox.globalThis = Object.assign(sandbox.globalThis, sandbox);
      sandbox.window = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(code, sandbox, { timeout: 1500 });

      // 让微任务与宏任务排空：混淆脚本通过 Promise.then 链异步调用 send
      // 多轮等待以覆盖 checkUpdate().then().then() 等链式调用
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 20));
      }
    } catch (e) {
      // 解析失败也允许导入，标记为非LX兼容
      if (!info.lxCompatible) info.lxCompatible = false;
      info.parseError = e.message;
    }

    return info;
  }

  /**
   * 从本地文件导入 .js 音源脚本
   */
  async importFromFile(filePath) {
    const code = fs.readFileSync(filePath, 'utf-8');
    const info = await this.parseLxScript(code);
    const src = {
      id: 'js_' + Date.now(),
      name: info.name,
      version: info.version,
      author: info.author,
      description: info.description,
      type: 'js',
      platforms: info.platforms,
      platformLabels: info.platforms.map(p => PLATFORM_LABELS[p] || p),
      qualities: info.qualities,
      qualityLabels: info.qualities.map(q => QUALITY_LABELS[q] || q),
      lxCompatible: info.lxCompatible,
      code: code,
      enabled: true, // 自动检测启用
      importedAt: new Date().toISOString()
    };
    this.sources.push(src);
    this.emit('source-added', src);
    return src;
  }

  /**
   * 从远程URL导入音源
   * - LX脚本URL：下载后自动识别
   * - 纯API URL：作为音源接口直接适配
   * 注意：远程URL只用于适配API调用，不内嵌分发JS代码
   */
  async importFromUrl(url) {
    const code = await this._fetch(url);
    // 判断是否是LX脚本（包含 @name 注释或 lx.send 调用）
    if (code.includes('@name') || code.includes('globalThis.lx') || code.includes('lx.send')) {
      const info = await this.parseLxScript(code);
      const src = {
        id: 'url_' + Date.now(),
        name: info.name,
        version: info.version,
        type: 'url',
        url: url,
        platforms: info.platforms,
        platformLabels: info.platforms.map(p => PLATFORM_LABELS[p] || p),
        qualities: info.qualities,
        qualityLabels: info.qualities.map(q => QUALITY_LABELS[q] || q),
        lxCompatible: info.lxCompatible,
        // 远程URL音源不保存完整代码，仅适配API调用
        code: null,
        apiBaseUrl: this._extractApiUrl(code) || url,
        apiKey: this._extractApiKey(code),
        enabled: true,
        importedAt: new Date().toISOString()
      };
      this.sources.push(src);
      this.emit('source-added', src);
      return src;
    }
    // 纯API接口
    const src = {
      id: 'api_' + Date.now(),
      name: '自定义API音源',
      version: '',
      type: 'url',
      url: url,
      apiBaseUrl: url,
      platforms: [],
      qualities: ['flac', '320k', '128k'],
      lxCompatible: false,
      enabled: true,
      importedAt: new Date().toISOString()
    };
    this.sources.push(src);
    this.emit('source-added', src);
    return src;
  }

  _extractApiUrl(code) {
    const m = code.match(/API_URL\s*=\s*["']([^"']+)["']/);
    return m ? m[1] : null;
  }

  _extractApiKey(code) {
    const m = code.match(/API_KEY\s*=\s*["']([^"']+)["']/);
    return m ? m[1] : null;
  }

  _fetch(url) {
    return new Promise((resolve, reject) => {
      const lib = url.startsWith('https') ? https : http;
      lib.get(url, { headers: { 'User-Agent': 'chenxi-music/0.1' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return this._fetch(res.headers.location).then(resolve, reject);
        }
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
  }

  /**
   * 导入本地文件夹（扫描音频文件）
   */
  async importFromFolder(folderPath, { depth = 3, formats = ['flac', 'wav', 'ape', 'dsd', 'dff', 'dsf', 'mqa', 'alac', 'mp3', 'aac', 'ogg'] } = {}) {
    const files = [];
    this._scanDir(folderPath, files, depth, 0, formats);
    const src = {
      id: 'local_' + Date.now(),
      name: folderPath,
      version: '',
      type: 'local',
      folder: folderPath,
      files: files,
      fileCount: files.length,
      platforms: ['local'],
      platformLabels: ['本地'],
      qualities: ['hires', 'flac', '320k', '128k'],
      qualityLabels: ['Hi-Res', '无损', '极品', '标准'],
      lxCompatible: false,
      enabled: true,
      importedAt: new Date().toISOString()
    };
    this.sources.push(src);
    this.emit('source-added', src);
    return src;
  }

  _scanDir(dir, results, maxDepth, curDepth, formats) {
    if (curDepth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this._scanDir(full, results, maxDepth, curDepth + 1, formats);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (formats.includes(ext)) {
          results.push({ path: full, name: entry.name, ext });
        }
      }
    }
  }

  /**
   * 调用音源获取播放URL（LX脚本协议）
   * @param {Object} source - 音源对象
   * @param {string} platform - 平台ID
   * @param {Object} musicInfo - {songmid/hash/id/rid, ...}
   * @param {string} quality - 音质档位
   * @returns {Promise<string>} 音频直链URL
   */
  async getMusicUrl(source, platform, musicInfo, quality) {
    if (source.type === 'js') {
      return this._callLxScript(source.code, platform, musicInfo, quality);
    } else if (source.type === 'url') {
      // 远程URL音源（如聆澜）：通过API获取播放URL
      return this._callRemoteApi(source, platform, musicInfo, quality);
    } else if (source.type === 'local') {
      throw new Error('本地音源不支持URL获取');
    }
    throw new Error('unsupported source type: ' + source.type);
  }

  /**
   * 调用远程API音源（如聆澜音源 v7）
   * API: POST {baseUrl}/url  Body: { source, songId, quality }
   * 或 GET {baseUrl}/url?source={}&songId={}&quality={}
   */
  async _callRemoteApi(source, platform, musicInfo, quality) {
    const baseUrl = source.apiBaseUrl;
    const songId = musicInfo.id || musicInfo.songmid || musicInfo.hash || musicInfo.rid || '';
    if (!songId) throw new Error('缺少歌曲ID');
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'chenxi-music/0.1' };
    if (source.apiKey) headers['X-API-Key'] = source.apiKey;

    // 尝试POST方式（聆澜等API常用POST）
    try {
      const resp = await this._httpRequest('POST', `${baseUrl}/url`, headers,
        JSON.stringify({ source: platform, songId, quality }));
      const json = JSON.parse(resp);
      if (json.code === 200 && json.url) return json.url;
      if (json.code === 200 && json.data && json.data.url) return json.data.url;
      if (json.url) return json.url;
    } catch (e) { /* POST失败尝试GET */ }

    // GET回退
    const url = `${baseUrl}/url?source=${platform}&songId=${encodeURIComponent(songId)}&quality=${quality}`;
    const resp = await this._httpRequest('GET', url, headers);
    const json = JSON.parse(resp);
    if (json.code === 200 && json.url) return json.url;
    if (json.url) return json.url;
    throw new Error(json.message || 'API返回无效数据');
  }

  /**
   * 运行LX脚本获取播放URL
   * 通过沙箱执行脚本代码，捕获 request handler，传入 musicUrl 请求
   */
  _callLxScript(code, platform, musicInfo, quality) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('LX脚本超时')), 8000);

      // 创建沙箱环境（与 parseLxScript 保持一致的完整环境）
      const lxObj = {
        EVENT_NAMES: { inited: 'inited', request: 'request', updateAlert: 'updateAlert' },
        send: () => {},  // musicUrl调用时不需关注inited事件
        on: (event, handler) => {
          if (event === 'request' || event === 'lx.request') {
            sandbox._handler = handler;
          }
        },
        // 真实HTTP请求：支持脚本内部的各种API调用
        request: (url, options, cb) => {
          this._lxRequest(url, options).then(
            (body) => {
              if (typeof cb === 'function') cb(null, { body, statusCode: 200, headers: {}, raw: body });
            },
            (err) => {
              if (typeof cb === 'function') cb(err);
            }
          );
        },
        utils: {
          buffer: { from: (s) => Buffer.from(s), bufToString: (b) => b.toString() },
          crypto: {
            md5: (s) => require('crypto').createHash('md5').update(s).digest('hex'),
            rsaEncrypt: () => '', randomBytes: () => Buffer.alloc(0),
            aesEncrypt: () => '', decode: (s) => s
          },
          url: { encode: encodeURIComponent, decode: decodeURIComponent, parse: (u) => new URL(u) }
        },
        env: 'desktop', version: '1.0.0'
      };

      const sandbox = {
        globalThis: { lx: lxObj },
        lx: lxObj,
        console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
        setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 5000)),
        clearTimeout,
        setInterval: (fn, ms) => setInterval(fn, Math.min(ms || 0, 5000)),
        clearInterval,
        queueMicrotask,
        Promise, isNaN, Number, Object, Array, Error, Math, Date, JSON, RegExp,
        Buffer, process: { env: {} },
        URL, URLSearchParams,
        TextEncoder, TextDecoder,
        require: (mod) => {
          if (mod === 'crypto') return require('crypto');
          return {};
        }
      };
      sandbox.globalThis = Object.assign(sandbox.globalThis, sandbox);
      sandbox.window = sandbox;

      try {
        vm.createContext(sandbox);
        vm.runInContext(code, sandbox, { timeout: 2000 });

        if (!sandbox._handler) {
          clearTimeout(timeout);
          reject(new Error('脚本未注册request handler'));
          return;
        }

        // 发送 musicUrl 请求
        const result = sandbox._handler({
          action: 'musicUrl',
          source: platform,
          info: { musicInfo, type: quality }
        });

        if (!result) {
          clearTimeout(timeout);
          reject(new Error('handler未返回结果'));
          return;
        }

        if (result.then) {
          result.then((url) => {
            clearTimeout(timeout);
            // 脚本可能返回 { url: "..." } 或直接返回URL字符串
            if (typeof url === 'string' && url.length > 5) resolve(url);
            else if (url && url.url) resolve(url.url);
            else if (url && url.data && url.data.url) resolve(url.data.url);
            else reject(new Error('无效的URL返回: ' + JSON.stringify(url).slice(0, 100)));
          }).catch((err) => {
            clearTimeout(timeout);
            reject(err);
          });
        } else {
          clearTimeout(timeout);
          // 同步返回结果
          if (typeof result === 'string' && result.length > 5) resolve(result);
          else if (result && result.url) resolve(result.url);
          else reject(new Error('无效的同步返回'));
        }
      } catch (e) {
        clearTimeout(timeout);
        reject(e);
      }
    });
  }

  /**
   * LX脚本的request函数实现
   * 支持GET/POST，返回响应体字符串
   */
  async _lxRequest(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = options.headers || {};
    if (!headers['User-Agent']) headers['User-Agent'] = 'Mozilla/5.0 ChenXi/1.0';
    const body = options.body || options.data || null;

    return new Promise((resolve, reject) => {
      const lib = url.startsWith('https') ? https : http;
      const urlObj = new URL(url);
      const reqOpts = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method, headers };

      const req = lib.request(reqOpts, (res) => {
        // 处理重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return this._lxRequest(res.headers.location, options).then(resolve, reject);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          resolve(raw);
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(new Error('request timeout')); });
      if (body && method !== 'GET') req.write(body);
      req.end();
    });
  }

  /**
   * 通用HTTP请求工具（用于远程API和fallback）
   */
  _httpRequest(method, url, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
      const lib = url.startsWith('https') ? https : http;
      const urlObj = new URL(url);
      const reqOpts = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method, headers };

      const req = lib.request(reqOpts, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return this._httpRequest(method, res.headers.location, headers, body).then(resolve, reject);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
      if (body && method !== 'GET') req.write(body);
      req.end();
    });
  }

  setEnabled(id, on) {
    const s = this.sources.find(x => x.id === id);
    if (s) { s.enabled = on; this.emit('source-toggled', s); }
  }

  remove(id) {
    const idx = this.sources.findIndex(x => x.id === id);
    if (idx >= 0) {
      const [removed] = this.sources.splice(idx, 1);
      this.emit('source-removed', removed);
    }
  }

  list() {
    return this.sources.map(s => ({
      id: s.id, name: s.name, version: s.version, type: s.type,
      platforms: s.platforms, platformLabels: s.platformLabels,
      qualities: s.qualities, qualityLabels: s.qualityLabels,
      lxCompatible: s.lxCompatible, enabled: s.enabled,
      fileCount: s.fileCount, importedAt: s.importedAt
    }));
  }

  /**
   * 加载内置 LX 音源脚本（built-in-sources/ 目录）
   * 应用启动时自动调用，内置音源始终启用且不可删除
   */
  async loadBuiltInSources() {
    const builtinDir = path.join(__dirname, '../../built-in-sources');
    if (!fs.existsSync(builtinDir)) return;
    const files = fs.readdirSync(builtinDir).filter(f => f.endsWith('.js'));
    for (const file of files) {
      const filePath = path.join(builtinDir, file);
      try {
        const code = fs.readFileSync(filePath, 'utf-8');
        const info = await this.parseLxScript(code);
        const src = {
          id: 'builtin_' + file.replace('.js', ''),
          name: info.name,
          version: info.version,
          author: info.author,
          description: info.description,
          type: 'js',
          code,
          filePath,
          platforms: info.platforms,
          qualities: info.qualities,
          platformLabels: info.platforms.map(p => PLATFORM_LABELS[p] || p),
          enabled: true,
          builtin: true,
          lxCompatible: info.lxCompatible,
          sources: info.sources,
          importedAt: new Date().toISOString()
        };
        // 避免重复加载
        if (!this.sources.some(s => s.id === src.id)) {
          this.sources.push(src);
          this.emit('source-added', src);
        }
      } catch (e) {
        console.error('内置音源加载失败:', file, e.message);
      }
    }
  }

  registerIpc() {
    ipcMain.handle('src:import-file', async (e, { filePath }) => {
      try {
        const src = await this.importFromFile(filePath);
        return { ok: true, source: src };
      } catch (err) { return { ok: false, error: err.message }; }
    });
    ipcMain.handle('src:import-url', async (e, { url }) => {
      try {
        const src = await this.importFromUrl(url);
        return { ok: true, source: src };
      } catch (err) { return { ok: false, error: err.message }; }
    });
    ipcMain.handle('src:import-folder', async (e, { folderPath, depth, formats }) => {
      try {
        const src = await this.importFromFolder(folderPath, { depth, formats });
        return { ok: true, source: src };
      } catch (err) { return { ok: false, error: err.message }; }
    });
    ipcMain.handle('src:parse-script', async (e, { code }) => {
      return await this.parseLxScript(code);
    });
    ipcMain.handle('src:list', () => this.list());
    ipcMain.handle('src:set-enabled', (e, { id, on }) => { this.setEnabled(id, on); return { ok: true }; });
    ipcMain.handle('src:remove', (e, { id }) => { this.remove(id); return { ok: true }; });
    ipcMain.handle('src:get-url', async (e, { sourceId, platform, musicInfo, quality }) => {
      const src = this.sources.find(s => s.id === sourceId);
      if (!src) return { ok: false, error: 'source not found' };
      try {
        const url = await this.getMusicUrl(src, platform, musicInfo, quality);
        return { ok: true, url };
      } catch (err) { return { ok: false, error: err.message }; }
    });
  }
}

module.exports = { SourceManager, PLATFORM_LABELS, QUALITY_LABELS };
