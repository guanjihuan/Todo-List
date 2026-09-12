// 工具栏组件

import { toast } from './feedback.js';
import { shortenPath, displayPath } from '../utils/dom.js';
import { openDataDirWithToast } from '../utils/data-dir.js';
import { isImeComposing } from '../utils/keymap.js';

export class Toolbar {
  // 主题切换图标（独立常量：避免长字符串散落在方法体内）
  // 线条风格与右侧齿轮/窗口控件按钮对齐：24×24 viewBox + stroke-width 2.2，
  // 在 CSS 强制渲染的 11×11 尺寸下描边约 1px
  static ICON_MOON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  static ICON_SUN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';

  constructor(store, settingsStore) {
    this.store = store;
    this.settingsStore = settingsStore;

    // 文件路径 chip 在底部状态栏
    this.fileInfoEl = document.getElementById('file-info');
    this.filePathText = document.getElementById('file-path-text');

    this.searchInput = document.getElementById('search-input');
    this.searchClear = document.getElementById('search-clear');
    this.searchShortcut = document.getElementById('search-shortcut');

    this.btnTheme = document.getElementById('btn-theme');
    this.btnSettings = document.getElementById('btn-settings');
    this.btnAlwaysOnTop = document.getElementById('btn-always-on-top');
    this.themeIcon = document.getElementById('theme-icon');

    // 自定义窗口控制按钮（frame: false 后接管系统标题栏）
    this.btnMinimize = document.getElementById('btn-minimize');
    this.btnMaximize = document.getElementById('btn-maximize');
    this.btnClose = document.getElementById('btn-close');

    this._dataDir = null;
    // 用户主目录：用于在未关联文件状态下把绝对路径转成 `~/...` 显示。
    // 取不到（老 preload / IPC 失败）时回退到显示绝对路径，行为兼容旧版本。
    this._homeDir = null;
    // 平台感知：Mac 用 ⌘，其它平台用 Ctrl —— 避免在 Mac 上显示"Ctrl+F"误导用户
    this._isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
    if (this.searchShortcut) {
      this.searchShortcut.textContent = this._isMac ? '⌘F' : 'Ctrl+F';
    }
    if (this.btnSettings) {
      const settingKey = this._isMac ? '⌘+,' : 'Ctrl+,';
      this.btnSettings.title = `设置 (${settingKey})`;
      this.btnSettings.setAttribute('aria-keyshortcuts', settingKey);
    }
    // 跟踪所有 store / IPC 订阅的取消函数 —— 与 TaskList / Sidebar 一致的清理约定。
    // 生产单例生命周期里不会被消费，但保留 destroy() 给将来 hot-reload / 单元测试。
    // 必须在 _setupEvents() **之前**初始化：_setupEvents() 末尾的
    // _storeUnsubs.push(window.api.onMaximizeStateChanged(...)) 要用这个数组，
    // 写反顺序会得到 TypeError: Cannot read properties of undefined (reading 'push')。
    this._storeUnsubs = [];

    // 搜索框 input 防抖 timer —— 提到实例字段，_clearSearch() 才能在清空时
    // 把"100ms 后再 setSearchQuery"的残留回调也掐掉，避免：
    //   用户输入「foo」 → 100ms 内点 ✕ → 立即 setSearchQuery('')（清空生效）
    //   → 再输入「bar」→ 100ms 后旧的「foo」才落地（错位的 searchQuery）
    // 表现为界面闪一下旧搜索结果再切到新结果（与 _clearSearch 后再输入的新结果
    // 叠加两次 render），用户看到 "EmptyState 闪一下又消失" 之类的诡异 bug。
    this._searchTimerId = 0;

    this._setupEvents();

    // 异步获取数据目录 + 用户主目录，用于"未关联文件"状态显示
    // v4+ 修复：getDataDir 失败时（IPC 通道丢失 / preload 重载等）保留 _dataDir=null，
    // 不让 unhandled promise rejection 冒到 console。UI 路径 chip 自然 fall through 到
    // "未关联文件" 提示，与 _dataDir 还没拿到时的瞬态 UI 一致 —— 用户不会看到闪屏。
    window.api.getDataDir().then((dir) => {
      this._dataDir = dir;
      this.updateFileInfo();
    }).catch((e) => {
      console.warn('[toolbar] getDataDir failed:', e?.message || e);
      this._dataDir = null;
      this.updateFileInfo();
    });
    window.api.getHomeDir?.().then((home) => {
      this._homeDir = home || null;
      this.updateFileInfo();
    }).catch(() => {
      this._homeDir = null;
    });

    // 监听数据目录变化（设置中修改）
    if (this.settingsStore) {
      this._storeUnsubs.push(this.settingsStore.on('change', async ({ changed }) => {
        if (changed.includes('dataDir')) {
          // v4+ 修复：包 try/catch。settingsStore.change 触发频率不高（仅设置里改时），
          // 但 IPC 偶发失败仍会冒 unhandled rejection。失败时保留 _dataDir=null，
          // UI 路径 chip fall through 到 "未关联文件"，与未初始化时一致。
          try {
            this._dataDir = await window.api.getDataDir();
          } catch (e) {
            console.warn('[toolbar] getDataDir after settings change failed:', e?.message || e);
            this._dataDir = null;
          }
          this.updateFileInfo();
        }
        if (changed.includes('theme')) {
          this.updateTheme();
        }
        if (changed.includes('alwaysOnTop')) {
          // 任何来源（renderer 自己 / 主进程托盘菜单通过 save-settings 反向写入）
          // 触发的 alwaysOnTop 变化都同步按钮视觉。
          this.updateAlwaysOnTop();
        }
      }));
    }

    // 托盘菜单勾选/取消「始终置顶」时，主进程会推 always-on-top:changed 过来。
    // settingsStore change 事件可能不会触发（主进程自己 saveConfig 没走 IPC 反向同步），
    // 必须显式订阅 IPC，否则按钮视觉会卡在旧状态。
    this._storeUnsubs.push(window.api.onAlwaysOnTopChanged(() => this.updateAlwaysOnTop()));

    this._storeUnsubs.push(this.store.on('file-path', () => this.updateFileInfo()));
    this._storeUnsubs.push(this.store.on('saved', (info) => this.onSaved(info)));
    this._storeUnsubs.push(this.store.on('save-error', (err) => {
      // 主进程的安全检查（assertInDataDir）会用英文抛 'path outside data directory'，
      // 直接拼到中文 toast 里读起来很违和。这里翻译为对用户友好的措辞。
      // 用户之所以会撞到这条，是「另存为」对话框默认在桌面 / 下载目录，被引导到了
      // 数据目录之外 —— 现在 defaultPath 已修正到数据目录内，这种错误应很少再发生。
      //
      // v3.4+：载荷升级为 {code, message, diskContent} 对象（见 task-store._buildSaveErrorPayload），
      // 但旧路径可能仍发字符串 —— 兼容两种格式。直接 `${err}` 对对象会变 `[object Object]`，
      // 必须显式取 .message / .code，否则用户看到的是没意义的方括号。
      let msg;
      if (typeof err === 'string') {
        msg = err.includes('outside data directory')
          ? '保存路径必须在数据目录内（请通过「设置」更改数据目录）'
          : `保存失败：${err}`;
      } else if (err && typeof err === 'object') {
        const text = err.message || err.code || '未知错误';
        msg = err.code === 'OUTSIDE_DATA_DIR'
          ? '保存路径必须在数据目录内（请通过「设置」更改数据目录）'
          : `保存失败：${text}`;
      } else {
        msg = '保存失败';
      }
      toast(msg, 'error', 4000);
    }));
    this._storeUnsubs.push(this.store.on('dirty', () => this.updateFileInfo()));
    this._storeUnsubs.push(this.store.on('theme', () => this.updateTheme()));
    // 设置保存失败也必须告诉用户：settingsStore._persist 失败时内存已生效（用户当下看到
    // 的是新值），但磁盘写不进 → 下次启动回到旧值。settings-store.js 会发 'save-error'，
    // 但全项目过去没人订阅 —— 用户切了主题/字号后重启发现没保留，一脸茫然。
    if (this.settingsStore) {
      this._storeUnsubs.push(this.settingsStore.on('save-error', ({ failed }) => {
        toast(`设置保存失败：${failed.join('、')} 未持久化（重启后会恢复旧值）`, 'error', 5000);
      }));
    }
    this.updateFileInfo();
    this.updateTheme();
    // 启动时根据持久化值同步按钮视觉（主进程此时已经应用过置顶状态）
    this.updateAlwaysOnTop();
    // 最大化按钮默认显示「最大化」图标，主进程 ready-to-show 后会推真实状态覆盖。
    // 这一步是为 IPC 丢失兜底 —— 比如热重载 / 渲染异常重启时 listener 被重建，
    // 之前的 broadcast 不会被回放，按钮应停在合法状态而不是同时显示两个图标。
    this._applyMaximizeState(false);
  }

  /**
   * 释放所有 store / IPC 订阅。生产单例生命周期里不会被调用（Toolbar 与窗口同生死），
   * 但保留入口给将来 hot-reload / 单元测试按需清理 —— 否则旧的 listener 仍会触发
   * updateFileInfo / updateTheme 等方法，而这些方法读 this.btnTheme 等 DOM 引用，
   * 可能撞上已被替换的 DOM。
   */
  destroy() {
    // 清理搜索 debounce —— 否则 destroy 后定时器还会 fire 一次，调 store.setSearchQuery
    // emit 'search'，订阅方（TaskList）跑 filter/render 但 DOM 已被替换，撞陈旧引用。
    // 顺序必须先 clearTimeout 再解订阅 —— 否则清不掉还会触发订阅的副作用。
    clearTimeout(this._searchTimerId);
    this._searchTimerId = null;
    for (const off of this._storeUnsubs || []) off();
    this._storeUnsubs = [];
  }

  _setupEvents() {
    // 搜索
    if (this.searchInput) {
      // 输入事件 debounce —— 与 import-dialog.js 的 100ms+rAF 模式对齐：
      // store.setSearchQuery 会 emit('search')，订阅方（TaskList）会跑一次完整
      // filter + render。普通用户连击时 input 事件密集触发（每键一次），大任务量
      // （几千条）下逐字符重新过滤会出现肉眼可见的卡顿；100ms 间隔人眼感知不到
      // 延迟，rAF 把状态写回 DOM 避免 layout 抖动。✕ 按钮和 Esc 走的是即时路径，
      // _clearSearch() 直接调用，不走 debounce。
      this.searchInput.addEventListener('input', (e) => {
        const q = e.target.value.trim();
        if (this.searchClear) this.searchClear.hidden = !q;
        clearTimeout(this._searchTimerId);
        this._searchTimerId = setTimeout(() => {
          this.store.setSearchQuery(q);
        }, 100);
      });

      // Esc 清空搜索 —— 与点 ✕ 等价，但不用抬手去找鼠标。
      // 仅在已有内容时拦截，避免抢其它场景的 Esc（命令面板、模态、编辑态…）。
      // IME 守卫：CJK/JP/KR 用户在搜索框里按 Esc 优先是「取消 IME 组合」，
      // 不应误清空搜索。
      this.searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !isImeComposing(e) && this.searchInput.value) {
          e.preventDefault();
          e.stopPropagation();
          this._clearSearch();
        }
      });
    }

    if (this.searchClear) {
      this.searchClear.addEventListener('click', () => {
        this._clearSearch();
      });
    }

    // 文件路径 chip：点击打开数据目录
    if (this.fileInfoEl) {
      this.fileInfoEl.addEventListener('click', () => this._openDataDirectory());
    }

    // 设置按钮
    if (this.btnSettings) {
      this.btnSettings.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('toolbar:settings'));
      });
    }

    // 主题按钮
    if (this.btnTheme) {
      this.btnTheme.addEventListener('click', () => document.dispatchEvent(new CustomEvent('toolbar:toggle-theme')));
    }

    // 始终置顶按钮 —— 走 settingsStore.update 让主进程统一落盘 + 应用 + 重建托盘菜单。
    // 单击立刻切换；不阻塞在 await 上（用户连点两次不应等上一次保存完）。
    if (this.btnAlwaysOnTop) {
      this.btnAlwaysOnTop.addEventListener('click', () => this._toggleAlwaysOnTop());
    }

    // 自定义窗口控制按钮（frame: false 后接管系统标题栏）
    if (this.btnMinimize) {
      this.btnMinimize.addEventListener('click', () => window.api.minimizeWindow());
    }
    if (this.btnMaximize) {
      // toggle 接口会返回新的 isMaximized，主进程已经把窗口切到对应状态，
      // renderer 只需要根据返回值刷图标。状态机只在主进程里有一份。
      this.btnMaximize.addEventListener('click', async () => {
        // v4+ 修复：async listener 里 await 一旦 reject 就是 unhandled rejection
        // （addEventListener 不接 Promise）。IPC 偶发失败时用户只看到「按钮点了没反应」，
        // 控制台冒一条未捕获错误。这里兜底：失败就不动图标 —— 主进程 onMaximizeStateChanged
        // (line 264) 仍会在窗口状态真变化时推送正确值，图标不会永久错位。
        try {
          const isMaximized = await window.api.toggleMaximizeWindow();
          this._applyMaximizeState(!!isMaximized);
        } catch (e) {
          console.warn('[toolbar] toggleMaximizeWindow 失败:', e?.message || e);
        }
      });
    }
    if (this.btnClose) {
      // 与系统 X 同义：默认走"隐藏到托盘"。托盘菜单"退出"才是真正退出。
      this.btnClose.addEventListener('click', () => window.api.closeWindow());
    }

    // 同步窗口最大化/还原状态：启动时主进程会推一次 ready-to-show → maximize-state，
    // 之后用户拖到屏幕边缘触发 Win+Up / 双击标题栏最大化时也会推。
    // 关键是不能只靠 click 回调 —— 系统级快捷键触发的最大化不走 renderer。
    //
    // 必须把 onMaximizeStateChanged 返回的 cleanup 也 push 到 _storeUnsubs：
    // 不收口的话 destroy() 后旧 listener 仍引用 this.btnMaximize 这种 DOM 引用，
    // 遇到 hot-reload / Toolbar 重建就会与新实例并存，按钮图标被多次刷新。
    this._storeUnsubs.push(window.api.onMaximizeStateChanged((isMaximized) => {
      this._applyMaximizeState(isMaximized);
    }));
  }

  /**
   * 把最大化按钮的图标/title 切到对应状态。
   * 状态机只在主进程里有一份（mainWindow.isMaximized()），renderer 只是被动渲染。
   */
  _applyMaximizeState(isMaximized) {
    if (!this.btnMaximize) return;
    // data-state 用 CSS 选择器控制两个 SVG 的显隐，比 innerHTML 替换轻量
    this.btnMaximize.dataset.state = isMaximized ? 'restore' : 'maximize';
    this.btnMaximize.title = isMaximized ? '还原' : '最大化';
    this.btnMaximize.setAttribute('aria-label', isMaximized ? '还原' : '最大化');
  }

  async _toggleAlwaysOnTop() {
    if (!this.settingsStore) return;
    const next = !this.settingsStore.get('alwaysOnTop');
    // settingsStore.update 同步触发 'change' 事件，change 监听器会立刻调
    // updateAlwaysOnTop() 同步按钮视觉 —— 不需要再单独预渲染一次。
    // settingsStore.update 内部走 save-settings IPC，主进程在那个 handler 里
    // 已经会调 mainWindow.setAlwaysOnTop + 重建托盘菜单，所以这里不再额外发 IPC。
    const ok = await this.settingsStore.update({ alwaysOnTop: next });
    if (!ok) {
      // settingsStore.update 内部已经发了 'save-error' 给通用 handler（已在
      // 构造函数里订阅 toast），这里只负责回滚视觉。settingsStore 不会自己
      // 撤销内存值 —— 内存里仍是新值，磁盘是旧值，下次启动按磁盘走。
      this._applyAlwaysOnTopVisual(!next);
    }
  }

  /**
   * 同步按钮的视觉激活态。从 settingsStore 与主进程 IPC 都汇聚到这一处。
   * 不用 await：纯 DOM 操作，立即生效。
   */
  updateAlwaysOnTop() {
    if (!this.btnAlwaysOnTop || !this.settingsStore) return;
    this._applyAlwaysOnTopVisual(this.settingsStore.get('alwaysOnTop'));
  }

  _applyAlwaysOnTopVisual(enabled) {
    if (!this.btnAlwaysOnTop) return;
    this.btnAlwaysOnTop.classList.toggle('active', !!enabled);
    this.btnAlwaysOnTop.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    this.btnAlwaysOnTop.title = enabled ? '始终置顶（已开启）' : '始终置顶';
  }

  // 打开数据目录
  async _openDataDirectory() {
    return openDataDirWithToast();
  }

  // 清空搜索（✕ 按钮 + Esc 共用）
  _clearSearch() {
    if (!this.searchInput) return;
    // 必须先掐掉 pending debounce —— 否则 100ms 内 setSearchQuery(q) 会带着旧的
    // 输入值落地，让"刚刚清空"的搜索框又被回填为旧值（详见构造函数的 _searchTimerId
    // 注释）。先 clear 再 setSearchQuery('') 是稳妥顺序：旧值决不会再被发出。
    clearTimeout(this._searchTimerId);
    this._searchTimerId = 0;
    this.searchInput.value = '';
    if (this.searchClear) this.searchClear.hidden = true;
    this.store.setSearchQuery('');
    this.searchInput.focus();
  }

  updateFileInfo() {
    if (!this.fileInfoEl || !this.filePathText) return;
    if (!this.store.filePath) {
      // 未关联文件时，显示默认数据目录的预期路径
      if (this._dataDir) {
        // 分隔符跟随 _dataDir 自身的风格：硬编码 '\\' 会在 macOS/Linux 上
        // 显示成 "~/TodoList\todo.md"
        const sep = this._dataDir.includes('\\') ? '\\' : '/';
        const fullPath = this._dataDir.replace(/[\\/]$/, '') + sep + 'todo.md';
        // 状态栏显示用 `~/...` 形式（避免泄露用户名 / 跨用户一致）；
        // 完整绝对路径放 title 属性，hover / 需要复制时仍能拿到。
        const display = displayPath(fullPath, this._homeDir);
        this.filePathText.textContent = display;
        this.fileInfoEl.title = `当前未关联文件\n新建或打开后，默认保存到:\n${fullPath}\n点击打开数据文件夹`;
      } else {
        this.filePathText.textContent = '未关联文件';
        this.fileInfoEl.title = '请新建或打开一个 Todo 文件\n点击打开数据文件夹';
      }
      this.fileInfoEl.classList.add('unsaved');
      this.fileInfoEl.classList.remove('dirty');
    } else {
      this.fileInfoEl.classList.remove('unsaved');
      const dirty = this.store.dirty;
      this.fileInfoEl.classList.toggle('dirty', dirty);
      // 已关联文件：直接展示当前路径 —— 即使用户自定义了 dataDir，也展示实际路径，
      // 状态栏应该如实反映「我现在在哪」而不是「默认应该在哪」。
      // 全路径交给 CSS ellipsis 在宽度不够时再省略，title 保留完整路径方便复制
      this.filePathText.textContent = this.store.filePath;
      this.fileInfoEl.title = this.store.filePath + (dirty ? '\n（未保存）' : '') + '\n点击打开数据文件夹';
    }
  }

  onSaved(info) {
    this.updateFileInfo();
    // 自动保存只更新状态栏，不弹 toast —— 频繁弹窗会严重打扰用户
    if (!info.auto) {
      toast(`已保存到 ${shortenPath(info.filePath)}`, 'success', 1500);
    }
  }

  updateTheme() {
    const resolved = this.store.resolveTheme();
    document.body.dataset.theme = resolved;
    if (this.themeIcon) {
      this.themeIcon.innerHTML = resolved === 'dark' ? Toolbar.ICON_MOON : Toolbar.ICON_SUN;
    }
    if (this.btnTheme) {
      // 用 title 反映「实际生效的主题」而非用户选择的模式 —— 用户切到「自动」时
      // 显示「跟随系统（当前：深色）」比单写「自动主题」更直观，能看到系统当前决议。
      // 注意不要在前面再加「当前：」前缀，否则会出现「当前：自动（当前：深色）」重叠。
      //
      // 文案与 settings-dialog 的「暗色 / 浅色 / 跟随系统」保持一致（去掉中间空格，
      // 用「跟随系统」而非「自动」），避免两处对同一概念两种说法引起认知割裂。
      const themeLabel = this.store.theme === 'auto'
        ? '跟随系统（当前：' + (resolved === 'dark' ? '深色' : '浅色') + '）'
        : (resolved === 'dark' ? '深色' : '浅色') + '主题';
      this.btnTheme.title = themeLabel;
    }
  }
}
