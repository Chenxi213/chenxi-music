// 辰曦音乐 - 渲染层交互逻辑
// 下拉框搜索风格 + 顶部菜单栏 + 键盘循环导航 + F4音源管理
// 完全适配争渡读屏：所有操作经UIA语义暴露 + ZDSRAPI独立通道播报

(function () {
  'use strict';
  const api = window.chenxi;

  // 状态
  const state = {
    queue: [],
    currentIndex: -1,
    playing: false,
    scope: 'song',
    site: 'all',
    quality: 'all',
    sources: [],
    sourceCheck: { total: 0, ok: 0, checking: false },
    playlists: [{ id: 'fav', name: '我的收藏' }, { id: 'later', name: '稍后听' }]
  };

  const platLabels = { wy:'网易云', tx:'QQ音乐', kg:'酷狗', kw:'酷我', mg:'咪咕', qsvip:'汽水VIP', git:'Git音源', bili:'B站', local:'本地' };
  const qualityMap = { hr: ['Hi-Res','hr'], loss: ['无损','loss'], ex: ['极品','ex'], std: ['标准','std'] };
  const fmtTime = (s) => { const m=Math.floor(s/60),ss=Math.floor(s%60); return m+':'+(ss<10?'0'+ss:ss); };
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  function announce(text) {
    $('#liveRegion').textContent = text;
    if (api?.zdsr) api.zdsr.speak(text, true);
  }

  // ---------- ALT 菜单栏事件 ----------
  $$('.alt-mi').forEach(btn => {
    btn.addEventListener('click', () => { switchAltPanel(btn.dataset.panel); focusMenuItem(btn.dataset.panel); });
  });

  // ---------- 搜索 ----------
  async function doSearch() {
    const kw = $('#searchInput').value.trim();
    if (!kw) { announce('请输入搜索关键词'); return; }
    announce('正在搜索 ' + kw);
    const list = $('#resultsList');
    list.setAttribute('aria-busy', 'true');
    list.innerHTML = '';
    $('#emptyHint').hidden = true;
    $('#searchMeta').textContent = '搜索中…';
    try {
      const res = await api.search.query(kw, state.site === 'all' ? null : [state.site], state.scope === 'all' ? null : [state.scope], 30);
      list.removeAttribute('aria-busy');
      if (!res.ok) { announce('搜索失败：' + res.error); renderResults([]); return; }
      renderResults(res.songs || []);
      const total = res.songs?.length || 0;
      $('#searchMeta').textContent = '搜索结果，共 ' + total + ' 首';
      if (total > 0) {
        announce('找到 ' + total + ' 条结果，按上下光标浏览，Enter播放，Menu键打开歌曲菜单');
        // 自动将焦点移入结果列表第一项
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
      li.setAttribute('aria-label', `${song.name} ${song.artist||''} ${platLabels[song.platform]||song.platform} ${qd[0]}`);
      li.dataset.idx = i;
      li.innerHTML = `
        <span class="ri-num">${i+1}</span>
        <span class="ri-name">${song.name}</span>
        <span class="ri-artist">${song.artist||''}</span>
        <span class="ri-plat">${platLabels[song.platform]||song.platform}</span>
        <span class="ri-quality"><span class="qt ${qd[1]}">${qd[0]}</span></span>
        <span class="ri-duration">${song.duration?fmtTime(song.duration):'--'}</span>
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
    const song = readSongFromDom(item);
    if (e.target.dataset.act === 'menu') {
      await showContextMenu(song, item);
    } else {
      await playSong(song);
    }
  });

  // 右键/上下文菜单
  $('#resultsList').addEventListener('contextmenu', async (e) => {
    const item = e.target.closest('.result-item');
    if (!item) return;
    e.preventDefault();
    await showContextMenu(readSongFromDom(item), item);
  });

  // 结果列表键盘导航：Enter播放、Menu键菜单、上下光标循环
  $('#resultsList').addEventListener('keydown', async (e) => {
    const items = $$('.result-item');
    if (!items.length) return;
    const current = document.activeElement;
    const idx = items.indexOf(current);

    if (e.key === 'Enter') {
      e.preventDefault();
      const item = current.closest('.result-item');
      if (item) await playSong(readSongFromDom(item));
      return;
    }
    if (e.key === 'Menu' || (e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault();
      const item = current.closest('.result-item');
      if (item) await showContextMenu(readSongFromDom(item), item);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = idx >= 0 && idx < items.length - 1 ? items[idx + 1] : items[0];
      next.focus();
      announce(next.getAttribute('aria-label'));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = idx > 0 ? items[idx - 1] : items[items.length - 1];
      prev.focus();
      announce(prev.getAttribute('aria-label'));
      return;
    }
  });

  function readSongFromDom(item) {
    const qd = item.querySelector('.qt');
    const platText = item.querySelector('.ri-plat').textContent;
    return {
      name: item.querySelector('.ri-name').textContent,
      artist: item.querySelector('.ri-artist').textContent,
      platform: Object.entries(platLabels).find(([k,v]) => v === platText)?.[0] || 'unknown',
      platformLabel: platText,
      bestQuality: qd?.classList.contains('hr')?'hr':qd?.classList.contains('loss')?'loss':qd?.classList.contains('ex')?'ex':'std',
      qualityLabel: qd?.textContent||'标准',
      duration: 0
    };
  }

  // ---------- 播放 ----------
  async function playSong(song) {
    announce('正在获取最高音质：' + song.name);
    const candidates = await buildCandidates(song);
    const res = await api.audio.play(song, candidates);
    if (!res.ok) { announce('播放失败：' + res.error); return; }
    announce('正在播放：' + song.name + '，' + song.artist + '，' + (res.quality?.label||'最高音质'));
  }

  async function buildCandidates(song) {
    const candidates = [];
    for (const src of state.sources.filter(s => s.enabled)) {
      if (!src.platforms?.includes(song.platform)) continue;
      for (const q of src.qualities||['flac','320k','128k']) {
        candidates.push({
          source: src.name, quality: q,
          getUrl: async () => {
            const r = await api.source.getUrl(src.id, song.platform, { songmid: song.id||song.name, hash: song.hash }, q);
            if (!r.ok) throw new Error(r.error);
            return r.url;
          }
        });
      }
    }
    return candidates;
  }

  // ---------- 上下文菜单 ----------
  async function showContextMenu(song, item) {
    const qualities = collectAvailableQualities(song.platform);
    const ctx = {
      isFavorite: state.playlists[0]?.songs?.includes(song.name),
      inQueue: state.queue.some(s => s.name === song.name),
      qualities: qualities.length?qualities:['flac','320k','128k']
    };
    await api.contextMenu.show(song, ctx);
  }
  function collectAvailableQualities(platform) {
    const set = new Set();
    for (const src of state.sources.filter(s => s.enabled)) {
      if (!src.platforms?.includes(platform)) continue;
      for (const q of src.qualities||[]) set.add(normalizeQualityId(q));
    }
    const order = ['hires','master','atmos','flac24bit','flac','320k','192k','128k'];
    return order.filter(q => set.has(q));
  }
  function normalizeQualityId(q) {
    const s = String(q).toLowerCase();
    if (s.includes('hires')||s.includes('hi-res')) return 'hires';
    if (s.includes('master')||s.includes('mqa')) return 'master';
    if (s.includes('atmos')||s.includes('dolby')) return 'atmos';
    if (s.includes('flac24')||s.includes('24bit')) return 'flac24bit';
    if (s.includes('flac')) return 'flac';
    if (s.includes('320')) return '320k';
    if (s.includes('192')) return '192k';
    if (s.includes('128')) return '128k';
    return s;
  }

  api.contextMenu.onAction(async ({action,payload}) => {
    if (action==='play') await playSong(payload);
    else if (action==='add-queue') { state.queue.push(payload); announce('已加入播放队列'); }
    else if (action==='favorite') { announce('已收藏：'+payload.name); }
    else if (action==='download') { announce('开始下载：'+payload.name); }
    else if (action==='copy-link') { await navigator.clipboard.writeText(payload.url||''); announce('链接已复制'); }
    else if (action==='share') { announce('分享：'+payload.name); }
    else if (action==='view-album') { announce('查看专辑：'+payload.album); }
    else if (action==='view-artist') { announce('查看歌手：'+payload.artist); }
    else if (action==='lyrics') { announce('打开歌词：'+payload.name); }
    else if (action==='similar') { announce('查找相似歌曲'); }
    else if (action==='same-artist') { announce('歌手其他歌曲'); }
    else if (action==='same-album') { announce('专辑其他歌曲'); }
    else if (action==='remove-queue') { state.queue = state.queue.filter(s=>s.name!==payload.name); announce('已从队列移除'); }
    else if (action==='set-quality') { announce('切换音质：'+payload.quality); }
    else if (action==='open-folder') { announce('打开文件位置'); }
    else if (action==='properties') { announce('歌曲信息：'+payload.name); }
  });

  // ---------- 搜索控件绑定 ----------
  $('#searchBtn').addEventListener('click', doSearch);
  $('#searchInput').addEventListener('keydown', (e) => { if (e.key==='Enter') doSearch(); });
  $('#scopeSelect').addEventListener('change', (e) => { state.scope = e.target.value; });
  $('#siteSelect').addEventListener('change', (e) => { state.site = e.target.value; });

  // 音质筛选
  $$('#qualityChips .chip').forEach(c => c.addEventListener('click', () => {
    $$('#qualityChips .chip').forEach(x => { x.classList.remove('on'); x.setAttribute('aria-checked','false'); });
    c.classList.add('on'); c.setAttribute('aria-checked','true');
    state.quality = c.dataset.q;
  }));

  // ---------- 迷你播放器 ----------
  $('#mpPlay').addEventListener('click', async () => {
    if (state.playing) await api.audio.pause(); else await api.audio.resume();
  });
  $('#mpPrev').addEventListener('click', playPrev);
  $('#mpNext').addEventListener('click', playNext);
  $('#mpStop').addEventListener('click', async () => { await api.audio.stop(); state.playing=false; });
  $('#mpProgress').addEventListener('click', async (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left)/rect.width;
    const dur = await api.audio.state().then(s=>s.duration);
    await api.audio.seek(pct*dur);
  });

  function playNext() { if (state.currentIndex < state.queue.length-1) { state.currentIndex++; playSong(state.queue[state.currentIndex]); } }
  function playPrev() { if (state.currentIndex > 0) { state.currentIndex--; playSong(state.queue[state.currentIndex]); } }

  api.audio.onTrackChanged(({song,quality}) => {
    $('#mpTrack').textContent = song.name;
    $('#mpArtist').textContent = song.artist||'';
    $('#mpQuality').textContent = quality?.label||'';
    state.playing = true;
    $('#mpPlay').textContent = '⏸';
  });
  api.audio.onStateChanged((s) => {
    state.playing = s.playing;
    $('#mpPlay').textContent = s.playing?'⏸':'▶';
    updateProgressBar(s.position,s.duration);
  });
  api.audio.onPosition((pos) => { api.audio.state().then(s=>updateProgressBar(pos,s.duration)); });
  api.audio.onError((msg) => announce('播放错误：'+msg));

  function updateProgressBar(pos,dur) {
    const pct = dur?Math.round(pos/dur*100):0;
    $('#mpProgress').setAttribute('aria-valuenow',pct);
    $('#mpProgressFill').style.width = pct+'%';
    $('#mpCurTime').textContent = fmtTime(pos);
    $('#mpTotalTime').textContent = fmtTime(dur);
  }

  // ---------- ALT 展开式菜单栏 ----------
  const altOverlay = $('#altOverlay');
  let altActivePanel = '';
  const ALT_PANELS = ['play','playlist','charts','source','settings','help'];

  function openAlt(panel) {
    altOverlay.hidden = false;
    switchAltPanel(panel || 'play');
    // 聚焦第一个菜单项
    const firstMi = document.querySelector('.alt-mi');
    if (firstMi) firstMi.focus();
  }
  function closeAlt() {
    altOverlay.hidden = true;
    $$('.alt-dd').forEach(d => d.hidden = true);
    $$('.alt-mi').forEach(m => { m.classList.remove('open'); m.setAttribute('aria-expanded','false'); });
    altActivePanel = '';
    $('#searchInput').focus();
  }
  function switchAltPanel(panel) {
    altActivePanel = panel;
    $$('.alt-dd').forEach(d => d.hidden = true);
    $$('.alt-mi').forEach(m => { m.classList.remove('open'); m.setAttribute('aria-expanded','false'); });
    const dd = $('#dd'+panel.charAt(0).toUpperCase()+panel.slice(1));
    if (dd) { dd.hidden = false; renderAltPanel(panel); }
    const mi = document.querySelector(`.alt-mi[data-panel="${panel}"]`);
    if (mi) { mi.classList.add('open'); mi.setAttribute('aria-expanded','true'); }
    // 音源管理面板：渲染完后聚焦第一个音源
    if (panel === 'source') {
      setTimeout(() => {
        const firstSrc = document.querySelector('#ddSource .alt-dd-item');
        if (firstSrc) firstSrc.focus();
      }, 50);
    }
  }
  function focusMenuItem(panel) {
    const mi = document.querySelector(`.alt-mi[data-panel="${panel}"]`);
    if (mi) mi.focus();
  }
  function focusPanelFirstItem(panel) {
    const dd = $('#dd'+panel.charAt(0).toUpperCase()+panel.slice(1));
    if (!dd) return;
    const first = dd.querySelector('.alt-dd-item, [tabindex="0"]');
    if (first) first.focus();
  }
  $('#altClose').addEventListener('click', closeAlt);
  api.menu.onOpen((panel) => openAlt(panel));
  api.menu.onClose(() => closeAlt());

  // ALT菜单键盘导航
  altOverlay.addEventListener('keydown', (e) => {
    const mis = $$('.alt-mi');
    const curMi = document.activeElement.closest?.('.alt-mi');
    const curDdItem = document.activeElement.closest?.('.alt-dd-item');
    const curPanelBtn = document.activeElement.closest?.('.panel-btn');

    // 左右光标：在菜单项之间切换
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const idx = mis.indexOf(curMi);
      const next = idx >= 0 && idx < mis.length - 1 ? mis[idx + 1] : mis[0];
      if (next) { switchAltPanel(next.dataset.panel); next.focus(); }
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const idx = mis.indexOf(curMi);
      const prev = idx > 0 ? mis[idx - 1] : mis[mis.length - 1];
      if (prev) { switchAltPanel(prev.dataset.panel); prev.focus(); }
      return;
    }
    // 下光标：从菜单项进入面板内容
    if (e.key === 'ArrowDown' && curMi && !curDdItem && !curPanelBtn) {
      e.preventDefault();
      focusPanelFirstItem(altActivePanel);
      return;
    }
    // 上光标：从面板内容返回菜单项
    if (e.key === 'ArrowUp' && (curDdItem || curPanelBtn)) {
      const items = getPanelItems(altActivePanel);
      const idx = items.indexOf(document.activeElement);
      if (idx === 0 || idx === -1) {
        e.preventDefault();
        focusMenuItem(altActivePanel);
        return;
      }
    }
    // Enter：在菜单项上展开面板；在面板项上执行
    if (e.key === 'Enter' && curMi) {
      e.preventDefault();
      switchAltPanel(curMi.dataset.panel);
      focusPanelFirstItem(curMi.dataset.panel);
      return;
    }
    // ESC 关闭
    if (e.key === 'Escape') { closeAlt(); return; }
  });

  // 全局快捷键
  document.addEventListener('keydown', (e) => {
    if (e.key==='Alt' && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      if (altOverlay.hidden) openAlt('play'); else closeAlt();
      return;
    }
    if (e.key==='F4' && !isTypingInInput(e.target)) {
      e.preventDefault();
      openAlt('source');
      return;
    }
    if ((e.key==='p'||e.key==='P') && !isTypingInInput(e.target)) {
      e.preventDefault();
      api.audio.state().then(s => {
        if (s.track) announce(`进度 ${fmtTime(s.position)}，共 ${fmtTime(s.duration)}，正在播放 ${s.track.name}`);
        else announce('当前未在播放');
      });
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.shiftKey) {
      const map = { p:'play', l:'playlist', r:'charts', s:'settings', h:'help' };
      if (map[e.key.toLowerCase()]) { e.preventDefault(); openAlt(map[e.key.toLowerCase()]); }
    }
  });

  function getPanelItems(panel) {
    const dd = $('#dd'+panel.charAt(0).toUpperCase()+panel.slice(1));
    if (!dd) return [];
    return $$('.alt-dd-item, .panel-btn', dd);
  }

  function isTypingInInput(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||target.isContentEditable;
  }

  // ---------- 面板渲染 ----------
  async function renderAltPanel(panel) {
    const el = $('#panel'+panel.charAt(0).toUpperCase()+panel.slice(1));
    if (!el) return;

    if (panel==='play') {
      const s = await api.audio.state();
      el.innerHTML = `
        <h3>播放面板</h3>
        <div class="ap-row"><div><span class="ap-label">当前曲目</span><span class="ap-sub">${s.track?.name||'未播放'}</span></div><span class="ap-badge">${s.playing?'播放中':'已暂停'}</span></div>
        <div class="ap-row"><div class="ap-label">歌手</div><span class="ap-sub">${s.track?.artist||'-'}</span></div>
        <div class="ap-row"><div class="ap-label">播放模式</div><select class="ap-select" id="playMode"><option>顺序播放</option><option>单曲循环</option><option>随机播放</option></select></div>
        <div class="ap-row"><div class="ap-label">音量</div><span style="color:var(--accent)">${Math.round(s.volume*100)}%</span></div>
        <div class="ap-row"><div class="ap-label">输出模式</div><span class="ap-badge">${s.outputMode}</span></div>
        <div class="ap-row"><div class="ap-label">无缝衔接 Gapless</div><button class="toggle ${s.gapless?'on':''}" id="playGapless" aria-pressed="${s.gapless}"></button></div>
        <h3 style="margin-top:16px">播放队列 · ${state.queue.length} 首</h3>
        ${state.queue.length?state.queue.slice(0,50).map((s,i)=>`<div class="src-row"><span class="sr-name">${i+1}. ${s.name} <span class="sr-detail">${s.artist||''}</span></span><span class="ap-badge">${i===state.currentIndex?'当前':''}</span></div>`).join(''):'<div style="color:var(--dim);padding:12px;text-align:center">队列为空</div>'}`;
      $('#playGapless')?.addEventListener('click', async (e) => {
        const on=e.target.classList.toggle('on');
        await api.audio.setGapless(on);
        announce('无缝衔接已'+(on?'开启':'关闭'));
      });

    } else if (panel==='playlist') {
      el.innerHTML = `
        <h3>歌单</h3>
        <div style="margin-bottom:12px"><button class="btn btn-p" id="plCreate">新建歌单</button></div>
        <div id="plListArea">
          ${state.playlists.map(pl=>`<div class="src-row" data-plid="${pl.id}"><div><span class="sr-name">${pl.name}</span><span class="sr-detail">${pl.songs?.length||0} 首</span></div><div><button class="btn-mini" data-act="pl-play" aria-label="播放 ${pl.name}">播放</button> <button class="btn-mini" data-act="pl-del" aria-label="删除 ${pl.name}">删除</button></div></div>`).join('')}
        </div>`;
      $('#plCreate')?.addEventListener('click', () => {
        const name=window.prompt('歌单名称');
        if (name?.trim()) { state.playlists.push({id:'pl_'+Date.now(),name:name.trim(),songs:[]}); announce('已创建歌单：'+name.trim()); renderAltPanel('playlist'); }
      });
      $$('#plListArea .btn-mini').forEach(btn => btn.addEventListener('click', (e) => {
        const row=e.target.closest('.src-row'); const plId=row.dataset.plid; const act=e.target.dataset.act;
        if (act==='pl-del') { state.playlists=state.playlists.filter(p=>p.id!==plId); renderAltPanel('playlist'); }
      }));

    } else if (panel==='charts') {
      const charts = [
        {name:'飙升榜',plat:'wy'},{name:'新歌榜',plat:'wy'},{name:'热歌榜',plat:'wy'},
        {name:'流行指数',plat:'tx'},{name:'热歌榜',plat:'tx'},{name:'新歌榜',plat:'tx'},
        {name:'酷狗TOP500',plat:'kg'},{name:'酷我热歌榜',plat:'kw'},{name:'咪咕榜',plat:'mg'}
      ];
      el.innerHTML = `<h3>排行榜</h3><div class="charts-grid">${charts.map(c=>`<button class="chart-card" data-plat="${c.plat}"><div class="chart-name">${c.name}</div><div class="chart-sub">${platLabels[c.plat]}</div></button>`).join('')}</div>`;
      $$('.chart-card').forEach(c => c.addEventListener('click', () => announce('加载排行榜：'+c.querySelector('.chart-name').textContent)));

    } else if (panel==='settings') {
      const s = await api.settings.get();
      el.innerHTML = `
        <h3>设置</h3>
        <div class="ap-row"><div class="ap-label">争渡读屏 ZDSRAPI</div><button class="toggle ${s.zdsrEnabled?'on':''}" id="setZdsr"></button></div>
        <div class="ap-row"><div class="ap-label">WASAPI 独占模式</div><button class="toggle ${s.wasapi?'on':''}" id="setWasapi"></button></div>
        <div class="ap-row"><div class="ap-label">无缝衔接</div><button class="toggle ${s.gapless?'on':''}" id="setGapless"></button></div>
        <div class="ap-row"><div class="ap-label">默认最高音质</div><span class="ap-badge">${s.defaultQuality||'Hi-Res'}</span></div>
        <div class="ap-row"><div class="ap-label">缓存目录</div><span class="ap-sub">${s.cacheDir||'默认'}</span></div>
        <div class="ap-row"><div class="ap-label">版本</div><span class="ap-sub">${s.version||'0.1.0'}</span></div>`;
      ['Zdsr','Wasapi','Gapless'].forEach(k=>{
        $(`#set${k}`)?.addEventListener('click', async (e)=>{
          const on=e.target.classList.toggle('on');
          await api.settings.set(k.toLowerCase(), on);
          announce(k==='Zdsr'?'争渡读屏'+(on?'开启':'关闭'):k==='Wasapi'?'WASAPI独占'+(on?'开启':'关闭'):'无缝衔接'+(on?'开启':'关闭'));
        });
      });

    } else if (panel==='help') {
      el.innerHTML = `
        <h3>帮助</h3>
        <div class="help-section"><h4>快捷键</h4>
          <div class="ap-row"><span class="ap-label">Alt / 顶部菜单</span><span class="ap-sub">打开功能菜单</span></div>
          <div class="ap-row"><span class="ap-label">Alt+P/L/C/S/H</span><span class="ap-sub">切换面板</span></div>
          <div class="ap-row"><span class="ap-label">F4</span><span class="ap-sub">音源管理</span></div>
          <div class="ap-row"><span class="ap-label">Enter</span><span class="ap-sub">播放选中歌曲</span></div>
          <div class="ap-row"><span class="ap-label">↑ ↓</span><span class="ap-sub">循环浏览结果</span></div>
          <div class="ap-row"><span class="ap-label">Menu / 右键</span><span class="ap-sub">歌曲上下文菜单</span></div>
          <div class="ap-row"><span class="ap-label">P</span><span class="ap-sub">播报进度</span></div>
          <div class="ap-row"><span class="ap-label">ESC</span><span class="ap-sub">关闭菜单</span></div>
        </div>
        <div class="help-section"><h4>关于</h4><div class="ap-sub">辰曦音乐 v0.1.0 · 发烧级无障碍音乐播放器</div></div>
        <div style="margin-top:12px"><button class="btn btn-p" id="helpCheckUpdate">检查更新</button></div>`;
      $('#helpCheckUpdate')?.addEventListener('click', async () => {
        announce('正在检查更新…');
        const res = await api.app.checkUpdate();
        if (res.hasUpdate) announce('发现新版本：'+res.version+'，请前往Release页面下载');
        else announce('当前已是最新版本');
      });

    } else if (panel==='source') {
      const list = state.sources;
      el.innerHTML = `
        <h3>音源管理 (${list.filter(s=>s.enabled).length}/${list.length} 已启用)</h3>
        <div id="srcList" role="listbox" aria-label="音源列表" tabindex="0">
          ${list.map((src,i)=>`
            <div class="alt-dd-item" role="option" tabindex="0" data-sidx="${i}" aria-selected="false"
                 aria-label="${src.name} ${src.author||''} ${src.enabled?'已启用':'已禁用'} ${src.platformLabels?.join(' ')||''}">
              <span class="ddi-label">${src.name}</span>
              <span class="ddi-detail">${src.author||''} ${src.version||''}</span>
              <span class="ddi-badge">${src.enabled?'已启用':'已禁用'}</span>
            </div>
          `).join('')}
        </div>
        <div style="margin-top:12px;display:flex;gap:8px">
          <button class="btn btn-p panel-btn" id="srcImportBtn" tabindex="0">导入音源</button>
          <button class="btn btn-g panel-btn" id="srcCheckAll" tabindex="0">检测全部</button>
        </div>`;

      // 音源列表键盘导航：上下循环
      const srcList = $('#srcList');
      srcList.addEventListener('keydown', async (e) => {
        const items = $$('.alt-dd-item', srcList);
        if (!items.length) return;
        const cur = document.activeElement;
        const idx = items.indexOf(cur);

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const next = idx >= 0 && idx < items.length - 1 ? items[idx + 1] : items[0];
          next.focus();
          announce(next.getAttribute('aria-label'));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          const prev = idx > 0 ? items[idx - 1] : items[items.length - 1];
          prev.focus();
          announce(prev.getAttribute('aria-label'));
          return;
        }
        // Tab 到导入按钮
        if (e.key === 'Tab' && !e.shiftKey) {
          const last = items[items.length - 1];
          if (cur === last) {
            e.preventDefault();
            $('#srcImportBtn')?.focus();
            return;
          }
        }
        // Enter 或上下文菜单
        if (e.key === 'Enter' || e.key === 'Menu' || e.key === 'ContextMenu') {
          e.preventDefault();
          const srcIdx = +cur.dataset.sidx;
          const src = state.sources[srcIdx];
          if (!src) return;
          showSourceContextMenu(src, srcIdx, cur);
          return;
        }
      });

      // 音源项点击/右键菜单
      $$('.alt-dd-item', srcList).forEach(item => {
        item.addEventListener('click', () => {
          const srcIdx = +item.dataset.sidx;
          const src = state.sources[srcIdx];
          showSourceContextMenu(src, srcIdx, item);
        });
        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const srcIdx = +item.dataset.sidx;
          const src = state.sources[srcIdx];
          showSourceContextMenu(src, srcIdx, item);
        });
      });

      // 导入按钮
      $('#srcImportBtn')?.addEventListener('click', () => showImportMenu());
      $('#srcImportBtn')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); showImportMenu(); }
      });
      $('#srcCheckAll')?.addEventListener('click', () => checkSources());
    }
  }

  // ---------- 音源加载与检测 ----------
  async function loadSources() {
    try {
      const list = await api.source.list();
      state.sources = list || [];
      updateSourceStatus();
    } catch(e) { console.error('loadSources',e); }
  }

  async function checkSources() {
    announce('开始检测音源可用性…');
    state.sourceCheck.checking = true;
    state.sourceCheck.total = state.sources.length;
    state.sourceCheck.ok = 0;
    updateSourceStatus();

    for (const src of state.sources) {
      try {
        const res = await api.source.check(src.id);
        src.checkOk = res.ok;
        if (res.ok) state.sourceCheck.ok++;
      } catch(e) { src.checkOk = false; }
      updateSourceStatus();
    }
    state.sourceCheck.checking = false;
    announce(`音源检测完成，${state.sourceCheck.ok}/${state.sourceCheck.total} 个可用`);
    updateSourceStatus();
  }

  function updateSourceStatus() {
    const sb = $('#statusBar');
    if (!sb) return;
    const ok = state.sourceCheck.ok;
    const total = state.sourceCheck.total || state.sources.length;
    if (state.sourceCheck.checking) {
      sb.innerHTML = `<span>当前未播放</span><span class="sb-sep">|</span><span>当前列表共 0 项</span><span class="sb-sep">|</span><span class="sb-checking">已加载 ${total} 个音源，正在后台逐站实测检测。站点检测完成，${ok} 个可用</span>`;
    } else {
      sb.innerHTML = `<span>当前未播放</span><span class="sb-sep">|</span><span>当前列表共 0 项</span><span class="sb-sep">|</span><span class="sb-source">已加载 ${total} 个音源，${ok} 个可用</span>`;
    }
  }

  // 音源上下文菜单
  async function showSourceContextMenu(src, idx, el) {
    const menuOverlay = document.createElement('div');
    menuOverlay.className = 'ctx-overlay';
    menuOverlay.innerHTML = `
      <div class="ctx-menu" role="menu" aria-label="${src.name} 操作菜单">
        <button class="ctx-item" role="menuitem" data-act="toggle">${src.enabled?'禁用':'启用'}</button>
        <button class="ctx-item" role="menuitem" data-act="check">刷新/检测</button>
        ${src.builtin?'':'<button class="ctx-item" role="menuitem" data-act="del">删除</button>'}
        <button class="ctx-item" role="menuitem" data-act="cancel">取消</button>
      </div>`;
    document.body.appendChild(menuOverlay);

    const items = $$('.ctx-item', menuOverlay);
    let curIdx = 0;
    items[0]?.focus();

    function closeCtx() { menuOverlay.remove(); el?.focus(); }

    menuOverlay.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        curIdx = curIdx < items.length - 1 ? curIdx + 1 : 0;
        items[curIdx].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        curIdx = curIdx > 0 ? curIdx - 1 : items.length - 1;
        items[curIdx].focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        execAction(items[curIdx].dataset.act);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeCtx();
      }
    });

    items.forEach((btn, i) => {
      btn.addEventListener('click', () => execAction(btn.dataset.act));
      btn.addEventListener('focus', () => { curIdx = i; });
    });

    async function execAction(act) {
      closeCtx();
      if (act === 'toggle') {
        src.enabled = !src.enabled;
        await api.source.setEnabled(src.id, src.enabled);
        renderAltPanel('source');
        announce(src.name + (src.enabled ? ' 已启用' : ' 已禁用'));
      } else if (act === 'check') {
        announce('正在检测 ' + src.name + '…');
        try {
          const res = await api.source.check(src.id);
          announce(src.name + (res.ok ? ' 检测通过' : ' 检测失败'));
        } catch (e) { announce(src.name + ' 检测失败'); }
      } else if (act === 'del') {
        await api.source.remove(src.id);
        state.sources.splice(idx, 1);
        renderAltPanel('source');
        announce('已删除：' + src.name);
      }
    }
  }

  // 导入音源菜单
  function showImportMenu() {
    const menuOverlay = document.createElement('div');
    menuOverlay.className = 'ctx-overlay';
    menuOverlay.innerHTML = `
      <div class="ctx-menu" role="menu" aria-label="导入音源">
        <button class="ctx-item" role="menuitem" data-act="url">网址导入</button>
        <button class="ctx-item" role="menuitem" data-act="file">本地导入</button>
        <button class="ctx-item" role="menuitem" data-act="cancel">取消</button>
      </div>`;
    document.body.appendChild(menuOverlay);

    const items = $$('.ctx-item', menuOverlay);
    let curIdx = 0;
    items[0]?.focus();

    function closeCtx() { menuOverlay.remove(); $('#srcImportBtn')?.focus(); }

    menuOverlay.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        curIdx = curIdx < items.length - 1 ? curIdx + 1 : 0;
        items[curIdx].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        curIdx = curIdx > 0 ? curIdx - 1 : items.length - 1;
        items[curIdx].focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        execAction(items[curIdx].dataset.act);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeCtx();
      }
    });

    items.forEach((btn, i) => {
      btn.addEventListener('click', () => execAction(btn.dataset.act));
      btn.addEventListener('focus', () => { curIdx = i; });
    });

    async function execAction(act) {
      closeCtx();
      if (act === 'url') {
        const url = window.prompt('音源链接');
        if (!url) return;
        const res = await api.source.importUrl(url);
        if (res.ok) { announce('导入成功：' + res.source.name); await loadSources(); renderAltPanel('source'); }
        else announce('导入失败：' + (res.error || '未知错误'));
      } else if (act === 'file') {
        const res = await api.source.importFile();
        if (res.ok) { announce('导入成功：' + res.source.name); await loadSources(); renderAltPanel('source'); }
        else announce('导入失败：' + (res.error || '未知错误'));
      }
    }
  }

  // ---------- 初始化 ----------
  async function init() {
    await loadSources();
    api.contextMenu.setPlaylists(state.playlists);
    // 启动后自动检测音源
    setTimeout(() => checkSources(), 2000);
  }

  init();
})();
