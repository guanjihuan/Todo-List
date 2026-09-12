// 跨脚本共享：window.api 桩。
//
// 用途：TaskStore / SettingsStore 等模块在模块加载时读 window.api.*，没有 IPC
// preload 环境时直接抛 undefined。之前 4+ 个脚本各自复制一份 6 行 stub，
// 容易漏字段或拼写漂移。
//
// 用法：
//   import { installApiStub } from './_lib/api-stub.mjs';
//   installApiStub();              // 默认桩
//   installApiStub({              // 自定义部分方法
//     writeFile: async () => ({ ok: true }),
//   });
//   // 测试中要临时改某个方法：
//   globalThis.window.api.readFile = async () => ({ ok: true, content: '...' });

/**
 * 默认 stub：所有方法返回「无害成功」值，让 TaskStore / SettingsStore 不抛错。
 *
 * 默认实现按「最小可运行」原则写：writeFile/readFile 返回 {ok:true}，on* 返回
 * noop unsubscribe，notify* 返回 undefined。
 * 需要断言具体调用的脚本可以覆盖。
 */
export function installApiStub(overrides = {}) {
  globalThis.window = globalThis.window || {};
  const api = {
    // 文件 IO —— TaskStore._autoSave / file-* IPC 用
    writeFile: async () => ({ ok: true }),
    readFile: async () => ({ ok: true, content: '' }),
    fileExists: async () => true,
    createIfMissing: async () => ({ ok: true }),
    createSnapshot: async () => ({ ok: true, snapshotPath: '' }),

    // 事件订阅 —— on* 模式返回 unsubscribe
    onFileExternalChange: () => () => {},
    onMenuCommand: () => () => {},
    onFlushPendingSave: () => () => {},
    onAlwaysOnTopChanged: () => () => {},
    onMaximizeStateChanged: () => () => {},
    onDirtyChanged: () => () => {},

    // 单向通知 —— preload 提供给 renderer 主动调
    notifyDirtyChanged: () => {},
    notifyFlushDone: () => {},

    // 设置存储
    getSettings: async () => ({}),
    saveSettings: async () => ({}),

    // 窗口控制
    setAlwaysOnTop: async () => true,
    minimizeWindow: async () => true,
    toggleMaximizeWindow: async () => true,
    closeWindow: async () => true,

    // 应用信息
    getDataDir: async () => '',
    getDefaultDataDir: async () => '',
    getVersion: async () => '0.0.0-test',
    getElectronVersion: async () => null,

    ...overrides,
  };
  globalThis.window.api = api;
  return api;
}
