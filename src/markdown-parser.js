// Markdown 解析器
// 将 Markdown 文本解析为分类与任务树
//
// 结构（v3 统一为标识驱动，v3.6 起移除顶部镜像段）：
//   - 全部任务（kind=OTHER_TASKS，容器；兼容旧名「其他任务」/「待办任务」/「全部任务」）
//     ## 工作 / ## 学习 / ## 生活 / ## 未分类（kind=NORMAL, parentOtherTasks=true）
//   - 回收站（kind=TRASH，特殊；删除的任务落点，软件不提供清空入口）
//   - 已完成任务（kind=COMPLETED，v3.4 起升级为真实分类，[✓] 打勾后任务自动搬到这里）
//
// 任务用 inline 标识表达状态（与 Markdown 风格天然贴合）：
//   - [✓]  已完成（checkbox 标记）
//   - ⭐    重要（U+2B50 白色中等星形）
//   - ▶     当前焦点（U+25B6 黑色右指三角；与 ⭐ 视觉权重对等）
//
// 智能视图（侧边栏的「当前任务」「重要任务」「已完成任务」）由 task-store
// 在内存中按任务标识（important / current / completed）实时聚合：
//   - 「当前任务」：task.current=true（行末 [▶] 标记）的任务
//   - 「重要任务」：task.important=true（行末 [⭐] 标记）的任务
//   - 「已完成任务」：直接读 kind=COMPLETED 分类
// 文件里**不再**为这些视图单独写一段 —— 同一条任务在文件里只活一次。
//
// 不再支持：Archive / Completed / Planned / 优先级 / 标签 / 备注 / 子步骤。
// 任务字段：text / completed / important / current。
// 旧文件中残留的元数据标记（[!high] / #tag / 缩进子步骤 / >备注）会被当作普通文本保留。
//
// 兼容旧文件：
//   - `# 当前任务` / `# 我的一天` 等旧章节在解析时仍被识别为 TODAY，
//     任务进入一个临时分类；store 的迁移逻辑会把这些任务搬到首个子分类
//     并打上 ▶ 标记，然后删掉临时分类。下一次保存就只剩「全部任务」
//     下的扁平结构。
//   - v3.x 顶部摘要 `# 当前任务` / `# 重要任务` 旧镜像段也走同样的迁移路径：
//     前者按 TODAY 迁移；后者作为 SMART_LIST_KEYS 命中被解析器整体跳过，
//     段下任务行归入「未分类」子分类（保守策略）。
//   - 行尾 `<!-- id:xxx -->` 注释（旧版写入器自动追加）会被剥掉以避免
//     污染 UI 文本，但不从中提取 id —— 任务身份由解析器末尾的统一计数器
//     分配（t1, t2, ...），跨重载重新生成。

// 特殊分类识别（不区分大小写、忽略空格）。
// 「当前任务」/「重要任务」仅在旧文件兼容时识别 —— 写入器已经不再写这些章节，
// store 迁移后即消失；新文件里读到这两个名字时按下方 SMART_LIST_KEYS / TODAY_KEYS
// 分流（前者在 __skip__ 路径下整段跳过、任务归「未分类」；后者走 TODAY 迁移）。
export const TODAY_KEYS = ['today', '今日', '今天', '当日', '今', '我的一天', '当前任务', 'myday', 'my day'];
// 「其他」单独作为子分类名是允许的（与「未分类」兜底不同语义）——
// 因此 OTHER_TASKS_KEYS 只放**容器** h1 的别名（包括化合物「其他任务」/「待办任务」/「全部任务」
// 和英文 todo 变体），不放孤立的「其他」。addSubCategory / renameCategory / UI 校验都按
// 这个数组作黑名单，把「其他」混进去会误封普通子分类的创建/重命名路径。
export const OTHER_TASKS_KEYS = ['其他任务', '全部任务', '待办任务', 'todo', 'todos', 'to-do', 'to do', 'other tasks', 'othertasks', 'others'];
export const TRASH_KEYS = ['回收站', '垃圾桶', '废纸篓', 'trash', 'trashcan', 'recycle bin', 'recyclebin', 'bin'];

// 智能列表段落名（仅用于旧文件兼容：读取时跳过，**不再写**）。
//
// 文件 v3 起彻底不再生成这些段落。智能列表视图全部由 task-store 在内存中
// 按任务标识（important / current）实时聚合，无需文件镜像。
// 保留这套 key 只是为了让解析器在读到旧版文件时不至于把里面的任务行
// 误收进真实分类 —— 与「全部任务」容器本身已含所有任务的理念一致。
//
// 「已完成任务」v3.4 起不再是镜像段：它被提升为真实分类（kind=COMPLETED），
// `[✓]` 打勾的任务会**自动移动**到这里 —— 见 COMPLETED_KEYS 与 CategoryKind.COMPLETED。
// 这里不再保留它的别名，避免被识别成「跳过」分类。
export const SMART_LIST_KEYS = [
  '重要任务', 'important tasks', 'important',
  '全部任务列表', 'all tasks', 'alltasks'
];

// 「当前」标识：与 ⭐ 一样靠末尾 inline 标记。
// 用 ▶（U+25B6 BLACK RIGHT-POINTING TRIANGLE）作为当前标记：
//   - 单字符 unicode，视觉权重和 ⭐ 对等，文件里一眼能扫到
//   - 「播放 / 进行中」语义贴切「当前正在做的事」
//   - BMP 字符，所有主流字体必支持
//
// 向后兼容 —— 解析器同时认 @当前（旧版本的文本标记）：
//   - 用户可能升级前手敲过 @当前 来标记当前任务
//   - 文件升级前可能存在遗留 @当前 行
//   - 写入器只输出新标记 ▶，旧标记在加载时仍然被识别
export const CURRENT_MARKER = '▶';
// 旧版标记：解析时仍识别（向后兼容），写入时不再使用
const LEGACY_CURRENT_MARKER = '@当前';

// 反向转义 helper —— writer 把原分类里的 `]` / `\` 转义成 `\]` / `\\` 以便
// `[原分类：xxx]` 标记能在包含 `]` 的分类名下闭合（C1 修复）。
// 这里把 `\\X` 反向成单字符：支持 `]` 与 `\` 两种（未来要支持更多也只需扩展 here）。
function unescapeOriginalCategory(s) {
  return String(s || '').replace(/\\(.)/g, '$1');
}

// 重要任务 inline 标记 —— 与 CURRENT_MARKER 对称。writer 拼 [⭐] 时必须复用此常量，
// 而不是字面量：否则哪天产品决定把 ⭐ 换成 🔥，必须 parser + writer 两处同时改，
// 容易漂移。
export const IMPORTANT_MARKER = '⭐';

// 行首 / 行尾的 inline 标记正则（用 IMPORTANT_MARKER / CURRENT_MARKER 拼出），
// 给 extractInlineMarkers 复用 —— 不能再字面量写 ⭐ / ▶：
//   - 与上面的 IMPORTANT_MARKER 注释同款问题：常量是 single source of truth，
//     regex 字面量是另一份 source
//   - writer 已经用 `[${CURRENT_MARKER}]` / `[${IMPORTANT_MARKER}]` 拼输出，
//     parser 也必须对称地复用常量，否则哪天改标记两边就会漂移
// 用 new RegExp(...) 在模块加载时构造一次，运行期零成本 —— 模块顶层只算一次。
//
// ⚠️ 前提：IMPORTANT_MARKER / CURRENT_MARKER 必须是纯字符（不能含正则元字符）。
// 历史上两个常量都是单个 Unicode 码点（⭐ / ▶），满足前提；若以后改成
// 多字符或带元字符的字符串，要么转义，要么回退到字面量 regex。
const MARKER_HEAD_RE = new RegExp(`^\\[(${IMPORTANT_MARKER}|${CURRENT_MARKER})\\]`);
// 行尾的 [⭐]/[▶]：v3.7+ 去掉前导 `\s`（修复 H5）。
// 旧版强制空白前缀，导致 `任务标题[⭐]foo` / `unimportant[⭐]`（用户文本里紧贴
// 其它字符）识别不到，important 永远 false，下一次保存原样写回 —— 数据丢失。
// 现在任意位置的尾标记都识别（行尾锚定保证不会吃行内"对比 [⭐] 用法"这种纯说明文本）。
// `任务标题[⭐]` → important=true，剥后 text='任务标题'。
const MARKER_TAIL_RE = new RegExp(`\\[(${IMPORTANT_MARKER}|${CURRENT_MARKER})\\]$`);

/**
 * 任务行正则：`- [x] 文本` / `* [✓] 文本` / `+ [ ] 文本` 都算合法任务。
 *
 * 共享原因：parseMarkdown（主路径）和 parseImportLine（导入路径）历史上字面
 * 复制同一正则，外加 task-store.js 的 parseImportLine 也再写一份。任何一处改了
 * 「`+ ` 也算任务」之类的规则，三处都会漂移。集中到此常量 + 让 task-store 复用，
 * 是 v3+ 防漂移的最低成本防线。
 *
 * ⚠️ 字符类必须是 `[ ✓xX]`（仅 4 种合法 checkbox 字符），不能用 `[^\]]+`：
 * 旧版用 `[^\]]+` 让 `⭐` / `▶` 也能匹配第一组 —— 这导致 `- [⭐] foo` 被解析为
 *   marker='⭐'（被当作 checkbox）, text='foo', completed=false
 * 即 `[⭐]` 这层 inline 标记被 TASK_LINE_RE **吃掉**，extractInlineMarkers 拿到的
 * 是裸 'foo'，永远 important=false —— 用户在 UI 上勾了「重要」保存后，再次加载
 * 重要标记就消失了（**静默数据丢失**）。同理 `- [▶] foo` 会丢 current。
 * 字符类只允许 ` ✓xX` 后，inline 标记 `⭐` / `▶` 必须落到第二组（text），由
 * extractInlineMarkers 正确剥出并翻译成 important / current。
 *
 * 兼容性：旧文件里如果出现 `- [!high] foo` 之类的"非标准 checkbox"（marker='!high'），
 * 也会**被新规则跳过**（第一组字符不再贪婪）。这种行会被下方 fallback 接管：
 * 去掉前导 `- ` 当作列表项文本送进 extractInlineMarkers —— 不会丢数据，
 * 但也不会被识别为任务（用户用 !high 等非标准标记不是合法任务）。
 */
export const TASK_LINE_RE = /^[-*+]\s+\[([ ✓xX])\](?:\s+(.*))?$/;

/**
 * 任务勾选标记的「完成态」判定。
 *
 * 三种合法标记：[✓]（首选）/ [x] / [X]（旧文件兼容）。
 * 与 parseMarkdown / parseImportLine / writer 的写入约定严格对齐 —— 任一处
 * 改了会立刻被这层规则拉齐。
 *
 * @param {string} ch - 单个字符（如从 `taskMatch[1]` 取出的方括号内字符）
 * @returns {boolean}
 */
export function isCompletedMarker(ch) {
  return ch === '✓' || ch === 'x' || ch === 'X';
}

/**
 * 给 categories 里的任务统一分配运行时 id（`t1`、`t2` ...）。
 *
 * 设计决策：任务 id 是运行时句柄，不是文件身份。
 *   - 写入器 v3+ 不再写出 `<!-- id:xxx -->` 注释
 *   - 解析器也不再从文本里还原 id
 *   - 每次加载（parseMarkdown 末尾 / mergeFromDisk / loadDefault）统一从 t1
 *     开始分配，跨重载重新生成
 *
 * 设计细节：parser 这版是「全量重置」式 —— 从 t1 开始无条件覆盖所有 task.id，
 * 用于 parseMarkdown() 末尾的初次分配。task-store.js 自己另有 _assignTaskIds 实例
 * 方法，是「保留已有」式（只在 !task.id 时补值），用于增量场景（merge / loadDefault
 * 时已经带 id 的任务不重置）。两处公式虽相似但语义不同，不能直接复用 —— 因此
 * 这版保持模块内部 helper，不对外 export，避免「看起来可复用、实际语义错」的误用。
 *
 * @param {Array} categories
 */
function assignTaskIds(categories) {
  let counter = 0;
  for (const cat of categories) {
    if (cat.kind === CategoryKind.OTHER_TASKS) continue; // 容器本身无任务
    for (const task of cat.tasks) {
      task.id = 't' + (++counter);
    }
  }
}

// 规范名常量
//
// 为什么定义在这里（而不是 task-store.js）：markdown-parser 是依赖树的叶子，
// 谁都可以安全 import。之前 markdown-writer 从 task-store 取 OTHER_TASKS_NAME，
// 而 task-store 又 import markdown-writer —— 形成循环依赖，ESM 下
// 会让先被求值的那一方拿到 undefined（取决于入口顺序），非常脆弱。
// 现在两者都从这里取，环被打断。

// 「全部任务」容器的固定名称（v2 改名链：其他任务 → 待办任务 → 全部任务，含当前任务）
export const OTHER_TASKS_NAME = '全部任务';

// 「当前任务」分类的规范名（迁移与默认创建都收敛到此名）
export const TODAY_CANONICAL_NAME = '当前任务';

// 「未分类」子分类的规范名 —— 删除任何子分类时，其任务都迁移到此分类下，
// 该分类本身不可删除（兜底必然存在，否则没有地方承接被释放的任务）
export const UNCATEGORIZED_NAME = '未分类';

// 「回收站」分类的规范名 —— 所有在界面上「删除」的任务都移到这里，不真正丢弃。
// 软件刻意不提供「清空回收站」入口：彻底删除必须由用户手工编辑 Markdown，
// 这样任何误删都可以从文件里找回。
export const TRASH_NAME = '回收站';

// 「已完成任务」分类的规范名 —— `[✓]` 打勾的任务会自动移到本节。
// 它是真实分类（kind=COMPLETED）而不是智能视图，原因：
//   1) 旧版「已完成任务」是 v3 起作废的镜像段；v3.4 把它升级为真实数据源，
//      任务实体只活在一个地方 —— 文件和数据模型都不再有冗余。
//   2) 与「回收站」同款处理：勾选即移动、取消勾选即回到它原来的分类
//      （v3.5+ 记在 `[原分类：xxx]` 里）。原分类丢了让 UI 弹选择器，
//      没有原分类记录才兜底到「未分类」。行为对称、数据归属明确。
//   3) UI 侧「已完成任务」智能视图直接读这个分类 —— 聚合逻辑保持简单。
export const COMPLETED_NAME = '已完成任务';

// 「已完成任务」分类的所有别名：解析时识别，writer 统一写为规范名 `已完成任务`。
// 兼容旧文件用过的英文别名，避免升级后用户的「# Completed Tasks」被误当普通分类。
export const COMPLETED_KEYS = ['已完成任务', 'completed tasks', 'completedtasks', 'completed', '完成', 'finished'];

// 分类类型枚举
export const CategoryKind = Object.freeze({
  TODAY: 'today',
  OTHER_TASKS: 'other_tasks',  // 容器：存放子分类（h2）
  NORMAL: 'normal',            // 普通分类（可作为「其他任务」的子分类）
  TRASH: 'trash',              // 回收站：删除的任务落点，排除于所有智能列表之外
  COMPLETED: 'completed'       // 已完成任务：[✓] 打勾后任务自动移动到这里，取消勾选回到原分类（[原分类：xxx]）
});

/**
 * 解析 Markdown 为任务树
 * @param {string} content
 * @returns {Array} 分类列表
 */
export function parseMarkdown(content) {
  if (!content || typeof content !== 'string') {
    return [];
  }

  // 去掉文件开头的 UTF-8 BOM（Windows 上一些编辑器会加）。
  // 不去的话 ^#\s+ 永远不匹配，整个文件被当作「无标题的纯任务清单」处理，
  // 再走一次 _ensureBaseStructure 写出新文档 —— BOM 用户每次保存都会重写文件。
  const normalized = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;

  // 检测文件是否为「新格式」：包含「全部任务」容器段（容器是 v3 唯一真实数据源）。
  //
  // v3.6 起不再有顶部 `# 当前任务` / `# 重要任务` 镜像段 —— 这些段在旧文件
  // （v3.x 之前版本写过镜像段的）里可能仍然存在，按以下路径消化：
  //   - # 当前任务 → TODAY 分类，store 的迁移逻辑搬到首个子分类并打 [▶]
  //   - # 重要任务 → __skip__，任务归入「未分类」
  // 下一次保存即扁平化为新结构。
  //
  // 注意：用 OR 形式匹配「全部任务」+ 旧名「其他任务」/「待办任务」—— 容器重命名链收敛后
  // 实际只剩「全部任务」，但旧文件可能还有旧名残留。
  //
  // 不用 `\b` 锚定：中文字符在 JavaScript regex 里不是 word char，`\b` 在「全部任务」与
  // 换行符之间不构成边界，会让整个检测静默失效 —— 中文字符段标题被误判为旧格式。
  // 改用反向断言(?=[#\s]|$) / 行尾锚定来匹配「标题后跟空白或行尾」。

  const lines = normalized.split(/\r?\n/);
  const categories = [];
  let currentCategory = null;
  let insideOtherTasks = false;
  let blockComment = false;
  // 上一个 h1 是被跳过的废弃段落（归档/已完成/…）时，其下的孤儿任务
  // 归入「未分类」而不是「当前任务」，见下方 __skip__ 分支的说明
  let orphansToUncategorized = false;
  // 上一个 h1 是「重要任务」等智能镜像段时（v3.x 旧文件残留），其下的任务即使
  // 没有 inline `[⭐]` 标记也要被打上 important=true —— 否则「# 重要任务」整段被
  // 跳过后，里面的任务会丢光重要标记，用户在「重要任务」智能视图里看不到。
  // 仅对真正代表"重要"的段生效；归档/历史等 __skip__ 段不传染。
  let inheritImportantFromHeading = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 块注释跳过 <!-- ... -->
    if (blockComment) {
      if (trimmed.includes('-->')) blockComment = false;
      continue;
    }
    if (trimmed.startsWith('<!--')) {
      // 单行 / 多行注释起始：直接跳过（HTML 注释对解析器透明）。
      if (!trimmed.includes('-->')) {
        blockComment = true;
      }
      continue;
    }

    if (!trimmed) continue;

    // 一级标题：分类开始
    const h1Match = trimmed.match(/^#\s+(.+)$/);
    if (h1Match) {
      const name = h1Match[1].trim();

      const kind = classifyByName(name);

      // 已废弃的概念（Archive / Completed / Important / 当前任务…）：不再建成分类。
      //
      // 「当前任务」v3 起彻底下沉为智能视图（@当前 标识驱动），但旧文件里仍可能
      // 存在 `# 当前任务` 章节。把它们也当作「废弃段落」处理 —— 任务落到临时
      // TODAY 分类，store 的迁移逻辑会把任务搬到首个子分类、打上 @当前 标记、
      // 然后删掉这个临时分类。第一次保存后文件结构自然扁平化。
      //
      // 「重要任务」v3.x 顶部镜像段走 __skip__ 路径：整段跳过、段下任务行归入
      // 「未分类」（保守策略，宁可多一条需要用户挪动的任务，也不要少一条）。
      //
      // 注意这里**不会丢弃**其下的任务：后面的任务行会走 `!currentCategory` 的兜底。
      // 但兜底默认是「当前任务」（kind=TODAY），意味着一个 `# 归档` 段落里几百条历史
      // 已完成项会被静默灌进用户的当前任务列表。所以这里改用「未分类」作为兜底目标 ——
      // 它本来就是孤儿任务的指定归属地，且是懒创建（该段落没任务就不会凭空出现）。
      if (kind === '__skip__') {
        currentCategory = null;
        insideOtherTasks = false;
        orphansToUncategorized = true;
        // 仅当分类名命中「重要任务」类智能镜像段时，传染 important 标记到下面的任务。
        // 其它 __skip__（归档/历史等）保持原行为，任务不再标记为重要。
        inheritImportantFromHeading = isInheritedImportantHeading(name);
        continue;
      }
      inheritImportantFromHeading = false;

      // 旧版「# 当前任务」/「# 我的一天」等章节：保留解析为 TODAY 分类的兜底能力，
      // 让旧文件迁移有路径。store 的 _migrateTodayCategory 会处理后续：
      //   1) 把任务搬到首个子分类
      //   2) 给每条任务打 current=true
      //   3) 删掉这个临时分类
      // 新文件不再生成这样的 h1 —— writeMarkdown 已移除。
      if (kind === CategoryKind.TODAY) {
        currentCategory = createCategory(name, kind);
        categories.push(currentCategory);
        insideOtherTasks = false;
        orphansToUncategorized = false;
        continue;
      }

      // 「# 回收站」「# 已完成任务」h1 出现多份时（Git 合并冲突没解干净 / 外部编辑器手敲多份）：
      // 旧行为是逐个 push 出多个 kind=TRASH / kind=COMPLETED —— 后续任务归到最后一个，
      // 中间那些的任务在 UI 上既看不见也没法恢复（getTrashCategory / getCompletedCategory
      // 只返回第一个）。store 层的 _consolidateTrash / _consolidateCompleted 兜底合并，
      // 但这里能在 parser 阶段直接复用第一份，把后续 h1 下的任务正确地追加到那个分类，
      // 避免"先 push 多份 → 再被 store 合并"产生的瞬时副作用（侧边栏可能短暂看到两份）。
      // 与下面 h2 的「## 未分类 复用第一份」同款防御。
      //
      // 「# 全部任务」容器也加同款防御（v3.7+ 修复 H1）：重复「# 全部任务」时
      // 复用第一份，否则 writer 会连续写出两份 `## 子分类`，子分类归属错乱。
      if (
        kind === CategoryKind.TRASH ||
        kind === CategoryKind.COMPLETED ||
        kind === CategoryKind.OTHER_TASKS
      ) {
        const existing = categories.find(c => c.kind === kind);
        if (existing) {
          currentCategory = existing;
          insideOtherTasks = false;
          orphansToUncategorized = false;
          continue;
        }
      }

      // 其他任务容器：作为 h1，但本身不存任务（仅作容器标识）
      currentCategory = createCategory(name, kind);
      categories.push(currentCategory);
      insideOtherTasks = (kind === CategoryKind.OTHER_TASKS);
      orphansToUncategorized = false;
      // v3.7+ 修复（H3 后置重排）：遇到 # 全部任务时，把所有出现在它之前
      // 的 parentOtherTasks=true 子分类（典型来源：被 __skip__ 段顶到文件
      // 顶部的「未分类」孤儿）移到容器之后 —— writer 依赖数组顺序把 parentOtherTasks
      // 分类写成容器下的 `##`，否则会把「## 未分类」写到 `# 全部任务` 前面、
      // 看起来像顶级分类（解析器再读又会按 orphan 路径处理，死循环脏数据）。
      if (kind === CategoryKind.OTHER_TASKS) {
        const containerIdx = categories.length - 1;  // 刚 push 进去
        const beforeContainer = categories
          .slice(0, containerIdx)
          .filter(c => c.parentOtherTasks);
        if (beforeContainer.length > 0) {
          // 从原位置删掉
          for (const c of beforeContainer) {
            const idx = categories.indexOf(c);
            if (idx >= 0) categories.splice(idx, 1);
          }
          // 紧跟容器插入（保留原相对顺序）
          categories.splice(containerIdx, 0, ...beforeContainer);
          // currentCategory 不变（仍是 # 全部任务 容器本身）
        }
      }
      continue;
    }

    // 二级标题：在「其他任务」容器下作为子分类
    const h2Match = trimmed.match(/^##\s+(.+)$/);
    if (h2Match) {
      if (!insideOtherTasks) {
        // 在真实分类（当前任务 / 普通分类 / 回收站）下出现的 h2：
        // 软件不会生成这种结构，但用户手工编辑时很自然会写出 `## 子任务` 之类的东西。
        // 旧行为是直接把 h2 吞掉、后续任务归入「未分类」 —— 这是不可逆的数据重组，
        // 用户原本想表达的「## 工作」会被静默丢掉。
        // 改为（v3.7+ 修复 H2）：把 orphan h2 提升为顶级 NORMAL 分类
        // （parentOtherTasks=false），后续任务归到这个分类下 —— 至少用户能在
        // UI 里看到分类名并调整归属，不会静默丢数据。
        // 同名去重：若已存在同名顶级 NORMAL 分类，复用第一份（与 OTHER_TASKS 同款防御）。
        //
        // **v3.7+ 修复（H3）**：orphan h2 名为「未分类」时**必须走保留名路径**，
        // 复用容器下的「未分类」（或新建 parentOtherTasks=true 的那份），否则
        // 会创建顶级 NORMAL 「未分类」+ 容器下「未分类」两个同名分类 —— sidebar
        // 渲染两份入口、用户能看到但点不到第二个的位置（任务丢了的体感 bug）。
        // 「未分类」是容器保留名（README 明确），语义上必须是容器下子分类，
        // 不允许顶级存在同名项。
        const orphanName = h2Match[1].trim();
        if (orphanName === UNCATEGORIZED_NAME) {
          currentCategory = getOrCreateUncategorized(categories);
          continue;
        }
        const existing = categories.find(
          c => c.kind === CategoryKind.NORMAL && !c.parentOtherTasks && c.name === orphanName
        );
        if (existing) {
          currentCategory = existing;
        } else {
          currentCategory = createCategory(orphanName, CategoryKind.NORMAL);
          categories.push(currentCategory);
          // debug 日志方便发现异常文件结构
          if (typeof console !== 'undefined' && console.debug) {
            console.debug('[parser] orphan h2 提升为顶级分类:', orphanName);
          }
        }
        continue;
      }
      const name = h2Match[1].trim();
      // 「未分类」是容器下的保留名（任务兜底，README 明确不可重复）。
      // 手工编辑 / 外部合并都可能写出第二个 `## 未分类`。如果照常 push，
      //   - sidebar 渲染两份同名入口（用户看到的 bug）
      //   - writer 把两份都写出去，下次加载又被 parser 读成两份，自维持脏数据
      //   - 第二个 h2 之后的任务被丢到一个永远选不到的"幽灵"分类（sidebar
      //     里两份「未分类」都点不到那一批任务的位置，体感"任务丢了"）
      // 改为复用第一份：第二个 `## 未分类` 不再创建新分类、只把 currentCategory
      // 重指到已有的那份，让后续任务继续往里追加。
      // store 层的 _consolidateUncategorized 兜底防绕过。
      if (name === UNCATEGORIZED_NAME) {
        const existing = categories.find(
          c => c.parentOtherTasks && c.name === UNCATEGORIZED_NAME
        );
        if (existing) {
          currentCategory = existing;
          continue;
        }
      }
      currentCategory = createCategory(name, CategoryKind.NORMAL);
      currentCategory.parentOtherTasks = true;
      categories.push(currentCategory);
      continue;
    }

    // 三级及以下标题：忽略
    if (/^#{3,}\s+/.test(trimmed)) continue;

    // 引用块：旧版本 Today 元数据或备注 —— 全部忽略
    if (trimmed.startsWith('>')) continue;

    // 任务列表项
    // 括号内允许任意字符（包括旧的 [!high] 等元数据标记 —— 现在已不再解析为元数据，
    // 但旧文件不应被无声丢弃，标记会以原文形式保留在任务文本中）。
    // 文本部分允许为空 —— `- [x]` 这种「纯勾选无文本」的合法手写形式也要识别，
    // 否则会被 _ensureBaseStructure 当成纯文本忽略、保存时直接消失，任务数据丢失。
    //
    // **v3.7+ 修复**：TASK_LINE_RE 收紧到只接受 4 种合法 checkbox 字符（` ✓xX`）。
    // 旧版用 `[^\]]+` 会让 `- [⭐] foo` 被解析为 marker='⭐' + text='foo'，
    // 等于把 inline `[⭐]` 标记**吃掉**，重要状态静默丢失。详见 TASK_LINE_RE 注释。
    const taskMatch = trimmed.match(TASK_LINE_RE);
    if (taskMatch) {
      // Markdown 是真相之源，用户手写的纯任务清单（无标题）也必须完整读进来，
      // 否则加载后自动保存会把原文件覆写成空文档。
      //   - 无标题     → 归入隐式的「当前任务」
      //   - 废弃标题下 → 归入容器下的「未分类」（见 __skip__ 分支）
      //   - 容器标题下 → 归入容器下的「未分类」子分类（容器本身不存任务）
      if (!currentCategory) {
        currentCategory = orphansToUncategorized
          ? getOrCreateUncategorized(categories)
          : getOrCreateImplicitToday(categories);
      } else if (currentCategory.kind === CategoryKind.OTHER_TASKS) {
        currentCategory = getOrCreateUncategorized(categories);
      }

      const marker = taskMatch[1];
      // 任务文本：可能为空（合法：`- [x]`）。下面的所有 strip 都要容忍空字符串，
      // 之前写 `taskMatch[2]` 在没有文本组的旧正则下会 undefined —— 一并修了。
      let text = (taskMatch[2] || '').trim();

      // 完成标记：[✓]（首选）/ [x] / [X]（旧文件兼容）
      let completed = isCompletedMarker(marker);

      // 行尾的 `<!-- id:xxx -->` 注释（v3 之前写入器会自动追加）。
// 写入器已不再生成，所以新文件不会有；但旧文件加载时仍要剥掉，
// 否则这些字符会作为任务文本的一部分显示在 UI 上。
//
// 锚定行尾：用户可能手敲 `<!-- id:t1 -->` 作为任务文本的一部分
// （比如示例代码、文档片段）。无锚定时正则会从文本中间抠出第一个
// 匹配，悄无声息地把用户的字串删掉 —— 是低门槛的数据损坏 vector。
// 锚 $ 后只剥末尾的那一个。
//
// 注意：v3+ 不再从文件里提取 id 作为任务身份。task.id 由本函数末尾
// 的统一计数器分配，跨重载重新生成。详见 end of parseMarkdown()。
      text = text.replace(/<!--\s*id:[^\s>]+\s*-->$/, '').trim();

      // 重要标记 + 当前标识 + 原分类：从文本中抽取并剥掉（共享逻辑，见 extractInlineMarkers）。
      // 不在原处写一份，是为了让 parseImportLine 能复用完全相同的解析语义，
      // 避免「导入说可以 / 保存后又说不行」或「标记不被翻译成 important/current 字段」。
      const markers = extractInlineMarkers(text);
      text = markers.text;
      const task = {
        text,
        completed,
        // 行内 [⭐] 标记已存在 → 直接 true；否则仅当父 h1 是「重要任务」类镜像段时才传染 true。
        // 避免 archive/历史段下的普通任务被错误标记成 important。
        important: markers.important || inheritImportantFromHeading,
        current: markers.current,
        originalCategory: markers.originalCategory
      };
      currentCategory.tasks.push(task);
      continue;
    }

    // 任务列表项 fallback —— TASK_LINE_RE 收紧到 `[ ✓xX]` 后，`- [⭐] foo` /
    // `- [▶] foo` / `- [!high] foo` 这类「首字符不是合法 checkbox」的列表项被拒收。
    // 必须兜住这些行 —— 静默忽略会导致用户在 UI 勾了「重要」保存后再次加载时
    // 重要标记消失（数据丢失）。做法：
    //   1) 匹配 `- [X]` / `* [X]` / `+ [X]`，X ∈ 非 checkbox 单字符
    //   2) 去掉前导 `- ` 把剩余文本（包括首括号）当成 task.text 送去 extractInlineMarkers
    //      → inline 标记被正确翻译成 important / current / originalCategory 字段
    //   3) 没有 checkbox 字符 → completed=false（视为未勾选）
    //
    // 注意：也覆盖用户手敲的 `- [原分类：X] foo` —— 之前由 TASK_LINE_RE 误把
    // `[原分类：X]` 整个当成 marker（marker='原分类：X'），现在正确剥出为 originalCategory。
    //
    // 排除字符集：4 种合法 checkbox 字符（` ✓xX`），这些已被上方 TASK_LINE_RE
    // 处理掉，无需 fallback。其它单字符（⭐、▶、!、?、A-Z 等）都走 fallback，
    // 保持旧版"宽容吃下任何字符"的行为 —— inline 标记（⭐/▶）的精确语义
    // 由 extractInlineMarkers 决定，fallback 只负责"不被忽略"。
    //
    // 注意：第一个括号后允许 `\s*`（不强制空白），让 `- [▶][⭐] 当前且重要`
    // 这类连续 inline 标记也能命中 —— 第二个 `[⭐]` 没有前导空白也能被整体
    // 捕获进 text，让 extractInlineMarkers 正常剥出。
    //
    // 注意：括号内允许多字符非 checkbox 内容（`[^ ✓xX\]]+`），不再卡单字符。
    // 旧版 `[^ ✓xX]` 单字符限制会让 `- [原分类：工作] 写周报` 这种多字符首括号
    // 行**完全匹配不上**（`原` 后面期望 `]` 但实际是 `分`）→ 整行静默被忽略，
    // 数据丢失（round 5 审计 H1）。多字符兜底后，`[原分类：X]` / `[!important]` /
    // `[foo]` 都能落到 text → extractInlineMarkers 把 `[原分类：X]` 正确剥到
    // originalCategory 字段；其它多字符内容（如 `[!important]`）当成字面文本
    // 保留，让 inline 标记翻译流程统一处理。
    const listFallbackMatch = /^[-*+]\s+\[([^ ✓xX\]]+)\](?:\s*(.*))?$/.exec(trimmed);
    if (listFallbackMatch) {
      // currentCategory 兜底逻辑与 TASK_LINE_RE 分支一致（见上）
      if (!currentCategory) {
        currentCategory = orphansToUncategorized
          ? getOrCreateUncategorized(categories)
          : getOrCreateImplicitToday(categories);
      } else if (currentCategory.kind === CategoryKind.OTHER_TASKS) {
        currentCategory = getOrCreateUncategorized(categories);
      }
      let text = (listFallbackMatch[2] || '').trim();
      // 把被 fallback 吃掉的 `[X]` 重新拼回 text —— extractInlineMarkers 才能
      // 看到 `[⭐]` / `[▶]` / `[原分类：X]` 等 inline 标记。否则相当于在
      // parseMarkdown 路径上把 inline 标记又丢了一次（和旧 TASK_LINE_RE bug 同款）。
      text = '[' + listFallbackMatch[1] + ']' + (text ? ' ' + text : '');
      text = text.replace(/<!--\s*id:[^\s>]+\s*-->$/, '').trim();
      const markers = extractInlineMarkers(text);
      const task = {
        text: markers.text,
        completed: false,  // 无合法 checkbox → 一律视为未完成
        important: markers.important,
        current: markers.current,
        originalCategory: markers.originalCategory,
      };
      currentCategory.tasks.push(task);
      continue;
    }
  }

  // v3 起不再要求存在「当前任务」分类 —— 它已经下沉为智能视图（@当前 标识驱动）。
  // 旧文件里若仍有 # 当前任务 章节，迁移由 store 的 _migrateTodayCategory 处理。

  // 确保存在「全部任务」容器（兼容旧名「其他任务」/「待办任务」）
  if (!categories.find(c => c.kind === CategoryKind.OTHER_TASKS)) {
    const o = createCategory(OTHER_TASKS_NAME, CategoryKind.OTHER_TASKS);
    categories.unshift(o);
  }

  // 为每个任务分配运行时 id。
  //
  // 写入器（markdown-writer）v3+ 不再写 `<!-- id:... -->` 注释，所以解析器也不再
  // 从文本里提取。任务在内存中的身份由本循环统一从 t1 开始分配，
  // 在本次加载周期内稳定，跨重载重新生成 —— 这是用户已接受的代价：
  // 外部编辑文件后，UI 选中态可能错位。
  assignTaskIds(categories);

  return categories;
}

/**
 * 判定 h1 名称是否是「传染 important 标记」的智能镜像段。
 * 仅对真正代表"重要"语义的段生效 —— 归档/历史/已计划等已废弃段不应传染。
 *
 * @param {string} name
 * @returns {boolean}
 */
function isInheritedImportantHeading(name) {
  const lower = (name || '').toLowerCase().trim();
  // SMART_LIST_KEYS 已包含 '重要任务' / 'important' / 'important tasks' /
  // '全部任务列表' / 'all tasks' / 'alltasks'。其中：
  //   - '重要任务' / 'important' / 'important tasks' → 传染 important = true
  //   - '全部任务列表' / 'all tasks' / 'alltasks' → 不传染（这只是一个总览段，
  //     里面的任务未必是重要的，只是被列出来而已）
  return (
    lower === '重要任务' || lower === 'important' || lower === 'important tasks'
  );
}

/**
 * 根据名称识别分类类型。
 * @returns {string} CategoryKind 或 '__skip__'（跳过）
 */
function classifyByName(name) {
  const lower = (name || '').toLowerCase().trim();
  // 已废弃的概念：完全跳过
  if (
    lower === 'archive' || lower === '归档' || lower === '历史' ||
    lower === 'planned' || lower === '已计划'
  ) {
    return '__skip__';
  }
  // 智能列表段落（重要任务 / 全部任务列表）：跳过 ——
  // 这些段落 v3.x 顶部镜像段残留会在旧文件里出现：真实任务靠「全部任务」容器里的
  // [▶]/[⭐] 标识承载，不需要再单独维护一个段；读取时整体跳过、段下任务归「未分类」，
  // 下次保存即清理。
  // 注：「已完成任务」v3.4 起不再是镜像段而是真实分类（kind=COMPLETED），
  // 由下面 COMPLETED_KEYS 分支处理，不在这里跳过。
  if (SMART_LIST_KEYS.includes(lower)) return '__skip__';
  if (TODAY_KEYS.includes(lower)) return CategoryKind.TODAY;
  if (OTHER_TASKS_KEYS.includes(lower)) return CategoryKind.OTHER_TASKS;
  if (TRASH_KEYS.includes(lower)) return CategoryKind.TRASH;
  if (COMPLETED_KEYS.includes(lower)) return CategoryKind.COMPLETED;
  return CategoryKind.NORMAL;
}

/**
 * 根据名称和类型创建分类对象
 */
function createCategory(name, kind) {
  let actualKind = kind;
  let isSpecial = false;

  if (
    kind === CategoryKind.TODAY ||
    kind === CategoryKind.OTHER_TASKS ||
    kind === CategoryKind.TRASH ||
    kind === CategoryKind.COMPLETED
  ) {
    isSpecial = true;
  }

  return {
    name,
    kind: actualKind,
    isSpecial,
    meta: null,
    parentOtherTasks: false,
    tasks: []
  };
}

/**
 * 取（或懒创建）隐式的「当前任务」分类。
 * 用于「文件里根本没有标题、直接就是任务清单」的情况 —— 这类手写文件必须完整读入，
 * 否则加载后的自动保存会把用户原文覆写成空文档。
 * 创建时插到数组最前，与末尾兜底逻辑保持同一位置语义。
 */
function getOrCreateImplicitToday(categories) {
  const existing = categories.find(c => c.kind === CategoryKind.TODAY);
  if (existing) return existing;
  const t = createCategory(TODAY_CANONICAL_NAME, CategoryKind.TODAY);
  categories.unshift(t);
  return t;
}

/**
 * 取（或懒创建）容器下的「未分类」子分类。
 * 用于「任务直接写在 `# 全部任务` 之下、没有 `##` 子分类标题」的情况：
 * 容器本身不存任务，但这些任务同样不能丢，统一归入「未分类」。
 */
function getOrCreateUncategorized(categories) {
  const existing = categories.find(
    c => c.parentOtherTasks && c.name === UNCATEGORIZED_NAME
  );
  if (existing) return existing;
  const sub = createCategory(UNCATEGORIZED_NAME, CategoryKind.NORMAL);
  sub.parentOtherTasks = true;
  // 紧跟容器之后：writeMarkdown 依赖数组顺序把它写成容器下的 `## 未分类`
  const oIdx = categories.findIndex(c => c.kind === CategoryKind.OTHER_TASKS);
  if (oIdx >= 0) {
    categories.splice(oIdx + 1, 0, sub);
  } else {
    categories.push(sub);
  }
  return sub;
}

/**
 * 从任务文本中抽取并剥掉重要 / 当前 / 原分类 inline 标记，返回剥净的 text 及对应字段。
 *
 * 与 parseMarkdown 内部解析任务行时**共用同一份逻辑**（原本写在 parseMarkdown 里内联），
 * 抽出来是为了让 task-store 的 parseImportLine 在导入时也走完全相同的解析路径：
 *   - 避免「导入时文本里有 [⭐]，但 important 字段为 false；保存后 parseMarkdown 又
 *     把 [⭐] 抽走」这种语义不一致。
 *   - 避免未来解析规则改动时只改一边。
 *
 * 标记规则（与 parser 严格对齐）：
 *   - 重要：
 *     - [⭐]（v3.2+）：方括号包裹，**只能出现在文本开头或结尾**。
 *       `]` 自身充当终止符 —— 后可紧贴任意字符（包括 CJK），开头判别不依赖空白。
 *       行内位置「对比 [⭐] 和 [ ]」不会被误命中，避免低门槛数据损坏 vector。
 *     - ⭐（v3.1 之前）：裸字符，必须前后有空白避免吃行内字符。
 *   - 当前：
 *     - [▶]（v3.2+）：方括号包裹，规则同 [⭐]
 *     - ▶（v3.1）/ @当前（v3.0）：裸/中文标识，必须前后有空白
 *     写入器只输出新格式 [▶]，旧标记在首次保存时自动改写。
 *   - 原分类（v3.5+）：[原分类：xxx]，方括号包裹 + 全角冒号 + 分类名。
 *     与 [⭐]/[▶] 同款位置约束（开头或结尾），括号内第一个 ] 充当终止符。
 *     用途：勾选/拖入「已完成任务」时记录原分类，取消勾选时直接归位。
 *     解析后落到 task.originalCategory；写回时由 writer 把标记排在
 *     [▶]/[⭐] 之后、文本之前 —— 与状态标记同列标记块，不被推到文本末尾。
 *     解析器保留对行首/行尾两种位置的支持 —— 旧文件 / 用户手敲的
 *     `[原分类：xxx]` 出现在文本末尾也能被识别。
 *
 * 多个标记同时出现时**顺序不固定** —— writer 当前输出 [▶][⭐]，旧文件可能是 [⭐][▶]，
 * 循环剥离直到稳定即可兼顾两种顺序。
 *
 * 纯函数。空 / 纯空白 / 不含标记的输入直接原样返回。
 *
 * @param {string} rawText - 已去掉 checkbox 标记 / 列表符号的纯文本（来自 parseMarkdown 或 parseImportLine）
 * @returns {{ text: string, important: boolean, current: boolean, originalCategory: string|null }}
 */
export function extractInlineMarkers(rawText) {
  let text = (rawText || '');

  // 行首/行尾的 [⭐] / [▶] 标记可同时出现，且**顺序不固定**：
  //   - writer 当前固定输出 [▶][⭐]（用户偏好：当前在前）
  //   - 旧文件 / 用户手敲 / 不同 markdown 工具可能是 [⭐][▶]
  // 单次 important→current 两阶段 pass 在 [▶][⭐] 输入下会漏剥 [⭐]
  // （第一次 pass 找不到行首 [⭐] 就放弃，剩下 [⭐] 漏到 text 里）。
  // 改为 loop：每次循环最多剥一个标记（行首 / 行尾 / 裸字符 之一），
  // 反复执行直到稳定 —— 这样两种顺序都能正确剥净。
  let important = false;
  let current = false;
  // v3.5+：原分类标记解析后的归属名。第一次匹配上即锁定 —— 与 important/current
  // 不同，原分类只能有一个（任务从哪来只有一处），后面的重复标记会被当作普通文本保留。
  let originalCategory = null;
  let safety = 0;
  while (safety++ < 10) {
    const before = text;

    // 1) 行首 [⭐] / [▶]（复用模块顶层 MARKER_HEAD_RE —— 字符源是常量 IMPORT/CURRENT）
    let m = MARKER_HEAD_RE.exec(text);
    if (m) {
      if (m[1] === IMPORTANT_MARKER) important = true; else current = true;
      text = text.slice(m[0].length);
    }
    // 2) 行尾 [⭐] / [▶]（同上，模块顶层 MARKER_TAIL_RE）
    else if ((m = MARKER_TAIL_RE.exec(text))) {
      if (m[1] === IMPORTANT_MARKER) important = true; else current = true;
      text = text.slice(0, text.length - m[0].length).trimEnd();
    }
    // 3) 行首 [原分类：xxx]（v3.5+）—— 非贪婪匹配（修复 M-D2），只首次记录值；
    //    重复标记也剥（修复 M-D1），不让 `[原分类：B]` 永久滞留文本。
    // C1 修复：原分类里可能有 `]`（writer 已转义为 `\]`）。字符类允许 `\.` 形式，
    // 捕获后再把 `\]`/`\\` 反向转义回 `]`/`\`。
    else if ((m = /^\[原分类：((?:\\.|[^\]])+?)\]/.exec(text))) {
      if (originalCategory === null) originalCategory = unescapeOriginalCategory(m[1]).trim();
      text = text.slice(m[0].length);
    }
    // 4) 行尾 [原分类：xxx]（v3.7+ 去掉 \s 前导，与 [⭐] 对称：H5 修复后规则统一）
    else if ((m = /\[原分类：((?:\\.|[^\]])+?)\]$/.exec(text))) {
      if (originalCategory === null) originalCategory = unescapeOriginalCategory(m[1]).trim();
      text = text.slice(0, text.length - m[0].length).trimEnd();
    }
    // 5) 旧版裸 ⭐（必须前后空白边界；前后必须有空白才能命中行内）
    else if ((m = /(?:^|\s)⭐(?=\s|$)/.exec(text))) {
      important = true;
      text = text.replace(/(?:^|\s)⭐(?=\s|$)/, ' ');
    }
    // 6) 旧版裸 ▶ 或 @当前（必须前后空白边界）
    else {
      const legacyMarkers = [CURRENT_MARKER, LEGACY_CURRENT_MARKER];
      let matched = false;
      for (const marker of legacyMarkers) {
        const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`);
        if (re.test(text)) {
          current = true;
          text = text.replace(re, ' ');
          matched = true;
          break;
        }
      }
      if (!matched) break; // 没匹配上任何标记 —— 已稳定
    }

    // 收尾：只剥首尾空白。去掉旧版 `/\s+/g` 全角折叠（修复 H8）：
    //   旧实现会把任务文本里用户原本写的连续空格（`前后  多空  格`）也一并
    //   折成单空格，触发条件仅仅是任务带了 `[⭐]` / `[▶]` 等标记。
    //   数据损坏是悄无声息的：保存时 text 已经丢空格，下次读回来还是丢。
    //   现实现只 trim 两端 —— 内部空白保持原样：
    //     - 1/3/4 行（head marker / head 原分类）剥后可能留前导空白 → trimStart 已涵盖
    //     - 2/4 行（tail marker / tail 原分类）剥后已 trimEnd
    //     - 5/6 行（legacy `前后 ⭐ 文本`）的 `(?:^|\s)⭐` replace 已自带单空格，
    //       不需要再次折叠 —— 旧版的 `\s+/g` 是为了消除这条路径的"双空格残留"，
    //       但实际用户输入里 `前后  多空  格` 也属于"想保留的连续空格"，
    //       不该因带了 marker 就被改写。
    text = text.trim();

    // 防御：本轮没剥掉任何字符（理论上不会），避免死循环
    if (text === before) break;
  }

  // C2 修复：writer 把任务里的换行转义为 `\n`（文件里仍是单行）。解析端反向
  // 转义：`\\n`（已转义的 backslash 自身）→ `\`，`\n`（单段内非结尾） → 真换行。
  // 这里只做单层 unescape —— writer 同样只做单层 escape，无嵌套风险。
  //
  // v4+ 修复：改为单次遍历解码。旧实现两次 replace 顺序错误会导致数据损坏 ——
  // 当原文含 `\n` 字面量（如 `C:\new_folder`、代码片段 `hello\nworld`），writer
  // 先转义 `\` 为 `\\`、再拼 `\n` 连接符，写到 markdown 的是 `\\n`（两个反斜杠+n）。
  // 旧 parser 先 `/\\n/g → \n` 把 `\\n` 里的 `\n` 误识别为换行符、再 `/\\\\/g → \`
  // 已无 `\\` 可匹配 → 原本单行的 `hello\nworld` 被拆成 `hello\` + 换行 + `world`。
  // 单次遍历正则 `/\\(\\|n)/g` 把 `\\` 和 `\n` 作为互斥的两种转义原子处理，
  // `\\n` 只会匹配为 `\\`（→ `\`）+ 字面 `n`，不会被误拆。
  const unescapedText = text.replace(/\\(\\|n)/g, (_match, group) => {
    return group === '\\' ? '\\' : '\n';
  });

  return { text: unescapedText, important, current, originalCategory };
}
