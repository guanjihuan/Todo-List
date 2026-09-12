// 安全的 IPC 桥
// 通过 contextBridge 暴露最小化的 API 给渲染进程

const { contextBridge, ipcRenderer } = require('electron');

// 渲染端的 dev 模式开关 —— preload 跑在 Node 上下文，可以同步读 process.env / process.argv。
// 与 main.js:416 的 dev 检测同款条件（NODE_ENV=development 或 --dev 参数），保持单一事实来源。
// renderer 用它开关 [sync] 控制台日志（dev 模式打印、生产静默），不影响功能。
const IS_DEV = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

contextBridge.exposeInMainWorld('api', {
  // 同步字段：渲染端在打 [sync] 日志前用 window.api.isDev 判断，避免生产环境控制台噪音
  isDev: IS_DEV,
  // 文件操作
  // 注：不暴露「打开文件对话框」—— UI 上已去掉新建/打开文件的入口，
  // 文件位置只通过设置里的数据目录决定
  saveFileDialog: () => ipcRenderer.invoke('file:save-dialog'),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  // options.force = true 跳过主进程的"防覆盖外部修改"mtime 检查，
  // 用于用户已明确同意覆盖外部编辑的场景（"保留本地" 按钮 / 手动 Ctrl+S）。
  // 自动保存默认 force=false，被主进程拒绝时返回 EXTERNAL_CHANGE_DETECTED，
  // 由渲染端走冲突解决流程。
  writeFile: (filePath, content, options = {}) =>
    ipcRenderer.invoke('file:write', { filePath, content, options }),
  fileExists: (filePath) => ipcRenderer.invoke('file:exists', filePath),
  createFileIfMissing: (filePath, content) => ipcRenderer.invoke('file:create-if-missing', { filePath, content }),
  createSnapshot: (filePath, label) => ipcRenderer.invoke('file:create-snapshot', { filePath, label }),

  // 应用信息
  getDataDir: () => ipcRenderer.invoke('app:get-data-dir'),
  getDefaultDataDir: () => ipcRenderer.invoke('app:get-default-data-dir'),
  // 用户主目录 —— renderer 用来把绝对路径转成 `~/...` 显示形式。
  // 跟 getDataDir / getDefaultDataDir 配套（都是路径信息，权限边界一致）。
  getHomeDir: () => ipcRenderer.invoke('app:get-home-dir'),
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  getElectronVersion: () => ipcRenderer.invoke('app:get-electron-version'),
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  // 打开外部链接（设置面板「关于」区的开发者主页链接用）
  // 主进程端做协议白名单（仅 http / https），防 file: / javascript: 等危险协议
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),

  // 设置
  getSettings: () => ipcRenderer.invoke('app:get-settings'),
  saveSettings: (partial) => ipcRenderer.invoke('app:save-settings', partial),
  chooseDataDir: () => ipcRenderer.invoke('app:choose-data-dir'),

  // 退出前保存：通知主进程 dirty 状态变化、接收刷写指令
  notifyDirtyChanged: (isDirty) => ipcRenderer.send('app:dirty-changed', isDirty),
  notifyFlushDone: () => ipcRenderer.send('app:flush-done'),
  onFlushPendingSave: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('app:flush-pending-save', handler);
    return () => ipcRenderer.removeListener('app:flush-pending-save', handler);
  },

  // 事件监听（来自主进程）
  // 路由表：主进程菜单 / 快捷键 → 渲染端处理器。新增菜单项时**必须**同步加这里，
  // 否则 main.js 发了 IPC 渲染端却没人监听，菜单点击会静默无效（v4 调试记录）。
  onMenuCommand: (callback) => {
    const events = ['menu:save', 'menu:reload', 'menu:toggle-theme', 'menu:settings'];
    const handlers = events.map(name => {
      const handler = () => callback(name);
      ipcRenderer.on(name, handler);
      return { name, handler };
    });
    return () => handlers.forEach(({ name, handler }) => ipcRenderer.removeListener(name, handler));
  },

  onFileExternalChange: (callback) => {
    // 载荷从 string（filePath）升级为 {filePath, diskContent}（v3.4+ 增强）
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('file:external-change', handler);
    return () => ipcRenderer.removeListener('file:external-change', handler);
  },

  // 窗口控制
  // setAlwaysOnTop：立即应用置顶状态（不落盘，由调用方走 saveSettings 持久化）。
  // 返回 boolean 表示是否应用成功——主进程在窗口不存在/被销毁时返回 false。
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke('window:set-always-on-top', enabled),

  // 始终置顶状态变更通知（来自主进程，比如托盘菜单点击），
  // toolbar.js 订阅这个事件以同步按钮的激活态。
  onAlwaysOnTopChanged: (callback) => {
    const handler = (_event, enabled) => callback(enabled);
    ipcRenderer.on('always-on-top:changed', handler);
    return () => ipcRenderer.removeListener('always-on-top:changed', handler);
  },

  // 自定义窗口控制（frame: false 后接管系统标题栏）
  // minimizeWindow：最小化到任务栏
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  // toggleMaximizeWindow：在最大化/还原之间切换，返回新的 isMaximized 状态，
  // renderer 拿到返回值后只负责把按钮图标刷成对应样式，避免在 renderer 端维护状态副本。
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  // closeWindow：与窗口右上角 X 同义 —— 默认隐藏到托盘（除非用户主动退出）
  closeWindow: () => ipcRenderer.invoke('window:close'),

  // 窗口最大化状态变化通知（来自主进程 maximize / unmaximize / ready-to-show），
  // toolbar.js 订阅这个事件以同步按钮图标（最大化态 ↔ 还原态）。
  onMaximizeStateChanged: (callback) => {
    const handler = (_event, isMaximized) => callback(isMaximized);
    ipcRenderer.on('window:maximize-state', handler);
    return () => ipcRenderer.removeListener('window:maximize-state', handler);
  }
});
