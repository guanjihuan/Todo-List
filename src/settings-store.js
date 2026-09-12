// 设置存储 - 内存状态管理 + 事件

import { EventEmitter } from './event-emitter.js';

/**
 * 默认设置
 * 注意：默认数据目录采用 ~/TodoList（用户主目录下的 TodoList），
 * 跨平台由主进程解析 —— Windows 上就是 %USERPROFILE%/TodoList。
 *
 * filter / sortBy：全局偏好，跨分类生效。重启后恢复上次选择。
 * 合法值：filter ∈ {all, current, completed, important}
 *        sortBy ∈ {manual, alphabet}
 *
 * backupEnabled：每日自动备份开关。默认开启，开启后首次使用当天
 *   自动在 <dataDir>/backup/ 下生成 todo-YYYY-MM-DD.md。
 *   主进程单独维护 lastBackupDate（YYYY-MM-DD）记入 config.json，
 *   它不在 DEFAULT_SETTINGS 里 —— 不属于「用户偏好」而是「内部进度」。
 *
 * *Position 五件套：控制「最新一条」落到列表的哪个位置。
 *   - newTaskPosition     新增任务的落点（addTask）
 *   - completedPosition   [✓] 打勾后任务搬到「已完成任务」分类时的落点
 *                         （toggleTask / batchToggleCompleted(true)）
 *   - uncompletePosition  取消勾选：已完成任务重新激活、回到原分类时的落点
 *                         （toggleTask 取消勾选 / restoreCompletedTask / picker 强制降级路径）
 *   - trashPosition       删除任务搬到「回收站」时的落点
 *                         （deleteTask / batchDeleteTasks / clearCompleted）
 *   - restorePosition     回收站任务恢复到原分类时的落点
 *                         （restoreTask 的 category / fallback 分支；picker hint 不动任务不读）
 *   - movePosition        右键「移到分类…」/ 批量「移到分类」时的落点
 *                         （moveTask / batchMoveTasks 的 toIndex < 0 分支；拖拽指定 toIndex 时不读）
 *   合法值都是 'front' | 'back'。默认 'front'（最新在最上面）—— 与用户对「最近的事应该一眼看到」
 *   的预期一致；切到 'back' 就是经典追加语义。设置由 TaskStore._appendTaskWithPosition
 *   在每次插入时实时读取 —— 用户切换设置后下一条新任务立即生效，已存在的任务不会被回溯重排。
 *   moveTask 不读任何 *Position：用户主动拖拽指定了 toIndex，落点由用户决定。
 *
 * importPosition（独立于五件套之外）：导入任务的顺序偏好。
 *   - 与 newTaskPosition / completedPosition **完全解耦**。用户在导入对话框内
 *     单独调整，UI 仅在导入窗口暴露 —— 不进主设置面板。
 *   - 合法值只有两个：
 *       'order'（默认）：按入参顺序插入到目标位置的最前面 —— 第一行排到最上，
 *         符合「前面的内容在前」的直觉。
 *       'front'         ：倒序插入到目标位置的最前面 —— 最后一行落在最上面。
 *   - 注意：导入对话框**不再**暴露「追加到末尾」选项。理由是它与全局
 *     newTaskPosition='back' 行为完全重叠 —— 导入对话框只管「顺序」这件事，
 *     「落点位置」由全局设置决定，避免职责重复。
 *   - 默认 'order'：粘贴多行文本时，第一行天然排到最前，符合「按输入顺序查看」的直觉；
 *     旧版默认走 newTaskPosition='front'，导致最后一行跑到最前面，与用户的输入顺序
 *     相反，让人困惑。
 */
const DEFAULT_SETTINGS = {
  dataDir: null,           // null 表示使用主进程默认值（~/TodoList）
  theme: 'dark',           // dark | light | auto
  filter: 'all',           // 全局默认过滤
  sortBy: 'manual',        // 全局默认排序
  fontSize: 'medium',      // small | medium | large
  colorStyle: 'indigo',    // 配色风格：indigo | ocean | forest | sunset | rose | mono
                            // 与 theme 正交：每种配色都包含浅色和深色两个变体
  backupEnabled: true,     // 每日自动备份开关（默认开启）
  alwaysOnTop: false,      // 窗口始终置顶（默认关闭，重启后由主进程按此值恢复）
  // v4+：插入位置偏好。新增 / 完成 / 取消完成 / 删除 / 恢复 五种动作分别落到 front（最新在最上）或 back（最新在最下）。
  newTaskPosition: 'front',
  completedPosition: 'front',
  uncompletePosition: 'front',
  trashPosition: 'front',
  restorePosition: 'front',
  // v4+：移到分类（右键菜单 / 批量移到分类）时任务的落点。
  // 拖拽（指定了 toIndex）不受此设置影响 —— 落点由用户手指决定。
  movePosition: 'front',
  // 导入任务的顺序偏好（独立于五件套）—— 见上方注释。默认值 'order'。
  importPosition: 'order'
};

// 每个字段允许的值集合：用于 update / load 的白名单校验。
// null 仅 dataDir 允许（语义是「恢复默认」）；其它字段必须是合法字符串之一。
// backupEnabled / alwaysOnTop 是布尔值，由 isValidValue 单独分支处理（不进 VALID_VALUES）。
const VALID_VALUES = {
  theme: ['dark', 'light', 'auto'],
  filter: ['all', 'current', 'completed', 'important'],
  sortBy: ['manual', 'alphabet'],
  fontSize: ['small', 'medium', 'large'],
  colorStyle: ['indigo', 'ocean', 'forest', 'sunset', 'rose', 'mono'],
  newTaskPosition: ['front', 'back'],
  completedPosition: ['front', 'back'],
  uncompletePosition: ['front', 'back'],
  trashPosition: ['front', 'back'],
  restorePosition: ['front', 'back'],
  movePosition: ['front', 'back'],
  // 导入任务的顺序偏好 —— 与五件套解耦，多了一个 'order' 选项。导入对话框内独享。
  // 只剩两个值：'order'（正序 + 最前）和 'front'（倒序 + 最前）。
  importPosition: ['order', 'front']
};

// 字段值迁移表 —— 老配置值 → 新配置值。load() 时把旧 enum 名翻译到新 enum 名，
// 而不是 silently 退回默认值：用户上次选的过滤方式不该因为 enum 改名就丢失。
// 当前唯一迁移：filter 的 'pending' → 'current'（v3.x 之前 PENDING 语义被替换为
// CURRENT —— 从「未完成」改为「[▶] 标记」，与「当前任务」智能列表对称）。
// 后续再有 enum 改名，在此追加；白名单不变（VALID_VALUES 是新值集合）。
const VALUE_MIGRATIONS = {
  filter: { 'pending': 'current' }
};

function isValidValue(key, value) {
  if (key === 'dataDir') return value === null || typeof value === 'string';
  // 布尔字段单独校验 —— 字符串 / 数字 / 任何非 boolean 一律拒绝，
  // 否则 update({backupEnabled: 'true'}) 这类会污染内存 + 下次保存固化为字符串
  // alwaysOnTop 同样走 boolean 通道 —— 任何非布尔（含 'true' 字符串）都拒掉。
  if (key === 'backupEnabled' || key === 'alwaysOnTop') return typeof value === 'boolean';
  return typeof value === 'string' && VALID_VALUES[key]?.includes(value);
}

export class SettingsStore extends EventEmitter {
  constructor() {
    super();
    this._settings = { ...DEFAULT_SETTINGS };
    this._loaded = false;
  }

  /**
   * 从主进程异步加载设置
   */
  async load() {
    try {
      const persisted = await window.api.getSettings();
      if (persisted && typeof persisted === 'object') {
        // 仅保留 DEFAULT_SETTINGS 中已定义且值合法的字段，防止脏数据
        // （主进程 saveConfig 端已对写入侧做了白名单，但加载侧仍要兜底：
        //  配置文件可能被用户直接编辑成 `theme: null` 之类的非法值，
        //  与 update 一样会污染内存 + 下次保存把脏值固化进文件）
        const sanitized = {};
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
          if (!(key in persisted)) continue;
          let v = persisted[key];
          // 1) enum 改名迁移：旧值 → 新值，发生在白名单校验之前，
          //    否则 'pending' 这种合法类型但合法值已下线的值会被直接丢掉。
          const migration = VALUE_MIGRATIONS[key];
          if (migration && Object.prototype.hasOwnProperty.call(migration, v)) {
            v = migration[v];
          }
          // 2) 白名单校验（类型 + 在枚举内），通过后才落地内存
          if (!isValidValue(key, v)) continue;
          sanitized[key] = v;
        }
        this._settings = { ...DEFAULT_SETTINGS, ...sanitized };
      }
    } catch (e) {
      console.warn('[settings] 加载失败，使用默认值:', e.message);
    }
    this._loaded = true;
    this.emit('load', this._settings);
    return this._settings;
  }

  /**
   * 获取当前设置（不可变副本）
   */
  get all() {
    return { ...this._settings };
  }

  get(key) {
    return this._settings[key];
  }

  /**
   * 更新一个或多个设置项
   *
   * 持久化失败时：内存状态已经改了（用户看到的设置立刻生效），但落盘失败 →
   * 下次启动会回到旧值。必须把失败告诉 UI（toast / 日志），否则用户以为保存成功。
   *
   * 输入校验：每个字段只接受明确合法的标量值。
   *   - dataDir：null 是合法语义（恢复默认），字符串也合法；其他类型忽略。
   *   - 其它字段（theme / filter / sortBy / fontSize）：必须是有限个枚举值之一。
   *     之前仅校验「值 !== 当前值」，于是 `update({ theme: null })` 之类调用
   *     会把内存里的 theme 抹成 null —— UI resolveTheme() 虽能兜底返回 'dark'，
   *     但 this._settings.theme 仍为 null，比较 `this._settings[k] !== v` 时会
   *     跟正常字符串凑出意外行为，且下次保存会把脏值写入配置文件，旧用户的设置
   *     从此被静默损坏。
   */
  async update(partial) {
    const updates = {};
    for (const [k, v] of Object.entries(partial)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      if (!isValidValue(k, v)) continue;
      if (this._settings[k] !== v) {
        this._settings[k] = v;
        updates[k] = v;
      }
    }
    if (Object.keys(updates).length === 0) return false;

    // v4+ 修复：先持久化再 emit（顺序换了，但 emit 本身两条路径都发）。
    // 旧实现先 emit 后 await _persist()，意味着 'change' 监听器（典型如 toolbar.js:89
    // 监听 dataDir 变化后立刻 window.api.getDataDir()）会在主进程还没把新值落盘时就
    // 跑到 IPC 那侧读 dataDir —— 主进程的 in-memory cache 与磁盘状态之间存在竞态，
    // 用户"刚刚改了数据目录"立刻新建文件，可能仍写到旧目录下。
    // 持久化后再 emit：UI 视觉延迟 ≈ 一次 IPC（几毫秒），用户无感；race 消失。
    //
    // 关键：失败时**仍然要 emit 'change'**。内存已经改了（上面的循环无条件写
    // this._settings），如果失败就不发 change，body.dataset.fontSize / colorStyle
    // 这些只在 change 里同步的字段会永远停在旧值 —— 内存说 large、界面显示 medium，
    // 而且后续某次成功的 update 只带它自己改的 key，fontSize 再也没机会补上。
    // 所以：change 照发（UI 与内存一致），再补一条 save-error 告诉用户「没落盘，
    // 重启会回滚」。两个事件语义不同，各司其职。
    const ok = await this._persist();
    this.emit('change', { changed: Object.keys(updates), settings: this.all });
    if (!ok) {
      // 让 UI 知道：内存更新成功但磁盘写入失败 —— 重启后会回到旧值
      this.emit('save-error', { failed: Object.keys(updates) });
    }
    return ok;
  }

  get loaded() {
    return this._loaded;
  }

  async _persist() {
    try {
      await window.api.saveSettings(this._settings);
      return true;
    } catch (e) {
      console.error('[settings] 保存失败:', e.message);
      return false;
    }
  }
}
