// 任务存储 - in-memory 状态管理 + 事件
//
// v3.4 「已完成任务」升级为真实分类：
//   当前任务（智能视图，跨子分类聚合 current=true 的任务；v2 的真实分类已下沉为 @当前 标识）
//   重要任务（智能视图，跨子分类聚合 important=true 的任务）
//   全部任务（kind=OTHER_TASKS，容器；聚合视图含 当前任务 + 子分类）
//     工作 / 学习 / 生活 / 未分类 / 用户自定义子分类（kind=NORMAL, parentOtherTasks=true）
//   已完成任务（kind=COMPLETED，**真实分类** —— [✓] 打勾后任务自动移动到这里，
//               取消勾选则回到它原来的分类（[原分类：xxx]，v3.5+ 由 toggleTask 写入）。
//               原分类丢失时弹分类选择器；任务没有原分类记录才兜底到「未分类」。
//               与回收站语义对称：删除→回收站，完成→已完成任务。
//               「已完成任务」智能视图直接读这个分类，不再跨子分类聚合）
//   回收站（kind=TRASH，删除的任务落点；排除于全部智能视图之外）
//
// 任务字段：text / completed / important / current
//
// 数据归属与状态同步不变量（v3.4 新增）：
//   - completed=true 的任务**只能**活在 kind=COMPLETED 分类
//   - completed=false 的任务**只能**活在 kind=NORMAL 子分类
//   - 由 toggleTask / batchToggleCompleted / restoreTask / moveTask 共同维护
//   - 加载时由 _migrateCompletedTasksToCategory 一次性归位旧文件
//
// v2 → v3 迁移：
//   旧文件 `# 当前任务` 章节下的任务会被搬到首个子分类并打上 current=true 标记，
//   然后删除临时分类。下一次保存即扁平化为新结构。
//
// v3 → v3.4 迁移：
//   旧文件里散落在各子分类的 [✓] 任务会被搬到新的「# 已完成任务」分类，
//   下一次保存即统一为新结构。

import {
  parseMarkdown,
  CategoryKind,
  TODAY_KEYS,
  OTHER_TASKS_KEYS,
  TRASH_KEYS,
  COMPLETED_KEYS,
  OTHER_TASKS_NAME,
  TODAY_CANONICAL_NAME,
  UNCATEGORIZED_NAME,
  TRASH_NAME,
  COMPLETED_NAME,
  extractInlineMarkers,
  TASK_LINE_RE,
  isCompletedMarker
} from './markdown-parser.js';
import { writeMarkdown, createDefaultDoc } from './markdown-writer.js';
import { EventEmitter } from './event-emitter.js';
import {
  diffCategories as diffCategoriesUtil,
  applyResolutions as applyResolutionsUtil,
  defaultResolutions as defaultResolutionsUtil,
  summarizeDiff as summarizeDiffUtil
} from './utils/markdown-diff.js';

// 规范名常量的单一定义点在 markdown-parser.js（依赖树叶子，避免循环依赖）。
// 这里 re-export 以保持既有 import 路径可用（settings-dialog / sidebar 等仍从 task-store 取）。
export { OTHER_TASKS_NAME, TODAY_CANONICAL_NAME, UNCATEGORIZED_NAME, TRASH_NAME, COMPLETED_NAME };

// 导入顺序偏好的合法值集合 —— 与 settings-store.VALID_VALUES.importPosition 对齐。
// 集中在一处保证：调用方 options.importPosition 覆盖 + 内部 _getInsertPosition('import')
// + 批量路径分支判断共用同一份白名单。'order' 比五件套多出来，是导入场景独有
// 的「按入参顺序插到目标位置最前面」语义（参见 settings-store.js DEFAULT_SETTINGS 注释）。
//
// 只有两种合法值：'order'（默认，正序 + 插到最前）和 'front'（倒序 + 插到最前）。
// 历史上曾有 'back'（正序 + 追加到末尾），但和全局 newTaskPosition='back' 行为完全重叠，
// 让导入对话框与全局设置重复承担「位置」职责 —— 删除。
const VALID_IMPORT_POSITION = new Set(['order', 'front']);

// 显示过滤器
// IMPORTANT: 仅显示标记为 ⭐ 的任务（与侧边栏「重要任务」智能列表同语义，
// 但作用范围限定为「当前分类」——用于快速聚焦当前分类下的重点项）
//
// CURRENT 取代了旧 PENDING（"待办"/!completed）的位置 —— 用户的 Todo List 心智是
// "我此刻在做什么"（[▶] current=true），而"待办"在中文里歧义大（可以指任何未完成
// 的任务，跟 pending 的语义不对齐）。CURRENT 的语义与「当前任务」智能列表（侧边栏）
// 对称：智能视图是跨分类聚合，过滤是当前分类下聚焦。
export const Filter = Object.freeze({
  ALL: 'all',
  CURRENT: 'current',
  COMPLETED: 'completed',
  IMPORTANT: 'important'
});

// 排序方式
// 按字母排序时，未完成的任务在前、已完成的在后（已完成的仍按字母排），
// 避免「未完成 ↔ 已完成」穿插导致的视觉混乱
export const SortBy = Object.freeze({
  MANUAL: 'manual',
  ALPHABET: 'alphabet'
});

// 「全部任务」容器的固定名称、「当前任务」规范名、「未分类」兜底名，
// 以及保留分类名列表（TODAY_KEYS / OTHER_TASKS_KEYS）—— 全部在文件顶部
// 从 markdown-parser.js 引入并 re-export，此处不再重复定义。

/**
 * 解析一行粘贴文本 → 一条待导入任务。
 *
 * 规则（按顺序）：
 *   1. trim 当前行；空行返回 null（由调用方计入 skipped）
 *   2. 行匹配 `- [ ]` / `- [✓]` 等 Markdown checkbox：
 *      - completed = ([✓]/[x]/[X]) 为 true
 *      - text = 剩余部分 trim（允许为空：`- [x]` 与 parseMarkdown 行为一致）
 *      注意：**不剥离**前导的 `- ` —— 它是 checkbox 的一部分而不是列表符号。
 *   3. 否则若 stripLeadingBullets === true：去掉前导的列表符号
 *      （`-` / `*` / `+` / `•` / `数字.` / `数字)`），保留剩余文本。
 *   4. 否则原样使用 trim 后的文本，completed 默认为 false。
 *   5. 解析完 checkbox / 列表符号后，调用 extractInlineMarkers 把文本里的
 *      [⭐] / [▶] / 裸 ⭐ / @当前 等标记翻译成 important / current 字段
 *      （与 parseMarkdown 完全一致 —— 不在导入时翻译就会留下「文本里写着
 *      [⭐]，但 important=false；下次保存时 parseMarkdown 又把 [⭐] 抽走」
 *      的诡异状态）。
 *
 * 中文标点 `、` / `。` / `；` 不是列表符号 —— `1.` 才会触发（要求前面至少一个数字）。
 *
 * 纯函数：被 importTasksToCategory 与导入对话框的实时预览共用，确保
 * 「预览说能导入 N 条 → 点确认也导入 N 条」。
 *
 * @param {string} rawLine
 * @param {{ stripLeadingBullets?: boolean }} [options]
 * @returns {{ text: string, completed: boolean, important?: boolean, current?: boolean, originalCategory?: string|null } | null}
 */
export function parseImportLine(rawLine, options = {}) {
  const strippedLeadingBullets = options.stripLeadingBullets !== false; // 默认 true
  const line = (rawLine || '').trim();
  if (!line) return null;

  // 1) Markdown checkbox 行 —— 必须先匹配，否则 `- [ ] foo` 会先被当作
  //    「带列表符号的列表项」剥掉前导 `- `，剩下 `[ ] foo`，用户期望的勾选状态就丢了。
  //    与 markdown-parser.js 对齐：[✓]/[x]/[X] 视为已完成；`[ ]` 视为未完成；
  //    括号里其它字符（如旧的 [!high]）一律视为未完成，标记本身已不再解析为元数据。
  //    文本部分允许为空（合法手写 `- [x]`，与 parseMarkdown 行为一致 —— 文件 load 会
  //    保留它，导入却悄悄丢掉会让用户数据「莫名消失」）。
  const checkboxMatch = line.match(TASK_LINE_RE);
  if (checkboxMatch) {
    const marker = checkboxMatch[1];
    const completed = isCompletedMarker(marker);
    let text = (checkboxMatch[2] || '').trim();
    // 把文本里的 [⭐] / [▶] / 裸 ⭐ 等 inline 标记翻译成 important / current 字段，
    // 然后从 text 中剥掉 —— 与 parseMarkdown 完全一致，避免「导入后文本里留着 [⭐]、
    // 但 important=false；下次保存时 parseMarkdown 又把 [⭐] 抽走」的诡异状态。
    const markers = extractInlineMarkers(text);
    return {
      text: markers.text,
      completed,
      important: markers.important,
      current: markers.current,
      originalCategory: markers.originalCategory
    };
  }

  // 2) 普通列表符号剥离（仅在选项开启时）
  let coreText;
  if (strippedLeadingBullets) {
    // 无序列表：` - foo` / `* foo` / `+ foo` / `• foo`
    // 有序列表：`1. foo` / `2) foo` —— 必须前面至少一个数字，避免吃掉以小数点结尾的标题
    const bulletMatch = line.match(/^(?:[-*+•]|\d+[.)])\s+(.*)$/);
    if (bulletMatch) {
      coreText = bulletMatch[1].trim();
      if (!coreText) return null;
    } else {
      coreText = line;
    }
  } else {
    coreText = line;
  }

  // 3) 与 parseMarkdown 一致：抽取 inline 标记（[⭐] / [▶] / 裸 ⭐ / @当前 等）
  //    —— 这样导入后任务的 important / current 字段正确，文本里也不会残留 [⭐] 字符。
  const markers = extractInlineMarkers(coreText);
  return {
    text: markers.text,
    completed: false,
    important: markers.important,
    current: markers.current,
    originalCategory: markers.originalCategory
  };
}

/**
 * 共享常量：parser 用的 kind 名 + 保留分类的中文显示名。
 * 集中放在这里避免任务列表、写作器、迁移逻辑各自硬编码「已完成任务」/「回收站」。
 */

export class TaskStore extends EventEmitter {
  // 任务插入位置 helper 用到的常量 —— 提至模块顶层以便外部 reference 测试用。
  // 与 settings-store 的 VALID_VALUES.newTaskPosition / completedPosition / trashPosition 对齐。
  static POSITION_FRONT = 'front';
  static POSITION_BACK = 'back';

  constructor(options = {}) {
    super();
    // settingsStore 可选：注入后 _appendTaskWithPosition 才能读到 *Position 偏好。
    // 缺省时按 DEFAULT_SETTINGS 默认值（front）走，等价于没开设置 —— 让单测 fixture
    // （makeStore()）不用关心这个依赖，老调用方 new TaskStore() 仍然有效。
    this._settingsStore = options.settingsStore || null;
    this.filePath = null;
    this.categories = [];
    this.selectedCategoryName = null;
    this.selectedSmartList = null;   // 'important' | 'allTasks' | 'completed' | null
    this.searchQuery = '';
    // 缓存 searchQuery 的小写版，避免每次渲染都 toLowerCase()（详见 setSearchQuery）
    this._searchQueryLower = '';
    this.filter = Filter.ALL;
    this.sortBy = SortBy.MANUAL;
    this.theme = 'dark';
    this.dirty = false;
    this._suppressDirty = false;

    // v4 起全实时同步：移除 800ms debounce。每次 _markDirty 直接走
    // _scheduleAutoSave → _doAutoSave；有 in-flight 写正在进行时新改动走
    // 「_needsResave 标记 → finally 里再补一次写」的合并路径，避免并发写。
    // 保留 _autoSave 属性 + cancel/flush 接口仅为兼容旧测试 mock 写法
    // （测试赋值为 () => {} 即可关闭自动保存，无需关心 cancel/flush）。
    this._autoSave = Object.assign(
      () => this._scheduleAutoSave(),
      { cancel() {}, flush() {} }
    );
    // 写入代次计数器：每次 _doAutoSave / saveNow 启动时 +1，并随 await 一并保留。
    // 写完回来时，如果当前代次已被自己推过（即用户在被 await 期间又改过东西，
    // _markDirty 又跑了一次 _doAutoSave），就把 dirty 复位 / emit('dirty', false) 推迟，
    // 留给下一次自动保存处理。否则会发生：
    //   用户改 A → autoSave 启动 → await writeFile（在这期间用户改 C）
    //   → writeFile 返回 → dirty=false / emit('dirty', false)
    //   → 但 C 还在内存里没写出去，UI 已显示「已同步」 → 下次重启 C 凭空消失。
    // 取消外部写入时也用同一机制：把当前代次 +1 让 in-flight 的 await 醒来后认作过期。
    this._writeGeneration = 0;
    this._inFlightGeneration = 0;
    // 「脏版本」计数器 —— 与 _writeGeneration 互补：
    // _writeGeneration 只在 _doAutoSave / saveNow 启动时 +1，能捕捉「另一个 save 已接力」。
    // 但 _markDirty 只推 _dirtyVersion + 设 dirty=true + 触发 schedule，await 期间如果
    // 用户又改了东西，_writeGeneration 没动，generation 检查会通过；这时必须靠
    // _dirtyVersion 比对来识别「快照不含最新改动」，否则 dirty=false 被错误地设上。
    this._dirtyVersion = 0;
    // 在 _doAutoSave 已经 await writeFile 期间收到新改动时标记为 true；
    // finally 里检查到就再补一次 _doAutoSave，把 in-flight 期间累积的改动一并写出去。
    // 这是替代原 800ms debounce 的「合并」机制 —— 没有等待窗口，但保证不丢改动。
    this._needsResave = false;

    // ── 细粒度 dirty 追踪（v5 双向同步新增）──
    //
    // 之前 `this.dirty` 只是单一布尔位,UI 拿不到「用户在内存里改了哪些任务 / 哪几个分类」。
    // 双向同步冲突解决需要：
    //   - 列出「本地有 + 文件没有」的任务（用户在 UI 新加的）
    //   - 列出「文件有 + 本地没有」的任务（外部编辑器新加的）
    //   - 列出两边都改了状态的任务（toggle / updateMeta 等）
    //
    // 这里累积受影响的对象 id（task 用 task.id,category 用 cat.name）。
    // 累积 Set 让：
    //   - 用户短时间内多次改同一条任务 → 只算一次改动（避免重复弹 dialog）
    //   - 删除任务时 id 还在 Set 里,供「对话期间又改了 N 项」回查用
    this._dirtyTaskIds = new Set();
    this._dirtyCategoryNames = new Set();
    // 兜底 Set：旧代码里有些路径只在结束时 _markDirty() 但忘了标 task/category id。
    // 这种 dirty=true 但 task/cat Set 都是空的情况,UI 显示「1 项未保存」但无法列出
    // 具体内容。dirty=true 时如果两个 Set 都空,序列化 fallback 会把整个 categories 当作"已改动"。
    this._dirtyStructuralOnly = false;

    // v3.7+ 修复 H6：picker 路径（取消勾选时原分类丢失）记每个 task 的 picker 次数。
    // 旧行为是 picker 路径只返回 restoreHint 不动任务 —— UI 关掉 dialog 后任务
    // 永远卡在 COMPLETED 但 completed=false，下次再 toggle 又走 picker，无限循环。
    // 阈值：同一 task 在 picker 路径停留超过 _PICKER_ATTEMPT_LIMIT 次，
    // 自动降级为 fallback（强制走「未分类」），同时 console.warn 提醒开发者。
    this._pickerAttempts = new Map();
    this._PICKER_ATTEMPT_LIMIT = 3;

    // ── 磁盘快照缓存（v5 新增）──
    //
    // resolveExternalChangeConflict 第一次拿到磁盘内容时存到这里：
    //   - dialog 打开期间 dialog 内的「查看行级 diff」按钮可立即渲染（无需再 IPC）
    //   - dialog 关闭前重新对比时,作为最新已知磁盘状态
    //   - apply 合并前若用户又改了磁盘 → 重新 readFile 刷新这里
    // 关闭 dialog 时清掉,避免常驻内存。
    this.diskSnapshot = null;
  }

  // ============================================
  //  加载 / 保存
  // ============================================

  /**
   * 从 Markdown 内容加载
   */
  loadFromContent(content, filePath = null, options = {}) {
    // options.mergeResolutions - {taskKey: 'a'|'b'|'both'|'skip'}
    //   软合并模式：与新内容 diff 后按选择应用，避免完全覆盖导致用户丢失本地未保存改动。
    //   见 mergeFromDisk() 的语义注释 —— loadFromContent 是「被动接受磁盘内容」，
    //   不重排 selection。
    const mergeResolutions = options && options.mergeResolutions;
    // v4+ 修复：先废掉任何 in-flight 的自动保存。极端竞态：
    //   1) 用户编辑 → _doAutoSave 已 await writeFile 走到一半
    //   2) 用户「打开」或「新建」另一份 todo.md → loadFromContent 替换 categories
    //   3) in-flight 的 writeFile 醒来 → serialize() 已经读到 new categories，
    //      但 fs.writeFile 的 filePath / fd 是另一份的（实际不会，因为 fd 是当时 capture 的）
    // 真正的隐患在 _doAutoSave 醒来后会 `_clearDirtyTracking()` 把 dirty 清零并发
    // 「saved」假象。cancelPendingSave 把代次 +1，让 in-flight 的 await 醒来时
    // 检测到代次对不上、放弃复位 dirty、放弃发「saved」事件。
    // 没这一步，用户切到新文件后看到的状态栏/标题「未保存」标记会闪烁出错，
    // 而且新文件如果走了 setFilePath / path 共享的 IPC，磁盘也可能被覆盖。
    this.cancelPendingSave();
    this._suppressDirty = true;
    try {
      const previousSelected = this.selectedCategoryName;
      const previousSmart = this.selectedSmartList;
      // C4 修复：parseMarkdown 内部抛错会让整个 loadFromContent 在 finally 后中断，
      // 调用方拿不到任何信号 —— UI 继续显示旧数据但用户以为已经重载。
      // 这里单独 try/catch：捕获后抛带类型的 load-failed 事件，让 app.js 走
      // 「.bak 回退」或冲突对话框路径，而不是默默保持旧状态。
      let incomingCategories;
      try {
        incomingCategories = parseMarkdown(content);
      } catch (parseErr) {
        // 关键状态清理：抛出前先把 _suppressDirty 关掉，让后续路径（app.js 的
        // .bak 回退、冲突对话框重试）能用 dirty 标志继续。
        this._suppressDirty = false;
        const err = new Error(`parseMarkdown failed: ${parseErr && parseErr.message || parseErr}`);
        err.code = 'PARSE_FAILED';
        err.originalError = parseErr;
        err.filePath = filePath;
        // 让外层 catch / finally 跑完清理工作，再重新抛错给上层
        this.emit('load-failed', { error: err, filePath, content });
        throw err;
      }

      // 软合并分支：先按用户选择合并 incoming vs 当前内存
      if (mergeResolutions && Object.keys(mergeResolutions).length > 0) {
        const diff = diffCategoriesUtil(incomingCategories, this.categories);
        const merged = applyResolutionsUtil(incomingCategories, diff, mergeResolutions);
        // 顺序归位（含「未分类」拉回末尾 —— 合并可能让兜底位置漂移）
        this.categories = this._normalizeOrder(merged);
        // 合并进来的磁盘任务没有运行时 id —— 重分配（与 mergeFromDisk 一致）
        this._assignTaskIds();
      } else {
        this.categories = incomingCategories;
      }

      this.filePath = filePath;

      // 清掉 picker 计数 —— 旧文件的 task.id 与新文件不一定对得上，
      // 残留计数会让用户在新文件里勾选时一上来就被降级 fallback。
      this._pickerAttempts.clear();

      // v3.6 起不再生成 / 解析顶部 `# 当前任务` / `# 重要任务` 镜像段 —— 任务统一活
      // 在「全部任务」容器的子分类下，[▶]/[⭐] 由 inline 标识驱动，智能视图由 store
      // 在内存中按标识聚合。旧文件里的镜像段由 parser 走 TODAY_KEYS / SMART_LIST_KEYS
      // 路径消化，下次保存即清理。

      this._ensureBaseStructure();

      // 选择分类
      // v3 起没有「当前任务」真实分类 —— 它已下沉为「当前」智能视图（@当前 标识驱动）。
      // 旧文件里的 `# 当前任务` 章节会被 _migrateTodayCategory 迁移走，
      // 加载完 categories 里不再有 kind=TODAY 的项。所以「找不到可还原的选择」时
      // 必须落到智能视图上，而不是去找一个已经不存在 TODAY 分类（会读到 undefined）。
      const stillExists = previousSelected && this.categories.some(c => c.name === previousSelected);
      if (previousSmart) {
        this.selectedSmartList = previousSmart;
      } else if (stillExists) {
        this.selectedCategoryName = previousSelected;
        this.selectedSmartList = null;
      } else {
        // 默认进入「当前」智能视图 —— 用户新建文件后打开，第一眼看到的就是
        // 被打上 @当前 的任务（没有就是空视图，会给提示）。
        this.selectedSmartList = 'current';
        this.selectedCategoryName = null;
      }

      this.dirty = false;

      // 外部编辑文件 → 文件顺序就是用户的最新意图。如果当前是字母序，
      // 渲染时会按字母重排、把用户刚刚在文件里调换的顺序抹掉 —— 这是错误的。
      // 自动切回 MANUAL：用户对文件的改动立刻可见，且和 reorderTask 的语义保持一致
      // （软件内拖拽也会切回 MANUAL）。用户下次想用字母序可以再点一次菜单。
      this._switchToManualSort();

      // 即使 filePath 没变也要发：切换数据目录 / 重载时让底部路径 chip 立即刷新
      this.emit('file-path', this.filePath);
      this.emit('load', { categories: this.categories, merged: !!mergeResolutions });
      this.emit('change');
    } finally {
      this._suppressDirty = false;
      // 这两步必须在 finally 内 —— 否则 parseMarkdown 抛异常时（极端的磁盘文件损坏
      // / parser 死循环等）跑不到，dirty 追踪集合残留。下一次 _markDirty 与旧「已清
      // dirty」状态冲突，自动保存路径误判。emit('dirty', false) 同理：必须保证下次
      // Cmd+Q 看到的是最新的 dirty=false，不再无意义触发空写。
      this._clearDirtyTracking();
      // _suppressDirty 期间 dirty=false 是静默设的，主进程和 UI 都看不见。
      // 这里补一次显式 emit，让退出前的 flush-save 判定不残留旧的「dirty」。
      this.emit('dirty', false);
    }
  }

  /**
   * 创建新的默认文档
   */
  loadDefault(filePath = null) {
    // v4+ 修复：与 loadFromContent / mergeFromDisk 对齐 —— 必须先废掉 in-flight 自动保存，
    // 否则用户在自动保存 await writeFile 期间点"新建"会触发此路径：
    //   1) _doAutoSave 已 await writeFile 走到一半
    //   2) 用户点"新建/打开"另一份 todo.md → loadDefault 替换 categories
    //   3) in-flight 的 writeFile 醒来 → serialize() 已经读到 new categories
    //      （实际不会，serialize 仍 capture 旧 categories），但 _clearDirtyTracking()
    //      会把 dirty 清零并发「saved」假象，新文件加载完后状态栏"未保存"标记
    //      会闪烁出错。
    // 真正的隐患是 in-flight 写完成后的 _clearDirtyTracking 把刚替换的 categories
    // 标成"已保存"，下次 render 会让用户看到的默认模板与磁盘上写出的内容不一致。
    // cancelPendingSave 把当前 in-flight 代次 +1，让 await 醒来时检测到代次对不上
    // 放弃复位 dirty、放弃发「saved」事件。
    this.cancelPendingSave();
    this._suppressDirty = true;
    try {
      this.categories = createDefaultDoc();
      this._assignTaskIds();
      this.filePath = filePath;
      // v3 起没有 TODAY 真实分类 —— 默认进入「当前」智能视图
      this.selectedSmartList = 'current';
      this.selectedCategoryName = null;
      this.dirty = false;
      this._clearDirtyTracking();
      // 同 loadFromContent：让底部路径 chip 跟着刷新（"临时模式" 等场景）
      this.emit('file-path', this.filePath);
      this.emit('load', { categories: this.categories });
      this.emit('change');
    } finally {
      this._suppressDirty = false;
    }
    // 同步 dirty=false 给监听者（理由同 loadFromContent）
    this.emit('dirty', false);
  }

  /**
   * 序列化为 Markdown
   */
  serialize() {
    return writeMarkdown(this.categories);
  }

  setFilePath(filePath) {
    this.filePath = filePath;
    this.emit('file-path', filePath);
  }

  // ============================================
  //  选中
  // ============================================

  selectCategory(name) {
    if (this.selectedCategoryName === name && !this.selectedSmartList) return;
    this.selectedCategoryName = name;
    this.selectedSmartList = null;
    this.emit('select', name);
    this.emit('change');
  }

  /**
   * 选中智能列表（虚拟聚合视图）
   * @param {string} smartKey 'important' | 'allTasks' | 'completed'
   */
  selectSmartList(smartKey) {
    if (this.selectedSmartList === smartKey) return;
    this.selectedSmartList = smartKey;
    this.emit('select', this.selectedCategoryName);
    this.emit('change');
  }

  /**
   * 智能列表定义（图标 + 名称）
   *
   * v3 起「当前任务」也是智能视图 —— 由 @当前 标识驱动，可出现在任意子分类下。
   * 这意味着侧边栏同时存在 当前任务 / 重要任务 / 已完成任务 三个并列的智能视图，
   * 以及「全部任务」容器作为唯一真实数据源。它们都从同一个任务池实时聚合：
   *   - 当前任务：text 末尾带 @当前 的任务
   *   - 重要任务：important=true 的任务
   *   - 已完成任务：completed=true 的任务
   *   - 全部任务：容器本身的视图（点击进入聚合）
   */
  static SMART_LISTS = [
    { key: 'current',    name: '当前任务',   desc: '标记为 [▶] 的任务' },
    { key: 'important',  name: '重要任务',   desc: '标记为 [⭐] 的任务' },
    { key: 'allTasks',   name: '全部任务',   desc: '所有任务（含全部子分类）' },
    { key: 'completed',  name: '已完成任务', desc: '所有已完成的任务' }
  ];

  /**
   * 获取当前选中的「虚拟视图」（实际分类 或 智能列表）
   */
  getSelectedCategory() {
    if (this.selectedSmartList) {
      return this._buildSmartListView(this.selectedSmartList);
    }
    return this.categories.find(c => c.name === this.selectedCategoryName) || null;
  }

  /**
   * 构造一个智能列表视图（伪 category 对象）
   */
  _buildSmartListView(key) {
    const def = TaskStore.SMART_LISTS.find(s => s.key === key);
    const name = def ? def.name : key;
    // collectSmartListTasks 内部已是单次遍历填充四个数组；直接取对应字段即可，
    // 不需要再过一层 _collectSmartListTasks(key) 包装（旧包装每次都重跑整个循环）
    const all = this.collectSmartListTasks();
    const tasks = all[key] ?? [];
    return {
      name,
      kind: CategoryKind.NORMAL,
      isSmartList: true,
      smartKey: key,
      meta: def ? def.desc : '',
      tasks
    };
  }

  /**
   * 一次遍历同时聚合所有智能列表的任务，避免 O(n×m) 渲染
   * 返回 { current: Task[], important: Task[], allTasks: Task[], completed: Task[] }
   *   - current:    @当前 标识的任务（任意子分类下）
   *   - important:  important=true 的任务
   *   - allTasks:   全部子分类下的任务（v3 起不再含 TODAY，因为 TODAY 章节已迁出）
   *   - completed:  [✓] 任务。v3.4 起所有已完成任务只活在一个地方 —— kind=COMPLETED 的
   *                 「# 已完成任务」分类 —— 所以直接读这个分类，不再扫所有子分类。
   *                 任务文本 / 勾选态与子分类下保持完全一致；侧边栏与 task-list 的
   *                 「已完成任务」智能视图都靠它渲染。
   *
   * 容器 / 回收站 / TODAY / 已完成任务(只走 completed 这条) 都被合理排除：
   *   - 容器（OTHER_TASKS）本身不存任务
   *   - 回收站（TRASH）里的任务若还出现在三个聚合视图里，删除就等于没删 ——
   *     用户会在「当前 / 重要 / 已完成 / 全部任务」里反复看见自己刚扔掉的东西
   *   - TODAY 分类虽在 v3 起被迁移走，但加载过程中的瞬态可能存在；显式排除保证
   *     同一份任务在「全部任务」聚合里只出现一次（避免重复计数）
   *   - COMPLETED 已完成任务分类：任务**只**通过 `completed` 字段返回，不再参与
   *     `current` / `important` / `allTasks` 三条聚合 —— 否则同一个已完成任务会同时
   *     出现在「已完成任务」「当前任务」「全部任务」三个智能视图里（current 任务被
   *     勾掉后语义不应该自动从「当前任务」聚合里消失）。
   *
   * 注：v3.4.1 曾尝试把"已完成且标了 ⭐ / ▶"的任务也放进 current/important 聚合，
   * 理由是"⭐/▶ 是任务属性、completed 是阶段性状态、两者正交"。这条语义被既有测试
   * check-md-ui-sync.mjs [13]（"current 视图 2 条（不含已完成的）"）明确否定 —— 用户
   * 完成一条任务后期待它从"当前任务"智能视图消失，而不是与未完成的并排出现。
   *
   * v4.1 起 toggleTask 勾选时**不再**清 task.current（标记是任务级状态，
   * 完成不该擦掉它），所以 "completed + current 共存" 现在是正常 UI 路径就会
   * 产生的数据形态，而不只是手编辑 Markdown 的边缘场景。此处的排除依然成立：
   * 状态被保留在文件与「已完成任务」列表里，只是不参与「当前任务」聚合。
   */
  collectSmartListTasks() {
    const current = [];
    const important = [];
    const allTasks = [];
    const completed = [];
    const completedCat = this.getCompletedCategory();
    for (const cat of this.categories) {
      if (cat.kind === CategoryKind.OTHER_TASKS) continue;
      if (cat.kind === CategoryKind.TRASH) continue;
      if (cat.kind === CategoryKind.TODAY) continue;
      if (cat.kind === CategoryKind.COMPLETED) continue;  // v3.4：已完成的统一从 completedCat 走
      const isSub = !!cat.parentOtherTasks;
      for (const task of cat.tasks) {
        const enriched = { ...task, _fromCategory: cat.name };
        if (task.current) current.push(enriched);
        if (task.important) important.push(enriched);
        if (isSub) allTasks.push(enriched);
      }
    }
    // 已完成任务：直接从 kind=COMPLETED 分类读，附带 _fromCategory 让 UI 知道
    // "这条任务是从哪来的"（用于右键"移动到分类"等场景，与智能列表 enriched 字段对称）。
    if (completedCat) {
      for (const task of completedCat.tasks) {
        completed.push({ ...task, _fromCategory: completedCat.name });
      }
    }
    return { current, important, allTasks, completed };
  }

  getCategory(name) {
    return this.categories.find(c => c.name === name) || null;
  }

  /**
   * 按 kind 查找分类 —— 内部 helper。
   *
   * 之前 6 处「`this.categories.find(c => c.kind === CategoryKind.X)`」散落在：
   *   - getOtherTasksContainer / getTrashCategory / getCompletedCategory（3 个 getter 内部）
   *   - _ensureBaseStructure / _migrateTodayCategory / _ensureOtherTasksContainer
   *     （3 处 inline find —— 容器存在性检查、TODAY 临时分类定位等）
   *
   * 抽到这里让 kind-find 的语义统一在一处：返回**第一个**匹配项（按 categories 数组顺序），
   * 没找到返回 null。所有调用方都假定「第一个」就是「权威」—— 这与 parser 的"reuse first"
   * （line 270-289 那段 h1 复用防御）以及 store 的 _consolidateX 系列（保留数组里第一份）
   * 同源约定。任何重复都会在加载时被 _consolidateX 收敛，所以 find 到的就是稳定的那个。
   *
   * 不要把 filter 也抽成 _filterByKind：_consolidateX 里的 filter 是「枚举所有重复」
   * 语义，与「find 第一个」意图不同，硬抽会让调用方误以为 helper 在去重。
   *
   * @param {string} kind
   * @returns {object|null}
   */
  _findByKind(kind) {
    return this.categories.find(c => c.kind === kind) || null;
  }

  /**
   * 获取「其他任务」容器
   */
  getOtherTasksContainer() {
    return this._findByKind(CategoryKind.OTHER_TASKS);
  }

  /**
   * 获取回收站分类（可能尚未创建 —— _ensureBaseStructure 后必然存在）
   */
  getTrashCategory() {
    return this._findByKind(CategoryKind.TRASH);
  }

  /**
   * 获取「已完成任务」分类（可能尚未创建 —— _ensureBaseStructure 后必然存在）
   *
   * v3.4 起为真实分类（kind=COMPLETED），与「回收站」语义对称：
   *   - 删除 → 移到回收站
   *   - 完成（[✓]）→ 移到已完成任务
   *
   * 调用方不直接调 `_getOrCreateCompletedCategory`（拿不到就新建）—— 那样会让
   * 普通查询路径意外创建空分类。需要在加载/迁移流程里建好之后再用。
   */
  getCompletedCategory() {
    return this._findByKind(CategoryKind.COMPLETED);
  }

  /**
   * 获取所有「子分类」（parentOtherTasks=true）
   * 按当前 categories 数组顺序返回
   */
  getSubCategories() {
    return this.categories.filter(c => c.parentOtherTasks);
  }

  // ============================================
  //  分类操作
  // ============================================

  /**
   * 新增子分类到「其他任务」下
   * @returns {object|null} 新分类
   */
  addSubCategory(name) {
    name = (name || '').trim();
    if (!name) return null;
    // 拒绝包含 `|` 的分类名：TaskList._selKey 用 `|` 拼 (cat, id)，批量浮栏的
    // _updateBatchBarState / _handleBatchAction / _showBatchMoveMenu 都用 key.split('|')
    // 反查分类名与 id —— 名字里出现 `|` 会让 split 出来的 cat 截断、id 拿错，
    // 选中/批量/移动全部静默错位。同样的约束在 renameCategory 里再守一次。
    if (name.includes('|')) return null;
    // 拒绝包含 `[` / `]` 的分类名：markdown-writer 写 `[原分类：${originalCategory}]`
    // 时不做转义，parser 的 `\[原分类：([^\]]+?)\]` 在名字含 `]` 时只截到第一个
    // `]` 就停，后面成了字面文本 —— 存盘 → 读回 → originalCategory 漂移甚至丢
    // 字段（v3.7+ 数据丢失 vector，见 markdown-parser.js inline marker 注释）。
    // 同时 `[` 在 markdown 里也是 # 标题的语法边界，混进分类名会让 heading 解析错位。
    // 同约束在 renameCategory 里再守一次。
    if (name.includes('[') || name.includes(']')) return null;
    if (this.categories.some(c => c.name === name)) return null;
    if (name === OTHER_TASKS_NAME) return null;
    // 阻止把子分类建成 Today 类（保留名）—— 否则下次 _ensureBaseStructure 迁移时
    // 会把 kind 从 NORMAL 提升为 TODAY，破坏父级顺序与 parentOtherTasks 结构。
    // 「回收站」同理：重名会让删除的任务混进一个用户以为是普通分类的地方。
    // 「已完成任务」同理（v3.4 起是真实分类）：重名会让 [✓] 自动移动的目标分类指错地方。
    const lower = name.toLowerCase().trim();
    if (TODAY_KEYS.includes(lower)) return null;
    if (OTHER_TASKS_KEYS.includes(lower)) return null;
    if (TRASH_KEYS.includes(lower)) return null;
    if (COMPLETED_KEYS.includes(lower)) return null;

    const cat = this._createCategory(name, CategoryKind.NORMAL);
    cat.parentOtherTasks = true;

    // 插入位置：「未分类」必须始终保持在子分类数组的末尾（_normalizeOrder 的内部约定，
    // 也是 reorderSubCategory 的防线前提）。新分类若插到「未分类」之后，会把它挤到中间，
    // 用户看到的就是「我建的新分类怎么跑到了兜底下面」—— 体验与 bug 一致。
    // 因此优先级：
    //   1) 「未分类」已存在 → 新分类插在「未分类」之前
    //   2) 「未分类」不存在但容器在 → 插到容器之后、最后一个 parentOtherTasks 之后
    //   3) 都没有 → push 到末尾（极端兜底；正常流程走不到）
    const uncategorizedIdx = this.categories.findIndex(
      c => c.parentOtherTasks && c.name === UNCATEGORIZED_NAME
    );
    if (uncategorizedIdx >= 0) {
      this.categories.splice(uncategorizedIdx, 0, cat);
    } else {
      const containerIdx = this.categories.findIndex(c => c.kind === CategoryKind.OTHER_TASKS);
      if (containerIdx < 0) {
        this.categories.push(cat);
      } else {
        let insertIdx = containerIdx + 1;
        while (
          insertIdx < this.categories.length &&
          this.categories[insertIdx].parentOtherTasks
        ) {
          insertIdx++;
        }
        this.categories.splice(insertIdx, 0, cat);
      }
    }

    this._markDirty({ categories: cat.name });
    this.emit('categories');
    this.emit('change');
    return cat;
  }

  /**
   * 兼容旧 API：addCategory 改为添加到「其他任务」下的子分类
   * （已弃用，建议直接使用 addSubCategory）
   */
  addCategory(name) {
    return this.addSubCategory(name);
  }

  renameCategory(oldName, newName) {
    newName = (newName || '').trim();
    if (!newName || oldName === newName) return false;
    // 与 addSubCategory 同款防线：拒绝包含 `|` 的新名 —— 选中键 / 批量解析依赖
    // key.split('|') 的语义，名字里出现 `|` 会让"移动到本分类"按钮解析到错分类。
    // 这里旧名同样要校验：万一旧名里早就含 `|`，下面的 cat 操作就跨过这道防线，
    // 直接静默放过更糟 —— 把已有「非法名字」的分类也卡住。
    // 同款挡 `[` / `]`：markdown-writer 不转义 [原分类：xxx] 里的 originalCategory，
    // 名字含 `]` 会让 parser 截断字段，存盘 → 读回 → 数据漂移。详见 addSubCategory。
    const cat = this.getCategory(oldName);
    if (!cat) return false;
    if (cat.name.includes('|') || newName.includes('|')) return false;
    if (cat.name.includes('[') || cat.name.includes(']')
        || newName.includes('[') || newName.includes(']')) return false;
    if (this.categories.some(c => c.name === newName)) return false;

    // Today / 全部任务 / 回收站 不允许重命名
    if (cat.kind === CategoryKind.TODAY) return false;
    if (cat.kind === CategoryKind.OTHER_TASKS) return false;
    if (cat.kind === CategoryKind.TRASH) return false;

    // 「未分类」是任务兜底 —— 名字在 store / parser / writer 里是魔法标识符
    // （_getOrCreateUncategorizedCategory / 迁移逻辑全部按 cat.name === '未分类' 定位）。
    // 改名会让兜底分类从数据模型里「消失」：下次删其它有任务的子分类时，store 找不到
    // 旧「未分类」，就凭空新建一个同名空分类，把释放出的任务丢进去，而用户原来那个被
    // 改名的旧分类就成了孤儿。两边不一致，数据完整性破坏。
    // —— 与 deleteCategory 里禁止删「未分类」的逻辑对称，这里禁止重命名它。
    if (cat.name === UNCATEGORIZED_NAME) return false;

    // 阻止把子分类改名成保留名（Today / 全部任务 / 回收站 / 已完成任务）。
    // 这种重命名会让它在原位变成特殊分类，破坏 categories 数组顺序和 parentOtherTasks 结构。
    const lower = newName.toLowerCase().trim();
    const isReserved =
      TODAY_KEYS.includes(lower) ||
      OTHER_TASKS_KEYS.includes(lower) ||
      TRASH_KEYS.includes(lower) ||
      COMPLETED_KEYS.includes(lower);
    if (isReserved) return false;

    cat.name = newName;

    if (this.selectedCategoryName === oldName) {
      this.selectedCategoryName = newName;
    }

    // 同步更新所有任务的 originalCategory 引用 —— COMPLETED 分类里任务的
    // originalCategory 标记指向「它打勾前所在的子分类」。如果只改 cat.name 而不同步更新
    // 这些引用，用户取消勾选时 _resolveRestoreTarget 找不到 newName，按「原分类丢失」
    // 走 picker → 每次取消勾选都弹分类选择器（噪音极大）。改名是幂等改名，跟随迁移。
    for (const c of this.categories) {
      if (!Array.isArray(c.tasks)) continue;
      for (const t of c.tasks) {
        if (t && t.originalCategory === oldName) t.originalCategory = newName;
      }
    }

    this._markDirty({ categories: [oldName, newName] });
    this.emit('categories');
    this.emit('change');
    return true;
  }

  /**
   * 删除子分类
   * 被删分类下的任务不丢弃，全部迁移到「未分类」子分类（兜底分类，由 _ensureBaseStructure 保证存在）。
   * 「未分类」本身不可删除 —— 否则被释放的任务无处归位。
   */
  deleteCategory(name) {
    const idx = this.categories.findIndex(c => c.name === name);
    if (idx < 0) return false;
    const cat = this.categories[idx];
    // 不允许删除 Today / 其他任务 / 回收站 / 非子分类
    if (cat.kind === CategoryKind.TODAY) return false;
    if (cat.kind === CategoryKind.OTHER_TASKS) return false;
    if (cat.kind === CategoryKind.TRASH) return false;
    if (!cat.parentOtherTasks) return false;
    // 「未分类」是删除时的任务兜底，删除它会让释放出的任务无处归位 —— 禁止
    if (cat.name === UNCATEGORIZED_NAME) return false;

    // 只在真的有任务要搬时才去找/建「未分类」——
    // 删除空分类不应该凭空造出一个兜底分类（那是纯粹的副作用噪音）
    const movedCount = cat.tasks.length;
    let fallback = null;
    if (movedCount > 0) {
      fallback = this._getOrCreateUncategorizedCategory();
      // 移交任务 —— 直接拼接数组，保留原顺序与任务对象（text/completed/important/id 全部原样带走）
      fallback.tasks = fallback.tasks.concat(cat.tasks);
      cat.tasks = [];
    }

    // ⚠️ 关键：不能再用先前缓存的 idx。
    // _getOrCreateUncategorizedCategory 在「未分类」缺失时会在容器后插入新分类，
    // 这会把原 idx 上的元素挤到 idx+1；如果我们仍按原 idx splice，就会切掉刚创建的「未分类」
    // —— 兜底分类脱离数组，任务在下次 serialize 时丢失。
    // 用对象引用重新定位目标，永远拿到「现在」的位置。
    const currentIdx = this.categories.indexOf(cat);
    if (currentIdx < 0) {
      // 极端兜底：cat 已不在数组里（不应发生，但避免后续流程误删其它分类）。
      return false;
    }
    this.categories.splice(currentIdx, 1);

    // 如果删除的是当前选中分类，把视图切到任务的新家「未分类」，
    // 让用户直接看到任务并没有丢；没有搬任务时才退回「当前」智能视图
    // （v3 已不再有 TODAY 真实分类 —— 必须落到智能视图上，否则读到 undefined）
    if (this.selectedCategoryName === name) {
      if (fallback) {
        this.selectedCategoryName = fallback.name;
      } else {
        this.selectedSmartList = 'current';
        this.selectedCategoryName = null;
      }
      this.emit('select', this.selectedCategoryName);
    }
    // 子分类被删 + 任务迁过去 —— 兜底分类与被删分类的归属都标脏
    const dirtyCats = [name];
    const dirtyTaskIds = [];
    if (fallback) {
      dirtyCats.push(fallback.name);
      for (const t of fallback.tasks) dirtyTaskIds.push(t.id);
    }
    this._markDirty({ tasks: dirtyTaskIds, categories: dirtyCats });
    this.emit('categories');
    this.emit('change');
    return true;
  }

  /**
   * 获取「未分类」子分类；不存在则创建一个并插入到「全部任务」容器之后。
   *
   * 两个必须守住的不变量：
   *  1) 只能有一个「未分类」。重名分类会让 getCategory() 只认第一个，
   *     后续 addTask/toggleTask 全部打到错误的对象上。所以这里按名字匹配，
   *     顺带把 parentOtherTasks 补正，而不是「找不到带标记的就再建一个」。
   *  2) 子分类必须排在 OTHER_TASKS 容器之后。writeMarkdown 把 parentOtherTasks
   *     的分类写成 `## X`，而 parseMarkdown 只在 `# 全部任务` 之后才认 `##`
   *     （insideOtherTasks 开关）。一个孤立的 `## 未分类` 不会让任务消失，但会更糟糕地
   *     静默改写归属：parser 跳过该 h2 时并不重置 currentCategory，于是下面的任务
   *     被并进上一个 h1（通常是「当前任务」）。已实测确认此行为。
   *     所以容器缺失时必须先把容器建出来，不能简单 push 到数组末尾。
   *
   * 注意：本方法会修改 categories 数组顺序，调用方后续若按索引 splice 目标分类会失效 —— 必须用 indexOf 重新定位。
   */
  _getOrCreateUncategorizedCategory() {
    // 不变量 1：按名字找（不强求 parentOtherTasks），找到就补正标记后复用
    const existing = this.categories.find(
      c => c.name === UNCATEGORIZED_NAME && c.kind === CategoryKind.NORMAL
    );
    if (existing) {
      existing.parentOtherTasks = true;
      return existing;
    }

    const sub = this._createCategory(UNCATEGORIZED_NAME, CategoryKind.NORMAL);
    sub.parentOtherTasks = true;

    // 不变量 2：确保容器存在，否则新分类会被序列化成孤立的 `##` 而在下次解析时丢失
    let oIdx = this.categories.findIndex(c => c.kind === CategoryKind.OTHER_TASKS);
    if (oIdx < 0) {
      const container = this._createCategory(OTHER_TASKS_NAME, CategoryKind.OTHER_TASKS);
      const todayIdx = this.categories.findIndex(c => c.kind === CategoryKind.TODAY);
      oIdx = todayIdx >= 0 ? todayIdx + 1 : this.categories.length;
      this.categories.splice(oIdx, 0, container);
    }
    this.categories.splice(oIdx + 1, 0, sub);
    return sub;
  }

  /**
   * 重新排序子分类（拖拽后）
   *
   * @param {number} fromIndex 拖动项在 getSubCategories() 中的下标
   * @param {number} toIndex   放置目标在 getSubCategories() 中的下标
   * @param {boolean} dropAbove true = 插到目标之前，false = 插到目标之后
   *
   * 旧实现只接受 (from, to) 并在全局数组上做 splice + `if (globalTo > globalFrom) globalTo--`
   * 的补偿，语义上等价于「永远插到目标之前」：向下拖一格时补偿刚好抵消位移
   * （[A,B,C] 把 A 拖到 B 上 → 仍是 [A,B,C]），子分类根本无法向下移动。
   *
   * 现在改为先在子分类下标空间里算出结果顺序，再写回 categories 中原有的子分类槽位 ——
   * 非子分类（当前任务 / 容器 / 回收站）的位置完全不动，因此不会破坏
   * _normalizeOrder() 维护的 `[当前任务, 容器, ...子分类, 回收站]` 不变量。
   */
  reorderSubCategory(fromIndex, toIndex, dropAbove = true) {
    const subs = this.getSubCategories();
    if (fromIndex < 0 || fromIndex >= subs.length) return false;
    if (toIndex < 0 || toIndex >= subs.length) return false;

    // 「未分类」是兜底分类 —— _normalizeOrder() 迁移/归位逻辑的内部约定里它排在子分类末尾。
    // 任何让它离开底部位置（被拖/被当成落点）的重排都会让兜底从此"漂"到中间位置，
    // 直到下一次加载被 _normalizeOrder 拉回。用户看到的就是"我拖完它又跑回来"，体验与 bug 一致。
    // 同时禁止它作为 drop target：插到它"前面"会让它身后夹一个非法位置（同理）。
    // 这里和 UI 层 pointerdown/_findDropTarget 是同一条防线的不同高度 —— 拦截任意调用入口。
    if (subs[fromIndex]?.name === UNCATEGORIZED_NAME) return false;
    if (subs[toIndex]?.name === UNCATEGORIZED_NAME) return false;

    const moving = subs[fromIndex];
    const reordered = subs.slice();
    reordered.splice(fromIndex, 1);

    // 插入点在「移除拖动项之前」的下标空间里算出，移除后需要左移一位
    let insertAt = dropAbove ? toIndex : toIndex + 1;
    if (fromIndex < insertAt) insertAt--;
    insertAt = Math.max(0, Math.min(insertAt, reordered.length));
    reordered.splice(insertAt, 0, moving);

    // 顺序没变就不标脏，免得一次无效拖拽触发自动保存
    if (reordered.every((c, i) => c === subs[i])) return false;

    const slots = [];
    this.categories.forEach((c, i) => { if (c.parentOtherTasks) slots.push(i); });
    slots.forEach((slot, i) => { this.categories[slot] = reordered[i]; });

    // 子分类重排不影响具体任务 —— 标记所有重排过的分类名（仍走 structural 路径）
    this._markDirty({ categories: reordered.map(c => c.name) });
    this.emit('categories');
    this.emit('change');
    return true;
  }

  // ============================================
  //  任务操作
  // ============================================

  addTask(categoryName, text) {
    text = (text || '').trim();
    if (!text) return null;

    const cat = this.getCategory(categoryName);
    if (!cat) return null;
    // 容器本身不接受任务
    if (cat.kind === CategoryKind.OTHER_TASKS) return null;
    // 回收站只接收「被删除的任务」，不能当普通分类往里新建
    if (cat.kind === CategoryKind.TRASH) return null;
    // v3.4：「已完成任务」分类是 [✓] 自动收集的归宿，不允许手工新建 —— 用户若想
    // 标记完成，直接在源分类里勾选即可（toggleTask 会自动搬过来）。开放 addTask
    // 会让用户绕过勾选机制，"提前预填"已完成任务，下次保存还可能被 writer 重写。
    if (cat.kind === CategoryKind.COMPLETED) return null;

    return this._appendTask(cat, text, false);
  }

  /**
   * 生成一条任务对象（含稳定 ID），不触发任何事件 / dirty。
   * _appendTask 与 importTasksToCategory 共用 —— 保证 ID 格式一致。
   * 不做 trim / 校验：调用方负责。
   *
   * 可选地接受 important / current —— 让导入路径能直接把
   * `parseImportLine` 抽出的 inline 标记写进任务字段，
   * 避免「先 _createTask(..., false) 再手动改 important / current」
   * 这么绕一圈。
   */
  _createTask(text, completed = false, { important = false, current = false, originalCategory = null } = {}) {
    return {
      id: 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      text,
      completed: !!completed,
      important: !!important,
      current: !!current,
      // v3.5+：勾选/拖入「已完成任务」时记录原分类名，取消勾选时直接归位。
      // 严格保留透传：传 null 就存 null（非空字符串才存），避免"忘了传"变成 '' 误判。
      originalCategory: originalCategory || null
    };
  }

  /**
   * 单条追加：构造 + 插入 + 触发 dirty + tasks/change 事件。
   * addTask 直接走这条路；importTasksToCategory 走批量路径（避免 N 次 emit）。
   */
  _appendTask(cat, text, completed = false) {
    const task = this._createTask(text, completed);
    this._appendTaskWithPosition(cat, task, 'newTask');
    this._markDirty({ tasks: task.id, categories: cat.name });
    this.emit('tasks', { categoryName: cat.name });
    this.emit('change');
    return task;
  }

  /**
   * 按用户偏好把单条任务插入到目标分类的任务数组里。
   *
   * 用途：把「该用 push 还是 unshift」集中到一处，由 settingsStore.get(settingKey) 决定。
   *   - kind='newTask'   → 读 newTaskPosition   （新增任务落点）
   *   - kind='completed' → 读 completedPosition  （打勾任务搬到「已完成」时的落点）
   *   - kind='trash'     → 读 trashPosition     （删除任务搬到「回收站」时的落点）
   *   - kind='move'      → 读 movePosition      （右键/批量「移到分类」时的落点）
   *
   * 边界：
   *   - settingsStore 未注入（fixture / 老调用方）→ 等价于 DEFAULT_SETTINGS 默认值 'front'，
   *     保证「最新在最上」行为对所有 TaskStore 实例一致。
   *   - 读取到的值不在白名单（理论上 settingsStore 不会放过脏值，但这里再守一道）
   *     → 回退到 'front'，与 settings-store DEFAULT_SETTINGS 默认值对齐。
   *
   * 显式恢复（restoreTask / _doRestoreMove / restoreCompletedTask）**不**走这里：
   * 「把任务搬回来」是归位动作，不是新插入，落点由目标分类语义决定（push 到末尾），
   * 强行套用 *Position 设置会让用户恢复一条已完成的任务时，跑 completedPosition='back'
   * 的设置结果插到「已完成」末尾，与「刚刚完成的任务排在最新」的心智冲突。
   *
   * @param {{tasks: Array}} cat - 目标分类
   * @param {object} task - 待插入任务对象
   * @param {'newTask'|'completed'|'trash'|'move'} kind
   */
  _appendTaskWithPosition(cat, task, kind) {
    const pos = this._getInsertPosition(kind);
    if (pos === 'back') {
      cat.tasks.push(task);
    } else {
      cat.tasks.unshift(task);
    }
  }

  /**
   * 读取给定 kind 对应的插入位置偏好。
   * 单独的 helper 让 importTasksToCategory 这种"批量插入"的路径能一次拿到 pos
   * 再决定整批按什么顺序插（push 整体 vs 倒序 unshift 整体），不需要每条都过 settingsStore.get。
   *
   * @param {'newTask'|'completed'|'trash'|'move'|'import'} kind
   * @returns {'front'|'back'|'order'}
   */
  _getInsertPosition(kind) {
    let settingKey;
    if (kind === 'completed') settingKey = 'completedPosition';
    else if (kind === 'uncomplete') settingKey = 'uncompletePosition';
    else if (kind === 'trash') settingKey = 'trashPosition';
    else if (kind === 'restore') settingKey = 'restorePosition';
    else if (kind === 'move') settingKey = 'movePosition';
    else if (kind === 'import') settingKey = 'importPosition';
    else settingKey = 'newTaskPosition';
    if (this._settingsStore && typeof this._settingsStore.get === 'function') {
      const raw = this._settingsStore.get(settingKey);
      // importPosition 多一个 'order' 合法值（'order' / 'front'）；其它 kind 只接受 'front' | 'back'
      if (kind === 'import') {
        if (raw === 'order' || raw === 'front') return raw;
      } else {
        if (raw === 'front' || raw === 'back') return raw;
      }
    }
    // import 的默认值是 'order'（按入参顺序、前面的内容在前），
    // 与其它 kind 的 'front' 默认不同 —— 因为导入场景下「按输入顺序」比
    // 「最后一行在最上」更符合用户直觉（旧版共用 newTaskPosition='front'
    // 导致最后一行跑到最前，让人困惑，故单独切默认）。
    return kind === 'import' ? 'order' : 'front';
  }

  /**
   * 从粘贴文本批量导入任务。
   *
   * 解析纯函数独立导出（见 parseImportLine）—— 导入对话框实时预览复用同一份逻辑，
   * 避免「预览说能导入、真正点确认却少了一行」这种诡异不一致。
   *
   * 性能：批量路径只在末尾触发一次 _markDirty + emit('tasks') + emit('change')，
   * 而不是「每条任务一次」。导入 1000 条任务不再触发 1000 次 UI 重渲染。
   */
  importTasksToCategory(categoryName, lines, options = {}) {
    const cat = this.getCategory(categoryName);
    if (!cat) return { ok: false, reason: 'INVALID_CATEGORY' };
    // 容器 / 回收站 / 已完成任务 拒绝：与 addTask 守卫一致，避免绕过 toggleTask 的语义
    if (cat.kind === CategoryKind.OTHER_TASKS) return { ok: false, reason: 'INVALID_CATEGORY' };
    if (cat.kind === CategoryKind.TRASH) return { ok: false, reason: 'INVALID_CATEGORY' };
    if (cat.kind === CategoryKind.COMPLETED) return { ok: false, reason: 'INVALID_CATEGORY' };

    const stripLeadingBullets = options.stripLeadingBullets !== false; // 默认 true
    // importPosition 可由调用方覆盖 settingsStore —— 导入对话框需要在「关掉对话框」
    // 之前把用户当前的选择当作这次操作的依据，避免 settingsStore 持久化失败时
    // 拿不到值。覆盖优先级：options.importPosition（合法值）> settingsStore > 默认 'order'。
    let importPos = 'order';
    if (options.importPosition && VALID_IMPORT_POSITION.has(options.importPosition)) {
      importPos = options.importPosition;
    } else {
      importPos = this._getInsertPosition('import');
    }
    const newTasks = [];
    let skipped = 0;

    for (const rawLine of lines) {
      const parsed = parseImportLine(rawLine, { stripLeadingBullets });
      if (!parsed) {
        // 空行 / 仅空白 / 解析后无文本
        skipped++;
        continue;
      }
      // 把 parseImportLine 抽出的 important / current / originalCategory 直接落到 task 字段
      // （与 parseMarkdown 路径同语义 —— 不在导入时翻译这些 inline 标记，
      // 用户数据就会在保存后被悄悄改写）
      newTasks.push(this._createTask(parsed.text, parsed.completed, {
        important: parsed.important,
        current: parsed.current,
        originalCategory: parsed.originalCategory
      }));
    }

    // 0 条有效行：跳过所有事件 / dirty —— 调用方可能取消预览前提前算了计数，
    // 这里绝不能因为「试了一下又关掉」就脏文档。
    if (newTasks.length === 0) {
      return { ok: true, added: 0, skipped };
    }

    // v3.4 数据归属不变量：completed=true 的任务**只能**活在 kind=COMPLETED 分类。
    // 导入 `- [✓]` 进普通子分类时立即搬到「# 已完成任务」分类，避免源分类出现
    // 「看起来没完成（写在「工作」里）但实际上是已完成态」的数据漂移 —— 与
    // toggleTask 路径完全同语义。
    //
    // 先分流：completed=true 的直接进已完成分类（带 originalCategory），其余进源分类。
    // 关键：**不能**先全部 push 到 cat.tasks 再从中抠 completedTasks —— 那会让已完成
    // 任务同时出现在源分类和已完成分类，违反不变量（UI 上能看到两份）。
    const completedTasks = [];
    const pendingTasks = [];
    for (const t of newTasks) {
      if (t.completed) {
        // 源分类是子分类才写 originalCategory —— 与 toggleTask 一致：
        // 子分类有名字语义；其他分类（理论上不会发生，addTask 守卫拦了）跳过。
        if (cat.parentOtherTasks && !t.originalCategory) {
          t.originalCategory = cat.name;
        }
        completedTasks.push(t);
      } else {
        pendingTasks.push(t);
      }
    }
    // 批量路径下走 importPosition 偏好 —— 与 newTaskPosition / completedPosition
    // 完全解耦。用户在导入对话框内单独调整，UI 仅在导入窗口暴露该选项。
    // 顺序约定（按用户预期）：
    //   - order 模式（默认）：按入参顺序插到目标位置的最前面 —— 第一行排到最上，
    //     与用户「按行号查看」的直觉一致。实现：unshift 整批（Array.unshift 按
    //     顺序在头部依次压入，等价于「把整批原样前置」）。
    //   - front 模式：入参倒序插到目标位置的最前面 —— 最后一行落在最上面。
    //     实现：依次遍历入参 + 每条 unshift，最后一条最后 unshift → 最终在最前。
    // 历史上曾有 'back' 模式（追加到末尾），与全局 newTaskPosition='back' 行为
    // 完全重叠 —— 「追加到末尾」属于位置语义，归全局设置管；导入对话框只管
    // 「顺序」。所以此处只剩 order / front 两路。
    // importPos 已在外层（options 覆盖 / settingsStore 兜底）解析好，此处直接复用。
    if (pendingTasks.length > 0) {
      if (importPos === 'order') {
        // unshift 整批：line1 先入头部、lineN 最后入头部，
        // 最终 cat.tasks[0]=line1, ..., cat.tasks[N-1]=lineN, 之后是原有任务。
        cat.tasks.unshift(...pendingTasks);
      } else {
        // 'front'（兜底也走这条）：依次 unshift，lineN 最后被 unshift 到头部 → lineN 在最上面。
        for (let i = 0; i < pendingTasks.length; i++) {
          cat.tasks.unshift(pendingTasks[i]);
        }
      }
    }

    let completedCatName = null;
    if (completedTasks.length > 0) {
      const completedCat = this._getOrCreateCompletedCategory();
      // 已完成分支与 pending 分支共用同一个 importPos —— 导入是一笔连贯操作，
      // 已完成任务在「# 已完成任务」分类里的相对顺序应与 pending 一致（都按用户
      // 在对话框里选的模式）。避免「pending 按 order、completed 按 front」的诡异
      // 行为。
      if (importPos === 'order') {
        completedCat.tasks.unshift(...completedTasks);
      } else {
        for (let i = 0; i < completedTasks.length; i++) {
          completedCat.tasks.unshift(completedTasks[i]);
        }
      }
      completedCatName = completedCat.name;
    }

    // 标脏的分类要包含已完成的归宿分类 —— 涉及两边
    const dirtyCats = [cat.name];
    if (completedCatName) dirtyCats.push(completedCatName);
    this._markDirty({ tasks: newTasks.map(t => t.id), categories: dirtyCats });
    this.emit('tasks', { categoryName: cat.name });
    if (completedCatName) this.emit('tasks', { categoryName: completedCatName });
    this.emit('change');
    return { ok: true, added: newTasks.length, skipped };
  }

  toggleTask(categoryName, taskId) {
    const cat = this.getCategory(categoryName);
    if (!cat) return { ok: false };
    // 回收站允许切换勾选（恢复前常想先把勾清掉或勾上）。
    // 但 ⭐ / ⚪ 这类元数据仍拒绝改 —— 那属于跨分类的状态，挪出回收站再切。
    // 彻底删除仍只能手工编辑 Markdown。
    const idx = cat.tasks.findIndex(t => t.id === taskId);
    if (idx < 0) return { ok: false };
    const task = cat.tasks[idx];
    const nowCompleted = !task.completed;

    // 回收站是「删除前的暂存区」，勾选/取消勾选应原地切换完成态：
    //   - 用户预期：在回收站里打勾/清勾，任务**仍留在回收站**。
    //     旧实现把「回收站里打勾」搬到「已完成任务」，违背"回收站是兜底区"
    //     的心智模型（用户可能只是想标个完成、回头手动清掉）。
    //   - 数据归属：与 v3.4 不变量兼容 —— 回收站是 TRASH 的例外豁免，
    //     _consolidateCompleted 与 markdown-writer 的 showOriginalCategory 守卫
    //     都已承认「回收站里允许 completed=true 任务」。这条路径保持对称：
    //     toggle 只动 bool、不动归属。
    //   - originalCategory 保留：从「已完成」删到回收站的任务仍带原分类标记
    //     （见 check-original-category [15]），在回收站切换完成态时不应清掉——
    //     用户恢复时还要靠它归位。
    if (cat.kind === CategoryKind.TRASH) {
      if (task.completed === nowCompleted) return { ok: true };
      task.completed = nowCompleted;
      this._markDirty({ tasks: task.id, categories: categoryName });
      this.emit('tasks', { categoryName });
      this.emit('change');
      return { ok: true };
    }

    // v3.4：勾选态切换会触发**跨分类移动** —— 数据归属必须保持一致：
    //   - 切到已完成（[✓]）：从当前分类搬到「# 已完成任务」（kind=COMPLETED）
    //   - 切回未完成（[ ]）：从「# 已完成任务」搬到「未分类」（兜底子分类）
    //
    // 为什么不在原分类就地改 completed=true？
    //   - 数据归属与状态要一致：completed=true 的任务就该活在 kind=COMPLETED 分类里。
    //     留在源分类会导致后续 clearCompleted / collectSmartListTasks / _normalizeOrder
    //     都要分别写"如果 task.completed=true 但 cat.kind !== COMPLETED 就当已完成任务"的
    //     特判，分支越多越容易出错。
    //   - UI 期望：用户打勾后任务**视觉上**从原分类消失、出现在「已完成任务」里。
    //     只改 bool 不移动 → UI 看起来任务还在原分类但被打了勾，与"打勾即完成"的直觉相悖。
    //
    // v3.5+：进入完成态时记录原分类（task.originalCategory = categoryName），
    // 退出完成态时按 _resolveRestoreTarget 解析目标：
    //   - 原分类还在 → 直接归位（用户最关心的体验）
    //   - 原分类丢失（删除/改名） → 弹分类选择器（见返回的 restoreHint）
    //   - 没有原分类信息（旧文件 / 兜底） → 直接去「未分类」，不弹窗（避免批量噪音）
    if (nowCompleted && cat.kind !== CategoryKind.COMPLETED) {
      const completedCat = this._getOrCreateCompletedCategory();
      // splice 在插入之前：避免 cat === completedCat（极端情况）时引用失效
      cat.tasks.splice(idx, 1);
      // 落点由 completedPosition 决定 —— 默认 'front'（最新完成的最上面），
      // 也支持 'back'（追加到「已完成任务」末尾，按时间倒序沉底）。
      this._appendTaskWithPosition(completedCat, task, 'completed');
      task.completed = true;
      // 记录原分类：兜底（修复 H3）—— 任何 NORMAL 分类都记，不只是挂容器的子分类。
      // 旧条件 `cat.parentOtherTasks` 漏掉以下场景：
      //   - 顶级 NORMAL 分类（来自 H2 修复后的 orphan h2 提升，或旧文件残留）
      //   - 任何还没挂上 OTHER_TASKS 容器的普通分类
      // 这些场景下 toggle 后 originalCategory 为 null，取消勾选时无归位依据，
      // 走 fallback 落到「未分类」而非原归属。
      // 跳过特殊分类（容器 / 已完成 / 回收站）作为原分类的语义：
      //   - OTHER_TASKS 是容器，本身没任务
      //   - TRASH 是删除兜底，不该成为「原分类」的语义来源
      //   - COMPLETED 自身已经在做了，重复记录没意义
      //   - 其它 kind（未知）也跳过，避免脏数据
      if (cat.kind === CategoryKind.NORMAL && cat.name) {
        task.originalCategory = categoryName;
      }
      // v4.1：勾选**不再**清 current（撤销早先的 H4 处理）。
      // 理由（用户明确要求）：[▶] 与 [⭐] 一样是任务级标记，不该被"完成"这个
      // 阶段性动作静默擦掉 —— 否则勾错一下再取消勾选，原来的当前标记就没了，
      // 用户得重新标一次。现在 completed 与 current / important 完全正交：
      //   - 文件里保留 `- [✓] [▶] …`（writer 一直支持输出）
      //   - 「已完成任务」列表里 ▶ 按钮照常显示 / 可切换
      //   - 取消勾选归位后，当前标记原样带回去
      // 「当前任务」智能视图仍然排除 kind=COMPLETED 的任务（完成 = 归档，
      // 见 collectSmartListTasks 的注释）—— 状态被保留，只是不再参与聚合。
      // 批量勾选（batchToggleCompleted）本来就没清 current，这里改完两条路径一致。
      this._markDirty({ tasks: task.id, categories: [categoryName, completedCat.name] });
      this.emit('tasks', { categoryName });
      this.emit('tasks', { categoryName: completedCat.name });
      this.emit('categories');
      this.emit('change');
      return { ok: true };
    }
    if (!nowCompleted && cat.kind === CategoryKind.COMPLETED) {
      // v3.5+：解析恢复目标 —— 原分类还在就回去，丢了就让 UI 弹窗，没有记录就走「未分类」
      const resolve = this._resolveRestoreTarget(task);

      // 'picker' 路径：**不动任务**。UI 拿到 hint 后调 store.restoreCompletedTask，
      // 由它按用户选择的目标分类搬走任务。先在 toggleTask 里搬走再让 restoreCompletedTask
      // 找会找不到（已完成分类里已经被 splice 了），所以这里必须有条件地分支。
      if (resolve.kind === 'picker') {
        // v3.7+ 修复 H6：picker 路径加超时。旧行为是无限循环：
        //   - UI 拿到 hint 弹 picker → 用户关掉 dialog → 任务卡在 COMPLETED 但 completed=false
        //   - 用户再次 toggle → 又走 picker → 永远不归位
        // 现在记每个 task 的 picker 次数，超过 _PICKER_ATTEMPT_LIMIT（默认 3）自动降级为
        // fallback（强制走「未分类」），避免脏状态累积。
        const taskKey = task.id || `${categoryName}::${idx}`;
        const prevAttempts = this._pickerAttempts.get(taskKey) || 0;
        const nextAttempts = prevAttempts + 1;
        if (nextAttempts > this._PICKER_ATTEMPT_LIMIT) {
          // 降级为 fallback：把任务搬到「未分类」，清掉 originalCategory
          this._pickerAttempts.delete(taskKey);
          if (typeof console !== 'undefined' && console.warn) {
            console.warn(
              `[task-store] picker 路径超过阈值 (${this._PICKER_ATTEMPT_LIMIT})，` +
              `task=${taskKey} 原分类=${resolve.missing} 强制降级为 fallback`
            );
          }
          const fallbackTarget = this._getOrCreateUncategorizedCategory();
          cat.tasks.splice(idx, 1);
          // picker 强制降级也是「取消勾选」动作 → 读 uncompletePosition。
          // 与 category / fallback 三分支统一行为。
          this._appendTaskWithPosition(fallbackTarget, task, 'uncomplete');
          task.completed = false;
          task.originalCategory = null;
          this._markDirty({ tasks: task.id, categories: [categoryName, fallbackTarget.name] });
          this.emit('tasks', { categoryName });
          this.emit('tasks', { categoryName: fallbackTarget.name });
          this.emit('categories');
          this.emit('change');
          return {
            ok: true,
            restoreHint: { kind: 'fallback', targetName: fallbackTarget.name, forceDowngrade: true }
          };
        }
        this._pickerAttempts.set(taskKey, nextAttempts);
        // task 仍在已完成分类里，状态也不变 —— 等 UI 决定后再走 restoreCompletedTask
        return {
          ok: true,
          restoreHint: { kind: 'picker', missing: resolve.missing }
        };
      }

      // v4+ 修复：resolve 不再返回 target（见 _resolveRestoreTarget 注释），
      // 根据 kind 现场解析。fallback 是「未分类」、category 是 resolve.target（已查到）。
      const target = resolve.kind === 'fallback'
        ? this._getOrCreateUncategorizedCategory()
        : resolve.target;
      cat.tasks.splice(idx, 1);
      // 落点由 uncompletePosition 决定（默认 'front'）：取消勾选相当于「重新激活」，
      // 与新增任务「最新在最上」的对称心智能保持一致。切到 'back' 时落到末尾，
      // 与原 push 语义兼容（用户在恢复路径上更可能有「按完成顺序排」的偏好）。
      this._appendTaskWithPosition(target, task, 'uncomplete');
      task.completed = false;
      // v3.5.1：恢复后清掉 originalCategory。任务已回到原分类，标记已完成使命：
      //   - 避免文件里出现 `[原分类：工作] 写周报`（任务本身就在「工作」里，标记是噪音）
      //   - 用户再次勾选时，会被写入新的原分类（基于当下的所在分类），不影响功能
      task.originalCategory = null;
      this._markDirty({ tasks: task.id, categories: [categoryName, target.name] });
      this.emit('tasks', { categoryName });
      this.emit('tasks', { categoryName: target.name });
      this.emit('categories');
      this.emit('change');
      // v3.5+：把解析结果回传给 UI（'category' / 'fallback' 都是已就位，UI 无需再处理）
      return {
        ok: true,
        restoreHint: { kind: resolve.kind, targetName: target.name }
      };
    }

    // 同分类内切换（极端兜底，正常流程走不到）：
    //   - 已完成分类里 [✓] → [✓]（再次 toggle）：cat.kind === COMPLETED 且 nowCompleted=true
    //     此时第一条 if 已被 cat.kind === COMPLETED 守门拦住 —— 不进这里
    //   - 普通子分类里 [ ] → [ ]（再次 toggle）：nowCompleted=false 且不在已完成分类
    //     此时第二条 if 同样不进
    // 走到这里意味着同一分类内部 toggle 一次 —— 旧实现的行为，无需移动。
    task.completed = nowCompleted;

    this._markDirty({ tasks: task.id, categories: categoryName });
    this.emit('tasks', { categoryName });
    this.emit('change');
    return { ok: true };
  }

  updateTaskText(categoryName, taskId, newText) {
    newText = (newText || '').trim();
    if (!newText) return false;
    const cat = this.getCategory(categoryName);
    if (!cat) return false;
    // 回收站里的任务允许改文字（恢复前常想先修个错别字），
    // 但 ⭐ / ⚪ 这类元数据仍拒绝改动 —— 那属于跨分类的状态，挪出回收站再切
    // （_followTrashIfEmptied 等清理逻辑才能正确运行）。彻底删除仍只能手工编辑 Markdown。
    const task = cat.tasks.find(t => t.id === taskId);
    if (!task) return false;
    if (task.text === newText) return false;
    task.text = newText;
    this._markDirty({ tasks: task.id, categories: categoryName });
    this.emit('tasks', { categoryName });
    this.emit('change');
    return true;
  }

  /**
   * 更新任务的元数据
   *
   * ⭐ / ▶（important / current）这类标识属于「任务级状态」而非「分类归属」：
   * 在回收站 / 已完成任务任务里改它们不会破坏 v3.4 的「completed=true 只活
   * 在 kind=COMPLETED」不变量 —— toggleTask 那种"勾选即移动"的跨分类转移
   * 在 updateTaskMeta 这条路径上不发生。所以这里**不再**因为 cat.kind === TRASH
   * 一刀切拒绝：用户在回收站里也能给任务打 / 取消 ⭐ / ▶（常见场景：恢复前
   * 想顺手标个当前，避免回头再切一次；又或者一个重要的「已完成任务」在
   * 「已完成」里也能重新标记当前）。
   *
   * 唯一仍然收紧的：不能把 trash 任务改成 `completed` 之外（这里没有这个
   * 字段，保持不变）；回收站里的彻底删除仍只能手工编辑 Markdown —— 这条
   * 由 deleteTask 自己守住（已在进入 trash 之前拦）。
   */
  updateTaskMeta(categoryName, taskId, meta) {
    const cat = this.getCategory(categoryName);
    if (!cat) return false;
    const task = cat.tasks.find(t => t.id === taskId);
    if (!task) return false;
    let changed = false;

    if ('important' in meta && !!meta.important !== !!task.important) {
      task.important = !!meta.important;
      changed = true;
    }

    // v3 起：与 important 同款处理，@当前 标识的 toggle 也走这条路
    if ('current' in meta && !!meta.current !== !!task.current) {
      task.current = !!meta.current;
      changed = true;
    }

    if (!changed) return false;
    this._markDirty({ tasks: task.id, categories: categoryName });
    this.emit('tasks', { categoryName });
    this.emit('change');
    return true;
  }

  /**
   * 删除任务 —— 实际是「移到回收站」，任务对象原样保留（text/completed/important 全带走）。
   *
   * 数据安全的核心约定：软件里没有任何入口能真正丢弃一条任务。
   * 回收站里的任务只能由用户手工编辑 Markdown 删除，所以这里对
   * kind=TRASH 的来源直接拒绝 —— 否则「删除回收站里的任务」就成了不可逆操作。
   *
   * v3.5.2+：进 trash 时同步记一份原分类，让回收站学「已完成任务」的逻辑：
   *   - 来源是真实子分类（kind=NORMAL）且还没有 originalCategory → 记下当前所在分类名
   *   - 来源是「已完成任务」（kind=COMPLETED） → originalCategory 已经在 toggle 时
   *     记过（指它"打勾前的子分类"），**不重写**：completed 的"原"与 trash 的"原"
   *     指向同一处，不动它意味着万一将来取消勾选归位 + 再次删除两条路径都能各自
   *     找到一致的来源。
   *   - 来源是 OTHER_TASKS / TRASH：guard 拦在前面，不会到这里。
   *
   * 与「已完成任务」write-once 的语义对称：originalCategory 一旦在 toggle 时记下，
   * 后续整条任务生命周期里只在「恢复」/「移出特殊分类」时清空；trash 这边只补登
   * "第一次进 trash 时"这一刻的快照。
   *
   * @returns {boolean} 是否发生了移动
   */
  deleteTask(categoryName, taskId) {
    const cat = this.getCategory(categoryName);
    if (!cat) return false;
    // 回收站内不允许再删除（彻底删除只能手工编辑文件）
    if (cat.kind === CategoryKind.TRASH) return false;
    const idx = cat.tasks.findIndex(t => t.id === taskId);
    if (idx < 0) return false;

    const [task] = cat.tasks.splice(idx, 1);
    // v3.5.2+：进 trash 时记原分类。详见函数头注释。COMPLETED 来源任务原本就有
    // originalCategory（toggle 时记的），这里的"无则补登"既不会覆盖它的
    // 已完成"原"语义，也能兜住普通子分类 → 直接删到 trash 的常见路径。
    if (cat.kind === CategoryKind.NORMAL && !task.originalCategory) {
      task.originalCategory = categoryName;
    }
    const trash = this._getOrCreateTrashCategory();
    // 落点由 trashPosition 决定 —— 默认 'front'（最近删除的排在最上面，找回时不用翻到底部），
    // 也支持 'back'（追加到「回收站」末尾）。两条插入都走 _appendTaskWithPosition 集中管理。
    this._appendTaskWithPosition(trash, task, 'trash');

    this._markDirty({ tasks: task.id, categories: [categoryName, trash.name] });
    this.emit('tasks', { categoryName });
    this.emit('tasks', { categoryName: trash.name });
    this.emit('categories');   // 回收站计数变了，侧边栏要刷新
    this.emit('change');
    return true;
  }

  /**
   * v3.5+：解析已完成任务取消勾选时的恢复目标分类。
   *
   * 判定优先级：
   *   1. 任务带 originalCategory 且同名子分类仍存在 → 直接归位（用户最关心的体验）
   *   2. 任务带 originalCategory 但子分类丢失（删除 / 改名） →
   *      返回 'picker'，由 UI 弹分类选择器（与回收站恢复的交互对齐）
   *   3. 任务没有 originalCategory（很旧的文件 / 兜底） →
   *      返回 'fallback'，目标为「未分类」；批量场景下走 fallback 不弹窗，避免噪音
   *
   * 注意：所有 kind=COMPLETED 分类本身排除 —— 即便有人手敲了一个「# 已完成任务」
   * 之外的 kind=COMPLETED，也绝不能作为恢复目标（破坏数据归属不变量）。
   *
   * @param {{ originalCategory?: string|null }} task
   * @returns {{ kind: 'category'|'picker'|'fallback', target: Category, missing?: string }}
   */
  _resolveRestoreTarget(task) {
    const original = task.originalCategory;
    if (!original) {
      // v4+ 修复：旧实现这里调 _getOrCreateUncategorizedCategory()，会按需新建
      // 「未分类」分类、push 进 this.categories、emit 'categories'。但调用方如果拿到
      // resolve 后发现是 picker 路径（toggleTask / restoreTask），任务根本不动 —— 用户
      // 在 UI 里点 Esc 取消分类选择器，store 已经替用户把「未分类」建好了，sidebar
      // 多出一个分类图标，状态和 UI 意图不一致。
      // 修正：纯函数化。返回 {kind, missing?, target?} 三种字段里只暴露 kind 和缺失名，
      // target 不再在这里解析；调用方在确认要落地（fallback 走「未分类」、picker
      // 走 restoreCompletedTask 显式分支）时再调 _getOrCreateUncategorizedCategory() /
      // _getOrCreateCompletedCategory()。这样 picker hint 路径不再有副作用。
      return { kind: 'fallback' };
    }
    // 在真实子分类里按名字找 —— parentOtherTasks=true 且不是已完成分类
    const found = this.categories.find(
      c => c.parentOtherTasks &&
           c.kind !== CategoryKind.COMPLETED &&
           c.name === original
    );
    if (found) {
      return { kind: 'category', target: found };
    }
    // 找不到 —— 让 UI 弹窗；不解析 target（picker 路径不会直接落地，副作用留着无意义）
    return {
      kind: 'picker',
      missing: original
    };
  }

  /**
   * v3.5+：从「已完成任务」分类里挑一条任务，按用户指定的目标分类恢复。
   *
   * 与 restoreTask（从回收站恢复）的差别：
   *   - restoreTask 是 TRASH → 子分类，固定走 toggleTask 的归属不变量守卫
   *   - restoreCompletedTask 是 COMPLETED → 子分类，专为「取消勾选时原分类丢了」设计
   *     目标分类由用户从 picker 选出来，不需要再走 _resolveRestoreTarget
   *
   * 调用方（UI）：在 toggleTask 返回 restoreHint.kind === 'picker' 时调本方法。
   *
   * @param {string} taskId
   * @param {string} toCategoryName
   * @returns {boolean}
   */
  restoreCompletedTask(taskId, toCategoryName) {
    const completedCat = this.getCompletedCategory();
    if (!completedCat) return false;
    const idx = completedCat.tasks.findIndex(t => t.id === taskId);
    if (idx < 0) return false;

    // 目标分类：必须是真实子分类（parentOtherTasks）才接 —— 容器 / 回收站 / 已完成
    // 全部排除。找不到或无效则兜底到「未分类」，但**不**弹窗（restoreCompletedTask 是
    // UI 已经决定好目标后的执行步骤）。
    let target = null;
    if (toCategoryName) {
      const found = this.categories.find(
        c => c.parentOtherTasks && c.name === toCategoryName
      );
      if (found) target = found;
    }
    if (!target) {
      target = this._getOrCreateUncategorizedCategory();
    }

    // 委托给 _doRestoreMove 统一处理：splice 出源 / 写入目标 / 清 originalCategory /
    // 触发事件 —— 与 toggleTask 取消勾选归位（category / fallback / picker 强制降级）
    // 共用同一条「读 uncompletePosition」入口，保持「任务重新激活」的语义统一。
    // 返回 boolean（而不是 restoreTask 的对象）以保留本方法的旧 contract，UI 调用方不变。
    const result = this._doRestoreMove(completedCat.tasks[idx], idx, target, completedCat, { kind: 'uncomplete' });
    return result.ok === true;
  }

  /**
   * 从回收站恢复任务到指定分类（默认回到任务上记的「原分类」；丢回原路径时
   * 走与「已完成任务」取消勾选同款 picker 语义，包括 completed 任务）。
   *
   * v3 起没有「当前任务」真实分类，历史的默认行为是回「未分类」 ——
   * 到了 v3.5.2，回收站学了「已完成任务」的逻辑：进入 trash 时已记下原分类
   * （参见 deleteTask / batchDeleteTasks 头部注释），恢复时优先按之归位，
   * 这样用户在「工作」里删一条 → 回收站 Enter 默认就能回家。
   *
   * v3.4 起：恢复的「目标归属」与「完成态」必须同步 —— 任务如果 completed=true，
   * 恢复到普通子分类会破坏"已完成任务只活在 kind=COMPLETED"的不变量。所以
   * completed=true 的任务自动改投到「# 已完成任务」分类；用户指定的 toCategoryName
   * 在这种情况下被忽略 —— 与 v3.5.1 之前一致。completed 任务到了「已完成任务」
   * 仍然保留 originalCategory，下一次取消勾选时按之归位。
   *
   * 调用语义（v3.5.2+；与 toggleTask 对齐）：
   *   - 显式 toCategoryName：用用户选的 —— 落回 picker 走这条路径
   *   - 没传 toCategoryName：走 _resolveRestoreTarget 同款三分支
   *       category  → 直接归位，返回 { ok:true, restoreHint:{kind:'category', targetName} }
   *       picker    → **不动任务**，返回 picker hint 让 UI 弹分类选择器。
   *                    用户选完后再调 restoreTask(taskId, picked) 完成移动
   *                    （对称于 toggleTask 的 picker → restoreCompletedTask 链路）
   *       fallback  → 落到「未分类」，返回 { ok:true, restoreHint:{kind:'fallback'} }
   *
   * @param {string} taskId - 任务 id
   * @param {string|null} [toCategoryName] - 目标分类名称；省略则按原分类解析
   * @returns {{ ok: boolean, restored?: boolean, restoreHint?: { kind: string, targetName?: string, missing?: string } }}
   */
  restoreTask(taskId, toCategoryName = null) {
    const trash = this.getTrashCategory();
    if (!trash) return { ok: false };
    const idx = trash.tasks.findIndex(t => t.id === taskId);
    if (idx < 0) return { ok: false };

    const taskSnapshot = trash.tasks[idx];

    // 1) completed 任务：无视 toCategoryName，永远重投「已完成任务」分类。
    //    保留 task.originalCategory：将来再取消勾选要按它归位。
    if (taskSnapshot.completed) {
      const completedCat = this._getOrCreateCompletedCategory();
      // 重投「已完成」不读 *Position —— 这是「任务还在存档区但换了入口」语义，
      // 真正的「恢复」语义是回到原分类（uncompletePosition）。
      return this._doRestoreMove(taskSnapshot, idx, completedCat, trash, { kind: 'uncomplete' });
    }

    // 2) 显式 toCategoryName：用户从菜单 / picker 选了具体目标 —— 直接走。
    //    与原 contract 对齐：传无效名（旧名 / 容器 / 回收站）**返回 false 而不静默**
    //    兜底 —— 这是给 caller 的明确信号（说明 caller 在传一个不被接受的分类）。
    //    picker 路径里 UI 也是先确认 picked 名字合法再调回来，不会触发这条失败。
    //    默认恢复（无 toCategoryName）才走 _resolveRestoreTarget 的兜底。
    if (toCategoryName) {
      const explicit = this.getCategory(toCategoryName);
      const isAcceptable = explicit &&
        explicit.kind !== CategoryKind.OTHER_TASKS &&
        explicit.kind !== CategoryKind.TRASH;
      if (!isAcceptable) {
        // 任务仍在 trash 里；返回 { ok: false } 让 caller 知道。
        return { ok: false };
      }
      // 显式 restore：读 restorePosition（默认 front）
      return this._doRestoreMove(taskSnapshot, idx, explicit, trash, { kind: 'restore' });
    }

    // 3) 默认恢复 —— 与 _resolveRestoreTarget 共用同款三分支：
    //    - category   （原分类还在）     → 归位
    //    - picker     （原分类丢了）     → 不动任务，让 UI 弹选
    //    - fallback   （无 originalCategory） → 落到「未分类」，与 v3.5.1 前的默认行为兼容
    const resolve = this._resolveRestoreTarget(taskSnapshot);
    if (resolve.kind === 'picker') {
      // task 仍在 trash 里等 UI 决定走哪 —— 与 toggleTask 的 picker hint 完全对称，
      // UI 弹完菜单后调 restoreTask(taskId, picked) 走路径 2 完成移动。
      return {
        ok: true,
        restored: false,
        restoreHint: { kind: 'picker', missing: resolve.missing }
      };
    }
    // v4+ 修复：resolve 不再返回 target。fallback 现场解析（picker 已早返回），
    // category 直接用 resolve.target（_resolveRestoreTarget 已查到原分类对象）。
    const restoreTarget = resolve.kind === 'fallback'
      ? this._getOrCreateUncategorizedCategory()
      : resolve.target;
    // category / fallback 走归位落点，读 restorePosition（默认 front）
    return this._doRestoreMove(
      taskSnapshot, idx, restoreTarget, trash,
      { kind: 'restore', restoreHint: { kind: resolve.kind, targetName: restoreTarget.name } }
    );
  }

  /**
   * v3.5.2+：restoreTask / restoreCompletedTask 共用的内部步骤 —— 把任务从
   * 源分类（trash 或 completed）移到目标分类、发事件、按规则清 originalCategory。
   * 返回值对齐 restoreTask 的契约：
   *
   *   - { ok: true, restored: true, restoreHint? }   任务已就位（picker path 不会走这里）
   *   - target 不合法（如不存在 / 是容器 / 是回收站自身） → { ok: false }（不动任务）
   *
   * 注意：原任务在 trash.tasks 中的 idx 在 splice 后失效，所以一次性读出 task 引用
   * （splice 返回值）后再 push / 改字段，避免 idx 与位置错位。
   *
   * 落点由 kind 决定（kind 决定读哪个 *Position 设置）：
   *   - kind='restore'   → 读 restorePosition（回收站 → 原分类路径，由 restoreTask 调用）
   *   - kind='uncomplete' → 读 uncompletePosition（已完成 → 原分类路径，由 restoreCompletedTask 调用）
   * 两条路径默认都 'front'（最新在最上），与「任务从存档区重新激活」的语义对齐。
   *
   * @param {{ originalCategory?: string|null }} taskSnapshot
   * @param {number} idx - task 在 trash.tasks 中的位置
   * @param {Category} target - 目标分类（已知 kind 合法）
   * @param {Category} source - 源分类（trash / completed，由调用方传入）
   * @param {{ restoreHint?: object, kind?: 'restore'|'uncomplete' }} [opts]
   * @returns {{ ok: boolean, restored?: boolean, restoreHint?: object }}
   */
  _doRestoreMove(taskSnapshot, idx, target, source, opts = {}) {
    if (!target || target.kind === CategoryKind.OTHER_TASKS || target.kind === CategoryKind.TRASH) {
      // 防御性：调用方应自己保证 target 合法。万一漏了守卫，**不动任务**并返回 false。
      return { ok: false };
    }
    const [task] = source.tasks.splice(idx, 1);
    // 普通子分类里任务已"回家"，原分类标记是噪音；COMPLETED / TRASH 保留。
    // 与 v3.5.1 起的语义对齐：completed 任务回「已完成任务」时 originalCategory 保留，
    // 未来取消勾选仍可正确归位。
    if (target.kind !== CategoryKind.COMPLETED && target.kind !== CategoryKind.TRASH) {
      task.originalCategory = null;
    }
    // 落点由调用方传入的 kind 决定（restore / uncomplete 分别对应不同的 *Position 设置）。
    this._appendTaskWithPosition(target, task, opts.kind || 'restore');

    // 从 trash 移出时要把空 trash 的选中项带走（恢复操作特有的副作用）。
    if (source.kind === CategoryKind.TRASH) {
      this._followTrashIfEmptied(source, target.name);
    }
    this._markDirty({ tasks: task.id, categories: [source.name, target.name] });
    this.emit('tasks', { categoryName: source.name });
    this.emit('tasks', { categoryName: target.name });
    this.emit('categories');
    this.emit('change');
    // 任务已成功归位 —— 清掉 picker 计数，否则下次 toggle 时同 task 还会从
    // 上次的尝试次数起步，可能直接撞阈值被强制降级 fallback。
    // key 与 toggleTask 里的一致（task.id 或 `cat::idx` 兜底）。
    const taskKey = task.id || `${source.name}::${idx}`;
    this._pickerAttempts.delete(taskKey);
    return { ok: true, restored: true, ...(opts.restoreHint ? { restoreHint: opts.restoreHint } : {}) };
  }

  moveTask(fromCategoryName, taskId, toCategoryName, toIndex = -1) {
    const fromCat = this.getCategory(fromCategoryName);
    const toCat = this.getCategory(toCategoryName);
    if (!fromCat || !toCat) return false;
    // 容器和回收站都不接受 moveTask：
    //   - OTHER_TASKS 是纯容器，本身不存任务
    //   - TRASH 只通过 deleteTask 进入（走 unshift + 专用事件），restoreTask 离开
    //     如果 moveTask 也允许移入 TRASH，就会绕过 deleteTask 的专属流程
    //     （事件模式不同、不触发 categories 徽标更新的正确语义）
    if (toCat.kind === CategoryKind.OTHER_TASKS) return false;
    if (toCat.kind === CategoryKind.TRASH) return false;
    const idx = fromCat.tasks.findIndex(t => t.id === taskId);
    if (idx < 0) return false;
    const [task] = fromCat.tasks.splice(idx, 1);
    // v3.4：移到「已完成任务」分类时强制 completed=true —— 维持"完成态与分类归属同步"不变量。
    // 反向（从已完成分类移走）允许，但通常没有 UI 入口；这里只做正向的强制，避免拖动到
    // 已完成分类却没勾选造成不一致。
    // v3.5+：拖入「已完成」时也要记下原分类，与 toggleTask 勾选走完全相同的恢复语义。
    //   - 来源是子分类（parentOtherTasks）→ 记原分类名
    //   - 来源是已完成 / 容器 / 回收站 → 不重记（避免把无关分类当原分类）
    // v3.5.1+：反向（已完成 → 普通子分类）也要清掉 originalCategory —— 任务已
    // 回到普通分类里，原分类标记就是噪音；统一由 writer 层只在 COMPLETED/TRASH
    // 输出 [原分类：xxx]，但这里把字段清干净更便于外部检查 / 数据一致性。
    //
    // 防御：从回收站拖 completed 任务到普通子分类时，**强制改投「已完成任务」分类**。
    // restoreTask 同款规则 —— 让 moveTask 与 restoreTask 在"从 trash 恢复 completed 任务"
    // 这条路径上行为一致，避免把 completed=true 任务落到 NORMAL 分类里破坏
    // "completed=true 只活在 kind=COMPLETED"的不变量（v3.4 数据归属不变量）。
    // 真实入口：拖拽任务从回收站到侧边栏子分类；默认走这条路径。
    let effectiveTarget = toCat;
    if (fromCat.kind === CategoryKind.TRASH && task.completed && toCat.kind !== CategoryKind.COMPLETED) {
      effectiveTarget = this._getOrCreateCompletedCategory();
    }
    if (effectiveTarget.kind === CategoryKind.COMPLETED && !task.completed) {
      task.completed = true;
    }
    // v3.7+：从「已完成任务」拖 completed 任务到普通子分类 → 强制 completed=false。
    // 与 TRASH 防御改投的语义不同：这里**尊重用户的拖拽意图**——「把这条已完成的
    // 任务挪到工作列表里 = 让它回到活跃工作」。如果改投回「已完成任务」就违背
    // 用户意图（拖了半天还在原地），把 completed 翻成 false 是更直观的体验，
    // 也与 toggleTask 取消勾选走「COMPLETED → 原分类 + completed=false」对称。
    // 不变量维持：completed=false 任务活在 NORMAL 子分类 —— v3.4 数据归属不变量。
    //
    // 副作用告知：completed 翻转是隐式行为 —— 用户可能没意识到「拖过去会自动
    // 取消勾选」。return 时附带 completedFlipped:true，UI 在 toast 文案里
    // 补一句「（同时取消完成状态）」，让副作用可见。
    //
    // v3.7+ 实装方式：返回字符串 targetName（向后兼容所有 caller），completed 翻转
    // 通过下面 emit('task:completed-flipped') 事件告知 task-list，UI 弹 toast 时
    // 文案补一句。不用包装对象 / 改返回类型，避免大范围改 caller 签名。
    const completedFlipped = effectiveTarget.kind !== CategoryKind.COMPLETED && task.completed;
    if (completedFlipped) {
      task.completed = false;
    }
    // v3.5+：拖入「已完成」时也要记下原分类，与 toggleTask 勾选走完全相同的恢复语义。
    // 来源是 NORMAL 分类（无论是否挂在容器下）→ 记原分类名；其它（已完成 / 容器 /
    // 回收站 / 顶级 OTHER_TASKS）→ 不重记（避免把无关分类当原分类）。
    //
    // 与早期版本的 `fromCat.parentOtherTasks` 校验对比：早期版本只接受容器下子分类，
    // 漏掉「parser H2 提升路径产生的顶级 NORMAL」这种边缘场景 —— _ensureBaseStructure
    // 在加载时已把它们转成 parentOtherTasks=true，所以加载流程下两者等价；
    // 但与 toggleTask / batchToggleCompleted 的「cat.kind === NORMAL」对称能避免
    // 任何绕过 _ensureBaseStructure 的路径产生 originalCategory 静默丢失。
    // 详见 toggleTask line 1183 的 H3 修复注释。
    if (effectiveTarget.kind === CategoryKind.COMPLETED &&
        fromCat.kind === CategoryKind.NORMAL && fromCat.name) {
      task.originalCategory = fromCategoryName;
    }
    if (effectiveTarget.kind !== CategoryKind.COMPLETED && effectiveTarget.kind !== CategoryKind.TRASH) {
      // 移到任何普通分类（NORMAL/TODAY 等）都视为"到家"，原分类标记失去意义
      task.originalCategory = null;
    }
    if (toIndex < 0) {
      // 未指定落点（右键「移到分类…」/ 批量移动 / 拖到侧边栏分类）→ 读 movePosition 设置
      // 决定任务落到目标分类的「前面」还是「后面」。默认 'front'（最新在最上面）。
      this._appendTaskWithPosition(effectiveTarget, task, 'move');
    } else if (toIndex >= effectiveTarget.tasks.length) {
      effectiveTarget.tasks.push(task);
    } else {
      // toIndex 是「移除源之后」数组里的下标（task-list.js 的 rest 数组语义）：
      // 与 reorderTask 同款约定，UI 已经按 rest 算 toIndex，store 与之对齐。
      // 同 cat 移动时，上面 fromCat.tasks.splice(idx, 1) 已经从 fromCat 摘走 task，
      // 若 fromCat === effectiveTarget，effectiveTarget.tasks 此刻是「移除源之后」的数组。
      // splice(toIndex, 0, task) 直接插入到正确位置；toIndex >= length 会自然追加。
      effectiveTarget.tasks.splice(toIndex, 0, task);
    }
    // 从回收站移出也是一种「恢复」：搬空后同样要把选中项带走
    if (fromCat.kind === CategoryKind.TRASH) {
      this._followTrashIfEmptied(fromCat, effectiveTarget.name);
    }
    // dirty 跟踪 + emit 要覆盖实际参与的两个分类（防御性改投时两者可能不同）
    const dirtyCategories = Array.from(new Set([fromCategoryName, effectiveTarget.name]));
    this._markDirty({ tasks: task.id, categories: dirtyCategories });
    this.emit('tasks', { categoryName: effectiveTarget.name });
    this.emit('tasks', { categoryName: fromCategoryName });
    // 侧边栏各分类的计数都可能变（尤其从回收站「恢复」时，回收站徽标要跟着减）
    this.emit('categories');
    this.emit('change');
    // 返回实际生效的目标分类名（防御性改投时可能与调用方传入的不同）：
    //   - UI 弹 toast 时用这个值告诉用户真实去向，避免"显示移到 A、实际落到 B"的认知错位
    //   - 老 caller 只看 truthy/falsy 不读 .targetName 也照样工作
    if (completedFlipped) {
      // v3.7+：副作用告知。toast 在 caller 弹「已移到 X」之后，用户可能没意识到
      // 勾选也被翻了。emit 'task:completed-flipped'，UI 在 task-list 构造函数
      // 订阅、文案补「（同时取消完成状态）」。在 'change' 之后 emit，UI render
      // 已经看到最新状态（completed=false），不会出现"toast 已翻但 UI 未翻"的撕裂。
      this.emit('task:completed-flipped', {
        taskId: task.id,
        fromCategoryName: fromCategoryName,
        toCategoryName: effectiveTarget.name
      });
    }
    return effectiveTarget.name;
  }

  reorderTask(categoryName, fromIndex, toIndex) {
    const cat = this.getCategory(categoryName);
    if (!cat) return false;
    if (fromIndex === toIndex) return false;
    if (fromIndex < 0 || fromIndex >= cat.tasks.length) return false;
    // 允许 toIndex === cat.tasks.length —— 「拖到最后一条之后」是合法操作。
    // 旧实现用 >= 拒绝这个值，结果是用户拖到末尾时 reorder 静默失败，
    // 任务留在原位但 UI 没有反馈，看起来像「拖不动」。
    if (toIndex < 0 || toIndex > cat.tasks.length) return false;
    const [task] = cat.tasks.splice(fromIndex, 1);
    // toIndex 是「移除源之后」数组里的下标（task-list.js:2900 的 `rest` 数组语义）：
    //   - 落在末尾（toIndex === rest.length）→ splice 自然 clamp 到末尾追加
    //   - 落在中间 → splice 在 rest 数组的正确位置插入
    // 这里**不再**调整 toIndex —— 调整反而会让 toIndex === rest.length（拖到末尾）
    // 这种合法 case 错位插到中间。UI 已经按 rest 语义算 toIndex，store 与之对齐即可。
    cat.tasks.splice(toIndex, 0, task);
    // 用户主动重排 → 切回手动排序，否则下次渲染会按字母把结果抹掉
    this._switchToManualSort();
    this._markDirty({ categories: categoryName });
    this.emit('tasks', { categoryName });
    this.emit('change');
    return true;
  }

  /**
   * 批量清除已完成任务 —— 同 deleteTask，实际是「移到回收站」，不丢弃。
   *
   * v3.4 起所有 completed=true 的任务都活在 kind=COMPLETED 分类里，所以
   * 「指定 categoryName 之外的清理」实际等价于「清空已完成分类」。这里仍
   * 保留指定分类的接口（兼容旧 UI/测试），但只在以下两种情况有意义：
   *   - 调用方传 COMPLETED 分类：把该分类下所有任务搬到回收站
   *   - 调用方传 null：扫所有"非容器/非回收站"分类里的 completed=true 任务
   *     （理论上 v3.4 后只有 COMPLETED 分类会有 completed=true；扫描是为了防御
   *      外部编辑器手工编辑 / 加载流程的瞬态）
   *   - 调用方传普通子分类：原本是「清空该子分类的已完成任务」，v3.4 后实际不会
   *     找到任何任务（迁移已完成）；保留接口仅为语义对称
   *
   * @param {string|null} categoryName - 指定分类；省略则处理全部真实分类
   * @returns {number} 移入回收站的任务数
   */
  clearCompleted(categoryName = null) {
    const targets = (categoryName
      ? [this.getCategory(categoryName)].filter(Boolean)
      : this.categories.filter(c => c.kind !== CategoryKind.OTHER_TASKS)
    ).filter(c => c.kind !== CategoryKind.TRASH);

    // 先收集，再统一入站：避免边遍历 categories 边往其中插入回收站分类
    const moved = [];
    for (const cat of targets) {
      const keep = [];
      for (const t of cat.tasks) {
        if (t.completed) moved.push(t);
        else keep.push(t);
      }
      cat.tasks = keep;
    }
    if (moved.length === 0) return 0;

    const trash = this._getOrCreateTrashCategory();
    // 落点由 trashPosition 决定：
    //   - front：依次遍历 moved + 每条 unshift → 最后被处理的一条落在最前（与
    //     _appendTaskWithPosition 的「最新在最上」语义对齐）。
    //   - back ：按收集顺序整体 push —— 入参顺序里最早被处理的最先入站。
    // 注意 moved 是按 (分类在 categories 数组的顺序, 子分类内任务顺序) 收集的，
    // 这是 UI 上用户看到的全局顺序 —— 用户清空/批量删除时希望保留它。
    if (this._getInsertPosition('trash') === 'back') {
      for (const t of moved) trash.tasks.push(t);
    } else {
      for (let i = 0; i < moved.length; i++) {
        trash.tasks.unshift(moved[i]);
      }
    }

    this._markDirty({
      tasks: moved.map(t => t.id),
      categories: Array.from(new Set([...targets.map(c => c.name), trash.name])),
    });
    this.emit('tasks');
    this.emit('categories');
    this.emit('change');
    return moved.length;
  }

  // ============================================
  //  批量操作（选择模式）
  // ============================================
  //
  // 设计原则：
  //   1) 与单条 API 完全一致的守卫（OTHER_TASKS / TRASH 拒绝、TRASH 拒绝改 meta 等）。
  //   2) 整批操作只触发一次 _markDirty + 一次 emit('change') + 按分类去重的 emit('tasks')。
  //      这是与 clearCompleted 同款的「先收集 → 一次性提交」模式 —— N 条操作不会触发 N 次重渲染。
  //   3) 直接遍历 splice / push，不调单条 mutator（单条 mutator 每次都 emit，会破坏 #2）。
  //   4) 入参 taskRefs: Array<{categoryName, taskId}>。为什么不是单纯的 taskId[]：
  //      智能列表（current/important/completed/allTasks）的 cat.tasks 是 enriched 副本（含 _fromCategory），
  //      同一 id 可能出现在多个分类的副本里 —— 必须用「(分类, id)」复合定位，
  //      与 _finishDrag 里 `sourceTask._fromCategory || cat.name` 的取值方式完全对称。
  //   5) 所有方法都返回 { moved: number, skipped: number }，让 UI 显示精确 toast / 确认文案。
  //      skipped 包括「守卫拒绝」「找不到任务」「id 不存在」三种情况，不抛错。

  /**
   * 把 taskRefs 解析成 [{ category, task }] 数组，过滤掉找不到 / 守卫拒绝的项
   *
   * 不 mutate 入参数组；返回的新数组里每个元素带原 category / task 引用 + parseOrder 字段
   * （用于在循环结束后保持原顺序）。
   *
   * @returns {{ valid: Array<{category, task, parseOrder, sourceIndex}>, skipped: number }}
   */
  _resolveTaskRefs(taskRefs, { allowTrash = true, disallowSourceKinds = [] } = {}) {
    const valid = [];
    let skipped = 0;
    if (!Array.isArray(taskRefs) || taskRefs.length === 0) {
      return { valid, skipped: 0 };
    }
    for (let i = 0; i < taskRefs.length; i++) {
      const ref = taskRefs[i];
      if (!ref || !ref.categoryName || !ref.taskId) { skipped++; continue; }
      const cat = this.getCategory(ref.categoryName);
      if (!cat) { skipped++; continue; }
      if (disallowSourceKinds.includes(cat.kind)) { skipped++; continue; }
      if (!allowTrash && cat.kind === CategoryKind.TRASH) { skipped++; continue; }
      const idx = cat.tasks.findIndex(t => t.id === ref.taskId);
      if (idx < 0) { skipped++; continue; }
      valid.push({ category: cat, task: cat.tasks[idx], parseOrder: valid.length, sourceIndex: idx });
    }
    return { valid, skipped };
  }

  /**
   * 按 taskId 在所有分类里查找 —— _resolveTaskRefs 的「宽容」退路。
   *
   * 严格版 _resolveTaskRefs 要求 (categoryName, taskId) 配对：用户必须
   * 给出任务当前所在分类。这对 delete / move / reorder 是对的（用户
   * 「从这条列表里选中的」语义明确，宽容会把已删除的任务又翻出来乱动）。
   *
   * 但 toggle 是「按 id 翻状态」语义 —— 任务在哪都应该翻得到。
   * v3.4 之后 toggle 会自动跨分类移动（[✓] → 已完成；取消勾选 → 原分类，
   * v3.5+ 记在 [原分类：xxx]；原分类丢失才回未分类），
   * 同一批 refs 第二次调用时可能已经不在原 categoryName 了 —— 宽容路径
   * 必须保留，否则「勾选 / 撤回」批量操作会静默跳过所有任务。
   *
   * 返回值结构与 _resolveTaskRefs 的 valid 元素一致（category / task /
   * sourceIndex），方便 batchToggleCompleted 直接 concat 使用。
   *
   * @param {string} taskId
   * @returns {{ category, task, sourceIndex } | null}
   */
  _findTaskByIdAnywhere(taskId) {
    if (!taskId) return null;
    for (const cat of this.categories) {
      const idx = cat.tasks.findIndex(t => t.id === taskId);
      if (idx >= 0) return { category: cat, task: cat.tasks[idx], sourceIndex: idx };
    }
    return null;
  }

  /**
   * 批量删除（移到回收站）
   *
   * 与单条 deleteTask 同款守卫：
   *   - TRASH 内的任务被拒绝（彻底删除只能手工编辑 Markdown）
   *   - 找不到的任务静默跳过
   *
   * 一次性倒序 unshift 到 trash（沿用 clearCompleted 的回收站顺序约定）：
   *   先按 taskRefs 入参顺序收集 → 倒过来 unshift → 回收站里保留入参的相对顺序，
   *   与「最近删除排在最上面」语义一致。
   *
   * @param {Array<{categoryName, taskId}>} taskRefs
   * @returns {{ moved: number, skipped: number }}
   */
  batchDeleteTasks(taskRefs) {
    const { valid, skipped: resolveSkipped } = this._resolveTaskRefs(taskRefs, { allowTrash: false });
    if (valid.length === 0) return { moved: 0, skipped: resolveSkipped };

    // 按 (category, sourceIndex) 分组 → 同分类内的多次 splice 合并处理（避免下标漂移）
    const byCat = new Map();
    for (const v of valid) {
      if (!byCat.has(v.category)) byCat.set(v.category, []);
      byCat.get(v.category).push(v);
    }

    // 从每个分类里 splice 出来：按 sourceIndex 倒序删除（避免下标漂移）。
    // 收集顺序 = 「按 (源分类入组顺序, 源下标倒序)」，与 taskRefs 入参顺序不一致；
    // 真正的入参顺序由 valid 数组保留（parseOrder），下面用 valid 数组重建 moved 数组。
    //
    // v3.5.2+：进 trash 前补登原分类 —— 与单条 deleteTask 同款语义：
    //   - 来源是 NORMAL 且任务没有 originalCategory → 写下 cat.name
    //   - 来源是 COMPLETED → 不动（已完成任务在 toggle 时已记下它的"原"）
    // 与单条版共用同条不变量：每条任务进 trash 后仅在恢复路径或移出特殊分类时清 originalCategory。
    const sourceCats = [];
    for (const [cat, items] of byCat) {
      items.sort((a, b) => b.sourceIndex - a.sourceIndex);
      for (const it of items) {
        if (cat.kind === CategoryKind.NORMAL && !it.task.originalCategory) {
          it.task.originalCategory = cat.name;
        }
        cat.tasks.splice(it.sourceIndex, 1);
      }
      sourceCats.push(cat.name);
    }

    // 按 taskRefs 入参顺序收集 task（与 UI 选中顺序对齐，回收站里用户的最近一次删除排在最上面）
    const moved = valid.map(v => v.task);

    const trash = this._getOrCreateTrashCategory();
    // 落点由 trashPosition 决定 —— 与 clearCompleted 同款策略：
    //   - front：依次遍历 moved + 每条 unshift → 入参里最后被选中的那条落在最前
    //     （与「最新删除的最上面」对齐，找回时不用翻到底部）。
    //   - back ：按入参顺序整体 push —— 入参顺序里最早被选中的最先入站。
    if (this._getInsertPosition('trash') === 'back') {
      for (const t of moved) trash.tasks.push(t);
    } else {
      for (let i = 0; i < moved.length; i++) {
        trash.tasks.unshift(moved[i]);
      }
    }

    // 任一源分类是当前选中分类的话，调用方应在删除前主动切走选中；
    // store 不自动切 —— 批量删除可能只删 5 条里的 3 条，剩下还在原分类，
    // 自动切走会让用户失去原分类的工作上下文。
    this._markDirty({
      tasks: moved.map(t => t.id),
      categories: Array.from(new Set([...sourceCats, trash.name])),
    });
    this.emit('tasks'); // 全量刷新（含所有源分类与回收站）
    this.emit('categories'); // 回收站计数变化 → 侧边栏
    this.emit('change');
    return { moved: moved.length, skipped: resolveSkipped };
  }

  /**
   * 批量移到分类（跨分类移动）
   *
   * 与单条 moveTask 同款守卫：
   *   - 目标分类不允许是 OTHER_TASKS（容器不存任务）或 TRASH（绕过 deleteTask 专属流程）
   *   - 源分类不允许是 TRASH 的任务走此 API（从回收站恢复走 restoreTask）
   *   - 保留 taskRefs 入参顺序 push 到 toIndex 位置
   *
   * @param {Array<{categoryName, taskId}>} taskRefs
   * @param {string} toCategoryName
   * @param {number} [toIndex=-1] - 目标插入位置；-1 表示追加到末尾
   * @returns {{ moved: number, skipped: number }}
   */
  batchMoveTasks(taskRefs, toCategoryName, toIndex = -1) {
    if (!toCategoryName) return { moved: 0, skipped: (taskRefs || []).length };
    const toCat = this.getCategory(toCategoryName);
    if (!toCat) return { moved: 0, skipped: (taskRefs || []).length };
    if (toCat.kind === CategoryKind.OTHER_TASKS) return { moved: 0, skipped: (taskRefs || []).length };
    if (toCat.kind === CategoryKind.TRASH) return { moved: 0, skipped: (taskRefs || []).length };

    // 源分类允许的 kind：除 TRASH 外都可以（普通子分类、智能列表视图下的 enriched cat，
    // 都视为 NORMAL）。
    const { valid, skipped: resolveSkipped } = this._resolveTaskRefs(taskRefs, { allowTrash: false });
    if (valid.length === 0) return { moved: 0, skipped: resolveSkipped };

    // 按源分类分组 → 同分类内按 sourceIndex 倒序 splice（避免下标漂移）
    const byCat = new Map();
    for (const v of valid) {
      if (!byCat.has(v.category)) byCat.set(v.category, []);
      byCat.get(v.category).push(v);
    }
    const sourceCats = [];
    for (const [cat, items] of byCat) {
      items.sort((a, b) => b.sourceIndex - a.sourceIndex);
      for (const it of items) {
        cat.tasks.splice(it.sourceIndex, 1);
      }
      sourceCats.push(cat.name);
    }

    // 按 taskRefs 入参顺序重建 moving 数组（顺序 = UI 选中顺序，目标分类里保留这个顺序）
    const moving = valid.map(v => v.task);

    // v3.4 数据归属不变量双向强制 —— 与单条 moveTask 完全对称。
    //   1. 目标 = COMPLETED：强制 completed=true。
    //      之前批量版只处理反向（completed → NORMAL 强改 false），
    //      漏了正向，导致「移到已完成任务」后任务还停在 completed=false 的不一致态。
    //   2. 目标 ≠ COMPLETED：强制 completed=false。
    //      来源可能是「已完成任务」智能视图（enriched cat 视作 NORMAL），
    //      落到普通子分类必须翻成未完成，否则违反 "completed=true 只活在 kind=COMPLETED"。
    // 同时：来源是 NORMAL 分类（任意层级，_ensureBaseStructure 已统一）
    // 且目标是 COMPLETED 时，记 originalCategory —— 与单条 moveTask 对齐，
    // 确保之后取消勾选能正确归位。
    for (const v of valid) {
      const t = v.task;
      if (toCat.kind === CategoryKind.COMPLETED) {
        if (!t.completed) t.completed = true;
        if (v.category.kind === CategoryKind.NORMAL && v.category.name && !t.originalCategory) {
          t.originalCategory = v.category.name;
        }
      } else {
        if (t.completed) t.completed = false;
        // 移到任何普通分类都视为"到家"，原分类标记失去意义 —— 与单条 moveTask 对齐。
        t.originalCategory = null;
      }
    }

    // 插入目标：toIndex 处理
    //   - toIndex < 0（未指定，右键/批量「移到分类」默认值）→ 读 movePosition 设置
    //     决定整批落到目标分类的「前面」还是「后面」。整批维持入参顺序：
    //     front → 倒序 unshift（最后 unshift 的排最前，第一批入参落在最上面）
    //     back  → 正序 push（第一批入参落在最下面）
    //   - toIndex >= length → push 到末尾（显式越界时保持旧行为）
    //   - 其它 → splice 到精确位置（拖拽跨分类场景）
    if (toIndex < 0) {
      const pos = this._getInsertPosition('move');
      if (pos === 'back') {
        toCat.tasks.push(...moving);
      } else {
        // 倒序 unshift：moving[0] 最后 unshift → 落在最前面，保持入参顺序
        for (let i = moving.length - 1; i >= 0; i--) {
          toCat.tasks.unshift(moving[i]);
        }
      }
    } else {
      const targetLen = toCat.tasks.length;
      const insertAt = toIndex >= targetLen ? targetLen : toIndex;
      toCat.tasks.splice(insertAt, 0, ...moving);
    }

    // 用户主动重排 → 切回手动排序（与单条 moveTask 同款）
    this._switchToManualSort();

    this._markDirty({
      tasks: moving.map(t => t.id),
      categories: Array.from(new Set([...sourceCats, toCat.name])),
    });
    // 按分类去重发出 tasks 事件
    const emitCats = new Set([...sourceCats, toCat.name]);
    for (const name of emitCats) this.emit('tasks', { categoryName: name });
    this.emit('change');
    return { moved: moving.length, skipped: resolveSkipped };
  }

  /**
   * 批量切勾选状态
   *
   * 与单条 toggleTask 同款语义：TRASH 内允许切（用户常想恢复前清勾）。
   *
   * v3.4 起：传入 `completed=true` 时，源分类**非**已完成分类的任务会被自动搬到
   * 「# 已完成任务」（kind=COMPLETED）；传入 `completed=false` 时，已完成分类里的任务
   * 会被搬到「未分类」。与单条 toggleTask 的数据归属约定一致 —— 「completed 状态」
   * 与「分类归属」必须同步。
   *
   * 注意语义：第二个参数 `completed` 是布尔值，不是「切换」标志。
   * UI 调用方在「标记为完成」按钮里传 true、「标记为未完成」传 false。
   * 想"切换"就在 UI 侧先读当前态再决定传什么。
   *
   * @param {Array<{categoryName, taskId}>} taskRefs
   * @param {boolean} completed
   * @returns {{ changed: number, skipped: number }}
   */
  batchToggleCompleted(taskRefs, completed) {
    const { valid, skipped: resolveSkipped } = this._resolveTaskRefs(taskRefs, { allowTrash: true });

    // v3.4 退路：toggleTask 在 [✓] 后会自动搬到 # 已完成任务分类，
    // 同一批 refs 在第二次调用时可能不再位于原 categoryName —— 例如
    // 「我刚才勾选的 3 条任务，现在想撤回」：任务已经不在「工作」里。
    // 单条 toggleTask(categoryName, taskId) 是 location-tolerant 的（按
    // taskId 在所有分类里搜），批量版本也必须跟得上，否则用户「勾选 / 撤回」
    // 路径会莫名其妙静默跳过所有 3 条。
    //
    // 注意：这是 toggle 特有的语义，不是所有批量操作都该宽容：
    //   - delete / move / reorder 严格按 (categoryName, taskId) 配对
    //     —— 「删除我列表里选中的这 3 条」语义清晰，宽容会把已删除的任务
    //     又找出来乱动。
    //   - toggle 是「按 id 翻状态」，location-tolerant 是它的本质。
    const resolvedIds = new Set(valid.map(v => v.task.id));
    const fallback = [];
    if (Array.isArray(taskRefs)) {
      for (const ref of taskRefs) {
        if (!ref || !ref.taskId) continue;
        if (resolvedIds.has(ref.taskId)) continue;
        const found = this._findTaskByIdAnywhere(ref.taskId);
        if (found) {
          fallback.push(found);
          resolvedIds.add(ref.taskId);
        }
      }
    }
    const allValid = valid.concat(fallback);
    if (allValid.length === 0) return { changed: 0, skipped: resolveSkipped };

    const wantCompleted = !!completed;
    let changed = 0;
    const changedCats = new Set();
    const dirtyTaskIds = [];   // 记录每个真正被改动过的任务 id（供 _markDirty 用）
    // 先按 (sourceCatName, targetCatName) 分组待移动：避免单条 splice/push 中途
    // 跨过同一分类导致下标漂移。一次提交后再触发 events。
    const moves = []; // { task, sourceCat, sourceIdx, targetCat }
    for (const v of allValid) {
      if (v.task.completed === wantCompleted) continue;
      // 跨分类移动的判定与单条 toggleTask 同款语义
      const needsMove =
        (wantCompleted && v.category.kind !== CategoryKind.COMPLETED) ||
        (!wantCompleted && v.category.kind === CategoryKind.COMPLETED);
      if (needsMove) {
        moves.push({
          task: v.task,
          sourceCat: v.category,
          sourceIdx: v.sourceIndex
        });
      } else {
        v.task.completed = wantCompleted;
        changedCats.add(v.category.name);
        dirtyTaskIds.push(v.task.id);
      }
      changed++;
    }

    // 提交移动：先按源分类分组，组内按 sourceIdx 倒序 splice 避免下标漂移；
    // 再统一 push 到目标分类。
    //
    // v3.5+：targetCat 不再是单一的「已完成分类」或「未分类」——
    //   - wantCompleted=true：所有任务统一进「已完成分类」（与之前一致），
    //     每条任务的 originalCategory 设为各自的 sourceCat.name（仅子分类才记）。
    //   - wantCompleted=false：每条任务按 _resolveRestoreTarget 解析，
    //     原分类还在 → 直接归位（多条任务可能归到不同分类）；
    //     原分类丢了 / 没记录 → 批量场景下统一走「未分类」兜底，**不弹窗**
    //     （批量操作连续弹多个分类选择器会非常扰民；单条 toggle 的 picker
    //     行为已经在 toggleTask 里保留）。
    if (moves.length > 0) {
      const bySrc = new Map();
      for (const m of moves) {
        if (!bySrc.has(m.sourceCat)) bySrc.set(m.sourceCat, []);
        bySrc.get(m.sourceCat).push(m);
      }
      // 第一次循环：按 sourceIdx 倒序 splice（下标有效），同时把每个 task 的目标分类
      // 解析结果暂存到 targetByTask。下次构造 byTarget 时按入参顺序读回来，
      // 保证目标分类里任务的相对顺序与 taskRefs 入参顺序一致 —— 与 batchDeleteTasks
      // 用 valid.map(v => v.task) 重排 moved 数组的策略对齐。
      const targetByTask = new Map();
      for (const [srcCat, items] of bySrc) {
        // 按 sourceIdx 倒序 splice，确保每一步 idx 都有效
        items.sort((a, b) => b.sourceIdx - a.sourceIdx);
        for (const it of items) {
          srcCat.tasks.splice(it.sourceIdx, 1);
          changedCats.add(srcCat.name);
          let target;
          if (wantCompleted) {
            // 全部进已完成分类；记录原分类（任何 NORMAL 分类都算原分类源）
            target = this._getOrCreateCompletedCategory();
            if (srcCat.kind === CategoryKind.NORMAL && srcCat.name) {
              it.task.originalCategory = srcCat.name;
            }
          } else {
            // 从已完成分类退出：按 _resolveRestoreTarget 解析
            const resolve = this._resolveRestoreTarget(it.task);
            // v4+ 修复：resolve 不再返回 target（picker 路径不解析，避免副作用新建分类），
            // 这里现场解析：kind='category' 用原 target，'fallback' 用「未分类」，
            // 'picker'（批量路径不弹窗）按注释兜底到「未分类」。
            if (resolve.kind === 'category') {
              target = resolve.target;
            } else {
              // picker / fallback 都走「未分类」兜底（批量场景下 picker 走 fallback，避免 N 次弹窗）
              target = this._getOrCreateUncategorizedCategory();
            }
            // v3.5.1：恢复后清掉 originalCategory —— 标记已完成使命，避免
            // 目标分类里出现 `[原分类：xxx] 任务` 这种冗余噪音。
            it.task.originalCategory = null;
          }
          it.task.completed = wantCompleted;
          targetByTask.set(it.task, target);
        }
      }
      // 第二次循环：按 moves 入参顺序（=taskRefs 入参顺序）构造 byTarget，
      // 让目标分类里任务的相对顺序与 UI 选中顺序对齐 —— 前一次循环里 bySrc.items
      // 是按 sourceIdx 倒序排的（splice 下标有效需要），不能直接用。
      const byTarget = new Map(); // targetCat → [task]
      for (const m of moves) {
        const target = targetByTask.get(m.task);
        if (!byTarget.has(target)) byTarget.set(target, []);
        byTarget.get(target).push(m.task);
      }
      for (const [target, tasks] of byTarget) {
        // wantCompleted=true 走 completedPosition（批量打勾 = 新增到已完成）
        // wantCompleted=false 走 uncompletePosition（批量取消勾选 = 任务重新激活），
        // 与单条 toggleTask 取消勾选走 uncompletePosition 的语义对齐 —— 批量版的
        // _resolveRestoreTarget 把 picker 兜底为 fallback（不弹窗），但落到 NORMAL
        // 子分类这一动作仍是「重新激活」，所以读 uncompletePosition 而不是 push 末尾。
        const kind = wantCompleted ? 'completed' : 'uncomplete';
        const pos = this._getInsertPosition(kind);
        if (pos === 'back') {
          target.tasks.push(...tasks);
        } else {
          // front 模式：依次 unshift —— 入参里最后一条落在最前（最新在最上），
          // 与 importTasksToCategory / clearCompleted / batchDeleteTasks /
          // 批量打勾的「正序遍历 + unshift」语义对齐。
          for (let i = 0; i < tasks.length; i++) {
            target.tasks.unshift(tasks[i]);
          }
        }
        changedCats.add(target.name);
      }
      for (const it of moves) dirtyTaskIds.push(it.task.id);
    }

    if (changed === 0) return { changed: 0, skipped: resolveSkipped + allValid.length };

    this._markDirty({
      tasks: dirtyTaskIds,
      categories: Array.from(changedCats),
    });
    for (const name of changedCats) this.emit('tasks', { categoryName: name });
    this.emit('categories'); // 已完成分类的计数变化 → 侧边栏
    this.emit('change');
    return { changed, skipped: resolveSkipped + (allValid.length - changed) };
  }

  /**
   * 批量改 meta（important / current）
   *
   * v3.6+：与单条 updateTaskMeta 一致 —— TRASH 不再一刀切拒绝。⭐ / ▶ 是任务级
   * 标识，与 completed-toggle 那种跨分类转移不同；用户在回收站 / 已完成任务里
   * 也能批量改它们（例如「把这 10 条恢复出来之前先批量打当前」）。其它破坏性
   * 跨分类操作（删除 / 移动 / 完成态切换）仍按各自守卫走，不在这里放松。
   *
   * 第二个参数 meta 是 partial：只传要改的字段。
   * 已为 true 的 important 不会被改成 false（不传就不动）；
   * 想"切换"就在 UI 侧先读当前态再决定传什么。
   *
   * @param {Array<{categoryName, taskId}>} taskRefs
   * @param {{ important?: boolean, current?: boolean }} meta
   * @returns {{ changed: number, skipped: number }}
   */
  batchUpdateMeta(taskRefs, meta) {
    if (!meta || ('important' in meta) === false && ('current' in meta) === false) {
      return { changed: 0, skipped: (taskRefs || []).length };
    }
    // 默认走宽容路径（allowTrash: true）—— TRASH 现在允许改 meta（详见 updateTaskMeta
    // 注释）。其它 kind 走 _resolveTaskRefs 默认 disallowSourceKinds = []，不限制。
    const { valid, skipped: resolveSkipped } = this._resolveTaskRefs(taskRefs, { allowTrash: true });
    if (valid.length === 0) return { changed: 0, skipped: resolveSkipped };

    let changed = 0;
    const changedCats = new Set();
    for (const v of valid) {
      let localChanged = false;
      if ('important' in meta && !!meta.important !== !!v.task.important) {
        v.task.important = !!meta.important;
        localChanged = true;
      }
      if ('current' in meta && !!meta.current !== !!v.task.current) {
        v.task.current = !!meta.current;
        localChanged = true;
      }
      if (localChanged) {
        changed++;
        changedCats.add(v.category.name);
      }
    }
    if (changed === 0) return { changed: 0, skipped: resolveSkipped + valid.length };

    this._markDirty({
      tasks: valid.filter(v => changedCats.has(v.category.name)).map(v => v.task.id),
      categories: Array.from(changedCats),
    });
    for (const name of changedCats) this.emit('tasks', { categoryName: name });
    this.emit('change');
    return { changed, skipped: resolveSkipped + (valid.length - changed) };
  }

  /**
   * 批量重排序（单分类内）
   *
   * 把指定 taskIds 集合在 categoryName 内整体移到 top / bottom。
   * 顺序保留（taskIds 入参顺序就是最终顺序）。
   *
   * 守卫：
   *   - 目标分类必须存在且不是 OTHER_TASKS / TRASH
   *   - 所有 taskId 都必须在该分类内（不在的静默跳过）
   *   - 不在目标分类里的 task 跳过（避免误移）
   *   - store 层不感知 sortBy —— ALPHABET 下的禁用由 UI 层负责
   *
   * @param {string} categoryName
   * @param {string[]} taskIds
   * @param {'top' | 'bottom'} position
   * @returns {{ moved: number, skipped: number }}
   */
  batchReorderInCategory(categoryName, taskIds, position) {
    const cat = this.getCategory(categoryName);
    if (!cat) return { moved: 0, skipped: (taskIds || []).length };
    if (cat.kind === CategoryKind.OTHER_TASKS || cat.kind === CategoryKind.TRASH) {
      return { moved: 0, skipped: (taskIds || []).length };
    }
    if (position !== 'top' && position !== 'bottom') {
      return { moved: 0, skipped: (taskIds || []).length };
    }
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return { moved: 0, skipped: 0 };
    }

    // 按 id 找出对应的 task 引用 + 在 cat.tasks 里的当前下标
    // 用 Map<id, task> 索引（同一分类内 id 唯一）
    const wanted = new Map();
    for (const v of cat.tasks) wanted.set(v.id, v);
    const moving = [];
    let skipped = 0;
    for (const id of taskIds) {
      const t = wanted.get(id);
      if (!t) { skipped++; continue; }
      moving.push(t);
    }
    if (moving.length === 0) return { moved: 0, skipped };

    // 从 cat.tasks 里 splice 出来（按当前下标倒序，避免漂移）
    // 这里 splice 的是引用相等，不是按 id 找下标 —— 更稳
    const remaining = cat.tasks.filter(t => !moving.includes(t));
    // 顺序：remaining 保持原顺序，moving 整体移到 top/bottom
    const next = position === 'top'
      ? [...moving, ...remaining]
      : [...remaining, ...moving];
    cat.tasks = next;

    this._markDirty({
      tasks: moving.map(t => t.id),
      categories: categoryName,
    });
    this.emit('tasks', { categoryName });
    this.emit('change');
    return { moved: moving.length, skipped };
  }

  /**
   * 获取回收站分类；不存在则创建并追加到 categories 末尾。
   *
   * 位置必须是末尾：writeMarkdown 依赖数组顺序，回收站要写成最后一个 `# 回收站`。
   * 若插在「全部任务」容器和它的子分类之间，后面的子分类会被写成容器外的孤立 `##`，
   * 下次解析时它们的任务会被静默并进回收站 —— 同 _getOrCreateUncategorizedCategory 的教训。
   */
  /**
   * 回收站被清空且用户正看着它时，把选中项跟到任务恢复过去的分类。
   *
   * 为什么需要：侧边栏在回收站为空时会隐藏这个入口。若不改选中项，
   * 用户会停在一个「侧边栏里已经不存在」的分类上 —— 主面板显示"回收站是空的"，
   * 侧边栏却没有任何高亮项，而且回收站入口已消失、点不回来。
   * 跟着最后一条任务走，是唯一不需要用户再点一次的收尾。
   */
  _followTrashIfEmptied(trash, targetName) {
    if (trash.tasks.length > 0) return;
    if (this.selectedSmartList) return;
    if (this.selectedCategoryName !== trash.name) return;
    this.selectCategory(targetName);
  }

  _getOrCreateTrashCategory() {
    const existing = this.getTrashCategory();
    if (existing) return existing;
    const trash = this._createCategory(TRASH_NAME, CategoryKind.TRASH);
    this.categories.push(trash);
    return trash;
  }

  /**
   * 取（或懒创建）「已完成任务」分类（kind=COMPLETED）。
   *
   * 位置：在所有子分类之后、回收站之前 —— 与 `_normalizeOrder` 维护的
   * `[TODAY, 容器, ...子分类, 已完成任务, 回收站]` 不变量一致。
   * 由 `_ensureBaseStructure` 统一调用建好之后，运行时（toggleTask / batchToggleCompleted
   * / restoreTask 等）也都走这里 —— 单一入口保证位置不漂移。
   */
  _getOrCreateCompletedCategory() {
    const existing = this.getCompletedCategory();
    if (existing) return existing;
    const completed = this._createCategory(COMPLETED_NAME, CategoryKind.COMPLETED);

    // 找到回收站的「前一个位置」插入：已完成的约定位置是在子分类之后、回收站之前。
    // 极端情况下如果 categories 里没有回收站（_ensureBaseStructure 流程还没跑），
    // 就插到末尾，等下次 _normalizeOrder 时再统一归位。
    const trashIdx = this.categories.findIndex(c => c.kind === CategoryKind.TRASH);
    if (trashIdx >= 0) {
      this.categories.splice(trashIdx, 0, completed);
    } else {
      this.categories.push(completed);
    }
    return completed;
  }


  /**
   * 把「回收站」收敛成唯一一个 kind=TRASH 分类（仅在加载时调用）。
   *
   * 处理两类手工编辑产物：
   *   1. 文件里写了多个 `# 回收站` → 解析出多个 TRASH。把后面的任务并进第一个，
   *      再删掉多余的分类。绝不丢任务：回收站的内容只能由用户自己删。
   *   2. 把「回收站」写成了容器下的 `## 回收站`（解析成 NORMAL 子分类）→ 提升为 TRASH。
   *      与 addSubCategory 拒绝保留名的策略一致：叫这个名字就是回收站，
   *      不能让它伪装成普通分类（否则同名冲突会让 getCategory 指向错的那个）。
   *
   * 任务顺序按文件中的出现顺序拼接，不做去重 —— 用户看到的就是文件里的样子。
   */
  _consolidateTrash() {
    // 把「名字正好是规范名 回收站、但被解析成普通子分类」的那一个正名。
    //
    // 只认规范名，不认别名（trash / bin / 垃圾桶 …）—— 因为需要正名的唯一理由是
    // **重名冲突**：_getOrCreateTrashCategory() 会建一个叫「回收站」的分类，
    // 若文件里已有同名普通子分类，getCategory('回收站') 从此指向错的那个。
    // 叫「bin」的子分类不会和「回收站」撞名，没有冲突，就不该被强行改判 ——
    // 否则用户一个装着活跃任务的 `## bin` 会整段变成「已删除」，
    // 标题也在下次保存时消失。宁可少管，也不要把活跃任务标成垃圾。
    for (const c of this.categories) {
      if (c.kind === CategoryKind.TRASH) continue;
      if (c.kind === CategoryKind.OTHER_TASKS || c.kind === CategoryKind.TODAY) continue;
      if ((c.name || '').trim() === TRASH_NAME) {
        c.kind = CategoryKind.TRASH;
        c.isSpecial = true;
        c.parentOtherTasks = false;   // 回收站是 h1，不能挂在容器下
      }
    }

    const all = this.categories.filter(c => c.kind === CategoryKind.TRASH);
    if (all.length <= 1) return;

    const primary = all[0];
    for (const dup of all.slice(1)) {
      primary.tasks.push(...dup.tasks);
    }
    const extras = new Set(all.slice(1));
    this.categories = this.categories.filter(c => !extras.has(c));
  }

  /**
   * 收敛容器下的「未分类」子分类 —— 与 _consolidateTrash 对称。
   *
   * 「未分类」是容器下的保留名（任务兜底），只能存在一份。markdown-parser 在遇到
   * 重复 `## 未分类` 时已经会合并第一份，本方法是 store 层的兜底防御：
   * 任何绕过 parser 的路径（未来的 merge 工具、外部导入、调试脚本……）都不能让
   * 「未分类」在内存里出现两份 —— 两份会让：
   *   - sidebar 渲染两份同名入口（用户看到的 bug）
   *   - getCategory('未分类') 只认第一份，第二份里的任务在 UI 上既看不见也没法恢复
   * 合并策略：保留 categories 数组里最早出现的那份（与 parser 的"复用第一个"行为
   * 一致 —— 文件里第一次出现的 `## 未分类` 是权威），后续副本的任务全部并入、丢弃副本。
   */
  _consolidateUncategorized() {
    const all = this.categories.filter(
      c => c.parentOtherTasks && c.name === UNCATEGORIZED_NAME
    );
    if (all.length <= 1) return;

    const primary = all[0];
    for (const dup of all.slice(1)) {
      primary.tasks.push(...dup.tasks);
    }
    const extras = new Set(all.slice(1));
    this.categories = this.categories.filter(c => !extras.has(c));
  }

  /**
   * 收敛「已完成任务」分类 —— 与 _consolidateTrash / _consolidateUncategorized 对称。
   *
   * v3.4 起「已完成任务」是真实分类（kind=COMPLETED），与回收站、未分类同列为保留名
   * 兜底。手工编辑产物有两类必须收敛：
   *
   *   1. 文件里写了多个 `# 已完成任务` → parser 解析出多个 COMPLETED。把后面的任务
   *      并进第一个，再删掉多余的分类。绝不丢任务：已完成任务只能由用户自己删。
   *   2. 把「已完成任务」写成了容器下的 `## 已完成任务`（解析成 NORMAL 子分类）→
   *      提升为 COMPLETED，避免 getCompletedCategory() / getCategory('已完成任务') 指向错
   *      的对象（与 _consolidateTrash 第一段同源问题）。
   *
   * 与 _consolidateTrash 的细微差异：不主动从 NORMAL 子分类里「搬 completed=true 的
   * 任务」过来 —— 那是 _migrateCompletedTasksToCategory 的职责（且 v3.4 数据归属不变
   * 量规定 NORMAL 子分类里不该有 completed=true 任务，发现就该报错/迁移而不是悄悄
   * 兜底）。本函数只处理「分类本身重复/错名」，不混职责。
   */
  _consolidateCompleted() {
    // 把「名字正好是规范名『已完成任务』、但被解析成普通子分类」的那一个正名。
    // 与 _consolidateTrash 第一段同源：避免 _getOrCreateCompletedCategory() 与文件里
    // 已有的同名普通子分类撞名。名字必须是规范名 COMPLETED_NAME 才认，别名（completed
    // tasks / 完成 / finished）不强制 —— 与 _consolidateTrash 行为对称。
    for (const c of this.categories) {
      if (c.kind === CategoryKind.COMPLETED) continue;
      if (c.kind === CategoryKind.OTHER_TASKS || c.kind === CategoryKind.TODAY) continue;
      if ((c.name || '').trim() === COMPLETED_NAME) {
        c.kind = CategoryKind.COMPLETED;
        c.isSpecial = true;
        c.parentOtherTasks = false;   // 已完成任务是 h1，不能挂在容器下
      }
    }

    const all = this.categories.filter(c => c.kind === CategoryKind.COMPLETED);
    if (all.length <= 1) return;

    const primary = all[0];
    for (const dup of all.slice(1)) {
      primary.tasks.push(...dup.tasks);
    }
    const extras = new Set(all.slice(1));
    this.categories = this.categories.filter(c => !extras.has(c));
  }

  // ============================================
  //  搜索
  // ============================================

  setSearchQuery(query) {
    const newQuery = (query || '').trim();
    // 与 setFilter / setSortBy 同款：值未变就别 emit，避免每次同值输入都触发
    // 全量重渲染（每键都打 'change' 会让 task-list.js / sidebar.js 都跑一遍）。
    if (newQuery === this.searchQuery) return;
    this.searchQuery = newQuery;
    // 同步缓存小写版：highlightTaskText / getVisibleTasks 都按
    // 任务调一次，若每次都重新 toLowerCase() 会变成 O(任务数 × 搜索词长) 的冗余计算。
    // 而搜索词在 setSearchQuery 之外不会变 —— 在这里算一次就够了，渲染热路径
    // 里直接查表。
    this._searchQueryLower = this.searchQuery.toLowerCase();
    // v4+ 修复：旧实现 emit('search', ...) —— 但全项目无任何 on('search') 订阅方
    // (grep 已确认)。监听者全靠 'change' 事件触发重渲染,这条 emit 是死代码。
    // 搜索词变化已通过 'change' 事件传达,这里只留 change 一条就够了。
    this.emit('change');
  }

  setFilter(filter) {
    if (!Object.values(Filter).includes(filter)) return;
    if (this.filter === filter) return;
    this.filter = filter;
    this.emit('filter', filter);
    this.emit('change');
  }

  setSortBy(sortBy) {
    if (!Object.values(SortBy).includes(sortBy)) return;
    if (this.sortBy === sortBy) return;
    this.sortBy = sortBy;
    this.emit('sort', sortBy);
    this.emit('change');
  }

  /**
   * 内部 helper：把排序方式切到 MANUAL 并发 sort 事件。
   *
   * 三处原本各自复制 4 行「判不等 → 赋值 → emit('sort')」（reorderTask 1425、
   * batchMoveTasks 1672、loadFromContent 文件顺序触发的 303），抽到这里。
   *
   * 保留判空（已经是 MANUAL 时直接 return）—— 否则每次用户拖拽都会重发 sort
   * 事件，触发整列表的 renderer 重渲染。判空靠 this.sortBy === MANUAL 一行短路，
   * 不需要额外缓存字段。
   */
  _switchToManualSort() {
    if (this.sortBy === SortBy.MANUAL) return;
    this.sortBy = SortBy.MANUAL;
    this.emit('sort', SortBy.MANUAL);
  }

  /**
   * 获取任务在当前过滤/排序下的可见列表
   *
   * 过滤顺序：filter → search → sort
   * 排序策略：
   *   - MANUAL：保持 cat.tasks 原始顺序（用户在 UI 上的手动调整）
   *   - ALPHABET：未完成在前 + 已完成在后，每组内按字母排（中文混排由 localeCompare 自然处理）
   */
  getVisibleTasks(category) {
    if (!category) return [];
    let tasks = category.tasks;

    // 1) 过滤
    //
    // 「当前任务 / 已完成任务 / 重要任务」智能列表本身就是一次过滤的结果，语义已被列表名固定，
    // 再叠加全局 filter 只会自相矛盾（例如在「已完成」里选 filter=pending → 永远空列表）。
    // UI 上这三个列表的过滤按钮是隐藏的（task-list.js 的 hideOnSmart），
    // 所以这里必须同步跳过过滤，否则用户被一个看不见、也关不掉的过滤器锁死。
    const bypassFilter =
      category.isSmartList &&
      (category.smartKey === 'completed' || category.smartKey === 'important' || category.smartKey === 'current');

    if (!bypassFilter) {
      if (this.filter === Filter.CURRENT) {
        tasks = tasks.filter(t => t.current);
      } else if (this.filter === Filter.COMPLETED) {
        tasks = tasks.filter(t => t.completed);
      } else if (this.filter === Filter.IMPORTANT) {
        tasks = tasks.filter(t => t.important);
      }
    }

    // 2) 搜索（在过滤结果上再次过滤）
    if (this.searchQuery) {
      // _searchQueryLower 由 setSearchQuery 同步缓存，避免每次 filter 回调里
      // 再 toLowerCase() 一次（任务量大时会变热路径里的可见瓶颈）
      //
      // v3.7+：把 originalCategory 也纳入匹配 —— UI 上原分类标签是独立 badge
      // 显示，搜索框只匹配 text 会让用户搜不到「原分类：工作」里的"工作"两字。
      // 把 origCat 加到 includes 里扩大语义：搜"工作"既能命中 text 里出现
      // "工作"的任务，也能命中原始分类为「工作」（现在在已完成 / 回收站），
      // 用户找跨分类源头时不会再以为"为什么搜不到"。
      // origCat 为 null 时短路 —— 空字符串 includes 任何查询都会 true，会把
      // 所有任务都匹配（这是典型 bug vector，必须先做 null 检查）。
      tasks = tasks.filter(t =>
        t.text.toLowerCase().includes(this._searchQueryLower) ||
        (t.originalCategory && t.originalCategory.toLowerCase().includes(this._searchQueryLower))
      );
    }

    // 3) 排序
    if (this.sortBy === SortBy.ALPHABET) {
      // 不修改原数组；先拆成「未完成 / 已完成」两组，组内按字母排，再拼接
      // 这样已完成任务统一沉底，避免穿插在未完成之间的视觉噪音
      // 不传 locale：用浏览器/系统默认 locale，让中文/英文/数字混排走自然的 ICU 排序
      const pending = tasks.filter(t => !t.completed);
      const completed = tasks.filter(t => t.completed);
      const byAlpha = (a, b) => a.text.localeCompare(b.text);
      pending.sort(byAlpha);
      completed.sort(byAlpha);
      tasks = [...pending, ...completed];
    }
    return tasks;
  }

  /**
   * 获取带搜索高亮的任务文本段
   */
  highlightTaskText(text) {
    if (!this.searchQuery) return [{ text, highlight: false }];
    const q = this.searchQuery;
    const parts = [];
    // 在 text 上做大小写不敏感匹配 —— 不用 lowerText.indexOf，因为后者在
    // toLowerCase() 改变字符长度的边界场景（土耳其语 İ → i̇ 长度 1→2）下，
    // lowerText 下标与 text 下标不对应，slice 会错位（高亮位置交替错乱）。
    // 算法：逐字符扫描 text，对每个起点尝试把 lowerQuery 与后续字符的 .toLowerCase()
    // 比较。语义与 text.toLowerCase().includes(query.toLowerCase()) 完全对齐：
    //   - text="İ", q="i" → lowerText="i̇", lowerQuery="i"，"i̇".includes("i")=true，
    //     高亮 "İ" 也标 highlight（虽然只消耗了 "i̇" 的前 1 个字符）
    //   - text="Hello World", q="l" → 单字符匹配，高亮每个 "l"
    // 复杂度 O(n*m)，但任务文本都很短（典型几十字），无性能问题。
    // 不走 RegExp 路线：避免 searchQuery 里的元字符（. * ? + 等）触发非预期匹配，
    // 也免去对 query 做转义的额外辅助函数。
    const lowerQuery = this._searchQueryLower;
    const queryLen = lowerQuery.length;
    let cursor = 0;
    let i = 0;
    while (i < text.length) {
      let matchLen = 0;     // text 字符数（待匹配会跨多少个 text 字符）
      let lowerLen = 0;     // 已匹配的 lowerText 字符数
      let matched = true;
      while (lowerLen < queryLen) {
        if (i + matchLen >= text.length) { matched = false; break; }
        const charLower = text[i + matchLen].toLowerCase();
        // charLower 的前 N 个字符必须 === lowerQuery[lowerLen..lowerLen+N]，
        // 其中 N = min(charLower.length, queryLen - lowerLen) —— 因为 toLowerCase()
        // 可能让一个 text 字符展开成多个 lowerText 字符（如 İ → i̇），我们需要按
        // 「lowerQuery 还差多少字符」来决定这个 text 字符能贡献多少 lowerText 字符。
        const remaining = queryLen - lowerLen;
        const take = Math.min(charLower.length, remaining);
        if (charLower.slice(0, take) !== lowerQuery.slice(lowerLen, lowerLen + take)) {
          matched = false;
          break;
        }
        lowerLen += take;
        matchLen++;
      }
      if (matched) {
        if (cursor < i) {
          parts.push({ text: text.slice(cursor, i), highlight: false });
        }
        parts.push({ text: text.slice(i, i + matchLen), highlight: true });
        cursor = i + matchLen;
        i = cursor;  // 跳到匹配结束位置继续
      } else {
        i++;
      }
    }
    if (cursor < text.length) {
      parts.push({ text: text.slice(cursor), highlight: false });
    }
    return parts;
  }

  // ============================================
  //  主题
  // ============================================

  resolveTheme() {
    if (this.theme === 'auto') {
      return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    return this.theme === 'light' ? 'light' : 'dark';
  }

  setTheme(theme) {
    if (theme !== 'light' && theme !== 'dark' && theme !== 'auto') return;
    this.theme = theme;
    this.emit('theme', theme);
  }

  // ============================================
  //  内部辅助
  // ============================================

  /**
   * 确保基础结构存在（全部任务 容器 + 至少一个子分类「未分类」+ 已完成任务 + 回收站）
   * 并做一次性迁移：
   *   - 旧的 `# 当前任务` / `# 我的一天` 等章节 → 任务搬到首个子分类并打 @当前 标记，删掉分类
   *   - 旧的 NORMAL 分类 → 「全部任务」下的子分类
   *   - 旧的「其他任务」/「全部任务」/「待办任务」容器名 → 「全部任务」
   *   - 「# 回收站」多份/挂错位置 → 收敛成唯一一个 kind=TRASH
   *   - v3.4：散落在各子分类的 [✓] 任务 → 搬到 kind=COMPLETED 的「# 已完成任务」
   *           （一次性升级迁移。之后的 toggle / batchToggle / restore 都会自动保持
   *           「completed=true 的任务只活在已完成分类里」的不变量）
   *
   * v3 起不再需要「当前任务」真实分类 —— 它下沉为 @当前 标识 + 智能视图。
   * 旧文件里仍有的 `# 当前任务` 章节会被迁移方法一次性消化，
   * 下一次保存时新文件就是纯标识驱动结构。
   */
  _ensureBaseStructure() {
    // 归一：手工编辑的文件可能出现「多个 # 回收站」或「## 回收站 子分类」。
    // 两种情况都必须收敛成唯一一个 kind=TRASH，否则：
    //   - 多个 TRASH：getTrashCategory() 只返回第一个，后面那些的任务在界面上
    //     既看不见也没法恢复（文件里还在，但对用户等于消失了）。
    //   - 「回收站」被当成普通子分类：之后 _getOrCreateTrashCategory() 会再建一个
    //     同名分类，getCategory('回收站') 从此指向错的那个，恢复/删除全部错位。
    // 合并而不是丢弃 —— 回收站里的东西只能由用户手工删。
    this._consolidateTrash();

    // 「未分类」收敛 —— 与 _consolidateTrash 对称。parser 已经处理大部分重复，
    // 这里兜底防御任何绕过 parser 的路径（merge 工具、外部导入、调试脚本……）。
    this._consolidateUncategorized();

    // 迁移：「其他任务」/「全部任务」/「待办任务」容器名 → 「全部任务」（v2 重命名链）
    // 同时确保容器存在 —— v3 起这是唯一一个真实容器章节
    this._ensureOtherTasksContainer();

    // 确保至少有 1 个子分类（默认「未分类」）—— _migrateTodayCategory 需要目标
    this._ensureUncategorizedSub();

    // 迁移：旧的 `# 当前任务` / `# 我的一天` 章节下的任务 → 搬到子分类 + 打 @当前 标记
    // 必须在 _normalizeOrder 之前执行，否则临时分类会被排到末尾再被合并逻辑忽略。
    this._migrateTodayCategory();

    // v3.4：确保「# 已完成任务」分类存在，并把散落在子分类里的 [✓] 任务搬过去。
    // 这一步**必须**在 `_normalizeOrder` 之前 —— 否则迁移过去的目标位置（kind=COMPLETED
    // 在子分类之后、回收站之前）会被排到末尾再被合并不见。
    //
    // 同样的：先 `_consolidateCompleted()` 收敛文件里已有的多个 `# 已完成任务` 副本或
    // 误解析为 NORMAL 的同名分类，再 `_getOrCreateCompletedCategory()` 兜底确认存在。
    // 顺序与 _consolidateTrash / _getOrCreateTrashCategory 的前后对称。
    this._consolidateCompleted();
    this._getOrCreateCompletedCategory();
    this._migrateCompletedTasksToCategory();

    // 迁移：旧的 NORMAL 分类 → 「全部任务」下的子分类
    for (const c of this.categories) {
      if (c.kind === CategoryKind.NORMAL && !c.parentOtherTasks) {
        c.parentOtherTasks = true;
      }
    }

    // 兜底：若迁移过程里容器/子分类被误删，再建一次
    if (!this._findByKind(CategoryKind.OTHER_TASKS)) {
      const o = this._createCategory(OTHER_TASKS_NAME, CategoryKind.OTHER_TASKS);
      this.categories.unshift(o);
    }
    if (!this.categories.some(c => c.parentOtherTasks)) {
      this._ensureUncategorizedSub();
    }

    // 最后统一归位（必须在所有迁移之后）
    this._normalizeOrder();
  }

  /**
   * 把 categories 数组按规范顺序归位：[当前任务, 全部任务容器, ...子分类, 已完成任务, 回收站]。
   *
   * 子分类之间的相对顺序保持不变（用户的手动排序不能被打乱），
   * **除了「未分类」必须始终排在子分类末尾** —— 它是删除/取消勾选时的任务兜底，
   * 任何让它漂离末尾的状态都会让用户新建的分类掉到它下面，体验与 bug 一致。
   *
   * 手工编辑的文件 / 旧版迁移残留 / 外部合并都可能让「未分类」出现
   * 在子分类中间，这里统一拉回 —— 与 reorderSubCategory 在运行时侧
   * 阻止「未分类」被拖走形成对称：运行时守入口，加载时兜底归位。
   *
   * 为什么必须做：writeMarkdown 完全依赖数组顺序 —— 容器写成 `# 全部任务`，
   * 其后的 parentOtherTasks 写成 `## 子分类`。若某个子分类排在容器**之前**
   * （旧文件里 `# 工作` 出现在 `# 全部任务` 之前时，上面的迁移只改标记不改位置），
   * 就会写出一个位于容器外的 `## 工作`；而 parseMarkdown 会忽略容器外的 h2，
   * 该分类连同它的任务会在下次加载时被静默并入上一个分类 —— 即数据损坏。
   *
   * v3.4 起新增「已完成任务」位置：排在**所有子分类之后、回收站之前**。
   * 回收站必须排在**最末尾**：它写成 `# 回收站`（h1），
   * 一旦夹在子分类中间就会提前关闭容器段，让后面的 `## 子分类` 落到容器之外 ——
   * 与上面同一种数据损坏。
   *
   * @param {Array} [categories] 不传则用 this.categories
   * @returns {Array} 重排后的数组
   */
  _normalizeOrder(categories = this.categories) {
    const today = categories.filter(c => c.kind === CategoryKind.TODAY);
    const container = categories.filter(c => c.kind === CategoryKind.OTHER_TASKS);
    const completed = categories.filter(c => c.kind === CategoryKind.COMPLETED);
    const trash = categories.filter(c => c.kind === CategoryKind.TRASH);
    const subs = categories.filter(
      c => c.kind !== CategoryKind.TODAY &&
           c.kind !== CategoryKind.OTHER_TASKS &&
           c.kind !== CategoryKind.COMPLETED &&
           c.kind !== CategoryKind.TRASH
    );
    // 「未分类」拉回子分类末尾（仅在它存在且不在末尾时）—— 详见方法顶部注释
    const unIdx = subs.findIndex(c => c.name === UNCATEGORIZED_NAME);
    let orderedSubs = subs;
    if (unIdx >= 0 && unIdx !== subs.length - 1) {
      const unCat = subs[unIdx];
      orderedSubs = [...subs.slice(0, unIdx), ...subs.slice(unIdx + 1), unCat];
    }
    const ordered = [...today, ...container, ...orderedSubs, ...completed, ...trash];
    if (categories === this.categories) {
      this.categories = ordered;
    }
    return ordered;
  }

  /**
   * v3.4 一次性升级迁移：把散落在各子分类的 [✓] 任务搬到「# 已完成任务」分类。
   *
   * 升级前：用户在「工作」「学习」等子分类里直接 `[✓]` 任务 —— 任务实体
   * 留在子分类，仅靠 `task.completed=true` 标记。
   * 升级后：所有 [✓] 任务必须只活在 kind=COMPLETED 分类里 —— 与「回收站」
   * 同款「数据归属与状态同步」原则。
   *
   * 升级窗口内的归位：
   *   1. 子分类里 completed=true 的任务 → 搬到「# 已完成任务」，保留顺序与文本
   *   2. 旧文件可能在「# 已完成任务」（旧版做镜像段）下已经有任务 —— parser
   *      v3.4 起把这种 h1 识别为真实分类后，那些任务保留在原 cat.tasks 里
   *      （已是目标位置），无需重复搬
   *   3. 旧版「# 已完成任务 镜像段」下的任务可能带 [⭐]/[▶] inline 标记，
   *      merge 时已经由 parseMarkdown 抽进 fields，文本也已经被剥净 —— 这里
   *      迁移的只是 completed=true 的判定，标记字段保持原状
   *
   * 仅在加载时跑一次 —— 运行时 toggle/batchToggle 已自带跨分类搬运，这条迁移
   * 路径不会被重复触发。
   */
  _migrateCompletedTasksToCategory() {
    const completedCat = this.getCompletedCategory();
    if (!completedCat) return;
    let movedCount = 0;
    for (const cat of this.categories) {
      if (cat === completedCat) continue;
      // 只从子分类 / TODAY 临时分类搬；TRASH 里允许有 completed=true 的任务
      // （用户可能勾选了回收站里的任务），不该被打扰
      if (cat.kind === CategoryKind.TRASH) continue;
      if (cat.kind === CategoryKind.OTHER_TASKS) continue;
      // 收集再统一提交，避免边遍历 cat.tasks 边往 completedCat.tasks 里 push
      // 时若分类有引用关系（极端情况下 cat === completedCat）导致下标漂移
      const moving = [];
      const keep = [];
      for (const t of cat.tasks) {
        if (t.completed) moving.push(t);
        else keep.push(t);
      }
      if (moving.length > 0) {
        cat.tasks = keep;
        // v3.5+：迁移时把来源子分类名写到每条任务的 originalCategory 上 —— 旧文件
        // 升级后用户立即享受"取消勾选回到原分类"的能力，不会因为升级而丢掉这个信息。
        // 仅在来源是子分类（parentOtherTasks）时记 —— TODAY 临时分类不该成为原分类语义
        // （迁移完它就被删了，记它会让后续恢复去找一个不存在的分类）。
        const isSubcategory = !!cat.parentOtherTasks;
        for (const t of moving) {
          if (isSubcategory && !t.originalCategory) {
            t.originalCategory = cat.name;
          }
        }
        // 顺序保留：把 moving 直接 push 到 completedCat.tasks 末尾，保持"按子分类
        // 出现顺序 + 子分类内任务顺序"的全局顺序 —— 与 UI 上看到的一致。
        completedCat.tasks.push(...moving);
        movedCount += moving.length;
      }
    }
    // 静默迁移（不 emit、不 toast）：用户视角是"打开文件后已完成任务自动归位"，
    // 就像"加载新版本后文件自动重排"一样的预期，不需要打扰。
    // 仅在确实有迁移发生时留给后续 _markDirty / autoSave 流程统一刷一次磁盘
    // （loadFromContent 已经把 dirty=false 显式设上了 —— 这里不必再推一次）。
    if (movedCount > 0 && typeof console !== 'undefined') {
      console.info(`[task-store] 已完成任务升级迁移：${movedCount} 条任务搬到「# 已完成任务」`);
    }
  }

  /**
   * v3 迁移核心：把旧文件里 `# 当前任务` / `# 我的一天` 等章节下的任务，
   * 搬到首个子分类并打上 current=true 标记，然后删掉这个临时分类。
   *
   * 为什么不直接合并到某个固定子分类（如「未分类」）？
   *   - 旧文件通常已有更贴近用户意图的子分类（工作/学习/…）—— 用户以前一定是
   *     先在子分类里写任务，再复制到「当前任务」方便聚焦。新策略要求每条任务有
   *     自己的归属分类，搬到「首个子分类」是最不让人意外的兜底。
   *   - 已无任务的临时分类直接删掉，不留痕迹。
   *
   * 为什么不保留这个分类作为 NORMAL（让用户可以手动删）？
   *   - 那样它会出现在侧边栏的「全部任务」容器下，且无法被识别为「当前任务」视图。
   *     用户在「当前任务」视图里看到的将是空集，体验非常迷惑。
   *   - 直接迁移 + 删除，副作用最小：用户下次保存就只剩扁平结构了。
   */
  _migrateTodayCategory() {
    const todayCat = this._findByKind(CategoryKind.TODAY);
    if (!todayCat) return;

    // 临时分类没任务：直接删掉，不影响数据
    if (!todayCat.tasks || todayCat.tasks.length === 0) {
      const idx = this.categories.indexOf(todayCat);
      if (idx >= 0) this.categories.splice(idx, 1);
      return;
    }

    // 挑目标子分类：优先「未分类」（任务没归处时的合理兜底），
    // 否则用第一个现存子分类。_ensureUncategorizedSub 已保证至少有「未分类」。
    let target = this.categories.find(
      c => c.parentOtherTasks && c.name === UNCATEGORIZED_NAME
    );
    if (!target) {
      target = this.categories.find(c => c.parentOtherTasks);
    }
    if (!target) {
      target = this._getOrCreateUncategorizedCategory();
    }

    // 合并任务 + 打 @当前 标记
    for (const task of todayCat.tasks) {
      task.current = true;
      target.tasks.push(task);
    }
    todayCat.tasks = [];

    // 删掉临时分类（按引用删除，避免索引错位）
    const idx = this.categories.indexOf(todayCat);
    if (idx >= 0) this.categories.splice(idx, 1);
  }

  /**
   * 把主进程 writeFile 返回的 result 包成 save-error 事件载荷：
   *   { code: result.error, message: result.error, diskContent: result.diskContent }
   *
   * 历史约定：save-error 事件载荷是字符串（旧版只发 result.error）。
   * v3.4+ 主进程在 EXTERNAL_CHANGE_DETECTED 时附带 diskContent —— 把它也带上，
   * 让外部修改冲突流程不需要再发一次 file:read。
   *
   * 注意：code 字段固定是 result.error 的字符串（与历史行为对齐），
   * 让 app.js 里 `error.code === 'EXTERNAL_CHANGE_DETECTED'` 这种判断保持可读。
   */
  _buildSaveErrorPayload(result) {
    if (!result) return { code: 'UNKNOWN', message: '未知错误' };
    return {
      code: result.error || 'UNKNOWN',
      message: result.error || '未知错误',
      diskContent: typeof result.diskContent === 'string' ? result.diskContent : null,
    };
  }

  /**
   * 确保「全部任务」容器存在，且名字为规范名
   *
   * 把 v2 重命名链「其他任务」→「待办任务」→「全部任务」收敛到当前规范名。
   * 单独的辅助方法被 _ensureBaseStructure 复用，避免主流程被命名归一的细节撑大。
   */
  _ensureOtherTasksContainer() {
    const existing = this._findByKind(CategoryKind.OTHER_TASKS);
    if (!existing) {
      const o = this._createCategory(OTHER_TASKS_NAME, CategoryKind.OTHER_TASKS);
      this.categories.unshift(o);
      return;
    }
    // 容器名归一：「其他任务」/「待办任务」/「全部任务」 → 「全部任务」
    if (existing.name !== OTHER_TASKS_NAME) {
      existing.name = OTHER_TASKS_NAME;
    }
  }

  /**
   * 确保至少有 1 个子分类（默认「未分类」）
   *
   * 是 _migrateTodayCategory 的前置条件：没有目标子分类就无法迁移旧 TODAY 章节的任务。
   * 单独抽出避免主流程被条件分支撑大。
   */
  _ensureUncategorizedSub() {
    if (this.categories.some(c => c.parentOtherTasks)) return;
    const sub = this._createCategory(UNCATEGORIZED_NAME, CategoryKind.NORMAL);
    sub.parentOtherTasks = true;
    const oIdx = this.categories.findIndex(c => c.kind === CategoryKind.OTHER_TASKS);
    if (oIdx >= 0) {
      this.categories.splice(oIdx + 1, 0, sub);
    } else {
      this.categories.push(sub);
    }
  }

  /**
   * 把内存状态标为「有未保存改动」并触发自动保存。
   *
   * 可选参数让调用方告诉 store「这次改动影响了哪些对象」—— 给双向同步
   * 冲突对话框列举「用户在内存里改了哪些任务 / 哪些分类」用：
   *   - tasks: 字符串或字符串数组,加入 _dirtyTaskIds
   *   - categories: 字符串或字符串数组,加入 _dirtyCategoryNames
   *
   * 不传 = 旧行为（结构改动但忘了标 id,这时 dirty=true 但两个 Set 都空,
   * UI 显示「1 项未保存」但无法列出具体内容 —— 这是兜底）。
   *
   * 批量操作（importTasksToCategory / clearCompleted / batchDelete 等）应在末尾
   * 一次性把所有 id 传进来,避免「对话期间只看到最后一条 id」的视觉错位。
   *
   * @param {{tasks?: string|string[], categories?: string|string[]}} [details]
   */
  _markDirty(details) {
    if (this._suppressDirty) return;
    const wasDirty = this.dirty;
    this.dirty = true;
    this._dirtyVersion++;
    if (details) {
      if (details.tasks) {
        const arr = Array.isArray(details.tasks) ? details.tasks : [details.tasks];
        for (const id of arr) {
          if (id) this._dirtyTaskIds.add(id);
        }
      }
      if (details.categories) {
        const arr = Array.isArray(details.categories) ? details.categories : [details.categories];
        for (const name of arr) {
          if (name) this._dirtyCategoryNames.add(name);
        }
      }
      if (!details.tasks && !details.categories) {
        // 调用方显式传了 details 但里面没东西 —— 视为「只有结构性改动」
        this._dirtyStructuralOnly = true;
      }
    } else {
      // 没传 details —— 同上,只能认定是结构性改动（旧代码 fallback 路径）
      this._dirtyStructuralOnly = true;
    }
    this._autoSave();
    // 仅在 false → true 转移时 emit。重复 markDirty 常见于批量操作（一次交互里
    // 多条任务标记完成会触发 N 次本方法），不停刷状态栏/工具栏文件信息是浪费
    // —— dirty 状态本身没变。
    // 必须**始终**递增 _dirtyVersion：saveNow 用它判断「序列化后到 await writeFile
    // 返回之间是否有过新编辑」，版本号必须能区分每次编辑才能正确清 dirty。
    if (!wasDirty) {
      this.emit('dirty', true);
    }
  }

  /**
   * 清空 dirty 追踪（saveNow / _doAutoSave 写盘成功后调用）。
   * 不传参 = 清全部；传 taskIds / categoryNames = 只清指定项。
   *
   * 注意：dirty=false 的 emit 在 saveNow / _doAutoSave 那里已发,这里只负责
   * 同步追踪集合。调用方负责统一协调。
   *
   * @param {{tasks?: string[], categories?: string[]}} [only]
   */
  _clearDirtyTracking(only) {
    if (!only) {
      this._dirtyTaskIds.clear();
      this._dirtyCategoryNames.clear();
      this._dirtyStructuralOnly = false;
      return;
    }
    if (only.tasks) {
      for (const id of only.tasks) this._dirtyTaskIds.delete(id);
    }
    if (only.categories) {
      for (const name of only.categories) this._dirtyCategoryNames.delete(name);
    }
    // v3.7+ 修复 M-D8：部分清后若两个 Set 都已空，重置 _dirtyStructuralOnly。
    // 旧行为是「dirty=true + 两个 Set 空 + structuralOnly=true」会让
    // getDirtySnapshot 返回 changeCount: 1 但列举不到任何 task/cat —— UI 显示「1 项未保存」
    // 但 conflict dialog 列不出项。reorderSubCategory 这类只标 categories 的路径
    // 保存后 categories Set 被清空但 structuralOnly 残留，导致 UI 永远显示未保存。
    // 修复：部分清后若两个 Set 都已空，structuralOnly 没有保留意义（兜底语义是
    // 「dirty=true + Set 空时仍能记录」，而 partial clear 后 dirty 由调用方维护），
    // 一并清掉。
    if (this._dirtyTaskIds.size === 0 && this._dirtyCategoryNames.size === 0) {
      this._dirtyStructuralOnly = false;
    }
  }

  // ============================================
  //  双向同步 / 冲突解决 公共 API
  // ============================================

  /**
   * 列出「本次会话内存里改过 / 新增 / 移除过的 task id」。
   * UI / 冲突解决对话框用它列举「本地独有的任务」与「需要快照保护的本地任务」。
   *
   * 注意 task id 是运行时句柄,跨 reload 重新分配 —— 这个 API 仅在当前会话内稳定。
   *
   * @returns {{
   *   taskIds: Set<string>,
   *   categoryNames: Set<string>,
   *   changeCount: number,
   *   structuralOnly: boolean
   * }}
   */
  getDirtySnapshot() {
    // changeCount = 任务数 + 分类数 + 结构标记 —— UI 用来显示「N 项未保存」
    // 当 structuralOnly=true 且两个 Set 都空时,返回 1（兜底）
    let count = this._dirtyTaskIds.size + this._dirtyCategoryNames.size;
    if (count === 0 && this._dirtyStructuralOnly && this.dirty) count = 1;
    return {
      taskIds: new Set(this._dirtyTaskIds),
      categoryNames: new Set(this._dirtyCategoryNames),
      changeCount: count,
      // structuralOnly = 「只是结构性兜底改动、没有真实任务/分类脏」。原写法
      // `count <= sum(setSizes)` 是反向逻辑：两 Set 空时 count=1、sum=0、1<=0=false
      // 返回 false；两 Set 有真实 id 时 count=X、sum=X、X<=X=true 返回 true —— 完全反掉。
      // 正确语义：仅当两 Set 都为空、且确实有结构标记时才算「纯结构性」。
      structuralOnly:
        this._dirtyStructuralOnly &&
        this._dirtyTaskIds.size === 0 &&
        this._dirtyCategoryNames.size === 0,
    };
  }

  /**
   * 缓存「最近一次外部修改后的磁盘内容」。
   * resolveExternalChangeConflict 第一次拿到 diskContent 时调用,
   * dialog 关闭时调 clearDiskSnapshot() 释放。
   *
   * @param {{filePath: string, content: string, parsedCategories: Array, fetchedAt: number}} snap
   */
  setDiskSnapshot(snap) {
    this.diskSnapshot = snap;
  }

  clearDiskSnapshot() {
    this.diskSnapshot = null;
  }

  /**
   * 同步磁盘 categories 与内存 categories,计算 diff。
   *
   * @param {Array} diskCategories - 磁盘文件解析出的 categories
   * @returns {{
   *   onlyInDisk: Array,
   *   onlyInMemory: Array,
   *   modified: Array,
   *   unchanged: Array,
   *   summary: { total: number, addedByFile: number, addedByMine: number, conflicting: number }
   * }}
   */
  diffWithDisk(diskCategories) {
    const diff = diffCategoriesUtil(diskCategories, this.categories);
    return {
      onlyInDisk: diff.onlyInA,
      onlyInMemory: diff.onlyInB,
      modified: diff.modified,
      unchanged: diff.unchanged,
      summary: summarizeDiffUtil(diff),
    };
  }

  /**
   * 根据用户在冲突对话框里的选择,把磁盘版本「合并」进内存。
   *
   * 与 loadFromContent 的区别：
   *   - loadFromContent 是「磁盘内容直接覆盖」,用户当前的选择 / 滚动位置可能跳走
   *   - mergeFromDisk 是「用户态（选中分类 / 搜索词等）保留 + categories 数组替换」,
   *     因为合并结果是用户主动选出来的,不是被动接受的
   *
   * @param {Array} diskCategories - 磁盘版本
   * @param {object} resolutions - {taskKey: 'a'|'b'|'both'|'skip'}
   * @returns {object} 合并后的 categories 数组（已 _normalizeOrder）
   */
  mergeFromDisk(diskCategories, resolutions) {
    // 与 loadFromContent 同理：合并前必须废掉 in-flight 自动保存，避免 _doAutoSave
    // 醒来时把刚合并进来的 categories 又覆盖回磁盘、或者发「saved」假象。
    this.cancelPendingSave();
    this._suppressDirty = true;
    try {
      const diff = diffCategoriesUtil(diskCategories, this.categories);
      const merged = applyResolutionsUtil(diskCategories, diff, resolutions || {});
      // 顺序归位（含「未分类」拉回末尾 —— 合并可能让兜底位置漂移）
      this.categories = this._normalizeOrder(merged);
      // 重新分配 id（合并进来的磁盘任务没有运行时 id）
      this._assignTaskIds();
      // 关键：diskCategories 来自 parseMarkdown —— parser 只按名字标 kind，
      // **不**跑迁移逻辑（旧文件里散落的 [✓] 任务、重复「未分类」、缺失的
      // 「已完成任务」分类都不会被自动收敛）。loadFromContent 走完之后
      // _ensureBaseStructure 会兜底；mergeFromDisk 以前漏了这一步，
      // 导致合并结果可能违反 v3.4 数据归属不变量：
      //   - completed=true 任务留在 NORMAL 子分类
      //   - 没有「已完成任务」分类 → 已完成任务对 UI 不可见
      //   - 重复的「未分类」让 _resolveRestoreTarget 拿到第一个就返回
      // 这里统一过一遍 _ensureBaseStructure 把这些边界情况压平：
      //   - _migrateCompletedTasksToCategory 把散落 [✓] 搬到「已完成任务」
      //   - _consolidateUncategorized / _consolidateTrash / _consolidateCompleted
      //     合并重名分类
      //   - _ensureOtherTasksContainer / _ensureUncategorizedSub / _getOrCreateCompletedCategory
      //     把缺失的容器/兜底分类补齐
      // _ensureBaseStructure 内部已经做 _normalizeOrder（幂等）+ NORMAL→parentOtherTasks
      // 矫正，所以前面那次 _normalizeOrder 可以保留也可省 —— 留着不亏，便于排查。
      this._ensureBaseStructure();
      // 合并是用户的「主动决策」,不需要立刻标 dirty —— 调用方接下来会 saveNow()
    } finally {
      this._suppressDirty = false;
    }
    // 触发 UI 重渲染
    this.dirty = false;
    this._dirtyTaskIds.clear();
    this._dirtyCategoryNames.clear();
    this._dirtyStructuralOnly = false;
    this.emit('load', { categories: this.categories, merged: true });
    this.emit('change');
    this.emit('dirty', false);
  }

  /**
   * 给冲突对话框的「默认选择」生成 helper。
   * 复用 markdown-diff.js 的逻辑。
   *
   * @param {object} diff - diffWithDisk() 返回值
   * @returns {object} resolutions
   */
  defaultMergeResolutions(diff) {
    return defaultResolutionsUtil({
      onlyInA: diff.onlyInDisk,
      onlyInB: diff.onlyInMemory,
      modified: diff.modified,
    });
  }

  /**
   * 调度一次自动保存。无 debounce，直接走 _doAutoSave —— 但如果有 in-flight 写正在进行
   * 则只标记 _needsResave，让 finally 里的补写路径兜底。
   *
   * v4 全实时同步的核心入口：
   *   - 单次编辑 → 直接启动 _doAutoSave，await 写完即关
   *   - await 期间再次编辑 → 仅置 _needsResave=true，避免并发写
   *   - finally → 检查 _needsResave && dirty，自动再启动一次 _doAutoSave
   *
   * 语义上等价于「writeFile 永远尽快写，没有等待窗口，但同一时刻只有一个写 in-flight」：
   *   - 用户每次勾选/编辑 → 立刻触发写
   *   - 快速连击 → 第一个写 in-flight，后续合并为一次尾随写
   *   - 写失败 → 保留 dirty，下一次 _markDirty 会重试
   */
  _scheduleAutoSave() {
    if (!this.dirty || !this.filePath) return;
    if (this._inFlightGeneration > 0) {
      // 已有写正在进行中 —— 标记等待中写完后再补一次保存，避免并发写竞争
      // （不同代次的 writeFile 同时落地 → 谁后写谁覆盖前者，可能反向覆盖最新状态）
      this._needsResave = true;
      return;
    }
    this._doAutoSave();
  }

  // ========================================================================
  // ⚠️ 与 saveNow() 共享「代次 + 脏版本双检查」骨架 —— 两份实现必须保持同步。
  // ----------------------------------------------------------------------
  // 故意保留重复，不抽 helper：autoSave（用户隐式触发）与 saveNow（用户显式
  // force 写）是语义独立的两条防线，force 路径若坏掉不应影响自动保存，反之亦然。
  //
  // 共享骨架（两处都要更新）：
  //   1) ++this._writeGeneration 抓代次 → 在 await 期间用户又改 → await 回来
  //      时若 generation 不匹配则视为过期，不清 dirty / 不发 saved
  //   2) 序列化前抓 _dirtyVersion → await 回来时若版本变大（说明快照不含最新
  //      改动）也保留 dirty，避免「磁盘没新东西但 UI 显示已同步」
  //   3) 走 window.api.writeFile（不带 force 走自动保存 / 带 force 走用户显式）
  //   4) finally 检测 _needsResave → 立即再补一次自动保存
  //
  // 改前先看 saveNow()，把同一组语义变化在那边也同步上。
  // ========================================================================
  async _doAutoSave() {
    if (!this.dirty || !this.filePath) return;
    // 二道防线：理论上 _scheduleAutoSave 已把 in-flight 拦在外面，但外部可能直接调进来
    // （比如旧测试或调试场景）—— 守住避免并发。
    if (this._inFlightGeneration > 0) {
      this._needsResave = true;
      return;
    }
    const generation = ++this._writeGeneration;
    this._inFlightGeneration = generation;
    this._needsResave = false;
    try {
      const content = this.serialize();
      // 在序列化之后捕获脏版本 —— 序列化本身不会脏，所以这个值就是「这次写入涵盖到的最后修改」。
      // await 回来时若版本变大，说明快照里没有那次新修改，必须保留 dirty 让后续自动保存兜底。
      const versionAtSerialize = this._dirtyVersion;
      // 自动保存：不带 force 选项，由主进程 mtime 检查保护外部编辑不被覆盖。
      // 若检测到冲突，result.error === 'EXTERNAL_CHANGE_DETECTED'，save-error 事件
      // 由渲染端处理并触发外部修改冲突解决流程。
      const result = await window.api.writeFile(this.filePath, content);
      // 代次过期：写完之后用户又改过东西、已经触发了更新的自动保存，
      // 这次 await 拿到的就是「写出去的旧快照」，不能清 dirty / 发 saved 假象。
      if (this._writeGeneration !== generation) return;
      if (this._dirtyVersion !== versionAtSerialize) {
        // 快照没包含最新的修改 —— 不能清 dirty，发个「saved」也会让 UI 显示已同步，
        // 但磁盘里其实没有那些新东西。_needsResave 已被 _scheduleAutoSave 在用户改时
        // 置上，finally 里会再补一次 _doAutoSave 把它们写出去。
        return;
      }
      if (result.ok) {
        this.dirty = false;
        this._clearDirtyTracking();
        // auto=true：通知 UI 更新状态栏，但不弹 toast（避免频繁打扰用户）
        this.emit('saved', { filePath: this.filePath, auto: true });
        this.emit('dirty', false);
      } else {
        // v3.4+: 载荷统一为 {code, message, diskContent?} 对象，让外部修改冲突流程
        // 不需要再发一次 file:read 就能拿到磁盘当前内容（见 main.js EXTERNAL_CHANGE_DETECTED 增强）。
        this.emit('save-error', this._buildSaveErrorPayload(result));
        // v3.7+ 修复 M-D10：保存失败后必须显式保留 dirty 状态。
        // 旧行为是只在 result.ok 分支 emit('dirty', false)，失败路径不补 dirty=true，
        // UI 在 save-error 处理完后回到脏态依赖监听者猜测（不同 UI 模块行为不一致，
        // 状态栏可能不显示「未保存」，用户不知道改动还没落盘）。
        // 修复：在失败路径 emit('dirty', true)，但仅当当前代次仍是自己（避免覆盖更新代的 dirty 事件）。
        if (this._writeGeneration === generation) {
          this.dirty = true;
          this.emit('dirty', true);
        }
      }
    } catch (e) {
      if (this._writeGeneration === generation) {
        this.emit('save-error', { code: 'EXCEPTION', message: e.message });
        // 同上：异常路径也补一次 dirty=true，保持 UI 状态栏显示「未保存」。
        this.dirty = true;
        this.emit('dirty', true);
      }
    } finally {
      if (this._inFlightGeneration === generation) {
        this._inFlightGeneration = 0;
      }
      // in-flight 写期间累积了新改动 → 立即再启动一次保存（补写尾随）。
      // 这是替代原 800ms debounce 的「合并」机制：没有等待窗口，但保证不丢改动。
      // 典型场景：用户在 writeFile await 期间连续勾选多条任务 → 这里一次性把
      // 最新状态写出去，避免「前一条写完但 dirty=true 又卡 800ms」的拖沓感。
      if (this._needsResave && this.dirty && this.filePath) {
        this._needsResave = false;
        this._doAutoSave();
      }
    }
  }

  // 取消「已排队但还没写出去」的自动保存，保留 dirty 状态。
  //
  // 给「文件被外部改了」这条路径用：那时候必须先把 in-flight 写「作废」，
  // 再去问用户怎么办 —— 否则这条 await 回来时还会把内存内容盖回文件，
  // 用户手工删掉的行就这么被复活了。而彻底删除任务只能手工编辑文件，
  // 所以这条路径正是我们让用户走的那条。
  //
  // v4 全实时同步后这里不再有 debounce 定时器可掐，只需把当前 in-flight 代次「作废」——
  // 即便 _doAutoSave 已经 await writeFile 走了，这条 await 醒来时也会发现
  // 代次对上、不去复位 dirty / 不发「saved」假象，避免覆盖文件后还自以为干净。
  cancelPendingSave() {
    if (this._inFlightGeneration) {
      // 让 in-flight 的 await 醒来时把这次写入视作过期；
      // 它不会清 dirty，因此后续 _markDirty 已经触发的下一次自动保存照常工作。
      this._writeGeneration++;
    }
  }

  // ========================================================================
  // ⚠️ 与 _doAutoSave() 共享「代次 + 脏版本双检查」骨架 —— 两份实现必须保持同步。
  // ----------------------------------------------------------------------
  // 完整说明见 _doAutoSave() 顶部的注释块。这里只强调用户显式保存的差异点：
  //   - 不判 dirty（用户按 Ctrl+S 时即便没改也要 force 写一遍 —— 主进程的 mtime
  //     预检会判断是否有变更，没有就跳过）
  //   - writeFile 带 force: true，告诉主进程「用户主动写，不要被外部修改拦截」
  //     （mtime 冲突时主进程返回 EXTERNAL_CHANGE_DETECTED，渲染端走冲突解决弹框）
  // 共享骨架（++代次、抓 _dirtyVersion、finally 检测 _needsResave）必须与
  // _doAutoSave() 同步演进。
  // ========================================================================
  async saveNow() {
    if (!this.filePath) {
      this.emit('save-error', { code: 'NO_FILE_PATH', message: '尚未设置文件路径' });
      return false;
    }
    // v4+ 修复：与 _doAutoSave 共享 in-flight 守卫。
    // 旧实现直接 ++_writeGeneration 后覆盖 _inFlightGeneration —— 在主进程层
    // 形成两条并发 writeFile IPC（同文件）：
    //   1) _doAutoSave 写入 contentA（带 preStat/confirm-stat 双重检查）
    //   2) saveNow 写入 contentB（force=true，跳过 preStat 的 lastSeen 比对）
    // 第二条的 confirm-stat 检测到第一条 rename 后的 mtime 变化 → 返回
    // EXTERNAL_CHANGE_DETECTED → 渲染端误以为是外部编辑触发的、弹出「文件与本地
    // 不一致」冲突对话框 —— 用户其实没动过外部编辑器。这是真正的 phantom 冲突。
    //
    // 修复：与 _doAutoSave 同样的「if (inFlight) { set _needsResave; return false; }」
    // 守卫。_doAutoSave 的 finally 块会检测 _needsResave 并补一次自动保存 —— 用户的
    // 「force save」意图被降级为「等当前 in-flight 结束后再 auto-save」，但因为这条
    // 场景下没有真正的外部编辑，auto-save 会成功落盘，最终结果一致。
    // force=true 的语义被降级为「不绕过 lastSeen 比对」，但 in-flight 是我们自己写入的、
    // lastSeen 已经被前一条 writeFile 更新过，不会误判 EXTERNAL_CHANGE_DETECTED。
    if (this._inFlightGeneration > 0) {
      this._needsResave = true;
      return false;
    }
    const generation = ++this._writeGeneration;
    this._inFlightGeneration = generation;
    this._needsResave = false;
    try {
      const content = this.serialize();
      // 同 _doAutoSave：在序列化后捕获脏版本，await 期间有新改动时不清 dirty。
      // saveNow 路径上「用户在写出过程中改东西」通常意味着丢盘更快（用户在另存为），
      // 但同样要守 —— 否则 dirty 被误清、状态栏显示已保存，下次启动就丢了。
      const versionAtSerialize = this._dirtyVersion;
      // saveNow 始终 force=true：调用方都是用户显式意图（Ctrl+S、"保留本地" 按钮、
      // 退出前刷写等），主进程 mtime 检查不会拦截，确保用户意图被尊重。
      const result = await window.api.writeFile(this.filePath, content, { force: true });
      if (this._writeGeneration !== generation) {
        // 期间已经被 cancelPendingSave 或另一次 saveNow 顶掉：把是否成功的决定权交给最新一次
        return false;
      }
      if (this._dirtyVersion !== versionAtSerialize) {
        // 快照不含最新修改 —— 不清 dirty、不发 saved / dirty(false)，留给后续自动保存兜底
        return false;
      }
      if (result.ok) {
        this.dirty = false;
        this._clearDirtyTracking();
        this.emit('saved', { filePath: this.filePath });
        this.emit('dirty', false);
        return true;
      } else {
        this.emit('save-error', this._buildSaveErrorPayload(result));
        return false;
      }
    } catch (e) {
      if (this._writeGeneration === generation) {
        this.emit('save-error', { code: 'EXCEPTION', message: e.message });
      }
      return false;
    } finally {
      if (this._inFlightGeneration === generation) {
        this._inFlightGeneration = 0;
      }
      // v4+ 修复：与 _doAutoSave 对称 —— saveNow 完成后若 _needsResave 仍为真，
      // 立即补一次自动保存。否则用户在 saveNow 的 await 期间改了东西、saveNow 写完后
      // 这些改动会卡在内存里等下一次 _markDirty（用户停下操作就丢盘）。
      // 用 _doAutoSave 而非 saveNow 自身：避免再次触发 force=true 的 mtime 跳过，
      // 同时复用 _doAutoSave 已有的「代次 + 脏版本双检查」骨架。
      if (this._needsResave && this.dirty && this.filePath && this._inFlightGeneration === 0) {
        this._needsResave = false;
        this._doAutoSave();
      }
    }
  }

  _createCategory(name, kind = CategoryKind.NORMAL) {
    return {
      name,
      kind,
      isSpecial: kind === CategoryKind.TODAY ||
                 kind === CategoryKind.OTHER_TASKS ||
                 kind === CategoryKind.TRASH ||
                 kind === CategoryKind.COMPLETED,
      meta: null,
      parentOtherTasks: false,
      tasks: []
    };
  }

  /**
   * 为内存中的任务分配稳定的 id（仅 loadDefault 需要；
   * loadFromContent 已在 parser 中赋值；addTask 自己生成）
   *
   * v4+ 修复：counter 从「已存在 id 的最大数字 + 1」起步，避免混入
   * 已有 id 的 categories 时重新生成的 id 与旧 id 撞号。
   * 旧实现一律从 0 开始，理论上 parser 给的 id 是 t1/t2/... 连续，
   * 但 `t` 之外的旧 id 格式（老版本写出的、自定义 parser 兼容路径、
   * 合并进来的部分 categories）可能出现 id 间隔，重新从 0 起就会
   * 与未触达的那些空位撞上 —— 即便数字不撞，序列化稳定性也会被打破。
   */
  _assignTaskIds() {
    // 1) 先扫一遍已有 id，挑出最大数字后缀；用正则兼容 't12' / 'task_12' 等历史格式
    let max = 0;
    const numRe = /(\d+)\s*$/;
    for (const cat of this.categories) {
      if (cat.kind === CategoryKind.OTHER_TASKS) continue;
      for (const task of cat.tasks) {
        if (typeof task.id !== 'string') continue;
        const m = numRe.exec(task.id);
        if (m) {
          const n = parseInt(m[1], 10);
          if (Number.isFinite(n) && n > max) max = n;
        }
      }
    }
    let counter = max;
    for (const cat of this.categories) {
      if (cat.kind === CategoryKind.OTHER_TASKS) continue;
      for (const task of cat.tasks) {
        if (!task.id) task.id = 't' + (++counter);
      }
    }
  }
}
