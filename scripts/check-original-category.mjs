// 回归测试：「原分类」标记 + 已完成任务恢复语义
//
// v3.5+ 行为契约：
//   1. 勾选子分类里的任务 → task.originalCategory = categoryName
//   2. writer 写出时把 `[原分类：xxx]` 排在 `[▶]/[⭐]` 之后、文本之前（标记块内）
//   3. parser 再读回来时能把 `[原分类：xxx]` 抽到 task.originalCategory
//   4. 取消勾选：原分类还在 → 直接归位（不再回「未分类」），归位后清掉 originalCategory
//   5. 取消勾选：原分类丢失（删除 / 改名） → toggleTask 返回 restoreHint.kind === 'picker'
//   6. 取消勾选：没有 originalCategory 记录（兜底） → 直接去「未分类」，不弹窗
//   7. 拖拽任务到「已完成任务」分类 → 同样记录 originalCategory
//   8. 旧文件升级迁移：散落的 [✓] 任务搬到「已完成」时自动记 cat.name
//   9. v3.5.1+：恢复后清掉 originalCategory，文件里不出现 `[原分类：xxx] 任务` 噪音
//   10. v3.5.1+：原分类标记仅在「已完成任务」「回收站」分类里输出（writer 护栏）
//   11. v3.5.1+：moveTask 把任务移出「已完成」到普通子分类时清 originalCategory
//   12. v3.5.1+：restoreTask 从回收站恢复到普通子分类时清 originalCategory
//
// v3.5.2+ 行为契约（[18] 节）：
//   13. deleteTask / batchDeleteTasks 把任务移到 trash 时同步记录 originalCategory
//       （与 toggleTask 把任务移到「已完成任务」时记 originalCategory 对称）
//   14. restoreTask 默认（无 toCategoryName）走 _resolveRestoreTarget：
//       - 原分类还在 → category 分支，直接归位
//       - 原分类丢失 → picker 分支，返回 restoreHint，任务**仍留在 trash**
//       - 无 originalCategory 记录 → fallback 分支，落「未分类」
//   15. picker 路径下 UI 调 restoreTask(taskId, picked) 完成归位 + 清 originalCategory
//   16. 已完成任务的 originalCategory 在 deleteTask 进 trash 时不被覆盖（沿用 toggle 时的值）
//
// 跑法：node scripts/check-original-category.mjs

import {
  TaskStore,
  parseImportLine
} from '../src/task-store.js';
import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';
import {
  parseMarkdown,
  CategoryKind,
  extractInlineMarkers
} from '../src/markdown-parser.js';
import { writeMarkdown } from '../src/markdown-writer.js';

// 往返：serialize 出来再 parse 回来，断言文件层的行为
function roundTrip(store) {
  return parseMarkdown(store.serialize());
}

function findCat(categories, name) {
  return categories.find(c => c.name === name) || null;
}

const BASE_DOC = `# 全部任务

## 工作

- [ ] 写周报

## 学习

- [ ] 看 Rust 入门

## 未分类

- [ ] 杂事
`;

// ============================================================
// [1] extractInlineMarkers：解析 [原分类：xxx] 标记
// ============================================================
console.log('\n[1] extractInlineMarkers 解析 [原分类：xxx] 标记');

{
  const r1 = extractInlineMarkers('[原分类：工作] 给妈妈买生日礼物');
  check('行首 [原分类：xxx] 被识别为 originalCategory',
    r1.originalCategory === '工作' && r1.text === '给妈妈买生日礼物',
    `originalCategory=${r1.originalCategory}, text=${r1.text}`);

  const r2 = extractInlineMarkers('看 Rust 入门 [原分类：学习]');
  check('行尾 [原分类：xxx] 被识别为 originalCategory',
    r2.originalCategory === '学习' && r2.text === '看 Rust 入门',
    `originalCategory=${r2.originalCategory}, text=${r2.text}`);

  const r3 = extractInlineMarkers('[▶] [⭐] 写季度汇报 [原分类：工作]');
  check('[原分类：xxx] 与 [▶]/[⭐] 共存时都正确抽取',
    r3.originalCategory === '工作' && r3.current && r3.important && r3.text === '写季度汇报',
    `orig=${r3.originalCategory}, curr=${r3.current}, imp=${r3.important}, text=${r3.text}`);

  const r4 = extractInlineMarkers('普通任务');
  check('没有标记时 originalCategory === null',
    r4.originalCategory === null,
    `originalCategory=${r4.originalCategory}`);

  const r5 = extractInlineMarkers('任务中含 [原分类：工作] 字面字符串');
  check('行中的 [原分类：xxx] 不被误识为标记',
    r5.originalCategory === null && r5.text.includes('任务中含'),
    `originalCategory=${r5.originalCategory}`);
}

// ============================================================
// [2] 勾选任务 → originalCategory 记录源分类
// ============================================================
console.log('\n[2] 勾选任务 → originalCategory 记录源分类');

{
  const store = makeStore(BASE_DOC);
  const workCat = store.getCategory('工作');
  const task = workCat.tasks.find(t => t.text === '写周报');
  const result = store.toggleTask('工作', task.id);

  check('toggleTask 返回 { ok: true }', result && result.ok === true);
  check('任务已从「工作」分类移除',
    !store.getCategory('工作').tasks.some(t => t.text === '写周报'));
  check('任务已到「已完成任务」分类',
    store.getCategory('已完成任务').tasks.some(t => t.text === '写周报'));
  check('task.originalCategory === "工作"',
    store.getCategory('已完成任务').tasks[0].originalCategory === '工作',
    `actual=${store.getCategory('已完成任务').tasks[0].originalCategory}`);
  check('task.completed === true',
    store.getCategory('已完成任务').tasks[0].completed === true);
}

// ============================================================
// [3] writer 把 [原分类：xxx] 排在 [▶]/[⭐] 之后、文本之前
// ============================================================
console.log('\n[3] writer 写出 [原分类：xxx]');

{
  const store = makeStore(BASE_DOC);
  const workCat = store.getCategory('工作');
  const task = workCat.tasks.find(t => t.text === '写周报');
  store.toggleTask('工作', task.id);

  const md = store.serialize();
  check('serialize 输出含 [原分类：工作]',
    md.includes('[原分类：工作]'),
    `output 前 400 字: ${md.slice(0, 400)}`);
  check('serialize 输出仍是 [✓] 勾选态',
    md.includes('- [✓]') && md.includes('写周报'));
  // v3.5+：[原分类：xxx] 排在标记块内（[▶]/[⭐] 之后、文本之前）
  // 验证：写出行形如 `- [✓] [原分类：工作] 写周报`（写在本行的「已完成任务」分类下）
  const completedLine = md.split('\n').find(l => l.includes('写周报') && l.includes('[✓]'));
  check('原分类标记排在文本之前（标记块内）',
    completedLine && /\[原分类：工作\]\s+写周报/.test(completedLine),
    `line: ${completedLine}`);
}

// ============================================================
// [4] Markdown 往返：parse → 仍然带 originalCategory
// ============================================================
console.log('\n[4] Markdown 往返 —— 解析回来仍带 originalCategory');

{
  const store = makeStore(BASE_DOC);
  const workCat = store.getCategory('工作');
  const task = workCat.tasks.find(t => t.text === '写周报');
  store.toggleTask('工作', task.id);

  // 重新 parse 自己 serialize 出来的 markdown，模拟"保存后再加载"
  const categories = roundTrip(store);
  const completed = findCat(categories, '已完成任务');
  const reloaded = completed?.tasks.find(t => t.text === '写周报');

  check('往返后任务仍在「已完成任务」',
    !!reloaded);
  check('往返后 task.originalCategory 仍为 "工作"',
    reloaded?.originalCategory === '工作',
    `actual=${reloaded?.originalCategory}`);
  check('往返后 task.completed === true',
    reloaded?.completed === true);
}

// ============================================================
// [5] 取消勾选：原分类还在 → 直接归位
// ============================================================
console.log('\n[5] 取消勾选：原分类还在 → 直接归位');

{
  const store = makeStore(BASE_DOC);
  const workCat = store.getCategory('工作');
  const task = workCat.tasks.find(t => t.text === '写周报');
  store.toggleTask('工作', task.id);  // 勾选
  const result = store.toggleTask('已完成任务', task.id);  // 取消勾选

  check('取消勾选返回 restoreHint.kind === "category"',
    result && result.restoreHint && result.restoreHint.kind === 'category',
    `restoreHint=${JSON.stringify(result?.restoreHint)}`);
  check('取消勾选后任务回到「工作」子分类',
    store.getCategory('工作').tasks.some(t => t.text === '写周报'));
  check('任务不再在「已完成任务」里',
    !store.getCategory('已完成任务').tasks.some(t => t.text === '写周报'));
  check('任务 completed === false',
    store.getCategory('工作').tasks.find(t => t.text === '写周报').completed === false);
  // v3.5.1：恢复后清掉 originalCategory —— 任务已回到「工作」里，再保留标记就是噪音
  check('恢复后 task.originalCategory === null',
    store.getCategory('工作').tasks.find(t => t.text === '写周报').originalCategory === null);
  check('恢复后 serialize 不含 [原分类：工作]',
    !store.serialize().includes('[原分类：工作]'));
}

// ============================================================
// [6] 取消勾选：原分类丢失 → restoreHint.kind === 'picker'
// ============================================================
console.log('\n[6] 取消勾选：原分类丢失（删除） → 弹窗提示');

{
  const store = makeStore(BASE_DOC);
  const workCat = store.getCategory('工作');
  const task = workCat.tasks.find(t => t.text === '写周报');
  store.toggleTask('工作', task.id);  // 勾选，记录原分类 = "工作"

  // 删除「工作」子分类 —— 模拟用户改了名或删了
  store.deleteCategory('工作');

  const result = store.toggleTask('已完成任务', task.id);  // 取消勾选

  check('原分类丢失时 restoreHint.kind === "picker"',
    result && result.restoreHint && result.restoreHint.kind === 'picker',
    `restoreHint=${JSON.stringify(result?.restoreHint)}`);
  check('restoreHint.missing === "工作"',
    result && result.restoreHint && result.restoreHint.missing === '工作',
    `missing=${result?.restoreHint?.missing}`);
  check('store.restoreCompletedTask 能把任务放到指定分类',
    store.restoreCompletedTask(task.id, '学习') &&
    store.getCategory('学习').tasks.some(t => t.text === '写周报'));
  // v3.5.1：picker 路径恢复后同样清掉 originalCategory
  check('picker 路径恢复后 task.originalCategory === null',
    store.getCategory('学习').tasks.find(t => t.text === '写周报').originalCategory === null);
  check('picker 路径恢复后 serialize 不含 [原分类：工作]',
    !store.serialize().includes('[原分类：工作]'));
}

// ============================================================
// [7] 取消勾选：没有 originalCategory → 直接去「未分类」
// ============================================================
console.log('\n[7] 取消勾选：没有 originalCategory 记录 → 直接去「未分类」');

{
  const store = makeStore(BASE_DOC);
  const workCat = store.getCategory('工作');
  const task = workCat.tasks.find(t => t.text === '写周报');

  // 手动设置：勾选但不记 originalCategory（模拟"很旧的文件"）
  store.toggleTask('工作', task.id);
  // 抹掉 originalCategory 模拟"旧版没有这个字段"
  const completedTask = store.getCategory('已完成任务').tasks[0];
  completedTask.originalCategory = null;

  const result = store.toggleTask('已完成任务', task.id);  // 取消勾选

  check('restoreHint.kind === "fallback"',
    result && result.restoreHint && result.restoreHint.kind === 'fallback',
    `restoreHint=${JSON.stringify(result?.restoreHint)}`);
  check('任务落到「未分类」',
    store.getCategory('未分类').tasks.some(t => t.text === '写周报'));
  check('restoreHint 不带 missing（不是 picker）',
    !result.restoreHint.missing);
}

// ============================================================
// [8] 拖入「已完成任务」分类 → 同样记录 originalCategory
// ============================================================
console.log('\n[8] 拖入「已完成任务」→ 同样记录 originalCategory');

{
  const store = makeStore(BASE_DOC);
  const workCat = store.getCategory('工作');
  const task = workCat.tasks.find(t => t.text === '写周报');

  // 通过 moveTask 拖入「已完成任务」（拖到 completed 分类，自动 completed=true）
  store.moveTask('工作', task.id, '已完成任务');

  const t = store.getCategory('已完成任务').tasks.find(x => x.text === '写周报');
  check('拖入后任务在「已完成任务」',
    !!t);
  check('拖入后 originalCategory === "工作"',
    t && t.originalCategory === '工作',
    `actual=${t?.originalCategory}`);
  check('拖入后 completed === true',
    t && t.completed === true);
}

// ============================================================
// [9] 旧文件升级迁移：散落的 [✓] 任务搬到「已完成」时记原分类
// ============================================================
console.log('\n[9] 旧文件升级迁移：散落的 [✓] 任务自动记原分类');

{
  // 模拟 v3.4 之前的旧文件：散落的 [✓] 任务在子分类里
  const OLD_DOC = `# 全部任务

## 工作

- [ ] 写周报
- [✓] 买牛奶

## 学习

- [✓] 看 Rust 入门

## 未分类

- [ ] 杂事
`;
  const store = makeStore(OLD_DOC);

  // 触发迁移（loadFromContent 已经跑过；这里再调一次确认幂等）
  // store._migrateCompletedTasksToCategory();

  const completed = store.getCategory('已完成任务');
  const workTask = completed.tasks.find(t => t.text === '买牛奶');
  const studyTask = completed.tasks.find(t => t.text === '看 Rust 入门');

  check('旧文件的 [✓] 任务都搬到了「已完成任务」',
    workTask && studyTask);
  check('「工作」来源的任务 originalCategory === "工作"',
    workTask && workTask.originalCategory === '工作',
    `actual=${workTask?.originalCategory}`);
  check('「学习」来源的任务 originalCategory === "学习"',
    studyTask && studyTask.originalCategory === '学习',
    `actual=${studyTask?.originalCategory}`);

  // 文件层验证：serialize 后能看到 [原分类：xxx]
  const md = store.serialize();
  check('serialize 后含 [原分类：工作]',
    md.includes('[原分类：工作]'));
  check('serialize 后含 [原分类：学习]',
    md.includes('[原分类：学习]'));
}

// ============================================================
// [10] batchToggleCompleted：批量取消勾选也走 _resolveRestoreTarget
// ============================================================
console.log('\n[10] 批量取消勾选：每条任务归到各自原分类');

{
  const store = makeStore(BASE_DOC);
  const workCat = store.getCategory('工作');
  const studyCat = store.getCategory('学习');
  const workTask = workCat.tasks.find(t => t.text === '写周报');
  const studyTask = studyCat.tasks.find(t => t.text === '看 Rust 入门');

  // 批量勾选
  store.batchToggleCompleted([
    { categoryName: '工作', taskId: workTask.id },
    { categoryName: '学习', taskId: studyTask.id }
  ], true);

  check('批量勾选后两条都在「已完成任务」',
    store.getCategory('已完成任务').tasks.length === 2);

  // 批量取消勾选
  const completed = store.getCategory('已完成任务');
  const t1 = completed.tasks.find(t => t.text === '写周报');
  const t2 = completed.tasks.find(t => t.text === '看 Rust 入门');
  store.batchToggleCompleted([
    { categoryName: '已完成任务', taskId: t1.id },
    { categoryName: '已完成任务', taskId: t2.id }
  ], false);

  check('「写周报」回到「工作」',
    store.getCategory('工作').tasks.some(t => t.text === '写周报'));
  check('「看 Rust 入门」回到「学习」',
    store.getCategory('学习').tasks.some(t => t.text === '看 Rust 入门'));
  // v3.5.1：批量恢复后也清掉 originalCategory
  check('批量恢复后「写周报」originalCategory === null',
    store.getCategory('工作').tasks.find(t => t.text === '写周报').originalCategory === null);
  check('批量恢复后「看 Rust 入门」originalCategory === null',
    store.getCategory('学习').tasks.find(t => t.text === '看 Rust 入门').originalCategory === null);
  check('批量恢复后 serialize 不含 [原分类：xxx]',
    !store.serialize().match(/\[原分类：/));
}

// ============================================================
// [11] parseImportLine：导入对话框也支持 [原分类：xxx]
// ============================================================
console.log('\n[11] parseImportLine 支持 [原分类：xxx]');

{
  const r1 = parseImportLine('- [ ] 看牙医 [原分类：生活]');
  check('parseImportLine 把 [原分类：xxx] 抽到 originalCategory',
    r1 && r1.originalCategory === '生活' && r1.text === '看牙医',
    `originalCategory=${r1?.originalCategory}, text=${r1?.text}`);
}

// ============================================================
// [12] CategoryKind.COMPLETED 不会被误认为恢复目标
// ============================================================
console.log('\n[12] kind=COMPLETED 的分类不能作为恢复目标');

{
  const store = makeStore(BASE_DOC);
  // 手动注入一个恶意分类（虽然实际不会发生，但要防御）
  store.categories.push({
    name: '陷阱',
    kind: CategoryKind.COMPLETED,  // 故意是 COMPLETED
    isSpecial: true,
    parentOtherTasks: false,
    tasks: []
  });

  const workCat = store.getCategory('工作');
  const task = workCat.tasks.find(t => t.text === '写周报');
  store.toggleTask('工作', task.id);

  // 把"工作"删了，但有个 kind=COMPLETED 的同名陷阱分类
  store.deleteCategory('工作');
  // 改名为「工作」（让它跟 originalCategory 同名）
  const trap = store.categories.find(c => c.name === '陷阱');
  trap.name = '工作';

  const result = store.toggleTask('已完成任务', task.id);
  // 应该返回 picker，因为同名"工作"分类是 COMPLETED 类型，不能作为恢复目标
  check('kind=COMPLETED 的同名分类不作为恢复目标',
    result && result.restoreHint && result.restoreHint.kind === 'picker',
    `restoreHint=${JSON.stringify(result?.restoreHint)}`);
}

// ============================================================
// [13] v3.5.1+：原分类标记仅在「已完成 / 回收站」分类里输出（writer 护栏）
// ============================================================
console.log('\n[13] writer 护栏：原分类标记仅在 COMPLETED/TRASH 输出');

{
  const store = makeStore(BASE_DOC);
  const workCat = store.getCategory('工作');
  const studyCat = store.getCategory('学习');
  const workTask = workCat.tasks.find(t => t.text === '写周报');
  const studyTask = studyCat.tasks.find(t => t.text === '看 Rust 入门');

  // 1. 勾选一条 → 进入已完成 → 出现 [原分类：工作]
  store.toggleTask('工作', workTask.id);
  // 2. 把另一条拖到已完成 → 同样记录
  store.moveTask('学习', studyTask.id, '已完成任务');

  const md = store.serialize();
  // 文件里 [原分类：工作] 出现在「已完成任务」段 ✓
  const completedSection = md.split('# 已完成任务')[1] || '';
  check('writer 在「已完成任务」段写出 [原分类：工作]',
    completedSection.includes('[原分类：工作]'));
  check('writer 在「已完成任务」段写出 [原分类：学习]',
    completedSection.includes('[原分类：学习]'));

  // 3. 通过 moveTask 把已完成任务拖回普通子分类 → originalCategory 清掉
  const completedTask = store.getCategory('已完成任务').tasks[0];
  store.moveTask('已完成任务', completedTask.id, '生活');

  // 4. 验证「生活」段不出现 [原分类：xxx]
  const lifeSection = md.split('# 生活')[1]?.split('\n')[0]; // 旧 md 无生活内容
  // 重新 serialize（因为 moveTask 后 md 应该变了）
  const mdAfter = store.serialize();
  // 「生活」分类下不该出现 [原分类：xxx]
  const lifeIndex = mdAfter.indexOf('## 生活');
  const uncategorizedIndex = mdAfter.indexOf('## 未分类');
  const lifeSectionNew = mdAfter.slice(lifeIndex, uncategorizedIndex > 0 ? uncategorizedIndex : undefined);
  check('moveTask 把已完成任务拖回普通子分类后，那条任务没 [原分类：xxx]',
    !lifeSectionNew.includes('[原分类：'),
    `life section: ${lifeSectionNew.slice(0, 200)}`);
}

// ============================================================
// [14] moveTask 跨普通子分类：原始 originalCategory 保持（防御性无侵入）
// ============================================================
console.log('\n[14] moveTask 普通子分类之间互拖 → originalCategory 不受影响');

{
  const store = makeStore(BASE_DOC);
  const workCat = store.getCategory('工作');
  const task = workCat.tasks.find(t => t.text === '写周报');
  // 故意设 originalCategory（外部编辑 / 解析器的产物）
  task.originalCategory = '工作';
  // 从「工作」拖到「学习」
  store.moveTask('工作', task.id, '学习');

  const moved = store.getCategory('学习').tasks.find(t => t.text === '写周报');
  // v3.5.1 进入 NORMAL 路径会清掉 originalCategory（即便它本来就被外部设了）
  check('普通子分类之间 moveTask 后 originalCategory === null',
    moved && moved.originalCategory === null,
    `actual=${moved?.originalCategory}`);
}

// ============================================================
// [15] restoreTask：从回收站恢复到普通子分类 → 清 originalCategory（防御）
// ============================================================
console.log('\n[15] restoreTask 回收站 → 普通子分类 → 清 originalCategory');

{
  const store = makeStore(BASE_DOC);
  const workCat = store.getCategory('工作');
  const task = workCat.tasks.find(t => t.text === '写周报');
  // 勾选 → 进已完成（带 originalCategory）→ 删 → 进回收站（保留状态）
  store.toggleTask('工作', task.id);
  store.deleteTask('已完成任务', task.id);

  const trashed = store.getCategory('回收站').tasks[0];
  // 模拟"防御性原始数据"：外部编辑设了 originalCategory（即使 completed=true 在 trash 里也罕见）
  // 这里直接用 deleteTask 后的状态：task.completed=true 且 task.originalCategory='工作'
  check('删除已完成任务后，回收站里 originalCategory 仍在',
    trashed && trashed.originalCategory === '工作' && trashed.completed === true);

  // 恢复到「学习」子分类
  const ok = store.restoreTask(trashed.id, '学习');
  // restoreTask 看到 taskSnapshot.completed=true 会重投到「已完成任务」—— 不进 NORMAL 路径
  // 这条路径下 originalCategory 应该保留
  const finalTask = store.getCategory('学习').tasks.find(t => t.text === '写周报')
    || store.getCategory('已完成任务').tasks.find(t => t.text === '写周报');
  if (ok && finalTask) {
    const inCompleted = store.getCategory('已完成任务').tasks.some(t => t.text === '写周报');
    if (inCompleted) {
      check('completed 任务从回收站恢复后重投「已完成」→ originalCategory 保留',
        finalTask.originalCategory === '工作',
        `actual=${finalTask.originalCategory}`);
    } else {
      check('非 completed 任务从回收站恢复到普通分类 → originalCategory === null',
        finalTask.originalCategory === null,
        `actual=${finalTask.originalCategory}`);
    }
  }
}

// ============================================================
// [16] writer 防御性：即便普通子分类任务的 originalCategory 被外部塞了，写出也不带标记
// ============================================================
console.log('\n[16] writer 防御性护栏：普通子分类不写 [原分类：xxx]');

{
  // 模拟外部手工编辑：把 [原分类：xxx] 强行写到普通子分类任务里
  const DIRTY_DOC = `# 全部任务

## 工作

- [ ] [原分类：生活] 写周报

## 学习

- [ ] 看 Rust 入门
`;
  const store = makeStore(DIRTY_DOC);
  const md = store.serialize();
  // 普通子分类下不应该出现 [原分类：xxx]（writer 护栏）
  const workSection = md.split('## 工作')[1]?.split('##')[0] || '';
  check('writer 护栏：普通子分类不输出 [原分类：xxx]',
    !workSection.includes('[原分类：'),
    `work section: ${workSection.slice(0, 200)}`);
}

// ============================================================
// [17] 回收站里仍可看到 [原分类：xxx]（用户要求：回收站也是特殊分类，原分类有信息价值）
// ============================================================
console.log('\n[17] 回收站里保留 [原分类：xxx]');

{
  const store = makeStore(BASE_DOC);
  const workCat = store.getCategory('工作');
  const task = workCat.tasks.find(t => t.text === '写周报');
  // 勾选 → 已完成 → 删 → 回收站
  store.toggleTask('工作', task.id);
  store.deleteTask('已完成任务', task.id);

  const md = store.serialize();
  const trashSection = md.split('# 回收站')[1] || '';
  check('回收站段保留 [原分类：工作]',
    trashSection.includes('[原分类：工作]'),
    `trash section: ${trashSection.slice(0, 200)}`);
}

// ============================================================
// [18] v3.5.2+：回收站学「已完成任务」的 [原分类：] 语义 + 默认归位
//
// 行为契约：
//   1) deleteTask 从普通子分类搬到 trash → 自动写 originalCategory
//   2) writer 在「# 回收站」段同步写出 [原分类：xxx]
//   3) restoreTask 默认（无 toCategoryName）命中原分类 → 直接归位
//   4) restoreTask 默认 原分类丢失 → 返回 picker hint，任务**仍留在 trash**
//   5) picker 路径后续 restoreTask(taskId, picked) 完成归位 + 清掉 originalCategory
//   6) batchDeleteTasks 也写 originalCategory（与单条 deleteTask 对称）
//   7) 已完成任务从「已完成任务」删到 trash，原分类不被覆盖（沿用 toggle 时记下的）
// ============================================================
console.log('\n[18] 回收站学「已完成任务」的 [原分类：] + 默认归位');

{
  // 18.1) 普通子分类删除 → 回收站里 originalCategory 已被记下
  const store = makeStore(BASE_DOC);
  const workCat = store.getCategory('工作');
  const task = workCat.tasks.find(t => t.text === '写周报');
  store.deleteTask('工作', task.id);

  const trashed = store.getTrashCategory().tasks[0];
  check('普通子分类删除后回收站里 originalCategory === "工作"',
    trashed && trashed.originalCategory === '工作',
    `actual=${trashed?.originalCategory}`);

  // 18.2) writer 在「# 回收站」段输出 [原分类：工作]
  const md = store.serialize();
  const trashSection = md.split('# 回收站')[1] || '';
  check('writer 在「# 回收站」段写出 [原分类：工作]（trash 端到端链路打通）',
    trashSection.includes('[原分类：工作]'),
    `trash section: ${trashSection.slice(0, 200)}`);

  // 18.3) 默认 restoreTask 走 category 分支：归到「工作」
  const result = store.restoreTask(task.id);
  check('默认 restoreTask 返回 { ok: true, restored: true }',
    result.ok === true && result.restored === true,
    `result=${JSON.stringify(result)}`);
  check('restoreHint.kind === "category" + 带 targetName="工作"',
    result.restoreHint && result.restoreHint.kind === 'category' &&
      result.restoreHint.targetName === '工作',
    `restoreHint=${JSON.stringify(result.restoreHint)}`);
  check('任务归到原分类「工作」',
    store.getCategory('工作').tasks.some(t => t.text === '写周报'),
    `work tasks: ${store.getCategory('工作').tasks.map(t => t.text)}`);
  check('回收站空',
    store.getTrashCategory().tasks.length === 0);
}

{
  // 18.4) 原分类丢失 → picker hint，任务仍留在 trash
  const store = makeStore(BASE_DOC);
  const workCat = store.getCategory('工作');
  const task = workCat.tasks.find(t => t.text === '写周报');
  store.deleteTask('工作', task.id);   // record originalCategory='工作'
  store.deleteCategory('工作');        // 原分类丢失

  // 此时任务在 trash，originalCategory='工作' 但 '工作' 已不存在
  const result = store.restoreTask(task.id);
  check('原分类丢失时 restoreTask 返回 picker hint',
    result && result.restoreHint && result.restoreHint.kind === 'picker',
    `result=${JSON.stringify(result)}`);
  check('picker hint.missing === "工作"',
    result.restoreHint && result.restoreHint.missing === '工作',
    `missing=${result.restoreHint?.missing}`);
  check('picker 路径下任务**仍留在 trash**（不动任务）',
    store.getTrashCategory().tasks.length === 1 &&
    store.getTrashCategory().tasks[0].text === '写周报',
    `trash: ${store.getTrashCategory().tasks.map(t => t.text)}`);

  // 18.5) picker 选定后调 restoreTask(taskId, picked) 完成移动 + 清 originalCategory
  const r2 = store.restoreTask(task.id, '学习');
  check('picker 后续 restoreTask(id, "学习") 完成归位',
    r2.ok === true && r2.restored === true &&
      store.getCategory('学习').tasks.some(t => t.text === '写周报'),
    `r2=${JSON.stringify(r2)}, study=${store.getCategory('学习').tasks.map(t => t.text)}`);
  const moved = store.getCategory('学习').tasks.find(t => t.text === '写周报');
  check('picker 路径恢复后 task.originalCategory === null（已"回家"）',
    moved && moved.originalCategory === null,
    `actual=${moved?.originalCategory}`);
}

{
  // 18.6) batchDeleteTasks 也写 originalCategory
  const store = makeStore(BASE_DOC);
  const workCat = store.getCategory('工作');
  const studyCat = store.getCategory('学习');
  const t1 = workCat.tasks.find(t => t.text === '写周报');
  const t2 = studyCat.tasks.find(t => t.text === '看 Rust 入门');
  store.batchDeleteTasks([
    { categoryName: '工作', taskId: t1.id },
    { categoryName: '学习', taskId: t2.id }
  ]);
  const trash = store.getTrashCategory().tasks;
  check('batchDeleteTasks 后回收站里两条任务都带 originalCategory',
    trash.length === 2 &&
    trash.some(t => t.text === '写周报' && t.originalCategory === '工作') &&
    trash.some(t => t.text === '看 Rust 入门' && t.originalCategory === '学习'),
    `trash: ${trash.map(t => `${t.text}(${t.originalCategory})`).join(', ')}`);
}

{
  // 18.7) 已完成任务删到 trash，originalCategory 不被覆盖
  const store = makeStore(BASE_DOC);
  const studyCat = store.getCategory('学习');
  const task = studyCat.tasks.find(t => t.text === '看 Rust 入门');
  // 勾选 → toggleTask 写 originalCategory='学习'
  store.toggleTask('学习', task.id);
  check('toggleTask 已写 originalCategory === "学习"（前置）',
    store.getCategory('已完成任务').tasks[0].originalCategory === '学习');

  // 删 → 进入 trash，originalCategory 应保持 '学习'（不被 deleteTask 覆盖）
  store.deleteTask('已完成任务', task.id);
  const trashed = store.getTrashCategory().tasks[0];
  check('completed 任务从「已完成任务」删到 trash → originalCategory 仍为"学习"（不重写）',
    trashed && trashed.originalCategory === '学习' && trashed.completed === true,
    `actual=${trashed?.originalCategory}, completed=${trashed?.completed}`);
}

console.log(`\n结果：通过 ${summary.pass} / 失败 ${summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
