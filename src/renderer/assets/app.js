// 辰曦音乐 - 渲染层交互逻辑
// 极简主界面 + ALT菜单 + 右键上下文菜单 + 默认最高音质
// 完全适配争渡读屏：所有操作经UIA语义暴露 + ZDSRAPI独立通道播报

(function () {
  'use strict';
  const api = window.chenxi;

  // 状态
  const state = {
    queue: [],            // 播放队列
    currentIndex: -1,     // 当前播放索引
    playing: false,
    platFilter: 'all',
    typeFilter: 'all',
    sources: [],
    playlists: [{ id: 'fav', name: '我的收藏' }, { id: 'later', name: '稍后听' }]
  };

  // ---------- 工具 ----------
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const fmtTime = (s) => { const m = Math.floor(s/60), ss = Math.floor(s%60); return m+':'+(ss<10?'0'+ss:ss); };
  const qualityMap = { hr: ['Hi-Res', 'hr'], loss: ['无损', 'loss'], ex: ['极品', 'ex'], std: ['标准', 'std'] };
  const platLabels = { wy:'网易云', tx:'QQ音乐', kg:'酷狗', kw:'酷我', mg:'咪咕', qsvip:'汽水VIP', git:'Git音源', bili:'B站', local:'本地' };

  // 争渡读屏播报（视觉隐藏的LiveRegion，争渡读屏自动朗读）
  function announce(text) {
    $('#liveRegion').textContent = text;
    if (api?.zdsr) api.zdsr.speak(text, true);
  }

  // ---------- 搜索 ----------
  async function doSearch() {
    const kw = $('#searchInput').value.trim();
    if (!kw) { announce('请输入搜索关键词'); return; }
    announce('正在搜索 ' + kw);
    // 无障碍：搜索期间声明 busy，争渡读屏播报加载状态
    const list = $('#resultsList');
    list.setAttribute('aria-busy', 'true');
    list.innerHTML = '';
    $('#emptyHint').hidden = true;
    try {
      const res = await api.search.query(kw, state.platFilter === 'all' ? null : [state.platFilter], state.typeFilter === 'all' ? null : [state.typeFilter], 30);
      list.removeAttribute('aria-busy');
      if (!res.ok) { announce('搜索失败：' + res.error); renderResults([]); return; }
      renderResults(res.songs || []);
      if (res.songs && res.songs.length > 0) {
        announce('找到 ' + res.total + ' 条结果，按 Enter 播放，按 Menu 键或右键打开歌曲菜单');
        // 自动将焦点移入结果列表第一项，便于键盘用户直接操作
        const firstItem = list.querySelector('.result-item');
        if (firstItem) firstItem.focus();
      } else {
        announce('未找到结果');
      }
    } catch (err) {
      list.removeAttribute('aria-busy');
      announce('搜索出错：' + (err.message || '未知错误'));
      renderResults([]);
    }
  }

  function renderResults(songs) {
    const list = $('#resultsList');
    list.innerHTML = '';
    list.removeAttribute('aria-busy');
    $('#emptyHint').hidden = songs.length > 0;
    songs.forEach((song, i) => {
      const qd = qualityMap[song.bestQuality] || qualityMap.std;
      const li = document.createElement('li');
      li.className = 'result-item';
      li.setAttribute('role', 'option');
      li.setAttribute('tabindex', '0');
      li.setAttribute('aria-label', `${song.name} ${song.artist || ''} ${platLabels[song.platform] || song.platform} ${qd[0]}`);
      li.dataset.idx = i;
      li.innerHTML = `
        <span class="ri-num">${i+1}</span>
        <span class="ri-name">${song.name}</span>
        <span class="ri-artist">${song.artist || ''}</span>
        <span class="ri-plat">${platLabels[song.platform] || song.platform}</span>
        <span class="ri-quality"><span class="qt ${qd[1]}">${qd[0]}</span></span>
        <span class="ri-duration">${song.duration ? fmtTime(song.duration) : '--'}</span>
        <span class="ri-actions">
          <button class="btn-mini play" data-act="play" aria-label="播放 ${song.name}">播放</button>
          <button class="btn-mini more" data-act="menu" aria-label="打开 ${song.name} 的上下文菜单">⋯</button>
        </span>`;
      list.appendChild(li);
    });
  }

  // 结果列表事件委托
  $('#resultsList').addEventListener('click', async (e) => {
    const item = e.target.closest('.result-item');
    if (!item) return;
    const idx = +item.dataset.idx;
    const act = e.target.dataset.act;
    // 从当前结果列表读取（简化版：从dom读）
    const song = readSongFromDom(item);
    if (act === 'menu') {
      await showContextMenu(song, item);
    } else {
      // 单击/播放按钮 → 播放（默认最高音质）
      await playSong(song);
    }
  });

  // 右键菜单
  $('#resultsList').addEventListener('contextmenu', async (e) => {
    const item = e.target.closest('.result-item');
    if (!item) return;
    e.preventDefault();
    const song = readSongFromDom(item);
    await showContextMenu(song, item);
  });

  // 键盘：Enter播放、Menu键打开上下文菜单
  $('#resultsList').addEventListener('keydown', async (e) => {
    const item = e.target.closest('.result-item');
    if (!item) return;
    if (e.key === 'Enter') { e.preventDefault(); await playSong(readSongFromDom(item)); }
    if (e.key === 'Menu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); await showContextMenu(readSongFromDom(item), item); }
  });

  function readSongFromDom(item) {
    const qd = item.querySelector('.qt');
    return {
      name: item.querySelector('.ri-name').textContent,
      artist: item.querySelector('.ri-artist').textContent,
      platform: Object.entries(platLabels).find(([k,v]) => v === item.querySelector('.ri-plat').textContent)?.[0] || 'unknown',
      platformLabel: item.querySelector('.ri-plat').textContent,
      bestQuality: qd?.classList.contains('hr') ? 'hr' : qd?.classList.contains('loss') ? 'loss' : qd?.classList.contains('ex') ? 'ex' : 'std',
      qualityLabel: qd?.textContent || '标准',
      duration: 0
    };
  }

  // ---------- 默认最高音质播放 ----------
  async function playSong(song) {
    announce('正在获取最高音质：' + song.name);
    // 构建候选音源列表 - 从已启用音源收集该歌曲的可获得URL获取器
    const candidates = await buildCandidates(song);
    const res = await api.audio.play(song, candidates);
    if (!res.ok) { announce('播放失败：' + res.error); return; }
    announce('正在播放：' + song.name + '，' + song.artist + '，' + (res.quality?.label || '最高音质'));
  }

  // 构建音质候选 - 遍历所有已启用音源
  async function buildCandidates(song) {
    const candidates = [];
    for (const src of state.sources.filter(s => s.enabled)) {
      if (!src.platforms?.includes(song.platform)) continue;
      for (const q of src.qualities || ['flac', '320k', '128k']) {
        candidates.push({
          source: src.name,
          quality: q,
          getUrl: async () => {
            const r = await api.source.getUrl(src.id, song.platform, { songmid: song.id || song.name, hash: song.hash }, q);
            if (!r.ok) throw new Error(r.error);
            return r.url;
          }
        });
      }
    }
    // 兜底：如果没有音源候选，加一个占位（让协商器返回错误并播报）
    return candidates;
  }

  // ---------- 右键上下文菜单 ----------
  async function showContextMenu(song, item) {
    // 动态收集该歌曲平台在各已启用音源的可获得音质档位
    const qualities = collectAvailableQualities(song.platform);
    const ctx = {
      isFavorite: state.playlists[0]?.songs?.includes(song.name),
      inQueue: state.queue.some(s => s.name === song.name),
      qualities: qualities.length ? qualities : ['flac', '320k', '128k']
    };
    await api.contextMenu.show(song, ctx);
  }

  // 收集指定平台在所有已启用音源中可获得的音质档位（去重并按优先级排序）
  function collectAvailableQualities(platform) {
    const set = new Set();
    for (const src of state.sources.filter(s => s.enabled)) {
      if (!src.platforms?.includes(platform)) continue;
      for (const q of src.qualities || []) {
        set.add(normalizeQualityId(q));
      }
    }
    const order = ['hires', 'master', 'atmos', 'flac24bit', 'flac', '320k', '192k', '128k'];
    return order.filter(q => set.has(q));
  }

  // 音质标识归一化（与主进程 audio-engine._normalizeQuality 保持一致）
  function normalizeQualityId(q) {
    const s = String(q).toLowerCase();
    if (s.includes('hires') || s.includes('hi-res') || s.includes('hi_res')) return 'hires';
    if (s.includes('master') || s.includes('mqa')) return 'master';
    if (s.includes('atmos') || s.includes('dolby')) return 'atmos';
    if (s.includes('flac24') || s.includes('24bit') || s.includes('24_bit') || s.includes('hires_flac')) return 'flac24bit';
    if (s.includes('flac') || s.includes('lossless') || s.includes('ape') || s.includes('alac') || s.includes('wav') || s.includes('dsd')) return 'flac';
    if (s.includes('320') || s.includes('exhigh')) return '320k';
    if (s.includes('192')) return '192k';
    if (s.includes('128') || s.includes('standard') || s.includes('std')) return '128k';
    const m = s.match(/(\d{3,})k?/);
    if (m) { const n = parseInt(m[1], 10); return n >= 320 ? '320k' : n >= 192 ? '192k' : '128k'; }
    return '128k';
  }

  // 右键菜单动作回调
  api.contextMenu.onAction(async ({ action, payload }) => {
    const song = payload?.song || payload;
    switch (action) {
      case 'play': await playSong(song); break;
      case 'play-next': state.queue.splice(state.currentIndex + 1, 0, song); announce('已添加到下一首：' + song.name); break;
      case 'add-queue': state.queue.push(song); announce('已添加到队列：' + song.name); break;
      case 'favorite': announce('已收藏：' + song.name); break;
      case 'unfavorite': announce('已取消收藏'); break;
      case 'download': announce('开始下载：' + song.name + '，默认最高音质'); break;
      case 'lyrics': announce('查看歌词：' + song.name); break;
      case 'song-detail': announce('查看详情：' + song.name); break;
      case 'artist': announce('查看歌手：' + song.artist); break;
      case 'album': announce('查看专辑'); break;
      case 'copy-name': await navigator.clipboard.writeText(song.name); announce('已复制歌名'); break;
      case 'copy-link': await navigator.clipboard.writeText(song.url || ''); announce('已复制链接'); break;
      case 'share-link': await navigator.clipboard.writeText(song.url || ''); announce('分享链接已复制'); break;
      case 'switch-quality': await playSongAtQuality(song, payload.quality); break;
      case 'remove': announce('已从列表移除'); break;
      default: announce(action);
    }
  });

  // 以指定音质播放（覆盖默认最高音质协商）
  async function playSongAtQuality(song, qualityId) {
    announce('正在切换音质为 ' + qualityId + '：' + song.name);
    const candidates = await buildCandidates(song);
    // 只保留指定音质档位的候选
    const filtered = candidates.filter(c => normalizeQualityId(c.quality) === qualityId);
    const useList = filtered.length ? filtered : candidates;
    const res = await api.audio.play(song, useList);
    if (!res.ok) { announce('播放失败：' + res.error); return; }
    announce('正在播放：' + song.name + '，' + (res.quality?.label || qualityId));
  }

  // ---------- 筛选 ----------
  $$('#platChips .chip').forEach(c => c.addEventListener('click', () => {
    $$('#platChips .chip').forEach(x => { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); });
    c.classList.add('on'); c.setAttribute('aria-checked', 'true');
    state.platFilter = c.dataset.p;
  }));
  $$('#typeChips .chip').forEach(c => c.addEventListener('click', () => {
    $$('#typeChips .chip').forEach(x => { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); });
    c.classList.add('on'); c.setAttribute('aria-checked', 'true');
    state.typeFilter = c.dataset.t;
  }));

  // 搜索
  $('#searchBtn').addEventListener('click', doSearch);
  $('#searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  // ---------- 迷你播放器 ----------
  $('#mpPlay').addEventListener('click', async () => {
    if (state.playing) { await api.audio.pause(); }
    else { await api.audio.resume(); }
  });
  $('#mpPrev').addEventListener('click', () => playPrev());
  $('#mpNext').addEventListener('click', () => playNext());
  $('#mpProgress').addEventListener('click', async (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const dur = await api.audio.state().then(s => s.duration);
    await api.audio.seek(pct * dur);
  });

  function playNext() {
    if (state.currentIndex < state.queue.length - 1) {
      state.currentIndex++;
      playSong(state.queue[state.currentIndex]);
    }
  }
  function playPrev() {
    if (state.currentIndex > 0) {
      state.currentIndex--;
      playSong(state.queue[state.currentIndex]);
    }
  }

  // 音频状态同步
  api.audio.onTrackChanged(({ song, quality }) => {
    $('#mpTrack').textContent = song.name;
    $('#mpArtist').textContent = song.artist || '';
    $('#mpQuality').textContent = quality?.label || '';
    state.playing = true;
    $('#mpPlay').textContent = '⏸';
  });

  // 更新进度条 ARIA 属性（争渡读屏可播报进度百分比）
  function updateProgressBar(pos, dur) {
    const pct = dur ? Math.round(pos / dur * 100) : 0;
    const bar = $('#mpProgress');
    bar.setAttribute('aria-valuenow', pct);
    bar.setAttribute('aria-valuemax', 100);
    $('#mpProgressFill').style.width = pct + '%';
    $('#mpCurTime').textContent = fmtTime(pos);
    $('#mpTotalTime').textContent = fmtTime(dur);
  }

  api.audio.onStateChanged((s) => {
    state.playing = s.playing;
    $('#mpPlay').textContent = s.playing ? '⏸' : '▶';
    updateProgressBar(s.position, s.duration);
  });
  api.audio.onPosition((pos) => {
    api.audio.state().then(s => updateProgressBar(pos, s.duration));
  });
  api.audio.onError((msg) => announce('播放错误：' + msg));

  // ---------- ALT 菜单 ----------
  const altOverlay = $('#altOverlay');
  function openAlt(panel) {
    altOverlay.hidden = false;
    $$('.alt-tab').forEach(t => { t.classList.remove('open'); t.setAttribute('aria-expanded', 'false'); });
    $$('.alt-panel').forEach(p => p.hidden = true);
    const tab = document.querySelector(`.alt-tab[data-panel="${panel}"]`);
    const pnl = $('#panel' + panel.charAt(0).toUpperCase() + panel.slice(1));
    if (tab) { tab.classList.add('open'); tab.setAttribute('aria-expanded', 'true'); }
    if (pnl) { pnl.hidden = false; renderAltPanel(panel); }
  }
  function closeAlt() {
    altOverlay.hidden = true;
    $$('.alt-tab').forEach(t => t.classList.remove('open'));
    $$('.alt-panel').forEach(p => p.hidden = true);
  }

  $$('.alt-tab[data-panel]').forEach(tab => {
    tab.addEventListener('click', () => openAlt(tab.dataset.panel));
  });
  $('#altClose').addEventListener('click', closeAlt);

  api.menu.onOpen((panel) => openAlt(panel));
  api.menu.onClose(() => closeAlt());

  // ESC关闭菜单
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !altOverlay.hidden) closeAlt();
    // Alt键单独按下打开默认面板
    if (e.key === 'Alt' && !e.ctrlKey && !e.shiftKey && altOverlay.hidden) {
      setTimeout(() => { if (altOverlay.hidden) openAlt('play'); }, 50);
    }
    // P 键播报进度（无障碍核心）- 仅当焦点不在输入框时触发
    if ((e.key === 'p' || e.key === 'P') && !isTypingInInput(e.target)) {
      e.preventDefault();
      api.audio.state().then(s => {
        if (s.track) {
          announce(`进度 ${fmtTime(s.position)}，共 ${fmtTime(s.duration)}，正在播放 ${s.track.name}`);
        } else {
          announce('当前未在播放');
        }
      });
    }
    // Alt+P/L/C/S/H 快速切换 ALT 面板
    if (e.altKey && !e.ctrlKey && !e.shiftKey) {
      const map = { p: 'play', l: 'playlist', c: 'charts', s: 'settings', h: 'help' };
      if (map[e.key.toLowerCase()]) {
        e.preventDefault();
        openAlt(map[e.key.toLowerCase()]);
      }
    }
  });

  // 判断当前焦点是否在可输入元素中（避免单字母快捷键拦截正常输入）
  function isTypingInInput(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  // ---------- ALT 面板渲染 ----------
  async function renderAltPanel(panel) {
    const el = $('#panel' + panel.charAt(0).toUpperCase() + panel.slice(1));
    if (!el) return;

    if (panel === 'play') {
      const s = await api.audio.state();
      el.innerHTML = `
        <h3>播放面板</h3>
        <div class="ap-row"><div><span class="ap-label">当前曲目</span><span class="ap-sub">${s.track?.name || '未播放'}</span></div><span class="ap-badge">${s.playing ? '播放中' : '已暂停'}</span></div>
        <div class="ap-row"><div class="ap-label">歌手</div><span class="ap-sub">${s.track?.artist || '-'}</span></div>
        <div class="ap-row"><div class="ap-label">播放模式</div>
          <select class="ap-select" id="playMode"><option>顺序播放</option><option>单曲循环</option><option>随机播放</option></select></div>
        <div class="ap-row"><div class="ap-label">音量</div><span style="font-family:var(--font-m);color:var(--accent)">${Math.round(s.volume*100)}%</span></div>
        <div class="ap-row"><div class="ap-label">输出模式</div><span class="ap-badge">${s.outputMode}</span></div>
        <div class="ap-row"><div class="ap-label">无缝衔接 Gapless</div><button class="toggle ${s.gapless?'on':''}" id="playGapless" aria-pressed="${s.gapless}"></button></div>
        <h4 style="margin-top:16px;margin-bottom:8px">播放队列 · ${state.queue.length} 首</h4>
        ${state.queue.length ? state.queue.slice(0, 50).map((s, i) =>
          `<div class="src-row"><span class="sr-name">${i+1}. ${s.name} <span class="sr-detail">${s.artist || ''}</span></span><span class="ap-badge">${i === state.currentIndex ? '当前' : ''}</span></div>`
        ).join('') : '<div style="color:var(--dim);padding:12px;text-align:center">队列为空，搜索后点击播放加入队列</div>'}`;
      $('#playGapless')?.addEventListener('click', async (e) => {
        const on = e.target.classList.toggle('on');
        await api.audio.setGapless(on);
        announce('无缝衔接已' + (on ? '开启' : '关闭'));
      });

    } else if (panel === 'playlist') {
      el.innerHTML = `
        <h3>歌单</h3>
        <div style="margin-bottom:12px"><button class="btn btn-p" id="plCreate">新建歌单</button></div>
        <div id="plListArea">
          ${state.playlists.map(pl => `
            <div class="src-row" data-plid="${pl.id}">
              <div><span class="sr-name">${pl.name}</span><span class="sr-detail">${pl.songs?.length || 0} 首</span></div>
              <div><button class="btn-mini" data-act="pl-play" aria-label="播放 ${pl.name}">播放</button> <button class="btn-mini" data-act="pl-del" aria-label="删除 ${pl.name}">删除</button></div>
            </div>`).join('')}
        </div>`;
      // 新建歌单
      $('#plCreate')?.addEventListener('click', () => {
        const name = window.prompt('歌单名称');
        if (name && name.trim()) {
          state.playlists.push({ id: 'pl_' + Date.now(), name: name.trim(), songs: [] });
          announce('已创建歌单：' + name.trim());
          renderAltPanel('playlist');
        }
      });
      // 歌单操作
      $$('#plListArea .btn-mini').forEach(btn => btn.addEventListener('click', (e) => {
        const row = e.target.closest('.src-row');
        const plId = row.dataset.plid;
        const act = e.target.dataset.act;
        if (act === 'pl-del') {
          state.playlists = state.playlists.filter(p => p.id !== plId);
          announce('歌单已删除');
          renderAltPanel('playlist');
        } else if (act === 'pl-play') {
          const pl = state.playlists.find(p => p.id === plId);
          if (pl?.songs?.length) { state.queue = [...pl.songs]; state.currentIndex = 0; playSong(state.queue[0]); }
          else announce('歌单为空');
        }
      }));

    } else if (panel === 'charts') {
      el.innerHTML = `
        <h3>排行榜</h3>
        <div class="charts-grid">
          <button class="chart-card" data-chart="wy" aria-label="网易云飙升榜"><div class="chart-name">网易云</div><div class="chart-sub">飙升榜</div></button>
          <button class="chart-card" data-chart="wy-new" aria-label="网易云新歌榜"><div class="chart-name">网易云</div><div class="chart-sub">新歌榜</div></button>
          <button class="chart-card" data-chart="tx" aria-label="QQ音乐热歌榜"><div class="chart-name">QQ音乐</div><div class="chart-sub">热歌榜</div></button>
          <button class="chart-card" data-chart="tx-new" aria-label="QQ音乐新歌榜"><div class="chart-name">QQ音乐</div><div class="chart-sub">新歌榜</div></button>
          <button class="chart-card" data-chart="kg" aria-label="酷狗TOP500"><div class="chart-name">酷狗</div><div class="chart-sub">TOP500</div></button>
          <button class="chart-card" data-chart="kw" aria-label="酷我热歌榜"><div class="chart-name">酷我</div><div class="chart-sub">热歌榜</div></button>
          <button class="chart-card" data-chart="mg" aria-label="咪咕榜"><div class="chart-name">咪咕</div><div class="chart-sub">音乐榜</div></button>
          <button class="chart-card" data-chart="qsvip" aria-label="汽水热歌榜"><div class="chart-name">汽水</div><div class="chart-sub">热歌榜</div></button>
        </div>
        <div id="chartResults" style="margin-top:12px"></div>`;
      $$('.chart-card').forEach(card => card.addEventListener('click', async () => {
        const chartId = card.dataset.chart;
        announce('正在加载排行榜…');
        const res = await api.search.query('', [chartId.replace('-new','').replace('-hot','')], null, 50);
        const area = $('#chartResults');
        if (area && res.ok && res.songs?.length) {
          area.innerHTML = res.songs.slice(0, 30).map((s, i) =>
            `<div class="src-row" data-idx="${i}" style="cursor:pointer"><span class="sr-name">${i+1}. ${s.name} <span class="sr-detail">${s.artist || ''}</span></span><span class="qt ${(qualityMap[s.bestQuality]||qualityMap.std)[1]}">${(qualityMap[s.bestQuality]||qualityMap.std)[0]}</span></div>`
          ).join('');
          area.querySelectorAll('.src-row').forEach(row => row.addEventListener('click', () => {
            const idx = +row.dataset.idx;
            const song = res.songs[idx];
            if (song) playSong(song);
          }));
          announce(`已加载 ${res.songs.length} 首`);
        } else {
          area.innerHTML = '<div style="color:var(--dim);padding:12px;text-align:center">加载失败或该平台暂不支持排行榜</div>';
          announce('排行榜加载失败');
        }
      }));

    } else if (panel === 'settings') {
      const s = await api.audio.state();
      const list = await api.source.list();
      state.sources = list;
      el.innerHTML = `
        <h3>设置</h3>
        <h4 style="margin-bottom:8px">音质与输出</h4>
        <div class="ap-row"><div><span class="ap-label">期望音质</span><span class="ap-sub">默认自动获取最高可用</span></div>
          <select class="ap-select" id="qExpect"><option>自动·最高</option><option>Hi-Res</option><option>无损</option><option>极品</option><option>标准</option></select></div>
        <div class="ap-row"><div><span class="ap-label">输出模式</span></div>
          <select class="ap-select" id="qMode"><option ${s.outputMode==='wasapi-exclusive'?'selected':''}>WASAPI独占</option><option ${s.outputMode==='wasapi-shared'?'selected':''}>WASAPI共享</option><option>ASIO</option><option>DirectSound</option></select></div>
        <h4 style="margin-top:16px;margin-bottom:8px">音源管理 · ${list.length} 个</h4>
        <div class="import-tabs">
          <button class="import-tab on" data-tab="url">网址导入</button>
          <button class="import-tab" data-tab="js">脚本导入(.js)</button>
          <button class="import-tab" data-tab="local">文件夹导入</button>
        </div>
        <div id="importPanel"></div>
        <div style="margin-top:12px"><div id="srcListArea"></div></div>
        <h4 style="margin-top:16px;margin-bottom:8px">无障碍</h4>
        <div class="ap-row"><div><span class="ap-label">争渡读屏独立通道</span><span class="ap-sub">切歌/错误经独立通道播报</span></div><button class="toggle on" data-a="tts" aria-pressed="true"></button></div>
        <div class="ap-row"><div><span class="ap-label">按键打断播报</span></div><button class="toggle on" data-a="interrupt" aria-pressed="true"></button></div>
        <div class="ap-row"><div><span class="ap-label">切歌播报</span></div><button class="toggle on" data-a="announce" aria-pressed="true"></button></div>`;
      // 音质/输出
      $('#qMode')?.addEventListener('change', (e) => api.audio.setMode(e.target.value.toLowerCase().replace(/\s/g, '-')));
      // 音源列表与导入
      renderSrcList(list);
      renderImportPanel('url');
      $$('.import-tab').forEach(t => t.addEventListener('click', () => {
        $$('.import-tab').forEach(x => x.classList.remove('on'));
        t.classList.add('on');
        renderImportPanel(t.dataset.tab);
      }));
      // 无障碍开关
      $$('[data-a]').forEach(t => t.addEventListener('click', async () => {
        const on = t.classList.toggle('on');
        t.setAttribute('aria-pressed', on);
        const k = t.dataset.a;
        if (k === 'tts') await api.zdsr.setEnabled(on);
        else if (k === 'interrupt') await api.zdsr.setInterrupt(on);
        else if (k === 'announce') await api.zdsr.setAnnounce(on);
        announce('设置已更新');
      }));

    } else if (panel === 'help') {
      const appVersion = '0.1.0';
      el.innerHTML = `
        <h3>帮助</h3>
        <div class="help-section">
          <h4>快捷键</h4>
          <div class="ap-row"><span class="ap-label">Alt</span><span class="ap-sub">打开功能菜单</span></div>
          <div class="ap-row"><span class="ap-label">Alt+P/L/C/S/H</span><span class="ap-sub">直接打开对应面板</span></div>
          <div class="ap-row"><span class="ap-label">Enter</span><span class="ap-sub">播放选中歌曲</span></div>
          <div class="ap-row"><span class="ap-label">Menu / 右键</span><span class="ap-sub">歌曲上下文菜单</span></div>
          <div class="ap-row"><span class="ap-label">P</span><span class="ap-sub">播报当前进度（非输入框时）</span></div>
          <div class="ap-row"><span class="ap-label">Esc</span><span class="ap-sub">关闭菜单</span></div>
          <div class="ap-row"><span class="ap-label">MediaPlayPause/Next/Prev</span><span class="ap-sub">媒体键控制</span></div>
        </div>
        <div class="help-section" style="margin-top:16px">
          <h4>使用说明</h4>
          <p style="color:var(--muted);font-size:13px;line-height:1.7;margin:0">
            在搜索框输入歌名、歌手或专辑，选择平台和类型筛选后点击搜索。
            搜索结果默认播放最高音质。右键点击歌曲可查看更多操作。
            通过 Alt 菜单管理歌单、查看排行榜、设置音源和音质。
            本软件完全适配争渡读屏，所有操作均有语音反馈。
          </p>
        </div>
        <div class="help-section" style="margin-top:16px">
          <h4>关于辰曦音乐</h4>
          <div class="ap-row"><span class="ap-label">版本</span><span class="ap-sub" id="helpVer">${appVersion}</span></div>
          <div class="ap-row"><span class="ap-label">架构</span><span class="ap-sub">Electron 桌面应用</span></div>
          <div class="ap-row"><span class="ap-label">音频引擎</span><span class="ap-sub">WASAPI 独占 / Hi-Res / Gapless</span></div>
          <div class="ap-row"><span class="ap-label">读屏适配</span><span class="ap-sub">争渡读屏 ZDSRAPI 独立通道</span></div>
          <div class="ap-row"><span class="ap-label">音源生态</span><span class="ap-sub">LX Music 自定义音源</span></div>
          <div style="margin-top:12px">
            <button class="btn btn-p" id="helpUpdate">检查更新</button>
            <button class="btn btn-g" id="helpFeedback" style="margin-left:6px">意见反馈</button>
          </div>
          <div id="updateResult" style="margin-top:8px"></div>
        </div>`;
      // 检查更新
      $('#helpUpdate')?.addEventListener('click', async () => {
        const area = $('#updateResult');
        area.innerHTML = '<span style="color:var(--dim)">正在检查更新…</span>';
        try {
          const r = await api.app.checkUpdate();
          if (r.ok && r.updateAvailable) {
            area.innerHTML = `<div style="color:var(--accent)">发现新版本 v${r.version}</div><div style="color:var(--muted);font-size:12px;margin-top:4px">${r.releaseNotes || ''}</div><button class="btn btn-p" id="doUpdate" style="margin-top:8px">立即更新</button>`;
            $('#doUpdate')?.addEventListener('click', async () => {
              area.innerHTML = '<span style="color:var(--dim)">正在下载更新…</span>';
              await api.app.downloadUpdate();
              area.innerHTML = '<span style="color:var(--accent)">更新已下载，重启后生效</span>';
            });
          } else if (r.ok) {
            area.innerHTML = '<span style="color:var(--fg)">已是最新版本</span>';
          } else {
            area.innerHTML = '<span style="color:var(--error)">检查失败：' + (r.error || '') + '</span>';
          }
        } catch (e) {
          area.innerHTML = '<span style="color:var(--error)">检查更新出错</span>';
        }
      });
      // 意见反馈
      $('#helpFeedback')?.addEventListener('click', () => {
        announce('请在项目主页提交反馈');
      });
    }
  }

  function renderSrcList(list) {
    const area = $('#srcListArea');
    if (!area) return;
    area.innerHTML = list.length ? list.map(s => {
      const typeLabel = s.type === 'js' ? 'LX脚本' : s.type === 'url' ? '网址' : s.type === 'local' ? '本地' : s.type;
      const typeClass = s.type === 'js' ? 'js' : s.type === 'local' ? 'local' : 'url';
      return `<div class="src-row">
        <div><span class="sr-name">${s.name} ${s.version || ''}<span class="sr-type ${typeClass}">${typeLabel}</span></span>
        <span class="sr-detail">${(s.platformLabels || []).join(' · ') || ''} ${(s.qualityLabels || []).join(' · ') || ''}${s.fileCount ? ' · ' + s.fileCount + '首' : ''}</span></div>
        <button class="toggle ${s.enabled?'on':''}" data-sid="${s.id}" aria-pressed="${s.enabled}" aria-label="切换 ${s.name}"></button>
      </div>`;
    }).join('') : '<div style="color:var(--dim);padding:12px;text-align:center">暂无音源</div>';
    $$('[data-sid]').forEach(t => t.addEventListener('click', async () => {
      const on = t.classList.toggle('on');
      t.setAttribute('aria-pressed', on);
      await api.source.setEnabled(t.dataset.sid, on);
      announce('音源已' + (on ? '启用' : '停用'));
    }));
  }

  function renderImportPanel(tab) {
    const p = $('#importPanel');
    if (tab === 'url') {
      p.innerHTML = `
        <div class="form-row"><label>名称</label><input id="urlName" type="text" placeholder="自动识别或手动填写"></div>
        <div class="form-row"><label>URL</label><input id="urlAddr" type="text" placeholder="LX音源URL或API地址"></div>
        <div><button class="btn btn-p" id="urlImport">导入音源</button> <button class="btn btn-g" id="urlTest" style="margin-left:6px">测试连接</button></div>`;
      $('#urlImport').addEventListener('click', async () => {
        const url = $('#urlAddr').value.trim();
        if (!url) { announce('请输入URL'); return; }
        announce('正在导入并自动识别…');
        const r = await api.source.importUrl(url);
        if (r.ok) { announce('已导入：' + r.source.name + ' ' + (r.source.version || '') + '，支持 ' + (r.source.platformLabels || []).join('、')); state.sources = await api.source.list(); renderSrcList(state.sources); }
        else announce('导入失败：' + r.error);
      });
    } else if (tab === 'js') {
      p.innerHTML = `
        <div class="form-row"><label>脚本文件</label><input id="jsPath" type="text" placeholder="选择或拖入 .js 音源脚本" readonly></div>
        <div><button class="btn btn-p" id="jsBrowse">选择文件</button> <button class="btn btn-g" id="jsImport" style="margin-left:6px">导入并启用</button></div>
        <div style="margin-top:8px;font-size:11px;color:var(--dim);font-family:var(--font-m)">提示：导入后自动解析 @name @version 与平台/音质</div>`;
      $('#jsBrowse').addEventListener('click', async () => {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = '.js';
        input.onchange = () => { if (input.files[0]) $('#jsPath').value = input.files[0].path; };
        input.click();
      });
      $('#jsImport').addEventListener('click', async () => {
        const fp = $('#jsPath').value.trim();
        if (!fp) { announce('请选择脚本文件'); return; }
        announce('正在解析脚本…');
        const r = await api.source.importFile(fp);
        if (r.ok) { announce('已导入：' + r.source.name + ' ' + (r.source.version || '') + '，支持 ' + (r.source.platformLabels || []).join('、') + '，音质 ' + (r.source.qualityLabels || []).join('、')); state.sources = await api.source.list(); renderSrcList(state.sources); }
        else announce('导入失败：' + r.error);
      });
    } else if (tab === 'local') {
      p.innerHTML = `
        <div class="form-row"><label>文件夹</label><input id="localPath" type="text" placeholder="选择音频文件夹" readonly></div>
        <div class="form-row"><label>扫描深度</label><select id="localDepth"><option value="99">不限</option><option value="3" selected>3层</option><option value="1">1层</option></select></div>
        <div><button class="btn btn-p" id="localBrowse">选择文件夹</button> <button class="btn btn-g" id="localImport" style="margin-left:6px">扫描并导入</button></div>`;
      $('#localBrowse').addEventListener('click', async () => {
        const picker = document.createElement('input');
        picker.type = 'file'; picker.webkitdirectory = true;
        picker.onchange = () => { if (picker.files[0]) $('#localPath').value = picker.files[0].path; };
        picker.click();
      });
      $('#localImport').addEventListener('click', async () => {
        const fp = $('#localPath').value.trim();
        if (!fp) { announce('请选择文件夹'); return; }
        announce('正在扫描…');
        const r = await api.source.importFolder(fp, +$('#localDepth').value, ['flac','wav','ape','dsd','dff','dsf','mqa','alac','mp3','aac','ogg']);
        if (r.ok) { announce('已导入本地曲库：' + r.source.fileCount + ' 首'); state.sources = await api.source.list(); renderSrcList(state.sources); }
        else announce('导入失败：' + r.error);
      });
    }
  }

  // ---------- 初始化 ----------
  (async function init() {
    state.sources = await api.source.list();
    api.contextMenu.setPlaylists(state.playlists);
    announce('辰曦音乐就绪');
    $('#searchInput').focus();
  })();

})();
