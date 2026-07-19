// native/wasapi/chenxi_audio.node - 原生WASAPI音频引擎存根
// 真实构建时用 C++/Rust 实现，编译为 .node 文件
// 此文件为 Electron 加载失败时的降级说明
//
// 实现要点：
// 1. WASAPI 独占模式：IMMDeviceEnumerator + IAudioClient Initialize with AUDCLNT_STREAMFLAGS_EVENTCALLBACK
// 2. ASIO 直通：通过 ASIO SDK 加载驱动
// 3. bit-perfect：不做任何重采样，源采样率原样输出
// 4. gapless：预加载下一曲到独立缓冲区，结束时无缝切换
// 5. ReplayGain：解析标签并应用增益
//
// 接口（通过 N-API 暴露给 Node.js）：
// class AudioEngine extends EventEmitter {
//   play(url: string, opts: {mode, gapless, replayGain}): Promise<void>
//   pause(): void
//   resume(): void
//   stop(): void
//   seek(seconds: number): void
//   setVolume(v: number): void  // 0-1，仅影响共享模式，独占模式为 bit-perfect 不调音量
//   setMode(mode: string): void
//   setGapless(on: boolean): void
//   preload(url: string): Promise<void>
//   events: 'position' (seconds), 'ended', 'error' (message)
// }
//
// 当此原生模块不存在时，audio-engine.js 自动降级到 HTMLAudioElement
// 降级模式下仍可正常播放，但无法实现 bit-perfect 与 WASAPI 独占

module.exports = null; // 占位，实际编译时替换为 .node 二进制
