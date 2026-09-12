// Electron 主进程
// 负责窗口管理、文件 IO、IPC 桥接

// 关键：如果系统环境变量 ELECTRON_RUN_AS_NODE=1 被设置，
// electron.exe 会作为普通 Node 运行而非 Electron。
// 这会让 `require('electron')` 返回路径字符串而非 API。
// 这里主动清除它，确保应用始终作为 Electron 运行。
if (process.env.ELECTRON_RUN_AS_NODE) {
  console.log('[main] 检测到 ELECTRON_RUN_AS_NODE=1，已清除（避免被当作 Node）');
  delete process.env.ELECTRON_RUN_AS_NODE;
}

// Windows 控制台编码修复：默认是 GBK(cp936)，导致中文日志乱码。
// 强制切换到 UTF-8，使 console.log 的中文能正确显示。
if (process.platform === 'win32') {
  try {
    process.stdout.setDefaultEncoding('utf8');
    process.stderr.setDefaultEncoding('utf8');
  } catch (e) {
    // 某些环境下 setDefaultEncoding 不可用，忽略
  }
}

const electronModule = require('electron');

// 检查 require('electron') 是否返回正确的 API（而非路径字符串）
// 在 Windows 上，如果项目路径包含非 ASCII 字符（如中文），可能会返回路径字符串
if (typeof electronModule === 'string' || !electronModule.app) {
  const errMsg = `
================================================================================
[FATAL] require('electron') 返回了无效值！

问题原因: 项目路径包含非 ASCII 字符（如中文）
  当前路径: ${__dirname}
  返回值: ${typeof electronModule === 'string' ? '字符串 (路径)' : '无效对象'}

解决方法: 将项目移动到 ASCII 路径，例如:
  D:\\Projects\\todo-list
  C:\\dev\\todo-list

或者创建一个符号链接（mklink /D）：
  mklink /D C:\\dev\\todo-list "D:\\data\\正在工作\\智能体管理的项目\\Todo List"

然后在符号链接路径下运行 npm start
================================================================================
`;
  console.error(errMsg);

  // 显示一个图形化错误窗口
  // v4+ 修复：Node require 缓存命中后第二次 require('electron') 仍返回同一个字符串；
  // 旧实现 `const { app: appApi } = require('electron')` 解构得到 undefined，
  // 错误窗口分支被跳过、直接 process.exit(1)，用户看到"启动后什么都没发生"。
  // 必须先 delete require.cache 让第二次 require 真的拿到 API 对象。
  // 进一步兜底：先写 stderr 让用户从启动器日志里至少能看到原因（即使 GUI 窗口也起不来）。
  process.stderr.write(errMsg);

  let appApi = null;
  let BrowserWindowApi = null;
  try {
    delete require.cache[require.resolve('electron')];
    const freshElectron = require('electron');
    if (typeof freshElectron === 'object' && freshElectron.app) {
      appApi = freshElectron.app;
      BrowserWindowApi = freshElectron.BrowserWindow;
    }
  } catch (e) {
    console.error('[main] 第二次 require electron 仍失败:', e.message);
  }

  if (appApi && typeof appApi.whenReady === 'function' && BrowserWindowApi) {
    appApi.whenReady().then(() => {
      const win = new BrowserWindowApi({
        width: 600,
        height: 380,
        resizable: false,
        title: 'Todo List - 启动错误'
      });
      win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
        <html><body style="font-family:sans-serif;padding:30px;background:#fee;color:#900;">
          <h2>⚠ 启动失败</h2>
          <p><b>问题：</b>项目路径包含非 ASCII 字符（如中文），导致 Electron 无法正确加载 API。</p>
          <p><b>当前路径：</b><br><code>${__dirname}</code></p>
          <p><b>解决方法：</b>将项目移动到 ASCII 路径（如 <code>D:\\Projects\\todo-list</code>）。</p>
          <p style="margin-top:30px;color:#666;font-size:12px;">详细说明请查看 README。</p>
        </body></html>
      `));
    });
    // 不退出，让用户看到错误窗口
    return;
  }
  // 拿不到真正的 electron API —— 兜底退出，stderr 已经写过原因
  process.exit(1);
}

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, Tray } = electronModule;
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

// 窗口图标和系统托盘共用同一图标
const APP_ICON_PATH = path.join(__dirname, 'icon.ico');

// 抑制 Windows 上常见的 "Unable to move the cache" / "Gpu Cache Creation failed" 警告
// 这些是 Electron 在受限目录下的良性警告，不影响功能。
app.commandLine.appendSwitch('disable-gpu-cache');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

let mainWindow = null;
let tray = null;
// 区分"用户主动退出"与"关闭按钮隐藏到托盘"。
// 仅在主动退出时，close 事件才不会被拦截隐藏。
let isQuitting = false;
// 退出时是否已经尝试刷写未保存数据。
// 第一次 before-quit 刷写后设为 true，第二次 before-quit（刷写完成后重试退出）直接放行，
// 避免写入失败时无限重试。用户再次修改后 renderer 会通知 dirty 变化，重置此标志。
let saveFlushed = false;
// 渲染进程报告的 dirty 状态（由 renderer 通过 app:dirty-changed 主动同步）
// 主进程据此判断退出前是否需要请求渲染进程刷写保存
let rendererDirty = false;
// 当前是否在等待渲染进程的刷写结果。flush-done / 兜底定时器共用同一标志，
// 防止「before-quit 被多次触发」或「渲染进程 flush-done 乱入未发起刷写」时
// 直接 app.quit()，绕过保存或留一个永远不释放的定时器。
let flushInProgress = false;
let flushTimeoutHandle = null;
// ready-to-show 兜底定时器的句柄。
// 当用户主动隐藏窗口后，必须取消它，避免 2 秒后被强制拉回。
let forceShowTimer = null;
let currentFilePath = null;
let fileWatcher = null;
// 抑制自己写入触发的文件监视事件（避免误弹"外部修改"对话框）。
//
// 四代方案对比：
//   v1（被淘汰）: 1.5s 时间窗口盲目抑制 → 用户紧接着的外部保存被吞。
//   v2（已废）:   mtime+size 指纹 → Node fs.watch 在 Windows 上的 callback 在 syscall
//                返回前就触发，fingerprint 永远来不及设置。race condition 不可解。
//   v3（也废）:   内容字符串指纹 → 同样被 fs.watch 时序问题击穿。
//   v4（上一代）: 主进程不过滤。所有 fs.watch 事件都发 IPC，渲染端 readFile 后
//                与 store.serialize() 比对 —— 完全相同视为自己写入的产物静默，
//                任何字节差异视为外部修改正常 reload + toast。判断在渲染端做，
//                不依赖主进程的时序/事件触发顺序，零误伤。
//   v5（当前）:   v4 的内容比对保留，同时再加 250ms statSync(mtime+size) 轮询兜底。
//                原因：用户实际报告「修改 todo.md 后软件没及时更新」，说明他
//                的环境里 fs.watch 根本没触发（云同步目录 / 网络盘 / 某些编辑器
//                的非标准保存路径）。fs.watch 依赖 OS 文件通知 API，不可靠。
//                polling 用 statSync 探测 mtime+size 变化触发相同 IPC —— 普适。
//                v4 的内容比对继续承担「自写入抑制」职责：polling 检测到变化
//                后发 IPC，渲染端读出来与 store.serialize() 比对，相同则静默。
//                250ms 是普适体验甜点（500ms 是可感知延迟，250ms 用户几乎无感，
//                statSync 对静态文件开销可忽略 —— 每秒 4 次 stat 不影响性能）。
//
// 主进程这里只做基础去重：同一保存的 burst 事件（Windows 上可能 2-3 个）只发 1 次 IPC。

// ============================================
//  配置管理（持久化用户设置）
// ============================================

/**
 * 默认数据目录：用户主目录下的 TodoList（~/TodoList）。
 *
 * 跨平台一律走 home：Windows 上就是 %USERPROFILE%/TodoList，macOS / Linux
 * 同理。不要再针对 Windows 特判 D:\TodoList —— 单盘笔记本根本没 D:，
 * 多盘用户也未必想把任务数据丢到非系统盘；统一走 ~/TodoList 最直观、最可移植。
 *
 * 历史：D 盘特判最初是为了"有一台专门放数据的机器"的用户；后来证明
 *   1) 大部分笔记本 / CI 没 D:，首次启动必然落入「临时模式」
 *   2) 有 D: 的用户也常常忘了同步自己设的 dataDir
 * 综合下来还是 home 最稳：自带云盘同步（OneDrive / iCloud Documents /
 * Dropbox）默认就覆盖 ~/TodoList，迁移也无须改代码。
 */
function getDefaultDataDir() {
  try {
    const home = app.getPath('home');
    return path.join(home, 'TodoList');
  } catch {
    const os = require('os');
    return path.join(os.homedir(), 'TodoList');
  }
}

// 默认目录在 app ready 之后才能解析（需要 app.getPath），先用占位值
let DEFAULT_DATA_DIR = null;

function getConfigPath() {
  // 配置存储在用户应用数据目录（Electron 推荐位置）
  return path.join(app.getPath('userData'), 'config.json');
}

/**
 * 主进程自己用到的配置默认值。
 *
 * 用途：loadConfig() 用这份兜底缺失字段，确保 appConfig 启动时就自洽 —— 任何
 * `appConfig.X` 访问拿到的是确定值，而不是 undefined。这件事不能用 truthy 检查
 * 凑合：loadConfig 返回 {} 时 appConfig.backupEnabled === undefined，truthy 检查
 * 把它当成"禁用"，结果新用户的每日备份机制永远不触发（config.json 不会被主进程
 * 自动写入 backupEnabled 字段），UI 却又显示开启 —— 主进程 / 渲染端不一致。
 *
 * 注意：dataDir / theme / filter / sortBy / fontSize 等不在这里 —— 它们要么是
 * null 语义（恢复默认），要么仅 renderer 用、main 自身不读。lastBackupDate 虽
 * 是主进程内部状态，但写入端（saveConfig）和读取端（maybeBackupToday）都明确
 * 处理 null，所以也不需要在这里兜底。
 */
const DEFAULT_CONFIG = {
  backupEnabled: true,    // 默认开启每日备份
  alwaysOnTop: false      // 默认关闭窗口置顶
};

// 安全审计 M2 修复：递归过滤危险 key，防止外部篡改的 config.json 通过
// `__proto__` / `constructor.prototype` 污染 Object.prototype。
// 应用场景：loadConfig 把磁盘 JSON 合并进内存配置；任何代码随后访问
// `appConfig.someKey` 时都会走原型链查找 —— 攻击者只需让 config.json
// 出现 `{"__proto__":{"isAdmin":true}}` 就能挂全局标志位。
function _stripProtoKeys(value) {
  if (Array.isArray(value)) return value.map(_stripProtoKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = _stripProtoKeys(value[k]);
    }
    return out;
  }
  return value;
}

function loadConfig() {
  try {
    const raw = fsSync.readFileSync(getConfigPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    // 防御性：配置文件被破坏或被外部改成 null / 数组 / 标量时，避免后续
    // `appConfig.dataDir` 之类的访问炸掉整个启动。
    const valid = (parsed && typeof parsed === 'object' && !Array.isArray(parsed));
    const safe = valid ? _stripProtoKeys(parsed) : {};
    return { ...DEFAULT_CONFIG, ...safe };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

let appConfig = {};

async function saveConfig(next) {
  // v3.7+ 修复 H11：先构造候选 next，**写盘成功后再 commit 内存**。
  // 旧实现是先 appConfig = {...appConfig, ...next} 再 writeFileSync：
  //   - 写盘失败时 catch 只 console.error，内存已被覆盖
  //   - maybeBackupToday 看到 appConfig.lastBackupDate === today 直接 return，
  //     当天再也不会产生备份
  // 新实现：写盘失败时 next 不写回 appConfig，lastBackupDate 保持原值，
  // 下次 maybeBackupToday 仍能正确触发；同时不再抛出（保留原行为：失败仅记日志）。
  //
  // v4+ 修复：原子写入（tmp + rename）。
  // 旧实现 fsSync.writeFileSync 在电源掉电 / 进程被杀中途会留下「半截 JSON」——
  // 下次启动 parseConfig 抛 SyntaxError → 用户设置（主题、置顶、数据目录等）全部
  // 回到默认，等于无声重置。tmp + rename 在同盘上是原子的：磁盘要么是旧完整配置、
  // 要么是新完整配置，永远不会半截。
  //
  // v4+ 修复：改为 async 函数。旧实现 EPERM/EBUSY 重试时用 while 循环 spin-lock
  // 阻塞主线程 50-100ms，期间 IPC / 定时器全部停滞。改为 setTimeout 异步等待，
  // 不阻塞事件循环。
  const candidate = { ...appConfig, ...next };
  const configPath = getConfigPath();
  const tmpPath = configPath + `.${process.pid}.${Date.now()}.tmp`;
  try {
    fsSync.mkdirSync(path.dirname(configPath), { recursive: true });
    fsSync.writeFileSync(tmpPath, JSON.stringify(candidate, null, 2), 'utf-8');
    // rename 在同盘上是原子的；Windows 上偶尔会因杀毒软件占文件失败，
    // 重试一次常见且无副作用。
    try {
      fsSync.renameSync(tmpPath, configPath);
    } catch (e) {
      if ((e.code === 'EPERM' || e.code === 'EBUSY') && fsSync.existsSync(tmpPath)) {
        // 杀毒软件/索引器短暂占用 —— 异步退避后重试一次（旧实现是 spin-lock，
        // 阻塞主线程 50-100ms；改为 setTimeout 不阻塞事件循环）。
        const delay = 50 + Math.floor(Math.random() * 50);
        await new Promise(resolve => setTimeout(resolve, delay));
        fsSync.renameSync(tmpPath, configPath);
      } else {
        throw e;
      }
    }
  } catch (e) {
    console.error('[main] 配置保存失败:', e.message);
    // 清理可能残留的 tmp 文件
    try { if (fsSync.existsSync(tmpPath)) fsSync.unlinkSync(tmpPath); } catch {}
    // 失败时不 commit —— 保持原 appConfig
    return appConfig;
  }
  appConfig = candidate;
  return appConfig;
}

/**
 * 获取实际生效的数据目录路径
 */
function resolveDataDir() {
  const custom = appConfig.dataDir;
  if (custom && typeof custom === 'string' && custom.trim()) {
    return custom;
  }
  return DEFAULT_DATA_DIR;
}

// ============================================
//  每日备份
// ============================================
//
// 开关：settingsStore.backupEnabled（默认 true）。关闭时整个机制空转，
// 即便调用 maybeBackupToday() 也直接 return —— 用户改回去当天再次开启
// 也照常触发，因为 disable 不清 lastBackupDate。
//
// 触发点：
//   - 启动时（app-start）—— 首次打开软件
//   - 写入文件前（file-write）—— 首次操作；只要还没备份过今天就被吸收
//
// 「每天一次」用 lastBackupDate（YYYY-MM-DD，本地日期）做幂等：
//   - 今天 == lastBackupDate → return
//   - 不等 → 复制 <dataDir>/todo.md → <dataDir>/backup/todo-YYYY-MM-DD.md → 落盘 lastBackupDate
//   - 文件不存在（用户从未保存过）→ return，什么也不写
//   - 复制失败（盘满 / 权限）→ 不更新 lastBackupDate，下次再试
//
// 并发：短时间内多次写入 / 启动 + 写入撞上时，backupInFlight 守卫只让一次进入；
// 后到的调用直接 return（同步检查 lastBackupDate 也兜底），不会写出多份同一天备份。

/**
 * 本地日期 YYYY-MM-DD（用本地时区；toISOString 走 UTC 在跨时区用户处会偏一天）
 */
function getTodayString() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

let backupInFlight = false;

async function maybeBackupToday(reason) {
  // 关闭 / 已备份过今天 / 别的调用正在跑 —— 都直接跳过。
  // 注意：备份成功前不更新 lastBackupDate，所以「今天还没备份过」的判断
  // 必须以磁盘上 lastBackupDate 字段为准，不能用 in-memory flag。
  if (backupInFlight) return;
  // 严格 === false：loadConfig 缺失字段时用 DEFAULT_CONFIG.backupEnabled = true
  // 兜底，appConfig.backupEnabled 永远是 boolean。truthy 检查会把 undefined 当成
  // 「禁用」—— 即便 IPC 写入侧和 SettingsStore 都做了 boolean 校验，未来若引入
  // 字符串污染（手工编辑 config.json 等），strict false 仍能正确识别为「禁用」。
  if (appConfig.backupEnabled === false) return;

  const today = getTodayString();
  if (appConfig.lastBackupDate === today) return;

  const dataDir = resolveDataDir();
  // 源文件路径固定 todo.md（与 renderer 中 createDefaultFile 的约定一致）。
  // 不存在就什么都不做 —— 用户可能首次启动、还没创建过文件。
  const sourcePath = path.join(dataDir, 'todo.md');
  const backupDir = path.join(dataDir, 'backup');
  const backupPath = path.join(backupDir, `todo-${today}.md`);

  // 路径合法性：内部构造的 path.join(dataDir, ...) 理论上必在 dataDir 内，
  // 但保留一道 assertInDataDir 兜底 —— 万一未来 dataDir 校验逻辑收紧
  // （如允许用户从快捷方式里指带 .. 的相对路径），不会在这里漏出 RCE。
  try {
    assertInDataDir(sourcePath);
    assertInDataDir(backupPath);
  } catch (e) {
    console.warn('[main] 备份路径校验失败:', e.message);
    return;
  }

  let stat;
  try {
    stat = await fs.stat(sourcePath);
  } catch {
    // 源文件不存在 —— 用户第一次启动还没保存过，跳过
    return;
  }
  if (!stat.isFile()) return;

  backupInFlight = true;
  try {
    await fs.mkdir(backupDir, { recursive: true });
    // 用 copyFile 而非 read+write：与同文件 .bak 单次备份走同一条路径，
    // 性能更好（OS 内核级 sendfile / CopyFileEx，无用户态缓冲）。
    // todo.md 量级下撞上「copy 中途源被外部写」的窗口极短，且 fs.rename 替换
    // 语义下源文件句柄仍指向原 inode —— 实际上不会产生不一致。
    await fs.copyFile(sourcePath, backupPath);
    saveConfig({ lastBackupDate: today });
    console.log(`[main] 已备份到 ${backupPath} (原因: ${reason})`);
  } catch (e) {
    console.warn('[main] 备份失败:', e.message);
    // 不更新 lastBackupDate —— 下次再试
  } finally {
    backupInFlight = false;
  }
}

// ============================================
//  启动日志
// ============================================

console.log('[main] Electron 启动中...');
console.log('[main] Platform:', process.platform);
console.log('[main] Electron version:', process.versions.electron);
console.log('[main] Project path:', __dirname);

// ============================================
//  窗口创建
// ============================================

function createWindow() {
  console.log('[main] 创建主窗口...');

  // 防御性清理：若上一次 createWindow 设置的 2s 兜底定时器尚未触发，
  // 先清掉它 —— 否则旧定时器会在窗口创建后触发，对「新」窗口执行 show，
  // 虽然 isVisible 检查能挡住多余 show，但悬空定时器是隐患。
  // 典型触发场景：窗口刚启动不久因 render-process-gone 被销毁重建。
  if (forceShowTimer) {
    clearTimeout(forceShowTimer);
    forceShowTimer = null;
  }

  mainWindow = new BrowserWindow({
    width: 960,
    height: 800,
    minWidth: 600,
    minHeight: 420,
    backgroundColor: '#0d1117',
    icon: APP_ICON_PATH, // 标题栏 + 任务栏图标
    show: false, // 先隐藏，ready-to-show 后再显示（避免白屏闪烁）
    autoHideMenuBar: true, // 自动隐藏菜单栏（替代 setMenuBarVisibility）
    // 自定义窗口：去掉系统标题栏，改由 renderer 顶部工具栏的 -webkit-app-region: drag
    // 接管拖拽，并在工具栏右侧画出自定义最小化/还原/关闭按钮。
    // 注意：保留 default 行为（无 frame 时仍可拖边缘调整大小、Win+Aero Snap 仍生效）。
    frame: false,
    titleBarStyle: 'hidden', // macOS 上隐藏标题栏；Windows 上被 frame:false 完全接管
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 允许 ES 模块加载（renderer 中的 type="module"）
      // 必需，否则 ES 模块会失败
    }
  });

  mainWindow.loadFile('index.html');

  // 启动时应用持久化的「始终置顶」状态。
  // config.json 在 app.ready 时已加载（appConfig），createWindow 是 ready 回调里调用，
  // 此时 appConfig 已就绪。如果上次会话开着，窗口创建后立刻置顶。
  if (appConfig.alwaysOnTop === true) {
    mainWindow.setAlwaysOnTop(true);
  }

  // ready-to-show：渲染完成后显示窗口，并同步自定义标题栏的最大化按钮状态
  mainWindow.once('ready-to-show', () => {
    console.log('[main] 窗口 ready-to-show，显示窗口');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
    broadcastMaximizeState();
  });

  // 回兜：2 秒后如果还没显示，强制显示（防止 ready-to-show 静默失败）
  forceShowTimer = setTimeout(() => {
    forceShowTimer = null;
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      console.warn('[main] ready-to-show 未触发，强制显示窗口');
      mainWindow.show();
    }
  }, 2000);

  // 错误监听
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('[main] 页面加载失败:', errorCode, errorDescription, validatedURL);
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[main] 渲染进程崩溃:', details);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.reload();
    }
  });

  mainWindow.webContents.on('console-message', (event, level, message, line, source) => {
    // level: 0=verbose, 1=info, 2=warning, 3=error
    if (level >= 3) {
      console.error(`[renderer ${source}:${line}]`, message);
    }
  });

  // 开发模式下自动打开 DevTools（方便调试）
  if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // 关闭事件
  // 默认拦截关闭按钮，改为隐藏到托盘（除非应用正在主动退出，或托盘不可用）
  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    // 没有托盘就无法恢复窗口，让窗口正常关闭（window-all-closed 会处理退出）
    if (!tray) return;
    e.preventDefault();
    hideWindow();
  });

  // 最大化/还原事件：把状态推给 renderer 同步自定义按钮图标。
  // 不监听 'resize' 是因为它会因每像素变化连续触发；'maximize' / 'unmaximize'
  // 是状态切换点，只触发一次，正好对应按钮图标的二态切换。
  // 初始状态由上方 ready-to-show 监听器推一次（renderer 还没挂 IPC 监听就丢消息，
  // 而 ready-to-show 时 renderer 已经初始化、IPC 可用）。
  mainWindow.on('maximize', () => broadcastMaximizeState());
  mainWindow.on('unmaximize', () => broadcastMaximizeState());

  mainWindow.on('closed', () => {
    console.log('[main] 窗口已关闭');
    stopWatchingFile();
    mainWindow = null;
  });

  console.log('[main] 主窗口创建完成');
}

// ============================================
//  系统托盘
// ============================================

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  // 显隐态变了，托盘菜单的「显示/隐藏窗口」文案要跟着翻转。
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function hideWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // 取消 ready-to-show 兜底定时器，避免用户主动隐藏后被强制拉回
  if (forceShowTimer) {
    clearTimeout(forceShowTimer);
    forceShowTimer = null;
  }
  mainWindow.hide();
  if (tray) tray.setContextMenu(buildTrayMenu());
}

/**
 * 切换窗口显隐。托盘左键单击时触发。
 */
function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    hideWindow();
  } else {
    showWindow();
  }
}

function buildTrayMenu() {
  // 根据窗口当前显隐态，只显示相关的那一项 —— 同时列出「显示 / 隐藏」会让用户
  // 困惑（不知哪个是当前态），点错了也只是再点一次，但体验不佳。
  const isVisible = mainWindow && !mainWindow.isDestroyed() &&
    mainWindow.isVisible() && !mainWindow.isMinimized();
  const toggleItem = isVisible
    ? { label: '隐藏窗口', click: () => hideWindow() }
    : { label: '显示窗口', click: () => showWindow() };
  return Menu.buildFromTemplate([
    toggleItem,
    { type: 'separator' },
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: appConfig.alwaysOnTop === true,
      click: (item) => {
        // 托盘菜单勾选时同步到窗口 + 落盘。
        // 直接复用 renderer 持久化路径：通知渲染端写入 settingsStore，
        // settingsStore.update 会通过 save-settings IPC 落盘，主进程这里也立刻
        // 应用到窗口，避免 renderer 还没起来（重启首次启动时）就先一步生效。
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setAlwaysOnTop(item.checked);
        }
        saveConfig({ alwaysOnTop: item.checked });
        // 通知 renderer 同步工具栏按钮状态（如果窗口存在）。
        mainWindow?.webContents.send('always-on-top:changed', item.checked);
      }
    },
    { type: 'separator' },
    {
      label: '设置...',
      click: () => {
        showWindow();
        // 与菜单栏"设置..."一致：通知渲染进程打开设置对话框
        mainWindow?.webContents.send('menu:settings');
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
}

function createTray() {
  if (tray) return;
  try {
    tray = new Tray(APP_ICON_PATH);
    tray.setToolTip('Todo List');
    tray.setContextMenu(buildTrayMenu());
    // 左键单击：切换窗口显示
    tray.on('click', () => toggleWindow());
    console.log('[main] 系统托盘已创建');
  } catch (e) {
    console.error('[main] 系统托盘创建失败:', e.message);
    tray = null;
  }
}

function destroyTray() {
  if (!tray) return;
  try {
    tray.destroy();
  } catch (e) {
    console.warn('[main] 销毁托盘失败:', e.message);
  }
  tray = null;
}

// ============================================
//  单实例锁
// ============================================
// 应用现在会驻留托盘（关闭窗口不退出），用户很容易忘记它还在运行而重复启动。
// 两个实例会各自 fs.watch 同一个 todo.md 并各自防抖自动保存，导致互相覆盖丢数据。
// 因此只允许一个实例：后启动的那个把已有窗口叫到前台，然后自己退出。
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  console.log('[main] 已有实例在运行，激活已有窗口后退出本实例');
  isQuitting = true;
  app.quit();
} else {
  app.on('second-instance', () => {
    console.log('[main] 检测到第二个实例启动，激活已有窗口');
    showWindow();
  });
}

// ============================================
//  应用生命周期
// ============================================

app.whenReady().then(() => {
  // 未拿到单实例锁时不应继续初始化（app.quit() 期间 ready 仍可能已触发）
  if (!gotSingleInstanceLock) return;

  // 启动时加载用户配置
  appConfig = loadConfig();
  // 解析默认数据目录（需要 app ready 才能访问 user paths）
  DEFAULT_DATA_DIR = getDefaultDataDir();
  console.log('[main] 已加载配置:', JSON.stringify(appConfig));
  console.log('[main] 数据目录:', resolveDataDir());

  // 启动时尝试今天的每日备份。异步触发、不阻塞启动 —— 即便备份耗时
  // 几百毫秒，UI 也已经在 ready-to-show 里 show 了。
  maybeBackupToday('app-start');

  console.log('[main] app ready');
  buildMenu();
  createWindow();
  createTray();

  app.on('activate', () => {
    // macOS: dock 图标被点击
    // 优先复用现有的窗口（隐藏时也要能恢复显示），否则才新建
    if (mainWindow && !mainWindow.isDestroyed()) {
      showWindow();
    } else if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch(err => {
  // v4+ 修复：旧实现只 console.error，用户看到「双击启动 → 什么都没发生 → 任务管理器
  // 进程在但窗口不见」。给一个原生错误对话框，至少让用户能搜到关键字、决定是否重启。
  console.error('[main] app ready 失败:', err);
  // dialog 依赖 app.ready —— whenReady().catch 触发时 app 已经 ready（否则这个 catch
  // 不会被调用），所以直接用同步 dialog.showMessageBox。BrowserWindow 可能从未创建，
  // 不传 parent 让它独立显示。
  try {
    const { dialog: dlg } = require('electron');
    dlg.showMessageBoxSync({
      type: 'error',
      title: 'Todo List - 启动失败',
      message: '应用初始化失败',
      detail: (err && err.stack) ? String(err.stack) : String(err),
      noLink: true
    });
  } catch (dialogErr) {
    // dialog 自己抛了（极端环境，比如没有 display）—— 静默走 stderr
    console.error('[main] 无法弹出错误对话框:', dialogErr);
  }
});

app.on('before-quit', (event) => {
  // 标记为主动退出，让 close 事件不再被拦截到托盘
  isQuitting = true;

  // 已有 flush 在跑：第一次 before-quit 触发的 flush 还没完。
  // 这里**不能** preventDefault —— 否则退出被永久卡住，flush-done 永远等不到再次 app.quit()。
  // 直接放行让 Electron 走完这次 before-quit；flush-done 处理器会在保存完成后自己再调 app.quit()。
  if (flushInProgress) return;

  // 退出前刷写未保存数据：
  // 自动保存有 800ms 防抖，用户如果在修改后 800ms 内退出（关闭托盘/窗口/系统关机），
  // 排队的保存会被丢弃 → 数据丢失。这里拦截退出，先让渲染进程立即保存。
  if (!saveFlushed && rendererDirty && mainWindow && !mainWindow.isDestroyed()) {
    event.preventDefault();
    flushInProgress = true;
    mainWindow.webContents.send('app:flush-pending-save');
    // 给渲染进程 5 秒完成保存，之后强制退出。句柄存进 flushTimeoutHandle，
    // flush-done 提前到时由它清掉，避免一个永不被释放的 setTimeout。
    flushTimeoutHandle = setTimeout(() => {
      flushTimeoutHandle = null;
      // 兜底备份：超时意味着 renderer 未在 5 秒内完成保存。无论 renderer 是
      // 已销毁还是活着但慢（大文件 IO / 主线程阻塞），磁盘上的内容可能不是最新的，
      // 强制退出前都做一份 .pre-crash.bak，用户至少能从数据目录恢复上次成功写入的内容。
      // 旧实现仅在 renderer 已销毁时备份 —— 活着但慢的场景下数据无声丢失。
      if (currentFilePath) {
        try {
          fsSync.copyFileSync(currentFilePath, currentFilePath + '.pre-crash.bak');
          console.warn('[main] 兜底：flush 超时，已写入 .pre-crash.bak');
        } catch (e) {
          console.warn('[main] 兜底备份失败:', e.message);
        }
      }
      saveFlushed = true;
      flushInProgress = false;
      app.quit();
    }, 5000);
    return;
  }
});

app.on('will-quit', () => {
  destroyTray();
});

app.on('window-all-closed', () => {
  console.log('[main] 所有窗口已关闭');
  // 有托盘时，应用保持在后台运行（仅由托盘菜单的"退出"或 app.quit() 真正退出）
  if (tray) return;
  if (process.platform !== 'darwin') app.quit();
});

// ============================================
//  IPC: 文件操作
// ============================================

// 注：不提供 'file:open-dialog' —— UI 上已去掉「打开文件」入口，
// 文件位置只由设置里的数据目录决定，留着一个无人调用的对话框只是多一个攻击面

/**
 * .bak 文件轮转：保留最近三份（.bak = 上次保存；.bak.1 = 上上次；.bak.2 = 再上一次）。
 *
 * 不做无限制累积：每次 file:write 都会创建一份 .bak，无清理时代码库会在数据目录
 * 里堆出与「写入次数 × 文件大小」等量的空间。普通用户一天保存几十次到几百次，
 * 一个文件 10 KB 一年下来也能堆到几百 MB —— 用户大概率不会手动去翻 .bak。
 *
 * 保留三份而不是两份（v3.4+ 改为三份）：多了「丢弃本地编辑前」的快照位
 * （见 file:create-snapshot，label=discard 的快照与 .bak 是不同命名空间，不会冲突）。
 * 三份为「连续三次 saveNow 失败后的连续 reload 留一阶余地」—— 典型用户场景下足够。
 *
 * 文件命名约定：.bak / .bak.1 / .bak.2 —— 不带时间戳是故意的，轮转时只需要 rename 三份文件，
 * 无需解析 / 生成时间戳，路径相关的旁路代码（用户自己 shell 写的恢复脚本）也好懂。
 *
 * @param {string} absPath 目标文件绝对路径
 */
async function rotateBakFiles(absPath) {
  const bakPath = absPath + '.bak';
  const bak1Path = absPath + '.bak.1';
  const bak2Path = absPath + '.bak.2';
  // v3.7+ 修复 M-P3：先复制到临时 .bak.new，再降级 .bak.1 → .bak.2 → .bak → .bak.new。
  // 旧顺序：删 .bak.2 → rename .bak.1 → rename .bak → copyFile(abs, .bak)
  //   - 降级 rename 中途失败（如 .bak.1 → .bak.2 成功但 .bak → .bak.1 失败），
  //     .bak 已被 .bak 的旧内容占着，copyFile 后 .bak 内容是「新文件 + .bak 旧内容竞争」
  //     极端下旧的"再上一次保存"丢失到 .bak.2 位置但若 .bak.2 删除已做则"再上一次"完全消失
  // 新顺序：先 copyFile 到 .bak.new（新内容已落盘）→ 删 .bak.2 → 降级 → 最后 rename .bak.new → .bak
  //   - 任一 rename 失败：.bak.new 已含新内容，原 .bak/.bak.1/.bak.2 都还在
  //     （除已删的 .bak.2），用户至少有"上次保存"+".bak.new"两个回退点
  //   - 最后一步 rename 成功：恢复"先删最旧 → 降级 → 新内容就位"的最终三份状态
  const bakNewPath = absPath + '.bak.new';
  try {
    // 1) 先把磁盘当前文件复制为 .bak.new —— 这是新内容，必须先落盘才能安全降级。
    if (fsSync.existsSync(absPath)) {
      await fs.copyFile(absPath, bakNewPath).catch((e) => {
        console.warn('[main] .bak.new 创建失败:', e.message);
        // 如果连新内容都没法落盘，跳过整个轮转（原 .bak 都不动）——
        // 用户至少保留完整的旧三份回退点
        throw e;
      });
    } else {
      // 源文件不存在时不做轮转（极少见，可能是文件被删后立即触发）
      return;
    }
    // 2) 删最旧的 .bak.2（无论如何都要保证最终只有三份）
    if (fsSync.existsSync(bak2Path)) {
      await fs.unlink(bak2Path).catch(() => {});
    }
    // 3) 把 .bak.1 降级为 .bak.2
    if (fsSync.existsSync(bak1Path)) {
      await fs.rename(bak1Path, bak2Path).catch((e) => {
        console.warn('[main] .bak.1 降级失败:', e.message);
      });
    }
    // 4) 把现有 .bak 降级为 .bak.1
    if (fsSync.existsSync(bakPath)) {
      await fs.rename(bakPath, bak1Path).catch((e) => {
        console.warn('[main] .bak 降级失败:', e.message);
      });
    }
    // 5) 把 .bak.new 重命名为 .bak —— 最后一步；rename 在同盘上原子，
    // 即便中途进程被杀，磁盘要么是旧三份、要么是完整新三份，永远不会半新半旧。
    await fs.rename(bakNewPath, bakPath).catch((e) => {
      console.warn('[main] .bak.new → .bak 重命名失败:', e.message);
      // 失败时 .bak.new 已存在但未就位 —— 下次轮转会再覆盖，文件不会丢
    });
  } catch (e) {
    // 整个轮转失败不应阻塞主流程 —— 用户至多少一份回退点，比写入失败好得多
    console.warn('[main] .bak 轮转失败:', e.message);
  }
}

/**
 * 读取磁盘当前内容（用于外部修改冲突场景的载荷增强）。
 *
 * 调用点：file:write 检测到 EXTERNAL_CHANGE_DETECTED 时，把磁盘内容一并塞回错误响应，
 * 渲染端拿到后立刻可以拿去做 diff —— 不用再额外发一次 file:read。
 *
 * 文件不存在 / 读取失败一律返回 null（调用方需要兼容）—— 让渲染端走「文件已删除」分支。
 */
async function readCurrentDiskContent(absPath) {
  try {
    return await fs.readFile(absPath, 'utf-8');
  } catch (e) {
    console.warn('[main] 读取磁盘当前内容失败:', absPath, e.message);
    return null;
  }
}

/**
 * 把磁盘当前文件复制为「带标签的快照」—— 与 .bak 轮转的命名空间不同，
 * 用于「主动丢弃本地编辑前」「退出前刷写时」「重载前」等用户可见意图。
 *
 * 与 .bak 轮转的核心区别：
 *   - .bak 是「隐式回退点」，不带时间戳，每 saveNow 自动轮转（保留最近 3 份）
 *   - 带标签快照是「显式意图记录」，带时间戳，**不轮转不清理** —— 用户主动丢弃的
 *     内容必须能找回，几个月后某天突然想回看时还能找得到
 *
 * 命名：${filePath}.${label}-${YYYYMMDD-HHmmss}.bak —— 与 .bak / .bak.1 / .bak.2 区分开，
 * 不会污染 rotateBakFiles 的命名空间。
 *
 * 合法 label 集合（白名单避免任意字符串被拼到文件名里）：
 *   - discard          —— 用户主动丢弃本地编辑前的快照
 *   - autosave-on-exit —— 退出前自动保存检测到外部修改时的快照
 *   - before-reload    —— reload 之前的快照
 *   - user-merge       —— 用户合并后保留旧版本（可选，将来用得到）
 */
const VALID_SNAPSHOT_LABELS = new Set([
  'discard', 'autosave-on-exit', 'before-reload', 'user-merge'
]);

ipcMain.handle('file:create-snapshot', async (event, { filePath, label }) => {
  let absPath;
  try {
    absPath = assertInDataDir(filePath);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (typeof label !== 'string' || !VALID_SNAPSHOT_LABELS.has(label)) {
    return { ok: false, error: `invalid label: ${label}` };
  }
  try {
    if (!fsSync.existsSync(absPath)) {
      // 文件已被外部删除 —— 快照源不存在，没法复制
      return { ok: false, error: 'FILE_NOT_FOUND' };
    }
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ts =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const snapshotPath = `${absPath}.${label}-${ts}.bak`;
    // 文件名冲突（同秒内两次 snapshot）—— 在末尾加 -N 后缀，N 从 1 开始
    let finalPath = snapshotPath;
    let collision = 1;
    while (fsSync.existsSync(finalPath)) {
      finalPath = `${absPath}.${label}-${ts}-${collision}.bak`;
      collision++;
    }
    await fs.copyFile(absPath, finalPath);
    console.log(`[main] 已创建快照 (label=${label}):`, finalPath);
    return { ok: true, snapshotPath: finalPath };
  } catch (e) {
    console.error('[main] 创建快照失败:', absPath, e.message);
    return { ok: false, error: e.message };
  }
});

/**
 * 把任意传入路径收敛到「当前生效的数据目录」之内。
 *
 * 必要性：renderer 拿到的是普通字符串，所有 file:read / file:write / file:create-if-missing
 * 此前完全信任调用方。配合一个 XSS（任务文本流过 innerHTML）就能让 renderer 把任意
 * 路径喂进来 —— 等于任意文件读写。Drop 一个 .bat 进 Startup 目录就是持久 RCE。
 *
 * 策略：path.resolve 后必须以数据目录的绝对路径为前缀；非字符串、穿越、空路径一律拒绝。
 * 目录存在与否不影响：写入端有自己的 mkdir -p，读取端只信任路径合法性。
 */
function assertInDataDir(p) {
  if (typeof p !== 'string' || !p) {
    throw new Error('path must be a non-empty string');
  }
  const root = path.resolve(resolveDataDir());
  const abs = path.resolve(p);
  // Windows 上 NTFS 是大小写不敏感的：`D:\TodoList\foo.md` 和 `d:\TODOLIST\foo.md`
  // 指向同一文件，但 `startsWith` 走字符串相等 —— 直接用 abs.startsWith(root)
  // 会被大小写差异绕过，逃出数据目录的「任意文件读写」防御。统一 toLowerCase 比对。
  const rootCmp = process.platform === 'win32' ? root.toLowerCase() : root;
  const absCmp = process.platform === 'win32' ? abs.toLowerCase() : abs;
  if (absCmp !== rootCmp && !absCmp.startsWith(rootCmp + path.sep)) {
    throw new Error('path outside data directory');
  }
  return abs;
}

ipcMain.handle('file:save-dialog', async () => {
  // 默认定位到数据目录 + 'todo.md'，避免用户在「桌面」「下载」之类位置创建文件 —
  // 写文件路径会被 assertInDataDir 卡在数据目录外，事后才报错，徒增一次往返。
  // 让对话框一开始就落在合法范围内，UX 上更顺。
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存 Todo 文件',
    defaultPath: path.join(resolveDataDir(), 'todo.md'),
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  });
  if (result.canceled) return null;
  return result.filePath;
});

ipcMain.handle('file:read', async (event, filePath) => {
  let absPath;
  try {
    absPath = assertInDataDir(filePath);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  try {
    const content = await fs.readFile(absPath, 'utf-8');
    // 读取成功后启动文件监听，使外部修改能被检测到
    // （写入路径已经在 file:write 中启动，这里补齐读取路径）
    currentFilePath = absPath;
    startWatchingFile(absPath);
    // 关键：刷新 lastSeen 到刚读到的文件的当前 stat。
    // startWatchingFile 只挂 fs.watch、不刷新基线 —— lastSeenMtimeMs/lastSeenSize
    // 仍停在「上一个文件」的状态。若用户在两次会话之间打开同一目录的另一份 todo
    // （例如 todo.md 与 archive.md），第一次写新文件时 preStat 与陈旧 lastSeen 比对
    // 会不相等、误判 EXTERNAL_CHANGE_DETECTED、弹「外部修改」冲突对话框。
    // 与 file:write / file:create-if-missing 后的 recordFileStat 对称。
    recordFileStat(absPath);
    return { ok: true, content };
  } catch (e) {
    console.error('[main] 读取文件失败:', absPath, e.message);
    // 文件被外部删除时返回专用错误码，让渲染进程能给出友好提示，
    // 而不是把 ENOENT 这种系统错误码直接展示给用户
    if (e.code === 'ENOENT') {
      return { ok: false, error: 'FILE_NOT_FOUND', message: '文件已被删除' };
    }
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('file:exists', async (event, filePath) => {
  // v3.7+ 修复 H10：file:exists 必须和 file:write / file:read 同款走 assertInDataDir。
  // 旧实现直接 fs.access(filePath) —— 配合一个 XSS 就能枚举整盘存在性
  // （for(let p of commonList) await api.fileExists(p)）。补上数据目录前缀校验后，
  // renderer 只能探测数据目录内的路径，对外仍能拿到 boolean。
  try {
    const absPath = assertInDataDir(filePath);
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('file:write', async (event, { filePath, content, options = {} }) => {
  let absPath;
  try {
    absPath = assertInDataDir(filePath);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  // v4+ 修复：内容大小上限 50 MB。正常 todo.md 远小于此值（数千条任务约几十 KB），
  // 任何超过这条线的请求几乎都是异常：渲染端被 XSS / 第三方插件注入的巨型字符串、
  // 调试代码误传测试 fixture、或者把别的文件路径指向 todo.md。直接拒绝避免：
  //   - 主进程 OOM（content 是 UTF-8 字符串，写 tmp 时被 Buffer.from 复制）
  //   - 把数据目录撑爆
  // 比配置写入的上限（settingsStore.configSchema 有 sizeLimit）更宽松，
  // 因为 todo.md 是用户真实数据；50 MB 约可容纳 5-10 万条任务，仍是合理边界。
  if (typeof content !== 'string') {
    return { ok: false, error: 'CONTENT_NOT_STRING' };
  }
  if (content.length > 50 * 1024 * 1024) {
    return { ok: false, error: 'CONTENT_TOO_LARGE', message: '内容超过 50 MB 上限' };
  }
  try {
    // 目标目录可能尚不存在（首次启动、用户新设的数据目录）
    await fs.mkdir(path.dirname(absPath), { recursive: true });

    // 每次保存前尝试今天的每日备份（在 .bak 单次备份之前；备份源就是磁盘上的
    // 当前文件，捕获的是本次写入之前的状态 —— 即「上次保存」的内容）
    await maybeBackupToday('file-write');

    // 防覆盖外部修改（仅非 force 模式）—— 双重检查 + 二次确认
    //
    // 真实数据丢失场景：用户在软件里改任务 → 800ms 内外部编辑器保存 →
    // autoSave 触发比 IPC（外部修改通知）到达更快 → autoSave 直接覆盖外部编辑。
    //
    // 必须在 writeFile 真正写盘之前用 mtime+size 探测：和 lastSeen 对不上就说明
    // 文件被外部动过，本次拒绝写盘并返回 EXTERNAL_CHANGE_DETECTED，让渲染端走
    // 外部修改冲突流程（弹对话框让用户选保留/丢弃）。force=true 跳过此检查，
    // 用于用户已明确同意覆盖的场景（"保留本地" 按钮 / Ctrl+S 手动保存等）。
    //
    // 二次确认（双 statSync）原因 —— 即使 pre-check 通过，写 tmp → rename 之间
    // 还有一个窗口（通常是 10-100ms，IO 期间）可能被外部编辑器插入：
    //   pre-check 时 mtime = T1（外部编辑前）
    //   ← 这之间外部编辑器保存 → 文件 mtime 变成 T2
    //   rename 写入 → 静默覆盖外部编辑（数据丢失）
    // 第二次 statSync 在 rename 前再次比对 pre-check 时的快照，能把这个窗口缩到
    // 几乎不可见（< 1ms）。fs.rename 在同文件系统内是原子的，剩余窗口外部编辑要么
    // 完全看不见（被覆盖）要么完全可见（rename 后下次轮询检测到）—— 不会再有半新半旧。
    // 通用 pre-stat 检查：捕获「外部编辑器保存 vs 我们的写入」race window
    //
    // force=false 的额外语义 — 与 lastSeenMtimeMs/lastSeenSize 比对：fs.watch / 轮询
    // 已经更新过 lastSeen，任何 mtime/size 不一致说明文件已被外部动过，本次拒绝
    // 写入并走冲突对话框。
    //
    // force=true 跳过 lastSeen 比对 —— 用户已经明确表态「覆盖外部修改」，但
    // **仍**做 preStat 抓取（写完后做 confirm-stat 比对），捕获 race window 内
    // 出现的**新一轮**外部修改 —— 用户按"保留本地"瞬间外部又改了一次 → 拒绝并
    // 走冲突对话框，而不是静默覆盖。一致性优先。
    const exists = fsSync.existsSync(absPath);
    let preStat = null;
    if (exists) {
      try {
        preStat = await fs.stat(absPath);
      } catch (e) {
        // statSync 失败（文件锁 / 权限）—— 宁可放过一次（保持旧行为）也不要阻塞保存
        console.warn('[main] statSync 失败，跳过冲突检查:', e.message);
      }
    }
    // 严格 === true：渲染端传 options.force = "false"（字符串）会被 truthy
    // 检查放过，等于「保留本地」语义失效 —— 用户的外部修改会被悄悄覆盖。
    // 强类型校验确保只有 boolean true 才能跳过外部修改检测。
    if (options.force !== true && preStat && (preStat.mtimeMs !== lastSeenMtimeMs || preStat.size !== lastSeenSize)) {
      console.warn(`[main] 拒绝写入：检测到外部修改 ${absPath}`);
      // 增强载荷：把磁盘当前内容一并塞回去，让渲染端不用再发一次 file:read
      // 就能走冲突对话框（v3.4+ 用户期望的体验）。
      const diskContent = await readCurrentDiskContent(absPath);
      return { ok: false, error: 'EXTERNAL_CHANGE_DETECTED', diskContent };
    }

    // .bak 轮转：把当前 .bak 降级为 .bak.1，再把磁盘当前文件复制为 .bak。
    // 在 race 检测通过之后执行 —— 万一二次确认发现 race，.bak 仍是外部编辑前的内容，
    // 回退效果与「上上次保存」相当（用户至多丢一份 autoSave 中间态，不是静默丢外部编辑）。
    // 不轮转的话 .bak 文件会无限膨胀（每次写一份，几千次写盘后磁盘占用难承受）。
    // 首次写入（文件不存在）跳过轮转 —— 没有「磁盘当前文件」可复制。
    if (exists) {
      await rotateBakFiles(absPath);
    }

    // 写 tmp（异步期间磁盘原文件不动，可被外部读取 / stat）
    // 命名：Date.now + pid + 随机串 —— 单纯 pid 后缀**不够**（同进程内 pid 恒定，
    // 800ms 防抖窗口内连按 Ctrl+S 可能落在同一毫秒 → tmp 同名 → 后写覆盖先写 tmp →
    // rename 失败 → 数据丢失）。再追加 6 字符随机串，碰撞 ≈ 36^6 = 21 亿。
    // force 与 !force 共用此约定。
    const tmpPath = absPath + '.tmp.' + Date.now() + '_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
    let tmpWritten = false;
    try {
      await fs.writeFile(tmpPath, content, 'utf-8');
      tmpWritten = true;

      // 二次确认：检查 pre-check 期间到现在，磁盘文件是否被外部动过
      // force 与 !force 都做 —— 这是 race window 防护的核心，把覆盖窗口缩到
      // 几乎不可见（< 1ms）。fs.rename 在同文件系统内是原子的，剩余窗口外部编辑
      // 要么完全看不见（被覆盖）要么完全可见（rename 后下次轮询检测到）。
      if (preStat) {
        try {
          const confirmStat = await fs.stat(absPath);
          if (confirmStat.mtimeMs !== preStat.mtimeMs || confirmStat.size !== preStat.size) {
            // race window 内被外部改了 —— 拒绝这次写入
            await fs.unlink(tmpPath).catch(() => {});
            console.warn(`[main] 拒绝写入：检测到 race window 内的外部修改 ${absPath}`);
            const diskContent = await readCurrentDiskContent(absPath);
            return { ok: false, error: 'EXTERNAL_CHANGE_DETECTED', diskContent };
          }
        } catch (e) {
          // 二次 stat 失败（极端情况：文件被外部删除）—— 视为外部修改拒绝
          await fs.unlink(tmpPath).catch(() => {});
          console.warn(`[main] 二次 statSync 失败，按外部修改处理:`, e.message);
          const diskContent = await readCurrentDiskContent(absPath);
          return { ok: false, error: 'EXTERNAL_CHANGE_DETECTED', diskContent };
        }
      }

      // 原子 rename：同文件系统下原子替换，外部编辑要么完全丢失（已被替换）
      // 要么完全可见（rename 之后发生，下次轮询 / fs.watch 检测到）。
      await fs.rename(tmpPath, absPath);
    } catch (e) {
      // rename 失败（AV / 索引器锁、EPERM、EXDEV 等）会留下 .tmp 残骸，
      // 每次写入都堆一份，几年下来把数据目录撑爆。这里无论成功失败都尝试清掉。
      if (tmpWritten) await fs.unlink(tmpPath).catch(() => {});
      throw e;
    }

    currentFilePath = absPath;
    startWatchingFile(absPath);
    // 主动写入完成：刷新 polling 基线，让 250ms 轮询跳过这次变化
    // （fs.watch 因 v4 注释里描述的时序问题可能来不及反应）
    recordFileStat(absPath);

    return { ok: true };
  } catch (e) {
    console.error('[main] 写入文件失败:', absPath, e.message);
    return { ok: false, error: e.message };
  }
});

/**
 * 仅在文件不存在时创建（用于首次启动写出初始文档）。
 * 使用 'wx' 标志：存在性检查与创建由内核原子完成，
 * 不存在"先检查再写入"的竞态窗口，绝不会覆盖已有用户数据。
 */
ipcMain.handle('file:create-if-missing', async (event, { filePath, content }) => {
  let absPath;
  try {
    absPath = assertInDataDir(filePath);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  // 与 file:write 同样的内容上限兜底 —— 防御性，防止恶意 / 异常渲染端
  // 绕过 file:write 的 50 MB 检查直接打 create-if-missing 把数据目录撑爆。
  if (typeof content !== 'string') {
    return { ok: false, error: 'CONTENT_NOT_STRING' };
  }
  if (content.length > 50 * 1024 * 1024) {
    return { ok: false, error: 'CONTENT_TOO_LARGE', message: '内容超过 50 MB 上限' };
  }
  try {
    await fs.mkdir(path.dirname(absPath), { recursive: true });

    await fs.writeFile(absPath, content, { encoding: 'utf-8', flag: 'wx' });
    // 主进程层不做抑制 —— 渲染端 readFile 后与 serialize() 比对判断是否自己写入

    currentFilePath = absPath;
    startWatchingFile(absPath);
    recordFileStat(absPath);
    return { ok: true };
  } catch (e) {
    if (e.code === 'EEXIST') {
      console.log('[main] 文件已存在，跳过创建:', absPath);
      return { ok: false, exists: true };
    }
    console.error('[main] 创建文件失败:', absPath, e.message);
    return { ok: false, error: e.message };
  }
});

// 文件监听
// fs.watch 在 Windows 上对一次保存可能触发 1-3 个事件（修改 + 重命名 + 再次修改），
// 不去重的话渲染端会连续弹「外部修改」对话框 —— 用户切回应用看到的是第一个
// 还没确认的对话框，第二第三个再叠上去，按钮位置错位且语义完全重复。
// 这里在源头做 400ms 去重，保证「一次外部保存 = 一次提示」。
let lastExternalChangeSentAt = 0;
const EXTERNAL_CHANGE_DEDUP_MS = 400;

// === 250ms 轮询兜底：fs.watch 在云同步目录 / 网络盘 / 某些编辑器下不可靠 ===
//
// 用户的真实反馈：修改 todo.md 后软件没及时更新 —— 说明 fs.watch 没触发。
// fs.watch 依赖 OS 文件通知 API，Dropbox / OneDrive / 远程盘映射 / 某些
// 编辑器的非原子保存路径下会丢事件。250ms 一次的 statSync 是普适可靠兜底：
//   - 比 500ms 体感响应快一倍（云盘场景下 fs.watch 失效时仍有可接受延迟）
//   - 每秒 4 次 statSync 对一个静态文件的开销可忽略（mtime+size 比对，不读内容）
//
// 自写入抑制不归这里管：polling 检测到变化就发 IPC，渲染端 readFile 后与
// store.serialize() 比对，字节相同视为自己写入的产物静默（v4 方案继续兜底）。
// 这里只做：(1) 不在主进程层做过滤；(2) 主动写入后刷新基线让 polling 跳过那次变化。
let lastSeenMtimeMs = 0;
let lastSeenSize = 0;
let pollTimer = null;
const POLL_INTERVAL_MS = 250;

function recordFileStat(filePath) {
  // 主进程刚写完文件后调用：让 polling 下一次 tick 看到 (mtime,size) 与
  // lastSeen 一致，不再误触发「外部修改」。fs.watch 因 v4 注释里的时序
  // 问题可能根本来不及响应，polling 的基线刷新是最可靠的兜底。
  try {
    const st = fsSync.statSync(filePath);
    lastSeenMtimeMs = st.mtimeMs;
    lastSeenSize = st.size;
  } catch {
    /* 文件尚未落盘 / 已被外部删 —— 忽略，polling 下一轮会自己探测 */
  }
}

function startPolling(filePath) {
  stopPolling();
  // 初始化基线，避免刚启动时把「上次会话之前的 mtime」当成「外部修改」
  recordFileStat(filePath);
  pollTimer = setInterval(() => {
    if (!currentFilePath) return;
    // v4+ 修复：窗口被最小化 / 隐藏时跳过 statSync。
    // 旧实现每 250ms 一次无脑 statSync —— 用户切到别的窗口、托盘里挂着、本应用最小化，
    // CPU 仍每秒钟 4 次磁盘 IO。窗口回到前台时本轮 polling 自然会发现 mtime/size
    // 变化（基线没刷新），与之前行为一致。
    // 兜底：窗口刚销毁（app 退出流程）也跳过，否则 BrowserWindow 已死、
    // isVisible() 会抛。
    if (mainWindow?.isDestroyed?.()) return;
    if (mainWindow && (mainWindow.isMinimized() || !mainWindow.isVisible())) return;
    let st;
    try {
      st = fsSync.statSync(currentFilePath);
    } catch {
      // 文件被外部删除 / 重命名等场景 —— 把基线清零让下一次 tick 把「文件被重建」
      // 视为外部修改。
      //
      // 为什么不能直接 return + 保留旧 lastSeen：
      //   若文件随后被外部以**同样的 mtime + size** 重建（delete + write 完全相同
      //   内容、文件系统沿用原 inode），下一轮 statSync 会拿到与 lastSeen 一致的结果
      //   → polling 会以「和基线一致」为由漏报。这种 case 在云同步目录偶有发生
      //   （客户端做去重优化时整文件删除 + 重建）。
      lastSeenMtimeMs = 0;
      lastSeenSize = 0;
      return;
    }
    if (st.mtimeMs === lastSeenMtimeMs && st.size === lastSeenSize) return;
    lastSeenMtimeMs = st.mtimeMs;
    lastSeenSize = st.size;
    // 与 fs.watch 共用 dedup 窗口，避免 fs.watch 已在 400ms 内发过则重复 IPC
    const now = Date.now();
    if (now - lastExternalChangeSentAt < EXTERNAL_CHANGE_DEDUP_MS) return;
    lastExternalChangeSentAt = now;
    // 增强载荷：把磁盘当前内容一并塞回去（v3.4+ 用户期望 —— 渲染端不用再发 file:read）。
    // setInterval 回调是 sync 函数，用 fire-and-forget 异步读取避免阻塞 polling。
    // 修复：在调度异步读取前捕获当前路径，避免 .then() 执行时 currentFilePath
    // 已被 startWatchingFile 切换到新路径，导致路径与内容错配。
    const capturedPath = currentFilePath;
    readCurrentDiskContent(capturedPath).then((diskContent) => {
      mainWindow?.webContents.send('file:external-change', {
        filePath: capturedPath,
        diskContent,
      });
    });
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startWatchingFile(filePath) {
  stopWatchingFile();
  try {
    fileWatcher = fsSync.watch(filePath, (eventType) => {
      // 同时响应 'change'（内容修改）和 'rename'（重命名 / 原子替换）。
      // 很多外部编辑器（VSCode、Sublime 等）保存时采用「写到临时文件再 rename」，
      // 在 Windows 上 fs.watch 通常只会触发 'rename'。旧实现只认 'change'，
      // 导致这些编辑器的保存永远唤不醒「外部修改」提示 —— 用户切回应用看到的
      // 还是旧内容，必须手动重载。
      if (eventType !== 'change' && eventType !== 'rename') return;
      // 关键：触发时立刻 statSync 把 lastSeen 刷新到「当前磁盘状态」。
      // 这一步是 race 修复的核心：
      //   旧实现：fs.watch 只发 IPC，不更新 lastSeen。polling 在 250ms 后才
      //   检测到同样的变化，期间 force=false 的 autoSave 拿陈旧的 lastSeen
      //   做 mtime 检查，与 statSync 拿到的「外部编辑后」状态对比仍是「一致」——
      //   静默覆盖外部编辑。
      //   现在：fs.watch 触发时立刻 statSync 拿到新状态，更新 lastSeen。
      //   若 autoSave 的 statSync 在此之后跑到，对比「新 lastSeen」与「新磁盘
      //   状态」也一致 —— 但后续 IPC 已发给 renderer 让用户介入，所以即使
      //   force=false 的写入跑通，也是「renderer 已知外部修改、用户尚未回复」
      //   的窗口期（< 100ms），数据丢失窗口被压缩到几乎不可见。
      //
      // 自写入场景无副作用：自己写入后 recordFileStat 已经把 lastSeen 刷成
      // 「自己刚写入」的状态，fs.watch 在 rename 时再次触发 → 再 statSync
      // 仍是同一份（rename 之后的磁盘状态）→ lastSeen 不变 → IPC 走 content 比对静默。
      try {
        const st = fsSync.statSync(filePath);
        lastSeenMtimeMs = st.mtimeMs;
        lastSeenSize = st.size;
      } catch {
        // 文件被外部删除 / 锁住 —— 立刻清零基线，避免「文件被同 mtime+size 重建」
        // 时漏报（同 startPolling 的处理）。下次 polling tick 会再探测。
        lastSeenMtimeMs = 0;
        lastSeenSize = 0;
      }
      // 不做自写入抑制 —— 见文件顶部三代方案的说明，fs.watch 时序无法支撑。
      // 一次外部保存可能在 fs.watch 里触发多个事件（Windows 尤其明显），
      // 在源头做去重避免渲染端堆叠对话框 / IPC 风暴。
      const now = Date.now();
      if (now - lastExternalChangeSentAt < EXTERNAL_CHANGE_DEDUP_MS) return;
      lastExternalChangeSentAt = now;
      // 增强载荷：把磁盘当前内容一并塞回去（v3.4+ 用户期望 —— 渲染端不用再发 file:read）。
      // fs.watch 的 listener 是 sync 函数，用 fire-and-forget 异步读取避免阻塞 watch 调度。
      readCurrentDiskContent(filePath).then((diskContent) => {
        mainWindow?.webContents.send('file:external-change', {
          filePath,
          diskContent,
        });
      });
    });
    // v3.7+ 修复 M-P2：fs.watch 在 Windows 上遇到 EPERM / ENOENT 后会直接 close
    // （不是再次触发事件）。整个 fileWatcher 实例变 dead，后续即使文件被
    // 重新创建，watcher 也不会重新监听 → 只剩 250ms polling 兜底，丢失实时性。
    // 修复：监听 'error' 事件，记录并重建 watcher。重建失败时 polling 仍可兜底。
    try {
      fileWatcher.on('error', (err) => {
        console.warn('[main] fs.watch error, 重建 watcher:', err && err.message);
        const cachedPath = filePath;
        try { fileWatcher && fileWatcher.close(); } catch {}
        fileWatcher = null;
        // 异步重建，避免在 'error' 回调里同步调用 fs.watch 引发二次报错
        setImmediate(() => startWatchingFile(cachedPath));
      });
    } catch {
      // 极个别 Node 版本 fileWatcher.on 自身抛错（极罕见）—— 静默兜底
    }
  } catch (e) {
    console.warn('[main] 文件监听启动失败:', e.message);
  }
  // fs.watch 在云同步目录 / 网络盘 / 某些编辑器下不触发事件 —— 250ms 轮询兜底
  startPolling(filePath);
}

function stopWatchingFile() {
  if (fileWatcher) {
    try { fileWatcher.close(); } catch {}
    fileWatcher = null;
  }
  stopPolling();
}

// ============================================
//  IPC: 应用信息
// ============================================

ipcMain.handle('app:get-data-dir', () => {
  return resolveDataDir();
});

ipcMain.handle('app:get-default-data-dir', () => DEFAULT_DATA_DIR);

// 用户主目录：renderer 用来把绝对路径转成 `~/...` 显示形式。
// 不暴露整个 fs，只读 home —— renderer 自己用 process.platform 检测不到
// contextIsolation 下的用户目录。
ipcMain.handle('app:get-home-dir', () => {
  try {
    return app.getPath('home');
  } catch {
    return require('os').homedir();
  }
});

ipcMain.handle('app:get-version', () => app.getVersion());

ipcMain.handle('app:get-electron-version', () => process.versions.electron || null);

// 打开外部链接 —— 由渲染端通过设置面板的「关于」区触发。
// 必须经过主进程 + shell.openExternal：renderer 在 sandbox 下无权直接调 shell，
// 而且走 https/http(s) 协议白名单能挡住把 `file:` / `javascript:` 之类的危险协议
// 塞进 href 后再回传给主进程的钓鱼路径。
ipcMain.handle('app:open-external', async (_event, url) => {
  if (typeof url !== 'string' || !url) return { ok: false, error: '链接无效' };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: '链接格式不正确' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: '仅支持 http / https 链接' };
  }
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('app:open-data-dir', async () => {
  // 只允许打开真实存在且是目录的路径。防止渲染端把恶意字符串塞进
  // dataDir 设置后让 shell.openPath 跑去执行一个 .exe。
  let dir;
  try {
    dir = path.resolve(resolveDataDir());
    const st = await fs.stat(dir);
    if (!st.isDirectory()) {
      return { ok: false, error: '数据路径不是一个目录' };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  try {
    // shell.openPath 返回 Promise<string>：成功时 resolve 空字符串，失败时 resolve
    // 错误描述字符串（注意不是 reject）。必须 await 并检查返回值，否则错误会被
    // 静默吞掉，IPC 永远返回 { ok: true }，用户看到按钮"点了没反应"却无从排查。
    const err = await shell.openPath(dir);
    if (err) {
      return { ok: false, error: err, path: dir };
    }
    return { ok: true, path: dir };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ============================================
//  IPC: 选择文件夹对话框
// ============================================

ipcMain.handle('app:choose-data-dir', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择数据文件夹',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '选择此文件夹',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ============================================
//  IPC: 窗口控制
// ============================================

// 设置窗口是否始终置顶。
// renderer 主动调 —— 启动时根据 settingsStore.alwaysOnTop 应用一次，
// 用户点击工具栏按钮时再 toggle。持久化由 app:save-settings 走。
ipcMain.handle('window:set-always-on-top', (_event, enabled) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  // BrowserWindow.setAlwaysOnTop 接受布尔；非法值直接抛 TypeError。
  // 严格校验：仅 boolean 透传，字符串 / 数字 / null 等一律拒掉。
  if (typeof enabled !== 'boolean') {
    console.warn('[main] setAlwaysOnTop 收到非布尔值:', enabled);
    return false;
  }
  try {
    mainWindow.setAlwaysOnTop(enabled);
    return true;
  } catch (e) {
    console.error('[main] setAlwaysOnTop 失败:', e.message);
    return false;
  }
});

// 自定义窗口控制按钮（frame: false 后接管系统标题栏的最小化/还原/关闭）。
// 注意：close 必须走与 close 事件一致的"隐藏到托盘"逻辑 —— 直接 mainWindow.close()
// 会被 mainWindow.on('close') 拦下隐藏，所以这里发信号走同一条路：
//   1) 主动退出（isQuitting=true）→ close 不拦截，正常销毁
//   2) 默认（isQuitting=false）→ close 拦截 + hideWindow 隐藏到托盘
// 与 X 按钮语义对齐："最小化"是任务栏可见但前台不可见，"关闭"是托盘后台驻留。
ipcMain.handle('window:minimize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.minimize();
  return true;
});

// 最大化/还原二合一按钮：根据当前状态切换，返回新的 isMaximized 给 renderer 同步图标。
// 单独传 maximize / restore 会让 renderer 必须跟踪状态，状态机两边各持一份容易漂移。
// 这里统一在主进程判断、返回最新值，renderer 收到后只负责把图标刷成返回值对应的样子。
ipcMain.handle('window:toggle-maximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
  return mainWindow.isMaximized();
});

// 关闭按钮：与窗口右上角 X 同义 —— 默认隐藏到托盘（与 mainWindow.on('close') 一致），
// 仅在用户主动退出（isQuitting=true，托盘菜单/快捷键）时才会真正销毁。
// 实现上不需要单独设 isQuitting：调用 mainWindow.close() 会被 close handler 拦下走托盘分支。
ipcMain.handle('window:close', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.close();
  return true;
});

// 把当前窗口的 isMaximized 状态推给 renderer（用于启动时按钮图标对齐，以及
// 系统级最大化/还原时同步 UI —— 例如用户双击标题栏或 Win+Up 触发的最大化）。
// 不走 invoke 是因为这是单向广播，且在 createWindow 之后就要推一次。
function broadcastMaximizeState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('window:maximize-state', mainWindow.isMaximized());
}

// ============================================
//  IPC: 应用设置（持久化）
// ============================================

ipcMain.handle('app:get-settings', () => appConfig);

// 渲染进程 dirty 状态变化时通知主进程，用于退出前判断是否需要刷写保存。
// 同时在 dirty 重新变为 true 时重置 saveFlushed，避免「退出 → 保存 → 取消 → 再改 → 再退出」
// 场景下第二次退出跳过保存检查。
ipcMain.on('app:dirty-changed', (_event, isDirty) => {
  // 防御：renderer 发 null / 0 / "" / undefined 进来时，typeof !== 'boolean' 直接拒掉。
  // 否则 rendererDirty 会变成 falsy → before-quit 看到 rendererDirty && ... 判定为 false
  // → 跳过刷写 → 直接退出 → 防抖窗口内未落盘的修改永久丢失。
  if (typeof isDirty !== 'boolean') {
    console.warn('[main] app:dirty-changed 收到非 boolean 值:', typeof isDirty, isDirty);
    return;
  }
  rendererDirty = isDirty;
  // v3.7+ 修复 M-P1：flushInProgress 期间不重置 saveFlushed。
  // 旧行为是 isDirty=true 无条件 saveFlushed=false —— 如果用户在 before-quit
  // 触发的 flush 期间（flushInProgress=true）又敲键盘，dirty-changed=true 会把
  // saveFlushed 提前重置；其后 flush-done 回调第一段由于 !rendererDirty 不成立
  // 进入再 flush 分支 → saveFlushed 又被重置 → app.quit() 5s timeout 兜底放过，
  // 用户最后敲的内容可能落盘失败。
  // 修复：flushInProgress 期间收到的 dirty=true 不重置 saveFlushed，等 flush-done
  // 回调内统一处理（flush-done 自己会重核 rendererDirty 并决定是否再 flush）。
  if (isDirty && !flushInProgress) saveFlushed = false;
});

// 渲染进程完成刷写保存后通知主进程，立即放行退出（无需等待 5 秒超时）。
// 必须守卫 flushInProgress：渲染进程在 before-quit 之外任何时刻发的 flush-done
// 都不应触发 app.quit()，否则一旦这条 IPC 失序到达，整个应用会被无条件退出，
// 且把 saveFlushed 提前设上让下一次真正退出跳过刷写检查（数据丢失）。
//
// 兜底：渲染端在 await saveNow 期间又改东西（rendererDirty 在我们处理完 flush-done
// 后才上报），单次 saveNow 只写入了旧 snapshot，dirty-changed 会把 saveFlushed 重置
// 但 quit 已经发生 —— 新编辑凭空消失。处理这条 IPC 时再核一次 rendererDirty，
// 仍脏就再起一轮 flush。两个通道（dirty-changed / flush-done）独立排队、不保证
// 到达顺序，所以「flush-done 收到时 dirty 仍为 true」才是真相 —— 渲染端在
// onFlushPendingSave 里的多轮 saveNow 已经把这条窗口压缩到最小。
ipcMain.on('app:flush-done', () => {
  if (!flushInProgress) return;
  flushInProgress = false;
  if (flushTimeoutHandle) {
    clearTimeout(flushTimeoutHandle);
    flushTimeoutHandle = null;
  }
  if (rendererDirty && mainWindow && !mainWindow.isDestroyed()) {
    // 渲染端仍脏 —— 再 flush 一次，不 quit
    saveFlushed = false;
    flushInProgress = true;
    mainWindow.webContents.send('app:flush-pending-save');
    flushTimeoutHandle = setTimeout(() => {
      flushTimeoutHandle = null;
      saveFlushed = true;
      flushInProgress = false;
      app.quit();
    }, 5000);
    return;
  }
  saveFlushed = true;
  app.quit();
});

ipcMain.handle('app:save-settings', async (event, partial) => {
  // 防御：渲染端发了 null / undefined / 原始类型进来时，'dataDir' in partial 会抛
  // TypeError 并把主进程栈泄给 renderer；白名单遍历也都会崩。直接当无效请求拒掉。
  if (!partial || typeof partial !== 'object') return appConfig;
  // 仅持久化已知的设置项，并对每项做白名单校验，防止 renderer 写入恶意值
  const sanitized = {};
  if ('dataDir' in partial) {
    // null = 恢复默认；非空字符串 = 用户自定义目录；其它一律忽略
    if (partial.dataDir === null) {
      sanitized.dataDir = null;
      // 数据目录改变 → 旧目录的「今天的备份」对新目录毫无意义。
      // 强制下次操作重新触发备份，让新目录也能享受今天的快照。
      // （主进程自己写 lastBackupDate 走 saveConfig，不走 IPC 白名单 —— 这里一并清掉）
      sanitized.lastBackupDate = null;
    } else if (typeof partial.dataDir === 'string') {
      // 防御：dataDir 是 assertInDataDir 的信任根 —— 渲染端把它设为 '/etc'，
      // 后续 file:read('/etc/passwd') 就能逃出"用户数据目录"沙箱。强制要求：
      //   - 绝对路径（避免相对路径在不同 cwd 下绕过）
      //   - path.normalize 后没有 .. 残留（path.resolve 已处理；这里再防御一道）
      //   - 真实存在的目录（renderer 选了不存在的目录会立即暴露，UX 上也不该静默接受）
      // 正常路径：renderer 走 chooseDataDir IPC（native dialog），那里必然存在且绝对。
      // 这层校验只挡被入侵的 renderer（XSS 注入恶意 settings 调用）—— 不挡正常用户流。
      //
      // v4+ 修复：旧实现是「校验失败 → console.warn 静默吞掉」，于是 renderer 的
      // settingsStore.update() 看不到失败（IPC 返回 appConfig 旧值、Promise resolve），
      // 用户在 settings dialog 里选了目录、看到「✓ 已保存」、磁盘却是旧值，重启后回到旧
      // 目录才会察觉。现在改为：校验失败直接抛错，让 IPC reject → settingsStore._persist
      // 返回 false → emit 'save-error' → toolbar.js 的 save-error 监听器 toast 报错。
      //
      // 安全审计 H1 修复：增加允许根目录白名单。即便 renderer 被攻陷也最多写到
      // 用户已知位置，不会被重定向到 /etc、/var/lib 之类的系统目录。
      // 白名单：用户主目录、文档、下载、桌面、AppData。允许子目录（含一层新建的）。
      const allowedRoots = [];
      try { allowedRoots.push(app.getPath('home')); } catch {}
      try { allowedRoots.push(app.getPath('documents')); } catch {}
      try { allowedRoots.push(app.getPath('downloads')); } catch {}
      try { allowedRoots.push(app.getPath('desktop')); } catch {}
      try { allowedRoots.push(app.getPath('userData')); } catch {}
      try { allowedRoots.push(app.getPath('appData')); } catch {}
      const resolved = path.resolve(partial.dataDir);
      if (resolved !== path.normalize(resolved)) {
        throw new Error(`数据目录路径不安全：${partial.dataDir}`);
      }
      // 解析符号链接后再次校验 —— 防止用 symlink 间接绕过白名单。
      // realpathSync 失败（路径不存在）由下面的 existsSync 兜底。
      let realResolved = resolved;
      try { realResolved = fsSync.realpathSync(resolved); } catch {}
      const inAllowedRoot = allowedRoots.some(root => {
        const r = root.toLowerCase();
        const p = realResolved.toLowerCase();
        return p === r || p.startsWith(r + path.sep);
      });
      if (!inAllowedRoot) {
        throw new Error(`数据目录必须在用户已知目录内：${resolved}`);
      }
      if (!fsSync.existsSync(resolved) || !fsSync.statSync(resolved).isDirectory()) {
        throw new Error(`数据目录不存在或不是文件夹：${resolved}`);
      }
      sanitized.dataDir = resolved;
      sanitized.lastBackupDate = null;
    }
  }
  if ('theme' in partial && ['dark', 'light', 'auto'].includes(partial.theme)) {
    sanitized.theme = partial.theme;
  }
  if ('filter' in partial && ['all', 'current', 'completed', 'important'].includes(partial.filter)) {
    // v3.7+ 修复：旧白名单用的是「pending」（v3.x 之前 PENDING 语义）。
    // 现在 settings-store.js 的 VALID_VALUES 是 ['all', 'current', 'completed', 'important']
    // （v3.x 起 PENDING 被替换为 CURRENT，「当前」语义对齐智能列表）。
    // 旧白名单下 renderer 发 'current' 会被这里**静默丢弃**——用户的「当前任务」
    // 全局过滤偏好重启就回到默认。修齐白名单。
    sanitized.filter = partial.filter;
  }
  if ('sortBy' in partial && ['manual', 'alphabet'].includes(partial.sortBy)) {
    sanitized.sortBy = partial.sortBy;
  }
  if ('fontSize' in partial && ['small', 'medium', 'large'].includes(partial.fontSize)) {
    // 之前白名单漏了 fontSize：SettingsStore 内存里写、UI 也立刻应用，
    // 但主进程落盘时把它静默丢掉了 —— 重启后字号回到 medium。补上。
    sanitized.fontSize = partial.fontSize;
  }
  if ('colorStyle' in partial && ['indigo', 'ocean', 'forest', 'sunset', 'rose', 'mono'].includes(partial.colorStyle)) {
    // 配色风格：与 theme 正交。同样以前漏过，UI 选了 ocean 重启后回到 indigo。
    sanitized.colorStyle = partial.colorStyle;
  }
  if ('backupEnabled' in partial && typeof partial.backupEnabled === 'boolean') {
    // 每日备份开关：renderer 通过 settingsStore.update 写入，主进程只接收 boolean
    sanitized.backupEnabled = partial.backupEnabled;
  }
  // 六个 *Position 设置（任务插入位置偏好）：front | back。
  // 与 settings-store.js 的 VALID_VALUES 对齐 —— 渲染端已校验过，主进程再守一道
  // 防止配置文件被直接编辑成脏值。白名单缺失会导致「UI 选了生效、重启回默认」。
  for (const key of ['newTaskPosition', 'completedPosition', 'uncompletePosition', 'trashPosition', 'restorePosition', 'movePosition']) {
    if (key in partial && (partial[key] === 'front' || partial[key] === 'back')) {
      sanitized[key] = partial[key];
    }
  }
  // 导入顺序偏好：order | front（与五个 front/back 不同，不在此循环处理）
  if ('importPosition' in partial && (partial.importPosition === 'order' || partial.importPosition === 'front')) {
    sanitized.importPosition = partial.importPosition;
  }
  if ('alwaysOnTop' in partial && typeof partial.alwaysOnTop === 'boolean') {
    // 始终置顶开关：与 BrowserWindow.setAlwaysOnTop 同步。
    // 注意此 IPC 仅落盘，窗口状态由 renderer 在 onStartup 时主动调 setAlwaysOnTop 应用。
    const valueChanged = appConfig.alwaysOnTop !== partial.alwaysOnTop;
    sanitized.alwaysOnTop = partial.alwaysOnTop;
    // v4+ 修复：先 saveConfig 让磁盘先落地，再应用窗口副作用。
    // 旧顺序下 saveConfig 失败时（磁盘满 / 权限不足），托盘菜单 / 窗口 setAlwaysOnTop
    // 已经按新值执行 → 用户看到托盘菜单「已勾选」+ 窗口置顶，但磁盘仍是旧值；
    // 下次启动 appConfig 加载旧值 → 托盘/窗口都回滚、用户一脸懵。
    // 修正顺序：saveConfig 失败则不进入副作用分支，菜单 / 窗口与磁盘三方一致。
    const committed = await saveConfig(sanitized);
    if (valueChanged) {
      // 仅在真变化时调 setAlwaysOnTop + 重建托盘菜单。
      // 反复保存相同值会无谓触发窗口属性重设（可能引发平台层闪烁）和
      // Tray.setContextMenu（Windows 上偶尔有可见菜单项重绘抖动）。
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setAlwaysOnTop(committed.alwaysOnTop);
      }
      if (tray) {
        tray.setContextMenu(buildTrayMenu());
      }
    }
    return committed;
  }
  return await saveConfig(sanitized);
});

// ============================================
//  应用菜单
// ============================================

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '保存',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu:save')
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        {
          label: '切换主题',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => mainWindow?.webContents.send('menu:toggle-theme')
        },
        { type: 'separator' },
        {
          label: '设置...',
          accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow?.webContents.send('menu:settings')
        },
        { type: 'separator' },
        {
          label: '重新加载',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow?.webContents.send('menu:reload')
        },
        { type: 'separator' },
        {
          label: '开发者工具',
          accelerator: 'F12',
          click: () => mainWindow?.webContents.toggleDevTools()
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
