# 辰曦音乐 ChenXi Music

发烧级无障碍音乐播放器 · Windows · 深度适配争渡读屏

## 设计原则

- **极简主界面**：只有搜索框、平台筛选、类型筛选、搜索按钮
- **ALT 菜单**：所有功能（播放控制/队列/音质/音源/无障碍设置）收入 ALT 菜单
- **默认最高音质**：播放时自动协商各音源可获得的最高档位（Hi-Res > 无损 > 极品 > 标准）
- **完全适配争渡读屏**：UIA/MSAA 语义 + ZDSRAPI 独立语音通道 + 盲文点显器
- **不影响外观**：所有无障碍逻辑在后台，UI 保持清新灵动
- **发烧音质**：WASAPI 独占 bit-perfect + ASIO 直通 + DSD/MQA/Hi-Res
- **歌曲右键菜单**：参考网易云/QQ/酷狗等主流平台，含播放/收藏/下载/分享/歌词/详情等

## 项目结构

```
chenxi-music/
├── src/
│   ├── main/                    # 主进程
│   │   ├── main.js              # 入口，整合所有模块
│   │   ├── audio-engine.js      # 音频引擎 + 最高音质协商
│   │   ├── zdsr-bridge.js       # 争渡读屏 ZDSRAPI 桥接
│   │   ├── source-manager.js    # 音源管理 + LX脚本沙箱
│   │   ├── search-aggregator.js # 多平台搜索聚合
│   │   └── context-menu.js      # 歌曲右键上下文菜单
│   ├── preload/
│   │   └── preload.js           # 安全 IPC 桥接
│   └── renderer/                # 渲染层
│       ├── index.html           # 极简主界面
│       ├── assets/
│       │   ├── main.css         # 清新深色样式
│       │   └── app.js           # 交互逻辑
├── native/
│   ├── zdsr/                    # ZDSRAPI_x64.dll FFI 绑定
│   └── wasapi/                  # WASAPI/ASIO 原生引擎
└── package.json
```

## 启动开发

```bash
cd chenxi-music
npm install
npm start          # 生产模式
npm run dev        # 开发模式（打开DevTools）
```

## 无障碍架构

### 三层适配争渡读屏

1. **UIA/MSAA 语义层**：所有控件暴露 Name/Role/Value/Patterns
2. **ZDSRAPI 独立通道**：`InitTTS(1, "ChenXi", TRUE)` 开通独立语音通道，`Speak`/`StopSpeak`/`Braille` 主动播报
3. **键盘骨架**：ALT+P/Q/H/S/A 五组面板，Enter 播放，Menu 键右键菜单，P 键播报进度

### 关键快捷键

| 键 | 功能 |
|----|------|
| Alt | 打开 ALT 菜单 |
| Alt+P | 播放控制 |
| Alt+Q | 播放队列 |
| Alt+H | 音质设定 |
| Alt+S | 音源管理 |
| Alt+A | 无障碍设置 |
| Esc | 关闭菜单 |
| Enter | 播放选中 |
| Menu / 右键 | 歌曲上下文菜单 |
| P | 播报进度（焦点不在输入框时生效，避免拦截搜索输入） |
| MediaPlayPause | 播放/暂停 |

## 默认最高音质协商

播放时遍历所有已启用音源，按优先级 Hi-Res → Master → Atmos → FLAC24bit → FLAC → 320k → 192k → 128k 尝试，取首个可用的档位与对应的播放 URL。跨音源降级：某音源的最高档位 URL 失败时自动尝试其他音源的同档位，再降级。音质标识归一化覆盖 `24bit`/`flac24bit`/`hires`/`lossless`/`exhigh`/`standard` 等各种写法。降级时经争渡读屏独立通道播报原因。

右键菜单的「音质选择」子菜单动态收集当前歌曲平台在各已启用音源的可获得档位，选中后以该音质重新播放（覆盖默认最高音质协商）。

## 音源导入

- **网址导入**：LX 音源远程 URL（自动识别）或纯 API 接口，远程 URL 仅适配不内嵌
- **脚本导入 (.js)**：本地 LX Music 音源脚本，自动解析 @name/@version/@description 与 sources 声明
- **文件夹导入**：本地音频文件夹，递归扫描 FLAC/WAV/APE/DSD/MQA 等

已适配的 LX 音源脚本：
- 非常刀 v4
- 全豆要·聚合音源 v4.1
- 长青SVIP音源 v1.2.0
- 聆澜音源(赞助版) v7（远程 URL，仅适配）

## 歌曲右键上下文菜单

参照各大音乐平台功能构建：播放、下一首播放、添加到队列、添加到歌单、收藏、下载、分享（链接/文本/微信/QQ/卡片）、歌词、歌曲详情、查看歌手、查看专辑、音质选择、来源信息、复制歌名/链接/信息、设为铃声、均衡器适配、从列表移除。
