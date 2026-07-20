// src/main/search-aggregator.js
// 辰曦音乐搜索聚合器 - LX脚本沙箱搜索 + 直接API回退 + 跨源去重
// 并行搜索所有已启用音源，统一格式化结果，5秒超时容错

const { ipcMain } = require('electron');
const vm = require('vm');
const https = require('https');
const http = require('http');
const EventEmitter = require('events');

// ============================================================
// 常量定义
// ============================================================

/** 搜索超时时间（毫秒） */
const SEARCH_TIMEOUT = 5000;

/** 音质等级排序（数值越大音质越好） */
const QUALITY_RANK = {
  'hr': 5,          // Hi-Res
  'hires': 5,       // Hi-Res 别名
  'flac24bit': 5,   // 24bit FLAC
  'loss': 4,        // 无损
  'flac': 4,        // FLAC
  'ex': 3,          // 极品
  '320k': 3,        // 320kbps
  'std': 2,         // 标准
  '128k': 2,        // 128kbps
};

/** 原始音质标识 → 标准档位映射 */
const QUALITY_NORMALIZE = {
  '128k': 'std',
  '320k': 'ex',
  'flac': 'loss',
  'flac24bit': 'hr',
  'hires': 'hr',
  'master': 'hr',
  'atmos': 'loss',
  'atmos_plus': 'loss',
  '1000k': 'ex',
  '2000k': 'loss',
  '4000k': 'hr',
  '999000k': 'hr',
  'sq': 'ex',
  'hq': 'ex',
};

/** 不支持任何搜索方式的平台，静默跳过 */
const UNSUPPORTED_PLATFORMS = new Set(['tx', 'kg', 'bili', 'git']);

// ============================================================
// SearchAggregator 类
// ============================================================

class SearchAggregator extends EventEmitter {
  /**
   * @param {import('./source-manager').SourceManager} sourceManager - 音源管理器实例
   */
  constructor(sourceManager) {
    super();
    /** @type {import('./source-manager').SourceManager} */
    this.srcMgr = sourceManager;
    /** 缓存已创建的 LX 沙箱 request handler，避免每次搜索都重新解析脚本 */
    this._handlerCache = new Map();
  }

  // ============================================================
  // 公开方法
  // ============================================================

  /**
   * 跨所有已启用音源并行搜索
   * 对每个匹配的平台+音源组合发起搜索任务，用 Promise.allSettled 容错
   * 最终对结果做跨源去重和音质聚合
   *
   * @param {string} keyword - 搜索关键词
   * @param {Object} [opts={}] - 搜索选项
   * @param {string[]} [opts.platforms] - 限定平台 ID 列表，含 'all' 或不传表示全部
   * @param {string[]} [opts.types] - 限定音质类型（'hr'/'loss'/'ex'/'std'），含 'all' 或不传表示全部
   * @param {number} [opts.limit=30] - 每个源单次搜索最大返回数
   * @returns {Promise<{total: number, songs: Object[]}>}
   */
  async search(keyword, opts = {}) {
    const { platforms = null, types = null, limit = 30 } = opts;

    // 从 sourceManager 内部列表获取完整音源对象（含 code 字段）
    const allSources = (this.srcMgr.sources || []).filter(s => s.enabled);

    // 构建所有搜索任务
    const tasks = [];
    for (const src of allSources) {
      // 本地文件夹音源不支持在线搜索
      if (src.type === 'local') continue;

      for (const plat of (src.platforms || [])) {
        // 平台过滤
        if (platforms && !platforms.includes(plat) && !platforms.includes('all')) continue;
        // 跳过不支持搜索的平台
        if (UNSUPPORTED_PLATFORMS.has(plat)) continue;

        tasks.push(
          this._searchSource(src, plat, keyword, limit)
            .catch(() => []) // 单个源失败不影响整体
        );
      }
    }

    // 并行执行所有搜索任务
    const settled = await Promise.allSettled(tasks);
    const allSongs = [];
    for (const r of settled) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        allSongs.push(...r.value);
      }
    }

    // 跨源去重 + 音质聚合
    const merged = this._mergeDuplicates(allSongs);

    // 音质类型过滤
    let filtered = merged;
    if (types && !types.includes('all')) {
      filtered = merged.filter(s =>
        (s.qualities || []).some(q => types.includes(q))
      );
    }

    return {
      total: filtered.length,
      songs: filtered.slice(0, limit * 2),
    };
  }

  /**
   * 清除 LX 脚本 handler 缓存
   * 在音源列表变更后调用，确保下次搜索使用最新脚本
   */
  clearCache() {
    this._handlerCache.clear();
  }

  /**
   * 注册 IPC 通信接口
   */
  registerIpc() {
    ipcMain.handle('search:query', async (_e, { keyword, platforms, types, limit }) => {
      try {
        const result = await this.search(keyword, { platforms, types, limit });
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });
  }

  // ============================================================
  // 搜索调度
  // ============================================================

  /**
   * 对单个音源+平台组合执行搜索
   * 优先 LX 脚本沙箱搜索，失败或无脚本时走直接 API 回退
   *
   * @param {Object} source - 完整音源对象（含 code / apiBaseUrl 等内部字段）
   * @param {string} platform - 平台 ID（wy/kw/mg/qsvip 等）
   * @param {string} keyword - 搜索关键词
   * @param {number} limit - 每页数量
   * @returns {Promise<Object[]>} 标准化后的歌曲列表
   */
  async _searchSource(source, platform, keyword, limit) {
    // 优先：LX 脚本沙箱搜索（仅 JS 类型 + 已识别为 LX 兼容的音源）
    if (source.type === 'js' && source.code && source.lxCompatible) {
      const songs = await this._searchViaLxSandbox(source, platform, keyword, limit);
      if (songs.length > 0) return songs;
    }

    // 回退：直接 API 搜索
    const fallbackSongs = await this._searchDirectFallback(platform, keyword, limit, source);
    if (fallbackSongs.length > 0) return fallbackSongs;

    return [];
  }

  // ============================================================
  // LX 脚本沙箱搜索
  // ============================================================

  /**
   * 通过 LX 脚本 VM 沙箱执行搜索
   * 在沙箱中运行脚本代码，提取其注册的 request handler，
   * 然后传入搜索消息并标准化返回结果
   *
   * @param {Object} source - 音源对象
   * @param {string} platform - 平台 ID
   * @param {string} keyword - 搜索关键词
   * @param {number} limit - 每页数量
   * @returns {Promise<Object[]>}
   */
  async _searchViaLxSandbox(source, platform, keyword, limit) {
    // 获取或创建该音源的 request handler（带缓存）
    const handler = await this._getLxHandler(source);
    if (!handler) return [];

    // 根据音源名称决定搜索 action 的候选顺序
    // 'musicSearch' 用于全豆要/qsvip 类脚本
    // 'search' 用于非常刀类脚本
    const actionCandidates = this._detectActionName(source);

    for (const action of actionCandidates) {
      try {
        const result = await this._callHandlerWithTimeout(handler, action, platform, keyword, limit);
        const songs = this._normalizeLxSearchResult(result, platform, source.name);
        if (songs.length > 0) return songs;
      } catch (e) {
        // 该 action 不支持或执行失败，尝试下一个候选
        console.debug(`[搜索] ${source.name} action=${action} 失败:`, e.message);
      }
    }

    return [];
  }

  /**
   * 根据音源名称检测搜索 action 候选列表
   * 不同脚本作者使用不同的 action 名称约定
   *
   * @param {Object} source - 音源对象
   * @returns {string[]} 候选 action 名称（按优先级排序）
   */
  _detectActionName(source) {
    const name = (source.name || '').toLowerCase();
    // 全豆要 / qsvip / 汽水类脚本优先 musicSearch
    if (name.includes('全豆要') || name.includes('qsvip') || name.includes('汽水')) {
      return ['musicSearch', 'search'];
    }
    // 非常刀类脚本优先 search
    if (name.includes('非常刀') || name.includes('刀')) {
      return ['search', 'musicSearch'];
    }
    // 默认：新版协议 musicSearch 优先，旧版 search 兜底
    return ['musicSearch', 'search'];
  }

  /**
   * 获取 LX 脚本的 request handler（带缓存）
   * 同一音源只创建一次沙箱，后续复用缓存
   *
   * @param {Object} source - 音源对象
   * @returns {Promise<Function|null>}
   */
  async _getLxHandler(source) {
    const cacheKey = source.id;
    if (this._handlerCache.has(cacheKey)) {
      return this._handlerCache.get(cacheKey);
    }
    try {
      const handler = await this._createLxSandbox(source.code);
      if (handler) {
        this._handlerCache.set(cacheKey, handler);
      }
      return handler;
    } catch (e) {
      console.error(`[搜索] 创建 ${source.name} 沙箱失败:`, e.message);
      return null;
    }
  }

  /**
   * 创建 LX 脚本 VM 沙箱并提取 request handler
   *
   * 沙箱提供完整的 lx 协议对象（send/on/request/utils），
   * 其中 request 函数会真正发起 HTTP 请求以支持脚本内部的网络调用。
   * 脚本通过 on(EVENT_NAMES.request, handler) 注册的回调会被捕获并返回。
   *
   * @param {string} code - LX 脚本源码
   * @returns {Promise<Function|null>} 脚本注册的 request handler
   */
  _createLxSandbox(code) {
    return new Promise((resolve) => {
      let handler = null;

      // ---- 沙箱内 HTTP 请求实现 ----
      // LX 脚本通过 lx.request(url, options, callback) 发起网络请求
      // 这里提供真实 HTTP 能力，让脚本能访问外部 API
      const _makeHttpRequest = (url, options, callback) => {
        if (typeof callback !== 'function') return;

        const method = (options && options.method) || 'GET';
        const headers = Object.assign(
          { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          (options && options.headers) || {}
        );
        const body = (options && options.body) || null;

        const lib = String(url).startsWith('https') ? https : http;

        try {
          const urlObj = new URL(url);
          const reqOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || (String(url).startsWith('https') ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method,
            headers,
          };

          const req = lib.request(reqOptions, (res) => {
            // 自动跟随重定向
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              return _makeHttpRequest(res.headers.location, options, callback);
            }

            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
              const raw = Buffer.concat(chunks);
              let responseBody = raw.toString('utf-8');
              // 尝试解析为 JSON，失败则保持字符串
              try { responseBody = JSON.parse(responseBody); } catch (_) { /* 保持字符串 */ }
              callback(null, {
                body: responseBody,
                statusCode: res.statusCode,
                headers: res.headers,
                raw: raw.toString('utf-8'),
              });
            });
          });

          req.on('error', (err) => callback(err));
          req.setTimeout(4000, () => req.destroy(new Error('sandbox request timeout')));

          if (body) {
            req.write(typeof body === 'string' ? body : JSON.stringify(body));
          }
          req.end();
        } catch (e) {
          callback(e);
        }
      };

      // ---- LX 协议对象 ----
      const lxObj = {
        EVENT_NAMES: {
          inited: 'inited',
          request: 'request',
          updateAlert: 'updateAlert',
        },
        /** send：脚本用于声明能力（搜索时忽略） */
        send: () => {},
        /** on：脚本用于注册 request handler —— 这是提取的核心 */
        on: (event, cb) => {
          if (event === 'request' && typeof cb === 'function') {
            handler = cb;
          }
        },
        /** request：脚本内部发起 HTTP 请求的通道 */
        request: (url, options, callback) => {
          _makeHttpRequest(url, options, callback);
        },
        utils: {
          buffer: {
            from: (s, enc) => Buffer.from(s, enc),
            bufToString: (b, enc) => Buffer.isBuffer(b) ? b.toString(enc || 'utf8') : String(b),
          },
          crypto: {
            md5: (s) => {
              try { return require('crypto').createHash('md5').update(String(s)).digest('hex'); }
              catch (e) { return ''; }
            },
            md5Prefix: (s) => {
              try { return require('crypto').createHash('md5').update(String(s)).digest('hex').substring(0, 16); }
              catch (e) { return ''; }
            },
            rsaEncrypt: (s, key) => {
              try {
                const crypto = require('crypto');
                return crypto.publicEncrypt({ key: String(key), padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(String(s))).toString('base64');
              } catch (e) { return ''; }
            },
            aesEncrypt: (s, key, iv, mode = 'CBC') => {
              try {
                const crypto = require('crypto');
                const alg = mode === 'ECB' ? 'aes-128-ecb' : 'aes-128-cbc';
                const cipher = crypto.createCipheriv(alg, Buffer.from(key), iv ? Buffer.from(iv) : Buffer.alloc(0));
                let out = cipher.update(String(s), 'utf8', 'base64');
                out += cipher.final('base64');
                return out;
              } catch (e) { return ''; }
            },
            randomBytes: (len) => {
              try { return require('crypto').randomBytes(Math.max(1, len || 8)).toString('hex'); }
              catch (e) { return Buffer.alloc(Math.max(1, len || 8)).toString('hex'); }
            },
            decode: (s) => {
              try { return Buffer.from(String(s), 'base64').toString('utf8'); }
              catch (e) { return String(s); }
            },
          },
          url: {
            encode: encodeURIComponent,
            decode: decodeURIComponent,
            parse: (u) => new URL(u),
          },
        },
        env: 'desktop',
        version: '1.0.0',
      };

      // ---- 沙箱上下文 ----
      const sandbox = {
        globalThis: {},
        lx: lxObj,
        console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
        setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 5000)),
        clearTimeout,
        setInterval: (fn, ms) => setInterval(fn, Math.min(ms || 0, 5000)),
        clearInterval,
        queueMicrotask,
        Promise, isNaN, Number, Object, Array, Error, Math, Date, JSON,
        Buffer, process: { env: {} },
        URL, URLSearchParams,
        TextEncoder, TextDecoder,
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
      };
      // 确保 globalThis、window、lx 指向同一个对象
      sandbox.globalThis = Object.assign(sandbox.globalThis, sandbox);
      sandbox.globalThis.lx = lxObj;
      sandbox.window = sandbox;

      const context = vm.createContext(sandbox);

      try {
        // 脚本初始化执行超时 3 秒
        vm.runInContext(code, context, { timeout: 3000 });
      } catch (e) {
        // 脚本执行异常不阻塞，handler 可能在异常前已注册
        console.debug(`[搜索] 脚本初始化异常（handler 可能已注册）:`, e.message);
      }

      // 等待异步 handler 注册（混淆脚本常通过 Promise.then 异步调用 on）
      // 如果同步已注册则快速返回，否则等待 150ms 覆盖异步场景
      if (handler) {
        resolve(handler);
      } else {
        setTimeout(() => resolve(handler), 150);
      }
    });
  }

  /**
   * 带超时调用 LX request handler
   *
   * @param {Function} handler - LX request handler 函数
   * @param {string} action - 搜索动作名（'musicSearch' 或 'search'）
   * @param {string} platform - 平台 ID
   * @param {string} keyword - 搜索关键词
   * @param {number} limit - 数量限制
   * @returns {Promise<any>} handler 返回的原始结果
   */
  _callHandlerWithTimeout(handler, action, platform, keyword, limit) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('搜索超时')), SEARCH_TIMEOUT);

      try {
        const message = {
          action,
          source: platform,
          info: {
            keyword,
            pagesize: limit,
            page: 1,
            limit,  // 部分脚本使用 limit 而非 pagesize
          },
        };

        const result = handler(message);

        if (result && typeof result.then === 'function') {
          // handler 返回 Promise
          result.then(
            (data) => { clearTimeout(timer); resolve(data); },
            (err) => { clearTimeout(timer); reject(err); },
          );
        } else if (result !== undefined && result !== null) {
          // handler 同步返回结果
          clearTimeout(timer);
          resolve(result);
        } else {
          // handler 返回空值，视为不支持该 action
          clearTimeout(timer);
          resolve(null);
        }
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  // ============================================================
  // 直接 API 回退搜索
  // ============================================================

  /**
   * 直接 API 回退搜索
   * 对于没有 LX 脚本支持搜索的平台，使用公开 API 或查找其他支持该平台的脚本
   *
   * 回退策略：
   * - qsvip（汽水VIP）：调用公开搜索 API
   * - wy/kw/mg（网易云/酷我/咪咕）：查找其他已启用且支持该平台的 LX 脚本
   * - tx/kg/bili/git：无搜索支持，静默跳过
   *
   * @param {string} platform - 平台 ID
   * @param {string} keyword - 搜索关键词
   * @param {number} limit - 数量限制
   * @param {Object} source - 当前音源对象
   * @returns {Promise<Object[]>}
   */
  async _searchDirectFallback(platform, keyword, limit, source) {
    // qsvip：使用公开 API 直接搜索
    if (platform === 'qsvip') {
      return this._searchQsvipDirect(keyword, limit);
    }

    // wy/kw/mg：遍历所有已启用的 JS 音源，找到支持该平台的脚本执行搜索
    if (['wy', 'kw', 'mg'].includes(platform)) {
      const allSources = this.srcMgr.sources || [];
      for (const src of allSources) {
        if (!src.enabled) continue;
        if (src.type !== 'js' || !src.code || !src.lxCompatible) continue;
        if (!(src.platforms || []).includes(platform)) continue;
        // 如果当前音源就是触发回退的那个（已尝试过），跳过
        if (src.id === source.id) continue;

        try {
          const songs = await this._searchViaLxSandbox(src, platform, keyword, limit);
          if (songs.length > 0) return songs;
        } catch (_) {
          // 继续尝试下一个音源
        }
      }
    }

    // 其他平台无搜索支持
    return [];
  }

  /**
   * 汽水VIP 直接 API 搜索
   * GET https://api.vsaa.cn/api/music.qishui.vip?act=search&keywords=...&page=1&pagesize=...&type=music
   *
   * @param {string} keyword - 搜索关键词
   * @param {number} limit - 数量限制
   * @returns {Promise<Object[]>}
   */
  _searchQsvipDirect(keyword, limit) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve([]), SEARCH_TIMEOUT);

      const params = new URLSearchParams({
        act: 'search',
        keywords: keyword,
        page: '1',
        pagesize: String(limit),
        type: 'music',
      });
      const url = `https://api.vsaa.cn/api/music.qishui.vip?${params.toString()}`;

      const makeRequest = (reqUrl) => {
        const lib = reqUrl.startsWith('https') ? https : http;
        lib.get(reqUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        }, (res) => {
          // 自动跟随重定向
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return makeRequest(res.headers.location);
          }

          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            clearTimeout(timer);
            try {
              const json = JSON.parse(data);
              const list = (json.data && json.data.list) || json.list || [];
              if (!Array.isArray(list)) { resolve([]); return; }

              const songs = list
                .map((item) => this._normalizeSong({
                  name: item.name || item.songName || item.title || '',
                  singer: item.singer || item.artist || item.artistName || '',
                  album: item.album || item.albumName || '',
                  songmid: item.songmid || item.id || '',
                  hash: item.hash || item.strMediaMid || '',
                  duration: item.duration || item.interval || 0,
                  img: item.img || item.cover || item.pic || '',
                  qualitys: item.qualitys || item.qualities || [],
                  id: item.id || item.rid || '',
                }, 'qsvip', '汽水VIP'))
                .filter(Boolean);

              resolve(songs);
            } catch (e) {
              console.error('[搜索] 汽水VIP API 响应解析失败:', e.message);
              resolve([]);
            }
          });
        }).on('error', () => {
          clearTimeout(timer);
          resolve([]);
        });
      };

      makeRequest(url);
    });
  }

  // ============================================================
  // 结果标准化
  // ============================================================

  /**
   * 标准化 LX 脚本返回的搜索结果
   * LX 脚本返回格式多样，需兼容多种结构并统一转换为内部格式
   *
   * 支持的返回格式：
   * - { list: [...] }
   * - { data: { list: [...] } }
   * - { data: [...] }
   * - { info: { list: [...] } }
   * - 直接返回数组 [...]
   *
   * @param {any} result - 脚本返回的原始结果
   * @param {string} platform - 平台 ID
   * @param {string} sourceName - 音源名称
   * @returns {Object[]} 标准化后的歌曲列表
   */
  _normalizeLxSearchResult(result, platform, sourceName) {
    if (!result) return [];

    let list = [];

    if (result.list && Array.isArray(result.list)) {
      // 格式1: { list: [...] }
      list = result.list;
    } else if (result.data && result.data.list && Array.isArray(result.data.list)) {
      // 格式2: { data: { list: [...] } }
      list = result.data.list;
    } else if (result.data && Array.isArray(result.data)) {
      // 格式3: { data: [...] }
      list = result.data;
    } else if (result.info && result.info.list && Array.isArray(result.info.list)) {
      // 格式4: { info: { list: [...] } }
      list = result.info.list;
    } else if (Array.isArray(result)) {
      // 格式5: 直接是数组
      list = result;
    }

    return list
      .map((song) => this._normalizeSong(song, platform, sourceName))
      .filter(Boolean);
  }

  /**
   * 标准化单首歌曲信息
   * 将不同脚本的字段名映射到统一的内部格式
   *
   * @param {Object} song - 原始歌曲数据
   * @param {string} platform - 平台 ID
   * @param {string} sourceName - 音源名称
   * @returns {Object|null} 标准化歌曲对象，无效数据返回 null
   */
  _normalizeSong(song, platform, sourceName) {
    if (!song || typeof song !== 'object') return null;

    // 歌名（必填，缺失则跳过）
    const name = song.name || song.songName || song.title || song.musicName || '';
    if (!name) return null;

    // 艺术家（兼容多种字段名）
    const artist = song.singer || song.artist || song.artistName
      || song.singerName || song.author || '';

    // 专辑名
    const album = song.album || song.albumName || song.disc || '';

    // 歌曲唯一标识（不同平台使用不同字段）
    const id = song.id || song.songid || song.songId || '';
    const songmid = song.songmid || song.songMid || song.mediaMid || song.mid || '';
    const hash = song.hash || song.fileHash || song.strMediaMid || '';
    const rid = song.rid || song.musicrid || song.songId || '';

    // 时长（部分脚本返回毫秒，部分返回秒，统一为秒）
    let duration = song.duration || song.interval || song.length || 0;
    if (duration > 10000) duration = Math.round(duration / 1000);

    // 封面图 URL
    const pic = song.img || song.cover || song.albumImg || song.pic
      || song.albumPic || song.logo || song.picUrl || '';

    // 音质信息提取与标准化
    const qualities = this._extractQualities(song);
    const bestQuality = this._determineBestQuality(qualities);

    return {
      name,
      artist: this._formatArtist(artist),
      album,
      platform,
      source: sourceName,
      id: String(id),
      songmid: String(songmid),
      hash: String(hash),
      rid: String(rid),
      duration: Math.max(0, duration),
      pic,
      bestQuality,
      qualities,
      meta: song, // 保留原始数据，供后续获取播放 URL 时使用
    };
  }

  /**
   * 格式化艺术家名称
   * LX 脚本中歌手字段可能是字符串、数组或逗号/分号分隔，统一处理
   *
   * @param {string|Array} artist - 原始艺术家信息
   * @returns {string} 用 " / " 分隔的艺术家字符串
   */
  _formatArtist(artist) {
    if (Array.isArray(artist)) {
      return artist
        .map((a) => (typeof a === 'string' ? a : (a.name || '')))
        .filter(Boolean)
        .join(' / ');
    }
    if (typeof artist === 'string') {
      return artist.replace(/[;；,，、]/g, ' / ').replace(/\s+/g, ' ').trim();
    }
    return '';
  }

  // ============================================================
  // 音质处理
  // ============================================================

  /**
   * 从歌曲数据中提取可用音质列表
   * 兼容多种音质声明方式
   *
   * @param {Object} song - 原始歌曲数据
   * @returns {string[]} 标准化音质列表（hr/loss/ex/std）
   */
  _extractQualities(song) {
    const qualities = new Set();

    // 方式1：从 qualitys / qualities / quality 字段获取
    const rawQualities = song.qualitys || song.qualities || song.quality || [];
    if (Array.isArray(rawQualities)) {
      for (const q of rawQualities) {
        const normalized = this._normalizeQuality(q);
        if (normalized) qualities.add(normalized);
      }
    } else if (typeof rawQualities === 'string' && rawQualities) {
      const normalized = this._normalizeQuality(rawQualities);
      if (normalized) qualities.add(normalized);
    }

    // 方式2：从 _qualitys 字段获取（部分脚本使用下划线前缀）
    if (song._qualitys && Array.isArray(song._qualitys)) {
      for (const q of song._qualitys) {
        const normalized = this._normalizeQuality(q);
        if (normalized) qualities.add(normalized);
      }
    }

    // 方式3：从 hash/size 等字段推断最低音质
    if (song.hash || song.strMediaMid) {
      if (!qualities.has('std')) qualities.add('std');
      if (song.fileSize || song.size) {
        if (!qualities.has('ex')) qualities.add('ex');
      }
    }

    return Array.from(qualities);
  }

  /**
   * 将单个音质标识归一化到标准档位
   *
   * @param {string|Object} quality - 原始音质标识（可能是字符串或 {type, size} 对象）
   * @returns {string|null} 标准档位：'hr'/'loss'/'ex'/'std'，无法识别返回 null
   */
  _normalizeQuality(quality) {
    if (!quality) return null;

    // 音质可能是对象形式 { type: 'flac', size: 12345 }
    const qStr = typeof quality === 'object'
      ? (quality.type || quality.quality || '')
      : String(quality);

    // 精确匹配
    if (QUALITY_NORMALIZE[qStr]) return QUALITY_NORMALIZE[qStr];

    // 模糊匹配
    const lower = qStr.toLowerCase();
    if (lower.includes('hires') || lower.includes('hi-res') || lower.includes('24bit') || lower.includes('master')) {
      return 'hr';
    }
    if (lower.includes('flac') || lower.includes('lossless') || lower.includes('无损')) {
      return 'loss';
    }
    if (lower.includes('320') || lower.includes('ex') || lower.includes('high') || lower.includes('极品') || lower.includes('hq')) {
      return 'ex';
    }
    if (lower.includes('128') || lower.includes('standard') || lower.includes('标准') || lower.includes('sq')) {
      return 'std';
    }

    return null;
  }

  /**
   * 从可用音质列表中确定最佳音质
   *
   * @param {string[]} qualities - 标准化音质列表
   * @returns {string} 最佳音质档位
   */
  _determineBestQuality(qualities) {
    if (!qualities || qualities.length === 0) return 'std';
    let best = 'std';
    let bestRank = 0;
    for (const q of qualities) {
      const rank = QUALITY_RANK[q] || 0;
      if (rank > bestRank) {
        bestRank = rank;
        best = q;
      }
    }
    return best;
  }

  // ============================================================
  // 跨源去重
  // ============================================================

  /**
   * 跨源去重 + 音质聚合
   * 歌名+艺术家相同（忽略大小写和空格）的歌曲合并为一条，
   * 聚合所有来源的可用音质，保留最完整的元数据
   *
   * @param {Object[]} songs - 标准化后的歌曲列表
   * @returns {Object[]} 去重合并后的歌曲列表
   */
  _mergeDuplicates(songs) {
    const map = new Map();

    for (const song of songs) {
      // 去重键：歌名 + 艺术家（小写、去空格）
      const key = (song.name + '|' + (song.artist || '')).toLowerCase().replace(/\s+/g, '');

      if (!map.has(key)) {
        // 首次出现：直接存入，初始化来源列表
        map.set(key, {
          ...song,
          qualities: [...(song.qualities || [])],
          sourceList: [{ source: song.source, platform: song.platform }],
        });
      } else {
        // 重复出现：合并音质与元数据
        const existing = map.get(key);

        // 合并音质（去重）
        for (const q of (song.qualities || [])) {
          if (!existing.qualities.includes(q)) {
            existing.qualities.push(q);
          }
        }

        // 记录来源
        existing.sourceList.push({ source: song.source, platform: song.platform });

        // 优先保留有封面图的版本
        if (!existing.pic && song.pic) {
          existing.pic = song.pic;
        }

        // 补全标识信息（不同源的标识字段可能互补）
        if (!existing.songmid && song.songmid) existing.songmid = song.songmid;
        if (!existing.hash && song.hash) existing.hash = song.hash;
        if (!existing.rid && song.rid) existing.rid = song.rid;
        if (!existing.id && song.id) existing.id = song.id;

        // 重新计算最佳音质
        existing.bestQuality = this._determineBestQuality(existing.qualities);
      }
    }

    return Array.from(map.values());
  }
}

module.exports = { SearchAggregator };