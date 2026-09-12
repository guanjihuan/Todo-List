// Markdown 写入器
// 将任务树序列化为 Markdown 文本
//
// 结构（v3.4 起「已完成任务」升级为真实分类；v3.5 起 `# 已完成任务` 文件位置固定在
//       `# 全部任务` 及其 `##` 子分类之后、`# 回收站` 之前）：
//   # 全部任务            ← 容器（h2 为子分类；未完成 / 非重要 / 非当前 的任务都活在这里）
//     ## 工作 / ## 学习 / ## 生活 / ## 未分类 / 用户自定义子分类…
//   # 已完成任务          ← 真实分类（kind=COMPLETED；[✓] 打勾后任务会自动移到这里）
//   # 回收站              ← 真实分类（仅当有任务时写出；用于彻底删除前的暂存）
//
// 任务状态由 inline 标识承载：
//   - [✓]  已完成（与下方 # 已完成任务 镜像对应）
//   - ⭐    重要
//   - ▶     当前焦点（U+25B6 BLACK RIGHT-POINTING TRIANGLE；可出现在任意子分类下，
//           「当前任务」智能视图按此聚合；解析器仍认旧版 @当前 标记以兼容升级前文件）
//
// v3 → v3.6 的关键变更：
//   - **移除顶部 `# 当前任务` / `# 重要任务` 镜像段**：v3.x 一度按用户要求把带 [▶]/[⭐]
//     标识的任务在文件顶部重复写一遍，顶部一眼看到当前/重要的任务 —— 但同一个
//     文本在文件里出现两次既冗余又复杂（用户后续反馈「感觉重复了，会有点复杂」）。
//     顶部一眼看到当前/重要任务这件事由 UI 侧边栏的智能视图承担即可，
//     数据模型始终只有「全部任务」容器里带 inline 标识的源任务。
//     旧文件里的镜像段由 parser 的 TODAY_KEYS / SMART_LIST_KEYS 路径消化
//     （前者迁移到首个子分类并打 [▶]，后者整段跳过、任务归「未分类」），
//     下一次保存即扁平化为新结构。
//
// v3.x → v3.4 的关键变更：
//   - 「# 已完成任务」从顶部镜像段**升级为真实分类**（kind=COMPLETED）：
//     `[✓]` 打勾后任务**自动移动**到这里，取消勾选则回到它原来的分类
//     （原分类名记在 `[原分类：xxx]` 里，由 toggleTask 写入）。
//     原分类丢了（被删/被改名）→ 弹分类选择器；任务没有原分类记录
//     （很旧的兜底场景）→ 直接落「未分类」不弹窗。
//     数据归属明确，与「回收站」语义对称（删除 → 移到回收站；完成 → 移到已完成任务）。
//     与 v3.2「# 已完成任务 镜像段」的差别：旧版任务实体仍活在源子分类里，
//     只是顶部重复显示；现在任务**只活在一个地方**（已完成任务分类），
//     「全部任务」容器只装未完成任务 —— 不再有"完成的任务既在「工作」里又在
//     「已完成任务」里"的数据冗余与归属歧义。
//     升级时一次性迁移：旧文件里散落在各子分类的 [✓] 任务会被搬到新的
//     「# 已完成任务」分类，下一次保存即统一。
//
// v2 → v3 的关键变更（历史）：
//   - 删除 `# 当前任务` h1 段：当前任务不再是一个独立分类，而是任意子分类下
//     任务都能打的 ▶ 标识。语义更灵活 —— 你可以让「工作」里的某条任务
//     既是 ▶、又不是「生活」里的某条任务的状态。
//
// 任务身份（task.id）是运行时句柄，单次加载周期内稳定，跨重载重新分配。
// 文件里不再写 `<!-- id:... -->` —— 任务靠 inline 标识（[✓] / [⭐] / [▶]）+ 文本识别。

import {
  CategoryKind,
  OTHER_TASKS_NAME,
  TRASH_NAME,
  UNCATEGORIZED_NAME,
  COMPLETED_NAME,
  CURRENT_MARKER,
  IMPORTANT_MARKER
} from './markdown-parser.js';

// 写在「回收站」标题下方的说明。软件不提供清空入口，所以文件本身必须讲清
// 彻底删除的唯一途径 —— 否则用户只会看到一个只增不减的列表，不知道怎么收拾。
const TRASH_NOTE = '<!-- 在软件里删除的任务会移到这里，不会真的消失。软件不提供「清空回收站」，要彻底删除请直接删掉下面对应的行。 -->';

// 写在「已完成任务」标题下方的说明。v3.4 起这是真实分类而非镜像段——
// 文件里必须讲清勾选 / 取消勾选后的行为，避免用户疑惑"我的任务怎么不见了"。
// v3.5+ 起取消勾选是回到原分类（[原分类：xxx] 记录）；原分类丢失时弹选择器。
const COMPLETED_NOTE = '<!-- [✓] 打勾的任务会自动移到本节；取消勾选后会回到它原来的分类。需要彻底归档请用「移到回收站」（Delete 键）。 -->';

/**
 * 将分类列表序列化为 Markdown
 * @param {Array} categories
 * @returns {string}
 */
export function writeMarkdown(categories) {
  if (!Array.isArray(categories)) {
    // 输入类型错误（不是数组）—— 这是开发者 bug，不是用户输入错误。
    // 静默返回空串会让磁盘文件被清空，下次加载就把用户的全部任务抹掉。
    // 抛错让上层 TaskStore.serialize() 走 save-error 路径，触发冲突对话框让用户介入，
    // 比"看起来成功了但下次启动丢盘"安全得多。
    throw new Error('writeMarkdown: categories 必须是数组');
  }
  if (categories.length === 0) {
    // 同样不写空文件 —— 如果上层传了空数组，要么是 _ensureBaseStructure 没跑，
    // 要么是极端 race。抛错让用户在冲突对话框里选「保留本地」/「重新加载」，
    // 永远不静默清空磁盘。
    throw new Error('writeMarkdown: categories 数组为空（_ensureBaseStructure 未运行？）');
  }

  const parts = [];

  // ── 真实分类段落 ──
  //
  // 分三遍写，强制 `# 已完成任务` 排在「全部任务」容器及其全部 `##` 子分类之后、
  // `# 回收站` 之前 —— 即使用户文件里它是夹在中间（v3.4 老文件 / 外部手工编辑后的乱序），
  // 写回来时也按期望的视觉顺序固定下来。
  //
  // 第一遍：除 COMPLETED / TRASH 之外的所有分类（容器 / 子分类 / TODAY 兜底 / 普通 h1）。
  // 第二遍：只写 COMPLETED，位置必然在第一遍末尾（所有 ## 子分类之后）。
  // 第三遍：只写 TRASH，保证它永远是文件最后一段（视觉上「最远」的兜底区）。
  //
  // 这不是简单的"sort 排序"—— sort 会改变 ## 子分类之间的相对顺序（用户手工编辑过的
  // ## 顺序会被打乱）。三遍循环保留了所有非 COMPLETED / 非 TRASH 分类的相对顺序。
  // ── 真实分类段落（全部任务 容器 + 子分类 + TODAY 兜底 + 普通 h1）──
  for (const cat of categories) {
    if (cat.kind === CategoryKind.COMPLETED) continue;  // 第二遍再写
    if (cat.kind === CategoryKind.TRASH) continue;      // 第三遍再写

    if (cat.kind === CategoryKind.OTHER_TASKS) {
      // 容器：本身不写任务，紧跟的 parentOtherTasks 子分类作为 ## 子分类
      parts.push(`# ${cat.name}`);
      parts.push('');
      continue;
    }

    // 兜底：旧文件里残留的 `# 当前任务` / `# 我的一天` 章节（迁移未彻底完成）
    // 也要写出来，避免解析器下次加载时再次把它们当成 TODAY 处理。
    // 正常流程下 store 会在加载时把它们迁移掉，这里基本不会触发。
    if (cat.kind === CategoryKind.TODAY) {
      if (!cat.tasks || cat.tasks.length === 0) continue;
      parts.push(`# ${cat.name}`);
      parts.push('');
      appendTasks(parts, cat.tasks, cat.kind);
      parts.push('');
      continue;
    }

    if (cat.parentOtherTasks) {
      // 子分类：在容器下作为 ## 标题
      parts.push(`## ${cat.name}`);
      parts.push('');
      appendTasks(parts, cat.tasks, cat.kind);
      parts.push('');
      continue;
    }

    // 普通分类（非子分类、非容器、非回收站、非已完成、非 TODAY）：仅在旧文件里可能出现
    // 写出来保留数据，迁移到「全部任务」下的工作是 store 的责任
    parts.push(`# ${cat.name}`);
    parts.push('');
    appendTasks(parts, cat.tasks, cat.kind);
    parts.push('');
  }

  // ── 真实分类段落（已完成任务 —— 固定排在 ## 子分类之后）──
  for (const cat of categories) {
    if (cat.kind !== CategoryKind.COMPLETED) continue;
    // v3.4：「# 已完成任务」是真实分类 —— [✓] 打勾的任务由 store 自动搬到这里。
    // 为空时整节都不写 —— 没人打过勾的文件不该凭空多出一个空标题。
    if (!cat.tasks || cat.tasks.length === 0) continue;
    parts.push(`# ${cat.name}`);
    parts.push('');
    parts.push(COMPLETED_NOTE);
    parts.push('');
    appendTasks(parts, cat.tasks, cat.kind);
    parts.push('');
  }

  // ── 真实分类段落（回收站 —— 固定排在文件最后一段）──
  for (const cat of categories) {
    if (cat.kind !== CategoryKind.TRASH) continue;
    // 回收站为空时整节都不写 —— 没删过任何东西的文件不该凭空多出一个空标题。
    if (!cat.tasks || cat.tasks.length === 0) continue;
    parts.push(`# ${cat.name}`);
    parts.push('');
    parts.push(TRASH_NOTE);
    parts.push('');
    appendTasks(parts, cat.tasks, cat.kind);
    parts.push('');
  }

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * 追加任务到输出（文本 + 勾选状态 + ⭐ + @当前 + 原分类 + ID 注释）
 *
 * @param {string[]} parts - 输出缓冲
 * @param {Array} tasks - 任务列表
 * @param {string} [categoryKind] - 所属分类类型；用于决定是否输出 [原分类：xxx]
 *   - COMPLETED / TRASH：写出 [原分类：xxx]（任务来源信息在此分类里有意义）
 *   - 其他：藏起来 —— 普通子分类里任务已"到家"，原分类标记是冗余噪音
 *   - 不传：兜底按"不输出原分类"处理
 */
function appendTasks(parts, tasks, categoryKind = null) {
  if (!tasks || tasks.length === 0) return;
  for (const task of tasks) {
    parts.push(formatTaskLine(task, categoryKind));
  }
}

/**
 * 格式化单条任务为 Markdown 行
 *
 * 输出顺序：`- [✓] [▶] [⭐] [原分类：xxx] 任务文本`
 *   - 所有状态标识用方括号包裹（与 [ ]/[✓] 风格统一）
 *   - 标记块集中在 checkbox 之后、文本之前 —— 一眼能扫到「这是标记」
 *   - 完成标记用 [✓]（打勾）而非 [x]（打叉）
 *   - [▶] 当前 → [⭐] 重要 → [原分类：xxx] → 顺序固定（用户偏好：所有"元信息"
 *     集中在文本之前，文件里一眼扫完一行就知道这条任务的全部标记状态）
 *   - 不再写 `<!-- id:... -->`：task.id 是运行时句柄，跨重载重新分配
 *   - ▶ 是 U+25B6 BLACK RIGHT-POINTING TRIANGLE，与 ⭐ 视觉权重对等
 *   - v3.5+：[原分类：xxx] 排到文本**前面**（与 [▶]/[⭐] 同处标记块），原因：
 *     「原分类」是任务的来源追溯（"它从哪来"），但视觉上和其他标记同列一行
 *     才方便用户在文件里扫读 —— 把它推到文本末尾会让一行内信息分散，
 *     看一条任务得从头到尾扫两遍。标记块统一前缀 + 文本在后的布局更紧凑。
 *   - v3.5.1+：`[原分类：xxx]` 仅在 kind=COMPLETED / kind=TRASH 分类里输出；
 *     普通子分类里的任务已经"到家"，原分类标记就是冗余噪音。
 *     （store 层会在恢复路径清掉 originalCategory，这里再叠加一层护栏：
 *     即便外部编辑把任务塞了带 [原分类：xxx] 标记，普通子分类也不会写出来。）
 *
 * @param {object} task
 * @param {string} [categoryKind] - 所属分类的 kind（见 CategoryKind）。仅 COMPLETED / TRASH 输出原分类标记
 */
/**
 * 对单个不含换行的任务文本片段做反向转义（与 parser 配套）：
 *   - `\` → `\\`（避免与 \n 序列冲突）
 *   - 其余字符按原样保留（marker / 标签交给 markdown parser 在原行内识别）
 */
function escapeTaskTextSegment(seg) {
  return String(seg).replace(/\\/g, '\\\\');
}

function formatTaskLine(task, categoryKind = null) {
  const checkbox = task.completed ? '[✓]' : '[ ]';
  // C2 修复：保留换行 —— 旧版直接折叠成空格，多行任务（如粘贴的邮件正文）会丢信息。
  // 折成 `\n` 转义序列：写进文件仍是单行（解析器要按行拆分），parser 反向转义回来。
  // \r 同理 —— 避免 Windows 剪贴板里的 \r\n 在 task 文本里残留。
  let text = String(task.text ?? '').replace(/\r\n?/g, '\n').split('\n').map(escapeTaskTextSegment).join('\\n');
  // v3.5.1+：原分类标记仅在「已完成任务」「回收站」里输出。
  // 普通子分类里再保留就是噪音（任务本身已在某个分类里，[原分类：xxx] 重复表达）。
  const showOriginalCategory = task.originalCategory &&
    (categoryKind === CategoryKind.COMPLETED || categoryKind === CategoryKind.TRASH);
  // C1 修复：原分类里若有 `]` 字符，按原样写到 `[原分类：xxx]` 里会被解析器的非贪婪
  // 正则 /\[原分类：([^\]]+?)\]/ 在第一个 `]` 截断，导致跨重载丢字符。
  // 解决：写时把 `]` 转义成 `\]`（兼容 markdown 转义惯例），读时再反向。
  const escapedOriginal = showOriginalCategory
    ? String(task.originalCategory).replace(/\\/g, '\\\\').replace(/\]/g, '\\]')
    : null;
  // 标记块：[▶] / [⭐] / [原分类：xxx] 按固定顺序拼接，无对应标记就跳过（不留空格）
  const markers = [
    task.current ? `[${CURRENT_MARKER}]` : null,
    task.important ? `[${IMPORTANT_MARKER}]` : null,
    escapedOriginal ? `[原分类：${escapedOriginal}]` : null
  ].filter(Boolean).join(' ');
  return `- ${checkbox} ${markers ? markers + ' ' : ''}${text}`;
}

/**
 * 创建一个空的默认文档（v3 标识驱动结构）
 *
 * 全部任务容器 + 4 个默认子分类（工作/学习/生活/未分类）。
 * 没有「当前任务」分类 —— 用户只要在任意子分类下添加任务并打上 @当前 即可。
 */
export function createDefaultDoc() {
  const task = (text) => ({ text, completed: false, important: false, current: false });
  const sub = (name) => ({
    name,
    kind: CategoryKind.NORMAL,
    isSpecial: false,
    meta: null,
    parentOtherTasks: true,
    tasks: []
  });

  return [
    {
      name: OTHER_TASKS_NAME,
      kind: CategoryKind.OTHER_TASKS,
      isSpecial: true,
      meta: null,
      parentOtherTasks: false,
      tasks: []
    },
    sub('工作'),
    sub('学习'),
    sub('生活'),
    sub(UNCATEGORIZED_NAME)
  ];
}
