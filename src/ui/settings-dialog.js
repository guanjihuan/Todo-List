// 设置对话框 - 数据目录、主题等

import { toast, runBeforeModalShow } from './feedback.js';
import { openDataDirWithToast } from '../utils/data-dir.js';
import { displayPath } from '../utils/dom.js';
import { isImeComposing } from '../utils/keymap.js';

/**
 * 打开设置对话框
 * @param {SettingsStore} settingsStore
 * @returns {Promise<{changed: boolean}>} 是否修改了需要重新加载的设置（数据目录）
 */
export function openSettingsDialog(settingsStore) {
  return new Promise((resolve) => {
    // M8：挂载 overlay 之前先清掉所有进行中的瞬态状态（拖拽 / 菜单 / 等）。
    runBeforeModalShow();
    // AbortController 必须最先创建 —— 所有 addEventListener 都要传 { signal }，否则
    // 每次打开对话框都会叠加一份「永远不会被 ac.abort() 清掉」的监听器，
    // 反复开关几次后主题/字号切换会被触发多次，按钮事件会被处理两遍。
    const ac = new AbortController();
    const { signal } = ac;

    // 共享关闭守卫：finish() / cancel() 任一先到都会 resolve Promise，再来一次会被忽略。
    // 没有它：点「完成」期间按 Esc → finish 已经在 await settingsStore.update（持久化），
    // cancel 又跑一遍 → cancel 先 resolve({changed:false})，用户改的设置"看着已生效"
    // 但调用方拿到 changed=false 不重载数据目录；update 后续仍写盘但 IPC 端无 UI 反馈。
    // 加 closed 后 cancel 看到 finish 已先动就直接退出，不会触发第二次动画/resolve。
    // 与 feedback.js 的 `resolved` 不同：这里在 finish/cancel 入口立即置位（同步），
    // settle() 不检查自己、再交由 Promise 自身的"忽略后续 resolve"语义兜底 —— 这样
    // animationend 和 250ms 兜底两路 finalize 都可以放心地调 settle。
    let closed = false;
    const settle = (value) => {
      // 这里不检查 closed：Promise 本身会忽略后续 resolve，多次调用是幂等的。
      // closed 只防止 finish/cancel 入口被并发进入（参见各函数 if (closed) return）。
      resolve(value);
    };

    // 记下打开前的焦点元素，关闭时还原 —— 否则用户按 Ctrl+, 开设置、Esc 关掉后，
    // 焦点漂在 document.body 上，键盘流断掉。
    const previouslyFocused = document.activeElement;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay settings-overlay';
    overlay.innerHTML = `
      <div class="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div class="modal-header settings-header">
          <div class="settings-header-left">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            <span id="settings-title">设置</span>
          </div>
          <button class="btn-icon-sm settings-close" data-action="cancel" title="关闭 (Esc)">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M18 6 6 18"/>
              <path d="m6 6 12 12"/>
            </svg>
          </button>
        </div>

        <div class="modal-body settings-body">

          <!-- 外观 -->
          <section class="settings-section">
            <div class="settings-section-header">
              <h3 class="settings-section-title">外观</h3>
              <p class="settings-section-desc">个性化你的工作界面</p>
            </div>

            <div class="settings-row">
              <label class="settings-label">主题</label>
              <div class="settings-segmented" data-setting="theme">
                <button data-value="dark" class="seg-btn">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                  </svg>
                  暗色
                </button>
                <button data-value="light" class="seg-btn">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="4"/>
                    <path d="M12 2v2"/>
                    <path d="M12 20v2"/>
                    <path d="m4.93 4.93 1.41 1.41"/>
                    <path d="m17.66 17.66 1.41 1.41"/>
                    <path d="M2 12h2"/>
                    <path d="M20 12h2"/>
                    <path d="m6.34 17.66-1.41 1.41"/>
                    <path d="m19.07 4.93-1.41 1.41"/>
                  </svg>
                  浅色
                </button>
                <button data-value="auto" class="seg-btn">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M12 2a10 10 0 0 0 0 20z" fill="currentColor" stroke="none"/>
                  </svg>
                  跟随系统
                </button>
              </div>
            </div>

            <div class="settings-row">
              <label class="settings-label">字体大小</label>
              <div class="settings-segmented" data-setting="fontSize">
                <button data-value="small" class="seg-btn">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                    <path d="M2.5 4a.75.75 0 01.75-.75h7.5a.75.75 0 010 1.5h-7.5A.75.75 0 012.5 4zm0 4a.75.75 0 01.75-.75h10a.75.75 0 010 1.5h-10A.75.75 0 012.5 8zm.75 3.25a.75.75 0 000 1.5h5.5a.75.75 0 000-1.5h-5.5z"/>
                  </svg>
                  小
                </button>
                <button data-value="medium" class="seg-btn">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                    <path d="M2 4a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4zm0 4.5a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75zm-.75 3.75a.75.75 0 01.75-.75h6.5a.75.75 0 010 1.5h-6.5a.75.75 0 01-.75-.75z"/>
                  </svg>
                  标准
                </button>
                <button data-value="large" class="seg-btn">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                    <path d="M1.5 3.75a.75.75 0 01.75-.75h11.5a.75.75 0 010 1.5H2.25a.75.75 0 01-.75-.75zm0 4.5a.75.75 0 01.75-.75h11.5a.75.75 0 010 1.5H2.25a.75.75 0 01-.75-.75zm-.75 3.75a.75.75 0 01.75-.75h7.5a.75.75 0 010 1.5h-7.5a.75.75 0 01-.75-.75z"/>
                  </svg>
                  大
                </button>
              </div>
            </div>

            <div class="settings-row">
              <label class="settings-label">配色风格</label>
              <div class="settings-segmented settings-segmented-color" data-setting="colorStyle">
                <button data-value="indigo" class="seg-btn" title="靛蓝（Linear 风格默认）">
                  <span class="color-swatch" style="background:#4f46e5"></span>靛蓝
                </button>
                <button data-value="ocean" class="seg-btn" title="海洋（蓝青）">
                  <span class="color-swatch" style="background:#0284c7"></span>海洋
                </button>
                <button data-value="forest" class="seg-btn" title="森林（翠绿）">
                  <span class="color-swatch" style="background:#059669"></span>森林
                </button>
                <button data-value="sunset" class="seg-btn" title="日落（暖橙）">
                  <span class="color-swatch" style="background:#ea580c"></span>日落
                </button>
                <button data-value="rose" class="seg-btn" title="玫瑰（玫红）">
                  <span class="color-swatch" style="background:#e11d48"></span>玫瑰
                </button>
                <button data-value="mono" class="seg-btn" title="单色（中性灰）">
                  <span class="color-swatch" style="background:#475569"></span>单色
                </button>
              </div>
              <p class="settings-hint">
                与「主题（明/暗）」正交：每种配色都包含浅色和深色两个变体，可独立选择
              </p>
            </div>

            </section>

          <!-- 数据存储位置 -->
          <section class="settings-section">
            <div class="settings-section-header">
              <h3 class="settings-section-title">数据存储</h3>
              <p class="settings-section-desc">所有任务以 Markdown 文件形式存储在此文件夹下</p>
            </div>

            <div class="settings-row">
              <label class="settings-label">当前位置</label>
              <div class="settings-input-group">
                <input type="text" id="settings-data-dir" class="settings-input" readonly>
                <button class="btn" id="settings-open-dir" title="在文件管理器中打开">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M15 3h6v6"/>
                    <path d="M10 14 21 3"/>
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                  </svg>
                  <span>打开</span>
                </button>
                <button class="btn" id="settings-choose-dir" title="选择其他文件夹">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
                    <circle cx="11" cy="13" r="2"/>
                    <path d="m21 21-2.5-2.5"/>
                  </svg>
                  <span>浏览</span>
                </button>
              </div>
              <p class="settings-hint">
                默认:
                <code id="settings-default-dir">…</code>
                <button class="settings-link" id="settings-reset-dir">恢复默认</button>
              </p>
            </div>

            <div class="settings-row">
              <label class="settings-label">每日自动备份</label>
              <div class="settings-segmented" data-setting="backupEnabled">
                <button data-value="false" class="seg-btn">关闭</button>
                <button data-value="true" class="seg-btn">开启</button>
              </div>
              <p class="settings-hint">
                开启后，每天首次打开软件或首次操作时，自动在数据目录下创建 <code>backup/</code> 文件夹并保存一份 <code>todo-YYYY-MM-DD.md</code>
              </p>
            </div>
          </section>

          <!-- 任务列表 -->
          <section class="settings-section">
            <div class="settings-section-header">
              <h3 class="settings-section-title">任务列表</h3>
              <p class="settings-section-desc">调整新增、完成、删除、移动时最新一条的落点</p>
            </div>

            <div class="settings-row">
              <label class="settings-label">新增任务</label>
              <div class="settings-segmented" data-setting="newTaskPosition">
                <button data-value="front" class="seg-btn">前面</button>
                <button data-value="back" class="seg-btn">后面</button>
              </div>
              <p class="settings-hint">
                最新添加的任务落到列表的「前面」（最上面）或「后面」（最下面）
              </p>
            </div>

            <div class="settings-row">
              <label class="settings-label">已完成任务</label>
              <div class="settings-segmented" data-setting="completedPosition">
                <button data-value="front" class="seg-btn">前面</button>
                <button data-value="back" class="seg-btn">后面</button>
              </div>
              <p class="settings-hint">
                打勾完成的任务搬到「已完成任务」分类时的落点
              </p>
            </div>

            <div class="settings-row">
              <label class="settings-label">回收站</label>
              <div class="settings-segmented" data-setting="trashPosition">
                <button data-value="front" class="seg-btn">前面</button>
                <button data-value="back" class="seg-btn">后面</button>
              </div>
              <p class="settings-hint">
                删除的任务搬到「回收站」时的落点
              </p>
            </div>

            <div class="settings-row">
              <label class="settings-label">标记为未完成</label>
              <div class="settings-segmented" data-setting="uncompletePosition">
                <button data-value="front" class="seg-btn">前面</button>
                <button data-value="back" class="seg-btn">后面</button>
              </div>
              <p class="settings-hint">
                已完成任务取消勾选后回到原分类时的落点
              </p>
            </div>

            <div class="settings-row">
              <label class="settings-label">恢复任务</label>
              <div class="settings-segmented" data-setting="restorePosition">
                <button data-value="front" class="seg-btn">前面</button>
                <button data-value="back" class="seg-btn">后面</button>
              </div>
              <p class="settings-hint">
                回收站里的任务恢复到原分类时的落点
              </p>
            </div>

            <div class="settings-row">
              <label class="settings-label">移到分类</label>
              <div class="settings-segmented" data-setting="movePosition">
                <button data-value="front" class="seg-btn">前面</button>
                <button data-value="back" class="seg-btn">后面</button>
              </div>
              <p class="settings-hint">
                右键「移到分类…」或批量移动时，任务落到目标分类的哪个位置
              </p>
            </div>
          </section>

          <!-- 关于 -->
          <section class="settings-section">
            <div class="settings-section-header">
              <h3 class="settings-section-title">关于</h3>
              <p class="settings-section-desc">应用信息和运行时环境</p>
            </div>
            <div class="settings-about">
              <div class="settings-about-row">
                <span class="settings-about-key">应用</span>
                <span class="settings-about-val">Todo List</span>
              </div>
              <div class="settings-about-row">
                <span class="settings-about-key">版本</span>
                <span class="settings-about-val" id="settings-version">…</span>
              </div>
              <div class="settings-about-row">
                <span class="settings-about-key">Electron</span>
                <span class="settings-about-val" id="settings-electron">…</span>
              </div>
              <div class="settings-about-row">
                <span class="settings-about-key">开发者</span>
                <a class="settings-about-val settings-about-link" href="#" id="settings-developer-link" title="打开开发者主页">关济寰</a>
              </div>
            </div>
          </section>

        </div>

        <div class="modal-footer">
          <button class="btn btn-link-danger" id="settings-reset-all" aria-label="恢复全部默认设置（主题、字号、配色、备份开关、插入位置、数据目录）">恢复全部默认</button>
          <button class="btn btn-primary" data-action="done">完成</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const inputEl = overlay.querySelector('#settings-data-dir');
    const chooseBtn = overlay.querySelector('#settings-choose-dir');
    const openBtn = overlay.querySelector('#settings-open-dir');
    const resetBtn = overlay.querySelector('#settings-reset-dir');
    const defaultDirEl = overlay.querySelector('#settings-default-dir');
    const versionEl = overlay.querySelector('#settings-version');
    const electronEl = overlay.querySelector('#settings-electron');
    const resetAllBtn = overlay.querySelector('#settings-reset-all');
    const developerLinkEl = overlay.querySelector('#settings-developer-link');

    // 初始化数据
    const initial = settingsStore.all;
    inputEl.placeholder = '(使用默认)';

    // 当前生效路径
    window.api.getDataDir().then((dir) => {
      // dialog 已关（用户在 IPC 期间按 Esc / 点 X）→ 不写 detached DOM
      if (signal.aborted) return;
      inputEl.dataset.current = dir;
      inputEl.value = dir;
    }).catch((e) => {
      // v4+ 修复：缺 .catch → IPC 偶发失败（如 main process 临时掉线）会让 promise
      // 进入 unhandled rejection，整条错误冒到 window.onerror；这里与 line 335 的
      // getElectronVersion 同款兜底 —— 失败时把 input 留空，让用户在「打开」按钮里
      // 自助操作，而不是让 UI 静默显示过期值。
      if (signal.aborted) return;
      console.warn('[settings-dialog] getDataDir failed:', e?.message || e);
      inputEl.value = '';
    });
    // 默认路径：用 `~/...` 显示形式 —— 不暴露用户名，跨用户一致。
    // 完整绝对路径放 title 属性，hover 时能看到（想复制可以走 input 框或「打开」按钮）。
    Promise.all([window.api.getDefaultDataDir(), window.api.getHomeDir?.()])
      .then(([dir, home]) => {
        if (signal.aborted) return;
        const display = displayPath(dir, home);
        defaultDirEl.textContent = display;
        defaultDirEl.title = dir;
      })
      .catch((e) => {
        if (signal.aborted) return;
        console.warn('[settings-dialog] getDefaultDataDir/homeDir failed:', e?.message || e);
        defaultDirEl.textContent = '(无法读取)';
      });
    window.api.getVersion().then((v) => {
      if (signal.aborted) return;
      versionEl.textContent = v;
    }).catch((e) => {
      if (signal.aborted) return;
      console.warn('[settings-dialog] getVersion failed:', e?.message || e);
      versionEl.textContent = '—';
    });
    // Electron 版本从主进程读取（renderer 无 process 全局）
    if (window.api.getElectronVersion) {
      window.api.getElectronVersion().then((v) => {
        if (signal.aborted) return;
        electronEl.textContent = v || '—';
      }).catch(() => {
        if (signal.aborted) return;
        electronEl.textContent = '—';
      });
    } else {
      electronEl.textContent = '—';
    }
    // 开发者主页链接 —— 单独存到 dataset.href 而不是直接写 href，避免被搜索引擎
    // / 爬虫误读。点击时再读出来走 IPC 让主进程 shell.openExternal 打开浏览器。
    if (developerLinkEl) {
      developerLinkEl.dataset.href = 'https://www.guanjihuan.com/about';
    }

    // 分段按钮（主题）— 即时预览，取消时恢复
    const themeSeg = overlay.querySelector('[data-setting="theme"]');
    const setSegActive = (val) => {
      themeSeg.querySelectorAll('.seg-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.value === val);
      });
    };
    // 记录打开对话框时的主题，取消时用来恢复
    const originalTheme = initial.theme;
    const originalResolvedTheme = document.body.dataset.theme;
    // 同样记录字体大小：dialog 打开预览后，点取消要把字号也回滚到原值
    const originalFontSize = document.body.dataset.fontSize || 'medium';
    setSegActive(initial.theme);
    themeSeg.addEventListener('click', async (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      const newTheme = btn.dataset.value;
      setSegActive(newTheme);
      inputEl.dataset.pendingTheme = newTheme;
      // 即时预览：解析 auto 并为 body 应用，让用户当场看到效果
      let resolved = newTheme;
      if (newTheme === 'auto') {
        resolved = window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      }
      document.body.dataset.theme = resolved;
    }, { signal });

    // 分段按钮（字体大小）— 即时预览
    const fontSizeSeg = overlay.querySelector('[data-setting="fontSize"]');
    const setFontSizeActive = (val) => {
      fontSizeSeg.querySelectorAll('.seg-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.value === val);
      });
    };
    setFontSizeActive(initial.fontSize || 'medium');
    fontSizeSeg.addEventListener('click', async (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      const newFontSize = btn.dataset.value;
      setFontSizeActive(newFontSize);
      inputEl.dataset.pendingFontSize = newFontSize;
      // 即时预览
      document.body.dataset.fontSize = newFontSize;
    }, { signal });

    // 记录打开对话框时的配色风格，取消时用来恢复（与 fontSize 同款策略）
    const originalColorStyle = initial.colorStyle || 'indigo';

    // 分段按钮（配色风格）— 即时预览
    // 配色风格由 body[data-color-style] 走 CSS 复合选择器解析，无需 JS 联动
    const colorStyleSeg = overlay.querySelector('[data-setting="colorStyle"]');
    const setColorStyleActive = (val) => {
      colorStyleSeg.querySelectorAll('.seg-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.value === val);
      });
    };
    setColorStyleActive(originalColorStyle);
    colorStyleSeg.addEventListener('click', async (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      const newStyle = btn.dataset.value;
      setColorStyleActive(newStyle);
      inputEl.dataset.pendingColorStyle = newStyle;
      // 即时预览：CSS 复合选择器 [data-theme][data-color-style] 自动生效
      document.body.dataset.colorStyle = newStyle;
    }, { signal });

    // 分段按钮（每日自动备份）— 布尔值用同样的 segmented 风格保持 UI 一致
    const backupSeg = overlay.querySelector('[data-setting="backupEnabled"]');
    const setBackupActive = (val) => {
      // 把 boolean 转成 'true' / 'false' 字符串一次，下面跟 button 的 data-value 直接比；
      // 否则初次打开时 initial.backupEnabled === false 会和 'false' 字符串不相等，
      // UI 默认选中态就丢了
      const target = String(val);
      backupSeg.querySelectorAll('.seg-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.value === target);
      });
    };
    setBackupActive(Boolean(initial.backupEnabled));
    backupSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      const newValue = btn.dataset.value === 'true';
      setBackupActive(newValue);
      inputEl.dataset.pendingBackupEnabled = newValue ? '1' : '0';
    }, { signal });

    // 分段按钮（任务插入位置）— 通用 helper：
    //   - 三个 *Position 设置共用同一份 UI 风格（前面 / 后面 二选一）
    //   - 选中态实时预览，点击即记录 pending 值到 inputEl.dataset
    //   - 「未点过」靠 dataset 上没这个属性来识别（与 backupEnabled 同款策略）
    const initPositionSeg = (segEl, settingKey) => {
      const setActive = (val) => {
        const target = String(val);
        segEl.querySelectorAll('.seg-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.value === target);
        });
      };
      // settingsStore 未加载完成时 initial[settingKey] 是 undefined —— 视为默认值 'front'
      const initialVal = initial[settingKey] || 'front';
      setActive(initialVal);
      segEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.seg-btn');
        if (!btn) return;
        const newValue = btn.dataset.value;
        setActive(newValue);
        inputEl.dataset[settingKey] = newValue;
      }, { signal });
    };
    initPositionSeg(
      overlay.querySelector('[data-setting="newTaskPosition"]'),
      'newTaskPosition'
    );
    initPositionSeg(
      overlay.querySelector('[data-setting="completedPosition"]'),
      'completedPosition'
    );
    initPositionSeg(
      overlay.querySelector('[data-setting="uncompletePosition"]'),
      'uncompletePosition'
    );
    initPositionSeg(
      overlay.querySelector('[data-setting="trashPosition"]'),
      'trashPosition'
    );
    initPositionSeg(
      overlay.querySelector('[data-setting="restorePosition"]'),
      'restorePosition'
    );
    initPositionSeg(
      overlay.querySelector('[data-setting="movePosition"]'),
      'movePosition'
    );

    // 浏览文件夹 - 仅更新 UI，不立即应用
    chooseBtn.addEventListener('click', async () => {
      // v4+ 修复：async listener 里 await reject → unhandled rejection（DOM 事件
      // 系统不接 Promise）。native 目录选择器失败（极端：权限 / shell 崩溃）时
      // 用户只看到「点了没反应」，且控制台冒未捕获错误。包 try/catch + toast。
      let chosen;
      try {
        chosen = await window.api.chooseDataDir();
      } catch (e) {
        if (signal.aborted) return;
        console.warn('[settings-dialog] chooseDataDir failed:', e?.message || e);
        toast('打开文件夹选择器失败，可直接在输入框里粘贴路径', 'error', 3000);
        return;
      }
      // 文件选择对话框是 native，用户可能按 Esc 关掉 → finish()/cancel() 已经
      // 走完，overlay.remove() 完毕，inputEl 已脱离 DOM。此时若继续写 inputEl.value
      // 会：(a) 静默吞掉用户的选择 (b) 把 detached 节点拖在闭包里直到 GC。
      // 守卫 signal.aborted：dialog 已关就什么也不做。
      if (signal.aborted) return;
      if (chosen) {
        inputEl.value = chosen;
        inputEl.dataset.userChanged = '1';
      }
    }, { signal });

    // 打开数据文件夹 - 调用系统文件管理器
    openBtn.addEventListener('click', () => openDataDirWithToast(), { signal });

    // 开发者主页链接 - 走 IPC 让主进程 shell.openExternal 打开浏览器
    // 必须 preventDefault + 拦截 href，否则 Electron 默认会在窗口内跳转，
    // 触发 hash 变化 / 导航走主进程 loadFile 路径，破坏 SPA 状态
    if (developerLinkEl) {
      developerLinkEl.addEventListener('click', async (e) => {
        e.preventDefault();
        const url = developerLinkEl.dataset.href || developerLinkEl.getAttribute('href');
        if (!url || url === '#') return;
        try {
          const res = await window.api.openExternal(url);
          if (res && res.ok === false) {
            if (!signal.aborted) toast('打开链接失败：' + (res.error || '未知错误'), 'error', 3000);
          }
        } catch (err) {
          if (!signal.aborted) toast('打开链接失败：' + (err.message || err), 'error', 3000);
        }
      }, { signal });
    }

    // 按钮点击后短暂闪一下「✓ 已恢复」，给用户即时反馈（不光是底部 toast）。
    // 不在这里用「disabled = true」：用户可能改主意再点一次取消，禁用会让
    // 状态看起来「卡住了」；用临时文本 + 样式做瞬态反馈即可。
    // 注意：定时器不挂在 signal 上（setTimeout 没有 signal 选项）—— 改在 cancel() /
    // finish() 的 finalize 阶段由调用方 clear 掉，避免 dialog 关掉后 timer 仍写
    // detached 节点。
    const resetFeedbackTimers = new Set();
    function flashResetFeedback(btn, msg = '✓ 已恢复') {
      if (!btn) return;
      const original = btn._resetOriginalText ?? btn.textContent;
      btn._resetOriginalText = original;
      btn.textContent = msg;
      btn.classList.add('settings-link-applied');
      if (btn._resetFeedbackTimer) clearTimeout(btn._resetFeedbackTimer);
      btn._resetFeedbackTimer = setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('settings-link-applied');
        btn._resetFeedbackTimer = null;
      }, 1600);
      resetFeedbackTimers.add(btn._resetFeedbackTimer);
    }
    function clearAllResetFeedbackTimers() {
      for (const t of resetFeedbackTimers) clearTimeout(t);
      resetFeedbackTimers.clear();
    }

    // 恢复默认 - 仅更新 UI
    resetBtn.addEventListener('click', async () => {
      let defaultDir;
      try {
        defaultDir = await window.api.getDefaultDataDir();
      } catch (e) {
        console.warn('[settings] getDefaultDataDir 失败:', e);
        if (!signal.aborted) toast('获取默认目录失败：' + (e.message || e), 'error', 3000);
        return;
      }
      // dialog 已关 → 不再操作 detached DOM，也不发 toast（dialog 都关了用户看不到）
      if (signal.aborted) return;
      inputEl.value = defaultDir;
      inputEl.dataset.userChanged = '1';
      inputEl.dataset.resetToDefault = '1';
      flashResetFeedback(resetBtn);
      toast('将在点击「完成」后恢复默认', 'info', 1500);
    }, { signal });

    // 恢复全部默认 - 立即应用其他设置（主题 + 字号 + 备份 + 三个插入位置），UI 标记 dataDir 待重置
    // 始终置顶由工具栏按钮 / 托盘菜单控制，不在设置面板里改
    resetAllBtn.addEventListener('click', () => {
      setSegActive('dark');
      inputEl.dataset.pendingTheme = 'dark';
      setFontSizeActive('medium');
      inputEl.dataset.pendingFontSize = 'medium';
      document.body.dataset.fontSize = 'medium';
      setColorStyleActive('indigo');
      inputEl.dataset.pendingColorStyle = 'indigo';
      document.body.dataset.colorStyle = 'indigo';
      setBackupActive(true);
      inputEl.dataset.pendingBackupEnabled = '1';
      // 六个 *Position 设置全部回到默认 'front'
      inputEl.dataset.newTaskPosition = 'front';
      inputEl.dataset.completedPosition = 'front';
      inputEl.dataset.uncompletePosition = 'front';
      inputEl.dataset.trashPosition = 'front';
      inputEl.dataset.restorePosition = 'front';
      inputEl.dataset.movePosition = 'front';
      for (const key of ['newTaskPosition', 'completedPosition', 'uncompletePosition', 'trashPosition', 'restorePosition', 'movePosition']) {
        const seg = overlay.querySelector(`[data-setting="${key}"]`);
        if (!seg) continue;
        seg.querySelectorAll('.seg-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.value === 'front');
        });
      }
      inputEl.dataset.userChanged = '1';
      inputEl.dataset.resetToDefault = '1';
      window.api.getDefaultDataDir().then((dir) => {
        // dialog 已关（用户在 IPC 期间按 Esc / 点 X）→ 不写 detached DOM，
        // 与同文件 line 311 / 319 / 326 / 333 等其它 getDataDir / getDefaultDataDir
        // 异步回调同款守卫。原代码漏了这个守卫，dialog 关掉后仍往 detached
        // inputEl.value 写入默认目录 —— 闭包拖住整个 dialog 状态到 GC 才释放。
        if (signal.aborted) return;
        inputEl.value = dir;
      }).catch((e) => {
        // v4+ 修复：缺 .catch → 失败冒 unhandled rejection；与 line 335/新加 line 311
        // 的兜底同款思路 —— dialog 已关就静默，留着 inputEl.value 不变即可。
        if (signal.aborted) return;
        console.warn('[settings-dialog] getDefaultDataDir failed:', e?.message || e);
      });
      flashResetFeedback(resetAllBtn, '✓ 已恢复全部');
      toast('将在点击「完成」后恢复全部默认', 'info', 1500);
    }, { signal });

    // 完成 - 统一应用所有更改
    const finish = async () => {
      if (closed) return;
      ac.abort();
      closed = true;  // 立即置位：保证 cancel 在 await 期间再来时不会重跑动画 + 不会
                      // 重复触发 update（更新盘 + reload 都靠 await 期间的状态同步）
      // 同 cancel：清掉所有 reset 反馈定时器，避免 timer 写 detached 节点。
      clearAllResetFeedbackTimers();
      let needReload = false;
      const updates = {};

      // 检测数据目录是否改变
      const before = inputEl.dataset.current || '';
      const after = inputEl.value || '';
      const wantsDefault = inputEl.dataset.resetToDefault === '1';
      if (inputEl.dataset.userChanged === '1' && (before !== after || wantsDefault)) {
        updates.dataDir = wantsDefault ? null : after;
        needReload = true;
      }

      // 主题
      if (inputEl.dataset.pendingTheme && inputEl.dataset.pendingTheme !== initial.theme) {
        updates.theme = inputEl.dataset.pendingTheme;
      }

      // 字体大小
      if (inputEl.dataset.pendingFontSize && inputEl.dataset.pendingFontSize !== (initial.fontSize || 'medium')) {
        updates.fontSize = inputEl.dataset.pendingFontSize;
      }

      // 配色风格（与 fontSize 同款比较模式：未点 = undefined 不进 updates）
      if (inputEl.dataset.pendingColorStyle && inputEl.dataset.pendingColorStyle !== (initial.colorStyle || 'indigo')) {
        updates.colorStyle = inputEl.dataset.pendingColorStyle;
      }

      // 每日自动备份开关 —— 用 pendingBackupEnabled（'1'/'0'）而不是 seg-btn 的 dataset.value，
      // 这样「从未点过」也能被识别：未点 → dataset 上没这个属性 → 不进 updates；
      // 点过 → 进 updates 并触发持久化。注意 boolean 比较要 coerce
      if (inputEl.dataset.pendingBackupEnabled !== undefined) {
        const newBackup = inputEl.dataset.pendingBackupEnabled === '1';
        if (newBackup !== Boolean(initial.backupEnabled)) {
          updates.backupEnabled = newBackup;
        }
      }

      // 任务插入位置（前面 / 后面）—— 与 backupEnabled 同款策略：
      //   - 用户**从未点过** → dataset 上没对应属性 → 不进 updates，避免把默认值误写盘
      //   - 用户**点过** → 与 initial 对比，变了才进 updates
      // 注意 isValidValue 已经把 'front' / 'back' 之外的值拒掉，这里不重复校验
      for (const key of ['newTaskPosition', 'completedPosition', 'uncompletePosition', 'trashPosition', 'restorePosition', 'movePosition']) {
        const pending = inputEl.dataset[key];
        if (pending === undefined) continue;
        const initialVal = initial[key] || 'front';
        if (pending !== initialVal) {
          updates[key] = pending;
        }
      }

      if (Object.keys(updates).length > 0) {
        // settingsStore.update 会同步触发 'change' 事件：
        //   - toolbar.js 的 'change' 监听器负责更新 store.theme 和 body.dataset.theme
        //     （通过 this.store.resolveTheme()），无需在这里重复赋值
        //   - app.js 的 'change' 监听器负责同步 fontSize 到 body.dataset.fontSize
        // 直接 store.theme = updates.theme 是死代码 —— Toolbar 监听器已在同一同步帧
        // 内通过 resolveTheme() 做了相同的事，重复赋值只会让后续维护者困惑
        try {
          await settingsStore.update(updates);
        } catch (e) {
          // 持久化失败（盘满、权限等）：不要吞掉，得让用户知道。
          // toolbar.js 已订阅 save-error 并 toast，这里再抛一次以保留 Promise reject 链
          toast(`设置保存失败：${e.message || e}`, 'error', 4000);
          // 仍然关闭面板 —— 用户已经在 UI 上看到了预览态，留着不让关只会让他们更迷惑
        }
      }

      // 缩放淡出后再 remove（与 confirmDialog/inputDialog 同款），焦点恢复
      // 必须在 animationend 内 —— 否则 focus 的元素已经被销毁，焦点跳到 body。
      // focus() 必须在 overlay.remove() 之前（见 feedback.js 同款注释）。
      const inner = overlay.querySelector('.modal');
      const finalize = () => {
        if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
          previouslyFocused.focus();
        }
        overlay.remove();
        settle({ changed: needReload });
      };
      if (inner) {
        inner.classList.add('is-closing');
        inner.addEventListener('animationend', finalize, { once: true });
        // 兜底必须 settle：否则 animationend 漏触发会让 Promise 永久挂起
        setTimeout(finalize, 250);
      } else {
        finalize();
      }
    };

    // 单一 AbortController 统一回收所有监听器
    // （已经在函数顶部创建 —— 这里只是保留引用，方便 finish() 也能 abort）

    const cancel = () => {
      if (closed) return;
      ac.abort();
      closed = true;  // 同 finish()：先置位，再做恢复
      // 关 dialog 时清掉所有 reset 反馈定时器 —— 否则 timer 在 detached 节点上
      // 继续写 .textContent / .classList，闭包把整个 dialog 状态拖到 GC 才释放。
      clearAllResetFeedbackTimers();
      // 恢复预览的主题（如果用户点过主题按钮的话）
      if (inputEl.dataset.pendingTheme) {
        document.body.dataset.theme = originalResolvedTheme;
      }
      // 恢复预览的字体大小（如果用户改过字号的话）—— 之前只回滚主题，
      // 用户改了字号就留下了"看似应用、点取消又改回去"的视觉副作用。
      if (inputEl.dataset.pendingFontSize) {
        document.body.dataset.fontSize = originalFontSize;
      }
      // 恢复预览的配色风格（如果用户改过配色的话）
      if (inputEl.dataset.pendingColorStyle) {
        document.body.dataset.colorStyle = originalColorStyle;
      }
      // 同 finish()：缩放淡出后 remove + 焦点恢复 + settle
      // shared resolved 守卫：若 finish 已先动，settle 跳过，cancel 不重复 resolve
      const inner = overlay.querySelector('.modal');
      const finalize = () => {
        if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
          previouslyFocused.focus();
        }
        overlay.remove();
        settle({ changed: false });
      };
      if (inner) {
        inner.classList.add('is-closing');
        inner.addEventListener('animationend', finalize, { once: true });
        // 兜底必须 settle（同 finish()）
        setTimeout(finalize, 250);
      } else {
        finalize();
      }
    };

    overlay.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'done') finish();
      else if (action === 'cancel' || e.target === overlay) cancel();
    }, { signal });

    const onKey = (e) => {
      if (e.key === 'Escape') {
        // IME 守卫：CJK/JP/KR 用户按 Esc 通常是「取消 IME 组合」（结束选词），
        // 不是「关闭对话框」。不挡掉会让 Esc 同时关掉 IME 和设置对话框，
        // 用户连保存按钮都还没看到就被踢回主界面。
        if (isImeComposing(e)) return;
        cancel();
      } else if (e.key === 'Enter' && !isImeComposing(e)) {
        // Enter 提交：与点「完成」按钮等价。本对话框没有可编辑的文本输入框
        // （数据目录是 readonly + 选择按钮 + checkboxes + radios + 分段按钮），
        // 所以 Enter 一律视为"确认"。readonly input 上 Enter 默认无行为、
        // 之前需要抬手找鼠标点"完成"；统一在键盘层兜底。
        //
        // isImeComposing 守卫：防御性地拦截中文输入法选词时的回车提交
        // （与 feedback.js / conflict-dialog.js / import-dialog.js 对齐）。
        finish();
      }
    };
    document.addEventListener('keydown', onKey, { signal });

    // 注意：不能在这里对 input 做 stopPropagation —— 那样会阻止上面的
    // document keydown listener（onKey）接收到 Escape，导致输入框内按 Esc
    // 无法关闭对话框。全局快捷键（app.js）已经通过检测 .modal-overlay 跳过，
    // 不需要我们在这里手动拦截冒泡。
  });
}
