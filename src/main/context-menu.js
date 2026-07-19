// src/main/context-menu.js
// 辰曦音乐歌曲右键上下文菜单 - 参考各大音乐平台功能构建
// 完全无障碍：每项都有 UIA Name/Role，争渡读屏可朗读可操作

const { Menu, ipcMain } = require('electron');

// 参考网易云/QQ音乐/酷狗/Apple Music 的歌曲右键菜单功能
const CONTEXT_MENU_ITEMS = [
  { id: 'play', label: '播放', accelerator: 'Enter', role: 'primary' },
  { id: 'play-next', label: '下一首播放', role: 'secondary' },
  { id: 'add-queue', label: '添加到播放队列', role: 'secondary' },
  { id: 'add-playlist', label: '添加到歌单', role: 'secondary', submenu: 'playlists' },
  { type: 'separator' },
  { id: 'favorite', label: '收藏', role: 'toggle', checkable: true },
  { id: 'download', label: '下载', role: 'secondary', submenu: 'quality' },
  { id: 'share', label: '分享', role: 'secondary', submenu: 'share' },
  { type: 'separator' },
  { id: 'lyrics', label: '查看歌词', role: 'secondary' },
  { id: 'song-detail', label: '歌曲详情', role: 'secondary' },
  { id: 'artist', label: '查看歌手', role: 'secondary' },
  { id: 'album', label: '查看专辑', role: 'secondary' },
  { type: 'separator' },
  { id: 'quality', label: '音质选择', role: 'secondary', submenu: 'quality' },
  { id: 'source-info', label: '来源信息', role: 'secondary' },
  { type: 'separator' },
  { id: 'copy-name', label: '复制歌名', role: 'utility' },
  { id: 'copy-link', label: '复制链接', role: 'utility' },
  { id: 'copy-info', label: '复制歌曲信息', role: 'utility' },
  { type: 'separator' },
  { id: 'ringtone', label: '设为铃声', role: 'utility' },
  { id: 'equalizer', label: '均衡器适配', role: 'utility' },
  { id: 'remove', label: '从列表移除', role: 'danger' }
];

class ContextMenuBuilder {
  constructor() {
    this.playlists = []; // 用户歌单
  }

  /**
   * 构建歌曲右键菜单
   * @param {Object} song - 歌曲信息
   * @param {Object} ctx - {isFavorite, inQueue, qualities, sources}
   */
  build(song, ctx = {}) {
    const template = [];

    for (const item of CONTEXT_MENU_ITEMS) {
      if (item.type === 'separator') {
        // 避免连续分隔符
        if (template.length && template[template.length - 1].type !== 'separator') {
          template.push({ type: 'separator' });
        }
        continue;
      }

      // 根据上下文过滤
      if (item.id === 'favorite' && ctx.isFavorite) {
        template.push({ label: '取消收藏', id: 'unfavorite', click: () => this._emit('unfavorite', song) });
        continue;
      }
      if (item.id === 'remove' && !ctx.inQueue) continue;

      const menuItem = {
        label: item.label,
        id: item.id
      };

      // 加速键（争渡读屏会朗读"快捷键 Enter"）
      if (item.accelerator) menuItem.accelerator = item.accelerator;

      // 复选状态
      if (item.checkable) {
        menuItem.type = 'checkbox';
        menuItem.checked = ctx.isFavorite || false;
      }

      // 子菜单
      if (item.submenu === 'playlists') {
        menuItem.submenu = this._buildPlaylistSubmenu(song);
      } else if (item.submenu === 'quality') {
        menuItem.submenu = this._buildQualitySubmenu(song, ctx.qualities || []);
      } else if (item.submenu === 'share') {
        menuItem.submenu = this._buildShareSubmenu(song);
      }

      // 点击回调
      if (!menuItem.submenu) {
        menuItem.click = () => this._emit(item.id, song);
      }

      template.push(menuItem);
    }

    // 去除末尾分隔符
    while (template.length && template[template.length - 1].type === 'separator') {
      template.pop();
    }

    return Menu.buildFromTemplate(template);
  }

  _buildPlaylistSubmenu(song) {
    const items = this.playlists.map(p => ({
      label: p.name,
      click: () => this._emit('add-to-playlist', { song, playlist: p })
    }));
    items.push({ type: 'separator' });
    items.push({
      label: '新建歌单…',
      click: () => this._emit('new-playlist', song)
    });
    return Menu.buildFromTemplate(items);
  }

  _buildQualitySubmenu(song, availableQualities) {
    const order = ['hires', 'master', 'atmos', 'flac24bit', 'flac', '320k', '192k', '128k'];
    const labels = {
      hires: 'Hi-Res', master: 'MQA Master', atmos: '杜比全景声',
      flac24bit: 'Hi-Res FLAC (24bit)', flac: '无损 FLAC (16bit)',
      '320k': '极品 320k', '192k': '高品 192k', '128k': '标准 128k'
    };
    const items = [];
    for (const q of order) {
      if (availableQualities.includes(q)) {
        items.push({
          label: labels[q] + (q === song.currentQuality ? ' ✓' : ''),
          type: 'radio',
          checked: q === song.currentQuality,
          click: () => this._emit('switch-quality', { song, quality: q })
        });
      }
    }
    if (!items.length) items.push({ label: '无可用音质', enabled: false });
    return Menu.buildFromTemplate(items);
  }

  _buildShareSubmenu(song) {
    return Menu.buildFromTemplate([
      { label: '复制分享链接', click: () => this._emit('share-link', song) },
      { label: '复制分享文本', click: () => this._emit('share-text', song) },
      { label: '分享到微信…', click: () => this._emit('share-wechat', song) },
      { label: '分享到QQ…', click: () => this._emit('share-qq', song) },
      { label: '生成分享卡片…', click: () => this._emit('share-card', song) }
    ]);
  }

  _emit(action, payload) {
    // 通知渲染层执行对应动作
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.getFocusedWindow();
    if (win) win.webContents.send('context-menu:action', { action, payload });
  }

  setPlaylists(list) { this.playlists = list; }

  registerIpc() {
    ipcMain.handle('ctx:show', (e, { song, context }) => {
      const win = require('electron').BrowserWindow.fromWebContents(e.sender);
      const menu = this.build(song, context);
      menu.popup(win);
      return { ok: true };
    });
    ipcMain.handle('ctx:set-playlists', (e, { playlists }) => {
      this.setPlaylists(playlists);
      return { ok: true };
    });
  }
}

module.exports = { ContextMenuBuilder, CONTEXT_MENU_ITEMS };
