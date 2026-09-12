// 应用主入口 - 初始化所有模块并连接事件

import { TaskStore } from './task-store.js';
import { SettingsStore } from './settings-store.js';
import { Sidebar } from './ui/sidebar.js';
import { TaskList } from './ui/task-list.js';
import { Toolbar } from './ui/toolbar.js';
import { openCommandPalette } from './ui/command-palette.js';
import { toast, confirmDialog, inputDialog } from './ui/feedback.js';
import { openSettingsDialog } from './ui/settings-dialog.js';
import { openConflictDialog } from './ui/conflict-dialog.js';
import { parseMarkdown } from './markdown-parser.js';
import { shortenPath } from './utils/dom.js';
import { joinPath, pathsEqual } from './utils/path.js';
import { Filter, SortBy } from './task-store.js';
import { CategoryKind } from './markdown-parser.js';

// ============================================
//  启动检查
// ============================================

// bootstrap 阶段的 [renderer] 调试日志 —— 与 syncLog 同款：仅 dev 模式打印，
// 生产环境静默。开发时打开 DevTools 能看到完整启动流程（设置/数据目录/默认文件
// 路径/存在性），便于排查「为什么数据目录不对」「为什么没读出文件」这类问题；
// 生产环境这些细节对用户无意义，控制台干净点更好。
function rendererLog(...args) {
  if (!window.api?.isDev) return;
  console.log('[renderer]', ...args);
}

// 检查 window.api 是否已注入（preload.js 必须已运行）
if (!window.api || typeof window.api.getDataDir !== 'function') {
  const errorHtml = `
    <div style="padding:40px;font-family:sans-serif;color:#e6edf3;background:#0d1117;height:100vh;">
      <h1 style="color:#f85149">⚠ 初始化失败</h1>
      <p>preload.js 未正确加载，window.api 不可用。</p>
      <p style="color:#8d96a0;margin-top:16px">可能的原因：</p>
      <ul style="color:#8d96a0">
        <li>Electron 版本过低，不支持当前 preload 配置</li>
        <li>preload.js 路径配置错误</li>
        <li>安全策略（contextIsolation）配置错误</li>
      </ul>
      <p style="color:#8d96a0;margin-top:16px">请尝试重启应用，或运行 <code style="background:#161b22;padding:2px 6px;border-radius:4px">npm install</code> 后重试。</p>
    </div>
  `;
  document.body.innerHTML = errorHtml;
  throw new Error('window.api not available');
}

// ============================================
//  初始化
// ============================================

const settingsStore = new SettingsStore();
// 把 settingsStore 注入 TaskStore —— 让 _appendTaskWithPosition 能读到
// newTaskPosition / completedPosition / trashPosition 偏好。
// 不注入时 TaskStore 默认按 'front' 走（与 DEFAULT_SETTINGS 对齐），
// 但生产环境里 settingsStore 永远先创建出来，所以这里必须传，避免新加任务时
// 用错落点（追加到末尾而不是最新在最上）。
const store = new TaskStore({ settingsStore });

// H4 修复：全局未处理 IPC 拒绝兜底 —— 之前 settings-dialog / toolbar / sidebar
// 里大量 `await window.api.xxx().catch(console.warn)` 只打日志、不通知用户，
// 用户看到按钮「点了没反应」却无从知晓是 IPC 通道断了。
// 这里装一个 unhandledrejection 监听，吞掉那些没被业务方处理的拒绝，转成 toast
// 让用户至少知道「刚才那个动作失败了」。业务方已经在 catch 里 toast 的不会冒到这里。
if (typeof window !== 'undefined' && !window.__todoUnhandledRejectionInstalled) {
  window.__todoUnhandledRejectionInstalled = true;
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e && e.reason;
    const text = reason && (reason.message || reason.code || String(reason));
    // 过滤明显可忽略的拒绝（用户主动取消的对话框等）
    if (!text || /abort/i.test(text) || /user cancelled/i.test(text)) return;
    rendererLog('unhandledrejection:', text);
    toast(`操作失败：${text}`, 'error', 3000);
  });
}

// bootstrap 幂等守卫：模块可能因 HMR / devtools 重载被多次执行，
// 而 window.api.onXxx 返回的解绑函数此前从未被持有 —— 每次重跑都会再叠加
// 一份监听器，导致 'menu:save' 一类事件被处理两次（双重保存、双重 toast）。
let bootstrapped = false;

// ============================================
//  启动流程
// ============================================


// 模块级：bootstrap 注册的所有监听器的取消函数。
// 生产单例里不会被消费 —— renderer 进程与窗口同生死，window unload 时整个进程销毁，
// 不存在"跨生命周期需要解绑"的场景。Electron renderer 默认也没有 HMR（devtools
// reload 会重启整个进程）。这里只是统一收集 cancel 函数，**避免 HMR / 单元测试场景
// 后续真的有需要时再补 cleanup**。当前实现下，bootstrapUnsubs 是单纯 reference
// 池 —— push 而不读 —— 不会泄漏。
const bootstrapUnsubs = [];

/**
 * 取消 bootstrap 注册的所有监听器。仅供 hot-reload / 测试场景使用。
 * - 直接调每个 cancel 函数，不存在「取消一半」状态 —— 任意顺序都安全。
 * - cancel 后把池清零，再调 bootstrap() 会重新注册（重新走 reset 分支）。
 */
export function disposeBootstrap() {
  while (bootstrapUnsubs.length) {
    const fn = bootstrapUnsubs.pop();
    try { fn(); } catch (e) { console.error('[renderer] bootstrap dispose 异常:', e); }
  }
  bootstrapped = false;
}

async function bootstrap() {
  if (bootstrapped) {
    console.warn('[renderer] bootstrap 已在执行，跳过重复调用');
    return;
  }
  bootstrapped = true;
  rendererLog('bootstrap 开始');

  // 跟踪所有 bootstrap 注册的 store / IPC / DOM 监听器的取消函数。
  // 生产单例生命周期里不会被消费（renderer 与窗口同生死），
  // 但保留在 cleanupBootstrap() 给将来 hot-reload / 单元测试使用。
  // 直接调 cancel 即可，不存在「取消一半」状态 —— 任何顺序都能保证 listener 不再被触发。
  bootstrapUnsubs.length = 0; // 重置（万一 bootstrap 被以某种方式二次调用）

  try {
    // 加载设置（用户配置）
    await settingsStore.load();
    const settings = settingsStore.all;
    rendererLog('设置:', settings);

    // 应用主题
    const theme = settings.theme || 'dark';
    store.theme = theme;
    document.body.dataset.theme = store.resolveTheme();

    // 应用字体大小
    document.body.dataset.fontSize = settings.fontSize || 'medium';

    // 应用配色风格（与 theme 正交 —— 由 CSS 复合选择器解析，body 上只要一个 data 属性即可）
    document.body.dataset.colorStyle = settings.colorStyle || 'indigo';

    // 恢复全局过滤 / 排序偏好（在 UI 组件实例化之前设置，避免一次空渲染）
    // 这里直接赋值即可：setFilter/setSortBy 早于 UI 订阅，没有 UI 副作用
    if (Object.values(Filter).includes(settings.filter)) {
      store.filter = settings.filter;
    }
    if (Object.values(SortBy).includes(settings.sortBy)) {
      store.sortBy = settings.sortBy;
    }
    // 将后续 setFilter/setSortBy 的变更同步持久化（用户切换偏好后立即写入设置）
    bootstrapUnsubs.push(store.on('filter', (filter) => settingsStore.update({ filter })));
    bootstrapUnsubs.push(store.on('sort', (sortBy) => settingsStore.update({ sortBy })));

    // 监听设置变化（字体大小实时生效）
    bootstrapUnsubs.push(settingsStore.on('change', ({ changed }) => {
      if (changed.includes('fontSize')) {
        document.body.dataset.fontSize = settingsStore.get('fontSize');
      }
      // 配色风格由 settingsStore → body data 属性 → CSS 复合选择器解析；
      // 与 theme 一样只写一个属性即可，无需触发额外 JS 重新渲染
      if (changed.includes('colorStyle')) {
        document.body.dataset.colorStyle = settingsStore.get('colorStyle');
      }
    }));

    // v4+ 修复：**必须**在任何 file:read / file:write IPC 之前注册 file:external-change 监听。
    // 旧实现把这条 listener 注册放在 bootstrap 后段（line 289+）—— readFile 调用 main 进程
    // 立刻 startWatchingFile（main.js:902），但渲染端还没注册 listener，期间云同步 / 外部编辑器
    // 修改 todo.md 触发的 IPC 全部被吞，用户启动后看到的就是旧内容、也不会弹冲突对话框。
    // resolveExternalChangeConflict 自身已有 `!pathsEqual(...) return` 守卫（store.filePath
    // 未绑定前直接 return），所以这里可以安全地在 filePath 尚未赋值时就注册。
    bootstrapUnsubs.push(window.api.onFileExternalChange((payload) => {
      // 兼容旧实现可能仍然只发字符串
      const filePath = typeof payload === 'string' ? payload : payload?.filePath;
      const diskContent = typeof payload === 'object' ? payload?.diskContent : null;
      resolveExternalChangeConflict(filePath, { diskContent });
    }));

    // 决定初始文件（根据用户配置的数据目录）
    const dataDir = await window.api.getDataDir();
    rendererLog('数据目录:', dataDir);

    const defaultPath = joinPath(dataDir, 'todo.md');
    rendererLog('默认文件路径:', defaultPath);

    let filePath = null;
    let content = null;
    // 文件存在但读取失败 —— 必须与"文件不存在"区分开：
    // 前者绝不能写入初始文档，否则会覆盖掉读不出来的用户数据
    let readFailed = false;

    // 尝试加载默认文件
    try {
      const exists = await window.api.fileExists(defaultPath);
      rendererLog('默认文件存在:', exists);

      if (exists) {
        const result = await window.api.readFile(defaultPath);
        rendererLog('默认文件存在:', exists, '→ 读取结果:', result.ok);
        if (result.ok) {
          filePath = defaultPath;
          content = result.content;
        } else {
          readFailed = true;
          rendererLog('读取默认文件失败:', result.error);
        }
      }
    } catch (e) {
      readFailed = true;
      rendererLog('检查默认文件出错:', e.message);
    }

    // 加载到 Store
    if (content !== null) {
      // C1 修复：解析失败时自动回退到 .bak —— 旧实现只在 readFailed 路径报错，
      // 但 parseMarkdown 在「读成功 + 解析为空数组」或「解析抛错」路径上仍会让
      // 后续 autoSave 把损坏内容写回磁盘（覆盖掉可恢复的 .bak）。
      // 先尝试直接解析；失败 / 内容为空 → 退回 .bak；.bak 也失败才进入临时模式。
      try {
        store.loadFromContent(content, filePath);
        // 双重保险：parseMarkdown 返回空数组（极少但发生过：文件被外部工具清空、
        // 解析器漏抛）。空数组 + _ensureBaseStructure 会塞回默认 4 个子分类，
        // 下一次 save 直接覆盖磁盘。
        const cats = store.categories;
        const looksLegit = Array.isArray(cats) && cats.some(c =>
          c.tasks && c.tasks.length > 0);
        if (!looksLegit) {
          rendererLog('loadFromContent 后无任务，疑似解析失败 —— 尝试 .bak 回退');
          const bak = await tryReadBak(filePath);
          if (bak) {
            store.loadFromContent(bak, filePath);
            toast(`主文件疑似损坏，已从备份恢复`, 'warning', 4000);
          } else {
            toast(`主文件为空且无备份，进入临时模式`, 'warning', 4000);
            store.loadDefault(null);
          }
        } else {
          toast(`已加载：${shortenPath(filePath)}`, 'success', 1500);
        }
      } catch (e) {
        rendererLog('loadFromContent 抛错，尝试 .bak 回退:', e.message);
        const bak = await tryReadBak(filePath);
        if (bak) {
          store.loadFromContent(bak, filePath);
          toast(`主文件解析失败，已从备份恢复：${e.code || ''} ${e.message}`, 'warning', 4000);
        } else {
          store.loadDefault(null);
          toast(`主文件解析失败且无备份：${e.code || ''} ${e.message}`, 'error', 6000);
        }
      }
    } else if (readFailed) {
      // 读不出来（磁盘错误 / 权限拒绝） —— 尝试 .bak 回退；都没有才进入临时模式
      const bak = await tryReadBak(filePath || defaultPath);
      if (bak) {
        store.loadFromContent(bak, defaultPath);
        toast(`无法读取主文件，已从备份恢复`, 'warning', 4000);
      } else {
        // 只读入内存、不绑定路径，避免任何写入动作碰到那个文件
        store.loadDefault(null);
        toast(`无法读取 ${shortenPath(defaultPath)}，已进入临时模式。请检查该文件后重启，勿在此状态下保存`, 'error', 8000);
      }
    } else {
      // 确认不存在：写出一份初始文档，避免数据只存在于内存中
      await createDefaultFile(defaultPath, `已创建: ${shortenPath(defaultPath)}`);
    }

    // 初始化 UI 组件
    const toolbar = new Toolbar(store, settingsStore);
    const sidebar = new Sidebar(store);
    const taskList = new TaskList(store, { settingsStore });

    // 状态栏
    bootstrapUnsubs.push(setupStatusBar());

    // 监听 Store 状态变化
    // 职责划分：
    //   #status-text = 进度统计（由 setupStatusBar() 写），它已挂 'change' / 'load'
    //   #status-meta = 保存状态：未保存 / 已同步 HH:MM
    //                  （CSS ::before 已提供 6px 状态点，dirty/saved 切换颜色，
    //                   不要在文本里再加 ●/✓ 否则会和圆点重叠）
    // 旧实现：dirty 写 #status-meta，saved 写 #status-text，但 setupStatusBar 又把
    // 统计塞回 #status-meta —— 三方争抢同一格，渲染顺序决定谁最终胜出。
    //
    // 保存成功的事件顺序：emit('saved') → emit('dirty', false)。
    // 因此 dirty(false) 处理器不能再写 textContent=''，否则会立刻把刚刚
    // 写好的「已同步 HH:MM」时间戳抹掉 —— 用户看到的现象是「Ctrl+S 之后
    // 状态栏空空的，好像没保存过」。
    bootstrapUnsubs.push(store.on('dirty', (isDirty) => {
      const meta = document.getElementById('status-meta');
      if (isDirty) {
        // 只有进入「有未保存修改」时才覆写文本；离开时不动文本，
        // 把「已同步 HH:MM」留给 saved 处理器去维护
        meta.textContent = '未保存';
      }
      meta.classList.toggle('dirty', isDirty);
      meta.classList.toggle('saved', !isDirty);
      // 通知主进程 dirty 状态变化，用于退出时判断是否需要刷写保存
      window.api.notifyDirtyChanged(isDirty);
    }));
    bootstrapUnsubs.push(store.on('saved', () => {
      const meta = document.getElementById('status-meta');
      const t = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      meta.textContent = `已同步 ${t}`;
      meta.classList.remove('dirty');
      meta.classList.add('saved');
    }));
    // 重新加载文件后清掉旧的保存状态提示 —— loadFromContent / loadDefault
    // 内部 _suppressDirty=true 期间不会 emit dirty，外部修改监听也走这里
    // 重置状态栏；不重置会让上一秒保存的「已同步 14:32」看上去像新加载
    // 出来的内容也是「已同步」状态，误导用户
    bootstrapUnsubs.push(store.on('load', () => {
      const meta = document.getElementById('status-meta');
      meta.textContent = '';
      meta.classList.remove('dirty');
      meta.classList.remove('saved');
    }));

    // 保存失败：把错误抛给用户（之前完全无反馈，磁盘满/权限问题会让用户误以为
    // 「未保存」只是延迟）。EXTERNAL_CHANGE_DETECTED 由主进程 mtime 检查触发：
    // 自动保存试图覆盖一个被外部动过的文件 —— 这正是数据丢失防护的核心触发点，
    // 必须走冲突解决流程，而不是简单地 toast 一行「保存失败」就丢弃用户的修改。
    //
    // v3.4+：save-error 载荷升级为 {code, message, diskContent} 对象（见 task-store._buildSaveErrorPayload）。
    bootstrapUnsubs.push(store.on('save-error', (errorInfo) => {
      // 兼容旧实现可能仍然发字符串（防御性）
      const code = typeof errorInfo === 'string' ? errorInfo : errorInfo?.code;
      const message = typeof errorInfo === 'string'
        ? errorInfo
        : (errorInfo?.message || errorInfo?.code || '未知错误');
      const diskContent = typeof errorInfo === 'object' ? errorInfo?.diskContent : null;
      if (code === 'EXTERNAL_CHANGE_DETECTED') {
        // 防御性：save-error 触发时 store.filePath 应已绑定，但理论上未关联文件
        // （loadDefault(null) 模式）下走 autoSave 的极端路径也可能发出此事件。
        // 这种场景 pathsEqual(null, null) 会短路通过（a===b），随即 readFile(null)
        // 在主进程抛错 —— 提前拦截并 toast 跳过。
        if (!store.filePath) {
          toast('检测到外部修改冲突，但当前未关联文件 —— 已跳过自动保存', 'warning', 4000);
          return;
        }
        // 主进程已经塞了 diskContent —— 不用再发 file:read
        syncLog('autoSave-race-blocked', { filePath: store.filePath });
        resolveExternalChangeConflict(store.filePath, { diskContent, source: 'save-error' });
      } else {
        toast(`保存失败：${message}`, 'error', 4000);
      }
    }));

    // 退出前刷写：主进程在 before-quit 时发送此消息，渲染进程立即保存
    // 保存完成后通知主进程，主进程随即真正退出（避免等待 5 秒超时）
    //
    // 多轮 saveNow 直到真的没有 dirty —— 防止「await saveNow 期间用户又改了」：
    // saveNow 内部用 _dirtyVersion 在 await 后比对，若检测到中途改动会保留
    // dirty=true 让后续 autoSave 兜底，但 quit 流程下没有「后续」，必须自己再写。
    // 上限 5 轮：用户一直狂敲键盘时不死循环，让主进程的 5s 超时兜底。
    bootstrapUnsubs.push(window.api.onFlushPendingSave(async () => {
      // v4+ 修复（H-Critical）：
      //   1) saveNow() 可能 reject（IPC 异常 / EXTERNAL_CHANGE_DETECTED 等），
      //      必须 try/catch/finally 包裹，否则 notifyFlushDone 永不调用，
      //      主进程 5s 超时兜底后强制 app.quit() —— 未保存内容被静默吞掉。
      //   2) store.filePath === null 但 dirty=true 时（用户改了内容但还没保存到磁盘）
      //      旧循环条件 `&& store.filePath` 直接不进入，必须先弹 Save As 让用户
      //      选位置，否则循环结束后 notifyFlushDone、主进程退出 → 永久丢数据。
      try {
        if (store.dirty && !store.filePath) {
          // 退出流程触发 —— 弹原生 Save As 对话框
          const result = await window.api.saveFileDialog();
          if (result) {
            store.setFilePath(result);
          }
        }
        // 多轮 saveNow 直到真的没有 dirty —— 防止「await saveNow 期间用户又改了」：
        // saveNow 内部用 _dirtyVersion 在 await 后比对，若检测到中途改动会保留
        // dirty=true 让后续 autoSave 兜底，但 quit 流程下没有「后续」，必须自己再写。
        // 上限 5 轮：用户一直狂敲键盘时不死循环，让主进程的 5s 超时兜底。
        for (let i = 0; i < 5 && store.dirty && store.filePath; i++) {
          await store.saveNow();
        }
      } catch (e) {
        // 兜底：saveNow reject 时记录错误但仍通知主进程放行退出
        // —— 强制挂起主进程不会让数据凭空恢复，反而让用户以为"卡死"。
        console.error('[flush] saveNow 异常:', e);
      } finally {
        window.api.notifyFlushDone();
      }
    }));

    // 文件外部修改检测
    // 已在 bootstrap 前段（line 143）注册 onFileExternalChange 监听，
    // 这里**不再重复注册** —— 旧实现 line 302 是 v3 时期的 listener，
    // 注释里说"必须在 file:read 之前注册"已搬到 line 143，旧 listener 应删除。
    // 重复注册会导致每次外部修改 IPC 被处理两次（虽然 conflictDialogShowing
    // 守卫能挡住重复弹框，但 CPU 开销翻倍 + 未来若守卫改动会埋雷）。

    // 主进程菜单事件
    bootstrapUnsubs.push(window.api.onMenuCommand((cmd) => {
      switch (cmd) {
        case 'menu:save': handleSaveFile(); break;
        case 'menu:reload': handleReload(); break;
        case 'menu:toggle-theme': toggleTheme(); break;
        case 'menu:settings': openSettings(); break;
      }
    }));

    // 工具栏事件
    document.addEventListener('toolbar:toggle-theme', toggleTheme);
    document.addEventListener('toolbar:settings', openSettings);
    bootstrapUnsubs.push(
      () => document.removeEventListener('toolbar:toggle-theme', toggleTheme),
      () => document.removeEventListener('toolbar:settings', openSettings)
    );

    // Cmd/Ctrl+K 调起命令面板
    const onCmdK = (e) => {
      // 已经在命令面板 / 模态中就别再触发
      if (document.querySelector('.modal-overlay, .command-palette-overlay')) return;
      // H13-1: 在 input/textarea 里 Cmd+K 是某些编辑器的"删除到行尾"，
      // 不要拦截；让浏览器 / 编辑器按自己的语义处理。
      const isInEditable = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
      if (isInEditable) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        openCommandPaletteHandler();
      }
    };
    document.addEventListener('keydown', onCmdK);
    bootstrapUnsubs.push(() => document.removeEventListener('keydown', onCmdK));

    // 全局快捷键
    bootstrapUnsubs.push(setupGlobalShortcuts());

    // 监听系统主题变化（仅在 store.theme === 'auto' 时生效）
    const mm = window.matchMedia?.('(prefers-color-scheme: light)');
    if (mm && mm.addEventListener) {
      const onMm = () => {
        if (store.theme === 'auto') {
          document.body.dataset.theme = store.resolveTheme();
        }
      };
      mm.addEventListener('change', onMm);
      bootstrapUnsubs.push(() => mm.removeEventListener('change', onMm));
    }

    rendererLog('bootstrap 完成');
  } catch (err) {
    console.error('[renderer] bootstrap 失败:', err);
    toast(`启动失败：${err.message}`, 'error', 5000);
  }
}

// ============================================
//  外部修改冲突解决（共用：file:external-change + save-error 中的
//  EXTERNAL_CHANGE_DETECTED 两条入口都走这里）
// ============================================
//
// 同步事件开发日志 —— 仅在 dev 模式（window.api.isDev）打印，生产环境静默。
// 生产环境不应被这些 [sync] 日志污染控制台，但 dev 模式用户可以打开 DevTools
// 看完整的事件流，调试"为什么没同步 / 为什么弹了冲突对话框"。
//
// 关键事件：
//   - external-change-detected：file:external-change 或 saveNow EXTERNAL_CHANGE_DETECTED 触发
//   - conflict-dialog-opened / -resolved：用户在对话框里做出选择
//   - autoSave-race-blocked：自动保存被主进程 mtime/size 二次确认拦截
//   - reload-from-disk（手动 Cmd/Ctrl+R 或菜单触发）
function syncLog(event, payload) {
  if (!window.api?.isDev) return;
  if (payload !== undefined) {
    console.info(`[sync] ${event}`, payload);
  } else {
    console.info(`[sync] ${event}`);
  }
}
//
// 这条路径有两个触发点：
//   1) 主进程 fs.watch / 0.5 秒 polling 检测到文件被外部修改 → IPC 通知渲染端
//   2) 主进程 file:write 的 mtime 预检发现上次基线和当前文件状态不一致 →
//      自动保存被拒绝，save-error 携带 EXTERNAL_CHANGE_DETECTED
//
// 两条入口合并成一个函数，确保逻辑（取消 autoSave / 读取 / 比对 / 弹对话框）
// 永远一致 —— 任何一处修改都能自动惠及另一处。
//
// 「保留本地」分支调 store.saveNow() 内部 force=true：用户已明确表态要覆盖外部
// 修改，主进程的 mtime 保护不会拦截这次写入。
//
// 「重入守卫」conflictDialogShowing：fs.watch + polling 在外部保存时可能各发一次
// IPC，加上 save-error 触发的话 800ms 内可能连弹两三个对话框。在 await 期间记录
// 状态，后续调用直接 return，避免栈叠对话框。
//
// 防御性：try/catch 包住整个处理流程。理论上 finally 一定会执行，但若 confirmDialog
// 实现里同步抛错、或 _doResolveExternalChangeConflict 自身在 await 之外同步抛错，
// 没有这个 try/catch 会让标志位永久卡住 —— 之后所有外部修改都被吞，用户再也看不到
// 「文件被外部修改」提示。catch 里至少 console.error + 一次性 toast，flag 仍然释放。
let conflictDialogShowing = false;

async function resolveExternalChangeConflict(changedPath, options = {}) {
  // 路径比较必须平台感知：详见 pathsEqual 注释。
  // Windows 上 store.filePath 是 `D:/...`（joinPath）、changedPath 是 `D:\...`（path.resolve），
  // 直接 !== 会让所有外部修改静默被吞。
  if (!pathsEqual(changedPath, store.filePath)) return;
  if (conflictDialogShowing) return;
  conflictDialogShowing = true;
  syncLog('external-change-detected', { source: options.source || 'file:external-change' });
  try {
    return await _doResolveExternalChangeConflict(changedPath, options);
  } catch (err) {
    // 防御性：万一处理流程内部抛错，标志位仍要在 finally 里释放（下面的 finally
    // 保证），同时给用户一个可观察的反馈 —— 不要静默吞掉。
    console.error('[renderer] 外部修改冲突处理失败:', err);
    toast(`外部修改处理失败：${err.message || err}`, 'error', 4000);
  } finally {
    conflictDialogShowing = false;
  }
}

async function _doResolveExternalChangeConflict(changedPath, options = {}) {
  // 第一件事：让 in-flight 的自动保存「作废」。
  // 下面有 await，若不先作废，那条 writeFile 会在我们还在问用户的时候
  // 把内存内容盖回文件 —— 用户手工删掉的行原地复活，且毫无提示。
  // v4 全实时同步后没有 debounce 定时器可掐，只需让 in-flight 的代次过期：
  // 它的 await 回来时发现代次对不上、不复位 dirty、不发 saved 假象。
  store.cancelPendingSave();

  // ── 取磁盘当前内容 ──
  // 优先用主进程随 IPC 附带的 diskContent（onFileExternalChange / save-error 都带），
  // 避免再发一次 file:read —— 渲染端起步就是冲突流程时，主进程已经把内容塞过来。
  let diskContent = typeof options.diskContent === 'string' ? options.diskContent : null;
  let diskParseFailed = false;
  if (diskContent === null) {
    const result = await window.api.readFile(changedPath);
    if (!result.ok) {
      if (result.error === 'FILE_NOT_FOUND') {
        toast(result.message || '文件已被删除', 'error', 4000);
      } else {
        toast(`读取文件失败：${result.error}`, 'error', 4000);
      }
      return;
    }
    diskContent = result.content;
  }

  // 自写入抑制：磁盘内容与内存 serialize() 字节一致 → 是自己写入的产物（autoSave
  // 完成、reload 无变化）→ 静默。这是判断「这次保存是不是我们自己写入的」唯一可靠
  // 办法 —— 主进程层无法可靠做（fs.watch 在 Windows 上的 callback 时序不稳）。
  if (diskContent === store.serialize()) {
    return;
  }

  // ── 解析磁盘内容 ──
  let diskCategories;
  try {
    diskCategories = parseMarkdown(diskContent);
  } catch (e) {
    diskParseFailed = true;
  }

  if (!store.dirty) {
    // 本地没有未保存的改动 → 直接 reload（不弹冲突对话框 —— 没东西可冲突）
    //
    // UX 细节：loadFromContent 会触发整列重渲，用户的滚动位置与焦点任务会丢失
    // —— 云同步偶发触发自动 reload 时，视图跳到顶部 + 焦点跳到首条，体验像「被
    // 刷新了」。这里在 reload 前抓 scrollTop + 焦点任务的 task.id，render 完后
    // requestAnimationFrame 还原（render 是同步 DOM 重建，下一帧取元素已存在）。
    //
    // 滚动容器 = #task-list（task-list.js line 39 取这个 id，CSS 给它 overflow:auto）。
    // 焦点任务按 data-id 找回（task-list.js line 1040 给每条 <li> 设 data-id=task.id）。
    // 都允许 null —— 用户本来就没滚也没焦点就不还原。
    const scrollContainer = document.getElementById('task-list');
    const savedScrollTop = scrollContainer?.scrollTop;
    const focusedEl = document.activeElement;
    const savedTaskId = focusedEl?.dataset?.id || null;
    store.loadFromContent(diskContent, changedPath);
    if (savedScrollTop != null) {
      requestAnimationFrame(() => {
        const sc = document.getElementById('task-list');
        if (sc) sc.scrollTop = savedScrollTop;
      });
    }
    if (savedTaskId) {
      requestAnimationFrame(() => {
        // CSS.escape 兜底：万一 id 里含特殊字符（虽然现行实现 task.id 都是 nanoid 安全字符集）
        const el = document.querySelector(`#task-list [data-id="${CSS.escape(savedTaskId)}"]`);
        if (el && typeof el.focus === 'function') el.focus();
      });
    }
    if (!diskParseFailed) {
      toast('文件已在外部修改，已重新加载', 'info');
    }
    return;
  }

  // 本地有未保存的改动 + 解析成功 → 进入任务粒度合并对话框。
  // 解析失败（用户改了文件导致 markdown 结构损坏）→ 退化为传统二选一对话框，
  // 因为 diffWithDisk 拿不到有意义的 categories 数组。
  if (diskParseFailed) {
    await _fallbackConflictDialog(changedPath, diskContent);
    return;
  }

  // ── 任务粒度合并对话框 ──
  const diff = store.diffWithDisk(diskCategories);
  const defaultResolutions = store.defaultMergeResolutions(diff);

  // 把解析后的 categories 缓存到 store —— 用户在 dialog 里继续操作 UI 时可基于
  // 最新内存状态做增量 diff。dialog 关闭时清掉（避免常驻）。
  store.setDiskSnapshot({
    filePath: changedPath,
    content: diskContent,
    parsedCategories: diskCategories,
    fetchedAt: Date.now(),
  });

  // 抓 dialog **打开瞬间**的 dirty 快照 —— 用于关闭时检测"dialog 期间用户继续
  // 改了 UI"。这是 v4 全实时同步后唯一能捕获的场景：
  // 用户在 conflict-dialog 里挑勾选标记，但同时也想手动勾掉一条任务，点完"应用合并"
  // 后 → 这条新勾选的任务会被一起处理（自然合并）。但 keep-file 路径会**直接丢弃**
  // dialog 期间的改动，无声丢数据 —— 必须二级确认拦住。
  const dirtySnapshotBeforeDialog = store.getDirtySnapshot();

  let choice;
  try {
    choice = await openConflictDialog({
      diff,
      defaultResolutions,
      summary: diff.summary,
      // 头部"查看完整行级 diff"按钮要用 —— 注意这里 serialize() 在 dialog 打开期间会被
      // 用户在 UI 上的改动"自然更新"，但按钮点击是**打开后**的事件，diff 视图反映的
      // 是"用户当时看到的差异"，体验上最直观。
      diskContent,
      memoryText: store.serialize(),
    });
  } finally {
    store.clearDiskSnapshot();
  }

  if (!choice || choice.action === 'cancel') {
    syncLog('conflict-dialog-resolved', { action: 'cancel' });
    return; // 用户取消 —— 什么都不做（store 内容保持原样，但 dirty 仍为 true，会继续自动保存）
  }

  // ── Dialog 期间 dirty 检查 ──
  // 注意：apply / keep-mine 路径下 dialog 期间的 UI 改动**会**被保留（已经反映在
  // store.categories 里），只有 keep-file 会丢弃。但即便保留，仍希望用户明确知情
  // —— "你刚改了这些，我准备把它们一起处理掉"。这是显式优于隐式的取舍。
  const dirtyConfirmed = await _confirmDialogPeriodDirty(dirtySnapshotBeforeDialog, choice);
  if (!dirtyConfirmed) {
    syncLog('conflict-dialog-resolved', { action: 'cancel-at-dirty-confirm' });
    return;
  }
  syncLog('conflict-dialog-resolved', { action: choice.action });

  if (choice.action === 'apply') {
    // 应用用户的逐条选择：合并结果替换 categories 数组（mergeFromDisk 重排顺序 + 重分配 id）
    store.mergeFromDisk(diskCategories, choice.resolutions);
    // 立刻把合并结果写回磁盘 —— 让 store 与 diskContent 再次一致，避免下一次
    // fs.watch/polling 又把它当成「外部修改」发 IPC 进来
    const saved = await store.saveNow();
    if (saved) {
      toast('已应用合并并保存到磁盘', 'success');
    } else {
      toast('合并已应用，但保存失败 —— 请检查文件权限', 'error', 4000);
    }
    return;
  }

  if (choice.action === 'keep-mine') {
    // 用户明确选「全部用本地」 → 走 saveNow 把本地写回磁盘（force=true）
    const saved = await store.saveNow();
    if (saved) {
      toast('已保留本地版本并写入磁盘', 'success');
    } else {
      toast('本地版本保留失败 —— 请检查文件权限', 'error', 4000);
    }
    return;
  }

  if (choice.action === 'keep-file') {
    // 用户明确选「全部用文件」+ 丢弃本地 → **必须**先存 .discard-*.bak 快照再 reload。
    // 这是用户最容易误点的按钮，所以先把本地版本留底 —— 误操作后能找回。
    const snapResult = await window.api.createSnapshot(changedPath, 'discard');
    if (snapResult?.ok) {
      // 成功创建快照：把磁盘当前内容 load 进去（覆盖本地），并在 toast 提示快照路径
      store.loadFromContent(diskContent, changedPath);
      toast(
        `已采用文件版本 —— 你的本地修改已保存到:\n${snapResult.snapshotPath}`,
        'success',
        6000
      );
    } else {
      // 快照创建失败 → **不**直接丢弃本地（避免真的丢数据），改为提示用户手动备份
      const ok = await confirmDialog({
        title: '无法创建快照',
        message: '创建快照失败（' + (snapResult?.error || '未知错误') +
                 '），强行丢弃本地可能会丢失数据。\n\n' +
                 '是否仍然丢弃本地修改？\n（建议先点「取消」并手动备份 todo.md）',
        confirmText: '仍然丢弃',
        cancelText: '取消',
        danger: true,
      });
      if (ok) {
        store.loadFromContent(diskContent, changedPath);
        toast('已采用文件版本（未创建快照）', 'warning', 4000);
      }
      // 取消 → 什么都不做（保持原本地状态）
    }
    return;
  }
}

/**
 * 兜底冲突对话框（仅在磁盘 markdown 解析失败时使用）——
 * 这种情况下拿不到有意义的 categories 数组，退化为传统「重载 / 保留」二选一。
 *
 * @param {string} changedPath
 * @param {string} diskContent
 */
async function _fallbackConflictDialog(changedPath, diskContent) {
  const reload = await confirmDialog({
    title: '文件被外部修改',
    message: '文件被外部修改，但软件无法解析其中的内容（可能是 markdown 结构损坏）。\n\n' +
             '· 重新加载：采用文件里的内容，丢弃本地未保存的修改\n' +
             '· 保留本地：立刻保存本地内容，覆盖掉外部的修改',
    // M-S13: confirmDialog 默认是「确认」视觉。把"重新加载"标 danger=true
    // —— 该按钮的语义是"丢弃本地劳动、加载未知结构"，必须高亮红边框 + 红文字，
    // 让用户在按下前意识到这是不可逆操作。confirmText 同步改为「放弃本地修改
    // （重新加载）」，把动作后果写在按钮上避免被误点。
    confirmText: '放弃本地修改（重新加载）',
    cancelText: '保留本地',
    danger: true,
  });
  if (reload) {
    store.loadFromContent(diskContent, changedPath);
    toast('已采用文件版本', 'success');
  } else {
    // "保留本地"会直接 saveNow 覆盖外部修改 —— 万一用户后悔没有 .bak 可恢复。
    // 先创建一份带 autosave-on-exit 标签的快照，再 saveNow。toast 里展示路径，
    // 让用户知道"如果后悔可以找回"。
    const snapResult = await window.api.createSnapshot(changedPath, 'autosave-on-exit');
    const saved = await store.saveNow();
    if (saved) {
      const snapPath = snapResult?.snapshotPath
        ? `\n\n本地版本快照已保存到:\n${snapResult.snapshotPath}`
        : (snapResult?.error ? `\n\n（注意：创建快照失败 — ${snapResult.error}）` : '');
      toast('已保留本地版本并写入磁盘' + snapPath, 'success', 6000);
    } else {
      toast('本地版本保存失败', 'error', 4000);
    }
  }
}

/**
 * 检测用户在 conflict-dialog 打开期间是否对 UI 做了额外改动；
 * 若是 —— 在执行用户的最终选择前弹二级确认，避免静默丢失"边看对话框边改"的劳动。
 *
 * 三种选择的影响：
 *   - apply：mergeFromDisk 把 diskCategories 合进**当前** categories，dialog 期间的
 *     UI 改动天然保留。仍弹确认：让用户明确知情"我刚改了这些，将被一起合并"
 *   - keep-mine：saveNow 把当前 categories（含 UI 改动）写回磁盘，保留天然。
 *   - keep-file：loadFromContent 直接替换 categories —— **会**丢 UI 改动，danger=true
 *
 * @param {ReturnType<typeof store.getDirtySnapshot>} before - dialog 打开前
 * @param {{action: string}} choice - 用户的选择
 * @returns {Promise<boolean>} true = 继续执行 choice；false = 用户在二级确认里取消
 */
async function _confirmDialogPeriodDirty(before, choice) {
  // structuralOnly 的场景（仅兜底改动）算"无新改" —— 不是用户主动操作
  const after = store.getDirtySnapshot();
  if (after.structuralOnly && after.changeCount <= (before.changeCount || 0)) {
    return true;
  }
  const newTaskIds = [...after.taskIds].filter(id => !before.taskIds.has(id));
  const newCatNames = [...after.categoryNames].filter(n => !before.categoryNames.has(n));
  const newTaskCount = newTaskIds.length;
  const newCatCount = newCatNames.length;
  if (newTaskCount === 0 && newCatCount === 0) return true;

  // 构建已改项列表（不超过 6 条避免对话框撑爆）
  const allLines = [];
  for (const tid of newTaskIds.slice(0, 6)) {
    // 直接在 store.categories 里线性搜 —— dirty snapshot 只是 Set 不会按 id 建索引，
    // 而 conflict-dialog 期间 dirty 项一般很少（用户手动勾选/改文本不会超过十几条），
    // 线性扫一遍 O(categories × tasks) 完全够用。
    let label = tid;
    for (const cat of store.categories) {
      const t = (cat.tasks || []).find(x => x.id === tid);
      if (t) { label = t.text || tid; break; }
    }
    allLines.push(`  · 任务：${label.length > 30 ? label.slice(0, 30) + '…' : label}`);
  }
  for (const name of newCatNames.slice(0, 6)) {
    allLines.push(`  · 分类：${name}`);
  }
  if (newTaskIds.length > 6 || newCatNames.length > 6) {
    allLines.push(`  · …另有 ${Math.max(0, newTaskCount + newCatCount - 6)} 项改动`);
  }

  const actionLabel = {
    apply: '应用合并',
    'keep-mine': '全部用本地',
    'keep-file': '全部用文件（丢弃本地）',
  }[choice.action] || choice.action;

  const destructiveNote = choice.action === 'keep-file'
    ? '\n\n⚠ 「全部用文件」会丢弃本地改动（包括你在解决冲突期间做的）。'
    : '';

  const message =
    `你在解决冲突期间改了 ${(newTaskCount + newCatCount)} 项：\n` +
    allLines.join('\n') + '\n\n' +
    `当前选择：${actionLabel}${destructiveNote}\n\n` +
    `是否继续？`;

  const ok = await confirmDialog({
    title: '解决冲突期间有改动',
    message,
    confirmText: '继续',
    cancelText: '取消',
    danger: choice.action === 'keep-file',
  });
  if (!ok) {
    toast('已取消 —— 你的选择未生效', 'info');
    // 返回 false 让 _doResolveExternalChangeConflict 在外层提前 return，
    // 不再继续执行用户已取消的 apply/keep-mine/keep-file 路径。
    // 简单可靠 —— 无需特殊错误类型标记。
    return false;
  }
  return true;
}

async function openSettings() {
  // 若有未保存修改，先询问再开设置，避免用户改完配置才后悔
  if (store.dirty) {
    const ok = await confirmDialog({
      title: '存在未保存的修改',
      message: '当前文档有未保存的修改，打开设置前是否先保存？\n（也可继续 — 修改会保留在内存中）',
      confirmText: '保存并继续',
      cancelText: '继续打开'
    });
    if (ok) await handleSaveFile();
  }
  const result = await openSettingsDialog(settingsStore);
  if (result && result.changed) {
    // 数据目录已改变：如果还有未保存的改动，必须先警告。
    // reloadFromCurrentDataDir 会用新目录里的文件覆盖内存 —— 这意味着
    // 用户在旧目录文件里改完、还没保存的修改会被静默丢掉。
    // 这里给一次「取消」的机会，避免误点把辛苦编辑的内容送走。
    if (store.dirty) {
      const proceed = await confirmDialog({
        title: '切换数据目录会丢弃未保存的修改',
        message: '切换到新数据目录后，会加载新目录下的 todo.md 覆盖当前内存中的内容。\n\n' +
                 '当前还有未保存的修改 — 它们会被丢弃，且无法恢复。\n\n' +
                 '要继续切换吗？',
        confirmText: '继续切换',
        cancelText: '取消',
        danger: true
      });
      if (!proceed) {
        // 用户取消：不能再恢复旧目录设置（已落盘）—— 提示去设置里手动改回
        toast('数据目录设置已保存，但未切换加载。请重新打开设置改回原目录', 'info', 5000);
        return;
      }
    }
    // 数据目录已改变，重新加载默认文件
    toast('正在切换数据目录...', 'info', 1500);
    await reloadFromCurrentDataDir();
  }
}

async function reloadFromCurrentDataDir() {
  const dataDir = await window.api.getDataDir();
  const defaultPath = joinPath(dataDir, 'todo.md');

  let filePath = null;
  let content = null;
  let readFailed = false;
  try {
    if (await window.api.fileExists(defaultPath)) {
      const result = await window.api.readFile(defaultPath);
      if (result.ok) {
        filePath = defaultPath;
        content = result.content;
      } else {
        readFailed = true;
      }
    }
  } catch (e) {
    readFailed = true;
    console.warn('[renderer] 重新加载默认文件出错:', e.message);
  }

  if (content !== null) {
    store.loadFromContent(content, filePath);
    toast(`已切换到：${shortenPath(filePath)}`, 'success', 2000);
  } else if (readFailed) {
    store.loadDefault(null);
    toast(`无法读取 ${shortenPath(defaultPath)}，已进入临时模式，请勿在此状态下保存`, 'error', 8000);
  } else {
    await createDefaultFile(defaultPath, `已在新目录创建: ${shortenPath(defaultPath)}`);
  }
}

/**
 * 在指定路径写出一份初始文档并接管它。
 * 写入走 createFileIfMissing（内核级 'wx'），已存在则一定不会被覆盖。
 * 失败时退回内存模式（filePath 为 null），由用户手动另存为。
 */
/**
 * 尝试读取 .bak 备份 —— 用于 bootstrap 路径的 C1 修复：
 *   主文件解析抛错或内容为空时，退回到 .bak 给用户一份历史版本。
 *   返回内容字符串；读取失败返回 null。
 *
 * 注意：这里依赖 main.js 的备份旋转策略 —— 每次成功 saveNow 后 .bak 都同步更新，
 * 因此回退到的版本一定是最近一次成功保存的内容，不会有"太久远"的风险。
 */
async function tryReadBak(filePath) {
  if (!filePath) return null;
  try {
    const bakPath = filePath + '.bak';
    const result = await window.api.readFile(bakPath);
    if (result && result.ok && result.content) return result.content;
  } catch (e) {
    rendererLog('.bak 读取出错:', e.message);
  }
  return null;
}

async function createDefaultFile(targetPath, successMessage) {
  // 先不绑定路径：确认写入成功后再 setFilePath，避免自动保存抢在前面
  store.loadDefault(null);

  const result = await window.api.createFileIfMissing(targetPath, store.serialize());

  if (result.ok) {
    store.setFilePath(targetPath);
    toast(successMessage, 'success', 2000);
    return true;
  }

  // 竞态：检查之后、写入之前文件出现了（另一实例、外部工具）。
  // 内核挡下了这次写入，此处改为读取它 —— 用户数据优先于模板。
  if (result.exists) {
    const existing = await window.api.readFile(targetPath);
    if (existing.ok) {
      store.loadFromContent(existing.content, targetPath);
      toast(`已加载已有文件：${shortenPath(targetPath)}`, 'success', 2000);
      return true;
    }
    toast(`${shortenPath(targetPath)} 已存在但无法读取，已进入临时模式，请勿保存`, 'error', 8000);
    return false;
  }

  toast(`无法写入 ${shortenPath(targetPath)}，请用 Ctrl+S 另存为`, 'error', 4000);
  return false;
}

// ============================================
//  文件操作
// ============================================

async function handleSaveFile() {
  if (!store.filePath) {
    const result = await window.api.saveFileDialog();
    if (!result) return false;
    store.setFilePath(result);
  }
  const ok = await store.saveNow();
  // 保存失败时不再弹通用 toast —— saveNow 内部已发 'save-error' 事件，
  // toolbar.js 订阅的处理器会发详细错误（区分 EXTERNAL_CHANGE_DETECTED
  // / outside data directory / 普通 IO 错误）。这里再弹一次会和详细错误
  // 重复出现两个 toast，用户误以为是两个独立问题。
  // 例外：NO_FILE_PATH 时 saveNow 内部根本不发 'save-error'（已发了自己
  // 设计的）—— 上面 saveFileDialog 流程保证了 filePath 已被赋值，到这里
  // 不会再撞 NO_FILE_PATH；EXTERNAL_CHANGE_DETECTED 走 resolveExternalChangeConflict
  // 也是另起 toast，不依赖这里。
  return ok;
}

/**
 * 手动「立即重新加载」—— 菜单 / Cmd/Ctrl+R 触发。
 *
 * 与外部修改自动检测的区别：
 *   - 外部修改自动检测是**单向通知**（磁盘改了 → 通知用户），由 fs.watch / polling 触发
 *   - 手动 reload 是**用户主动拉取**，不依赖外部事件兜底 —— 万一 fs.watch + polling
 *     都漏了某个外部保存（云同步偶发 bug / 第三方编辑器非标准保存路径），用户可以
 *     主动拉一次磁盘状态对账
 *
 * 决策树：
 *   - 没有 filePath → 提示用户「未关联文件」（极早版本或异常清空）
 *   - 磁盘内容 == store.serialize() → toast「已是最新」，不做任何事
 *   - 磁盘内容 != 本地 && !dirty → 直接 loadFromContent（无冲突可处理）
 *   - 磁盘内容 != 本地 && dirty → 退到 confirmDialog 让用户二选一：
 *     · 重新加载 → 先创建 .discard 快照再覆盖
 *     · 保留本地 → saveNow(force=true) 覆盖磁盘
 *
 * 注意：与外部修改自动检测**互不触发**——这里走 `cancelPendingSave` 后读磁盘，
 * 不会再走 resolveExternalChangeConflict（避免双弹冲突对话框）。
 */
async function handleReload() {
  if (conflictDialogShowing) {
    // 用户已经在外部修改流程里了 —— 别再嵌套手动 reload，避免对话框栈叠
    toast('正在解决外部修改冲突，请稍后再试', 'info');
    return;
  }
  if (!store.filePath) {
    toast('未关联文件 —— 请先在设置里选择数据目录', 'warning');
    return;
  }

  syncLog('reload-from-disk', { filePath: store.filePath });

  // 第一件事：让 in-flight 的自动保存作废（与 _doResolveExternalChangeConflict 同款）
  store.cancelPendingSave();

  const result = await window.api.readFile(store.filePath);
  if (!result.ok) {
    if (result.error === 'FILE_NOT_FOUND') {
      toast('文件已被删除', 'error', 4000);
    } else {
      toast(`读取文件失败：${result.error}`, 'error', 4000);
    }
    return;
  }
  const diskContent = result.content;

  // 字节一致 → 已是最新，避免误 toast
  if (diskContent === store.serialize()) {
    syncLog('reload-noop', { reason: 'already-in-sync' });
    toast('已是最新', 'info', 2000);
    return;
  }

  if (!store.dirty) {
    // 本地没改 → 直接 reload
    store.loadFromContent(diskContent, store.filePath);
    syncLog('reload-no-dirty', { diskLength: diskContent.length });
    toast('已重新加载磁盘版本', 'success');
    return;
  }

  // 本地有 dirty + 磁盘不一致 → 二选一
  const reload = await confirmDialog({
    title: '磁盘版本与本地不同',
    message: '磁盘上的文件与本地内存不一致，且你还有未保存的修改。\n\n' +
             '· 重新加载：采用文件里的内容（**会丢弃本地未保存的修改**），先创建 .bak 快照\n' +
             '· 保留本地：立刻保存本地内容，覆盖掉磁盘版本',
    confirmText: '重新加载',
    cancelText: '保留本地',
  });
  if (reload) {
    // 与 conflict-dialog 的 keep-file 同款处理：先 snapshot 再覆盖
    const snapResult = await window.api.createSnapshot(store.filePath, 'discard');
    if (snapResult?.ok) {
      store.loadFromContent(diskContent, store.filePath);
      syncLog('reload-applied', { snapshotPath: snapResult.snapshotPath });
      toast(
        `已采用文件版本 - 你的本地修改已保存到:\n${snapResult.snapshotPath}`,
        'success',
        6000
      );
    } else {
      // 快照失败 → 二次确认避免真丢数据
      const proceed = await confirmDialog({
        title: '无法创建快照',
        message: '创建快照失败（' + (snapResult?.error || '未知错误') +
                 '），强行重新加载可能会丢失数据。\n\n是否仍然继续？',
        confirmText: '仍然重新加载',
        cancelText: '取消',
        danger: true,
      });
      if (proceed) {
        store.loadFromContent(diskContent, store.filePath);
        toast('已采用文件版本（未创建快照）', 'warning', 4000);
      }
    }
  } else {
    // 保留本地 → 直接 saveNow（force=true 覆盖磁盘）
    const saved = await store.saveNow();
    syncLog('reload-keep-mine', { saved });
    if (saved) {
      toast('已保留本地版本并写入磁盘', 'success');
    } else {
      toast('本地版本保存失败', 'error', 4000);
    }
  }
}

// 命令面板入口
async function openCommandPaletteHandler() {
  try {
    await openCommandPalette(store, {
      onSwitchCategory: (name) => store.selectCategory(name),
      onSwitchSmartList: (key) => store.selectSmartList(key),
      onToggleTheme: () => toggleTheme(),
      onOpenSettings: () => openSettings(),
      onNewList: async () => {
        const name = await inputDialog({ title: '新建列表', placeholder: '例如：阅读、健身、副业...' });
        if (!name) return;
        // 含 `|` 在选中文案就拦下来 —— store 也会拒绝，但提前告知比「按下确认没反应」
        // 更直接。sidebar.js 的同款路径同样处理。
        if (name.includes('|')) {
          toast('分类名不能包含 "|" 字符（用于选中键分隔）', 'error');
          return;
        }
        if (store.categories.some(c => c.name === name)) {
          toast(`已存在分类 "${name}"`, 'error');
          return;
        }
        const cat = store.addCategory(name);
        if (!cat) {
          // 兜底：保留名等其它拒绝原因
          toast(`"${name}" 是保留名称，请换一个`, 'error');
          return;
        }
        store.selectCategory(name);
        toast(`已创建 "${name}"`, 'success');
      }
    });
  } catch (e) {
    console.warn('[app] 命令面板打开失败:', e);
  }
}

function toggleTheme() {
  // 三态循环：dark → light → auto → dark
  // 旧实现只在 dark/light 之间切换，导致用户一旦在设置里选了「跟随系统」
  // 就再也回不去了 —— 主题按钮只能切到 light/dark，永远碰不到 auto
  const cycle = { dark: 'light', light: 'auto', auto: 'dark' };
  const newTheme = cycle[store.theme] || 'dark';
  // 通过 setTheme 触发 'theme' 事件，让 Toolbar 等订阅者更新图标
  store.setTheme(newTheme);
  document.body.dataset.theme = store.resolveTheme();
  // 同步到持久化设置
  settingsStore.update({ theme: newTheme });
}

// ============================================
//  状态栏
// ============================================

function setupStatusBar() {
  // 文件路径由 Toolbar 统一管理（在状态栏 #file-info 中渲染）

  // 缓存：每次 store 'change' 都会触发 update()，但绝大多数 change 不影响统计
  // （勾选时任务数不变 / 切换选中分类 / 排序方式等）。缓存上一次写入的字符串，
  // 与本次相同就跳过 DOM 写入 —— 'change' 在拖拽 / 打字时高频触发，省掉
  // textContent 写入与 reflow。Setup 阶段 oldText=null 强制写一次。
  let oldText = null;
  const update = () => {
    // 排除容器（OTHER_TASKS，本身无任务）和回收站（TRASH，已删除任务不计入进度）
    // 与 collectSmartListTasks 的排除规则保持一致 —— 否则用户删了任务却看到
    // 状态栏数字纹丝不动，会以为删除没生效
    const total = store.categories.reduce(
      (sum, c) => sum + ((c.kind === CategoryKind.OTHER_TASKS || c.kind === CategoryKind.TRASH) ? 0 : c.tasks.length), 0
    );
    const done = store.categories.reduce(
      (sum, c) => sum + ((c.kind === CategoryKind.OTHER_TASKS || c.kind === CategoryKind.TRASH) ? 0 : c.tasks.filter(t => t.completed).length), 0
    );
    const subCount = store.getSubCategories().length;
    const nextText = `${done}/${total} 已完成 · ${subCount} 个子分类`;
    // 写入相同文本跳过 reflow；首次（oldText===null）强制写
    if (nextText === oldText) return;
    oldText = nextText;
    // 写 #status-text（进度统计）；#status-meta 专用于保存状态，见 bootstrap 里的
    // 'dirty' / 'saved' 订阅 —— 两格各司其职，避免互相覆盖
    const el = document.getElementById('status-text');
    if (el) el.textContent = nextText;
  };

  update();
  // 返回取消函数，让 bootstrap 能把它纳入统一的 listener 清理池
  const offs = [
    store.on('change', update),
    store.on('load', update)
  ];
  return () => offs.forEach(off => off());
}

// ============================================
//  全局快捷键
// ============================================

function setupGlobalShortcuts() {
  const onKey = (e) => {
    // 模态对话框 / 命令面板 / 右键菜单打开时，不要抢键
    if (document.querySelector('.modal-overlay, .command-palette-overlay, .context-menu:not([hidden])')) {
      return;
    }

    const ctrl = e.ctrlKey || e.metaKey;
    const isInEditable = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);

    // Alt+1..4 切换列表。命令面板里每一项都标注了这些快捷键、README 也写了，
    // 但此前全项目没有任何 altKey 处理 —— 纯属空头承诺，这里补上实现。
    //
    // v3 起顺序：当前任务 / 重要任务 / 全部任务 / 已完成任务。
    // 「当前任务」不再有独立分类 —— 它是聚合智能视图，所以 Alt+1 走 selectSmartList。
    //
    // 必须在编辑态跳过：在 task-input 框里 Alt+1 会被浏览器或输入法抢走，
    // 也避免在用户输入中文/特殊符号时误触切换列表。统一在编辑态放行。
    if (e.altKey && !ctrl && !isInEditable && ['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault();
      if (e.key === '1') {
        store.selectSmartList('current');
      } else if (e.key === '2') {
        store.selectSmartList('important');
      } else if (e.key === '3') {
        store.selectSmartList('allTasks');
      } else {
        store.selectSmartList('completed');
      }
      return;
    }

    // Ctrl+, 打开设置
    if (ctrl && e.key === ',') {
      e.preventDefault();
      openSettings();
      return;
    }

    // H13: Ctrl+Shift+T 切换主题（README / 命令面板 / 顶部工具栏都已标这个快捷键，
    // 但此前 setupGlobalShortcuts 完全没接 —— 点工具栏能切，键盘切就死。
    // 这里补上，与 toolbar:toggle-theme 走同一条 toggleTheme() 路径，保证行为一致。
    if (ctrl && e.shiftKey && (e.key === 'T' || e.key === 't')) {
      e.preventDefault();
      toggleTheme();
      return;
    }

    if (ctrl && e.key === 'f') {
      e.preventDefault();
      const searchInput = document.getElementById('search-input');
      if (!searchInput) return;
      searchInput.focus();
      searchInput.select();
      return;
    }

    if (ctrl && e.shiftKey && e.key === 'N') {
      e.preventDefault();
      const addCategoryBtn = document.getElementById('btn-add-category');
      if (!addCategoryBtn) return;
      addCategoryBtn.click();
      return;
    }

    // F - 打开过滤菜单（不在输入框时）
    if ((e.key === 'f' || e.key === 'F') && !ctrl && !isInEditable) {
      // 但要避免和 Ctrl+F（搜索）冲突，Ctrl+F 已处理在上方
      const filterBtn = document.getElementById('btn-filter');
      // 「已完成」/「重要」智能列表下该按钮是 hidden 的（语义已自带过滤）。
      // hidden 元素照样能响应 .click()，而 _showFilterMenu 用 getBoundingClientRect()
      // 定位 —— 隐藏时全是 0，菜单会弹到屏幕左上角。这里直接忽略按键。
      if (!filterBtn || filterBtn.hidden) return;
      e.preventDefault();
      filterBtn.click();
      return;
    }

    // / 快速聚焦搜索（不抢占编辑中的输入）
    if (e.key === '/' && !isInEditable && !ctrl) {
      e.preventDefault();
      const search = document.getElementById('search-input');
      search.focus();
      search.select();
      return;
    }
  };
  document.addEventListener('keydown', onKey);
  // 返回取消函数，让 bootstrap 能把它纳入统一的 listener 清理池
  return () => document.removeEventListener('keydown', onKey);
}

// ============================================
//  启动
// ============================================

bootstrap();
