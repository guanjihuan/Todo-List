// 回归测试：不变量 ——「[✓] 只能出现在 # 已完成任务 或 # 回收站」
//
// 用户规则（v3.4+）：勾选状态 [✓] 是「已完成任务」分类的指纹，回收站允许保留
// 完成态（用户删除已完成任务时不丢失勾选状态），其他任何分类 / 顶部镜像段都不
// 允许写 [✓]。
//
// 关键路径：
//   - 顶部镜像段（# 当前任务 / # 重要任务）：不允许出现 [✓]
//   - 全部任务容器及 ## 子分类：不允许出现 [✓]
//   - # 已完成任务 / # 回收站：是 [✓] 的合法落点
//
// 校验策略：
//   1. 解析 data/todo.example.md —— 例行文件必须已满足不变量
//   2. 模拟用户手敲 [✓] 到 ## 工作 / ## 未分类 / ## 学习 —— store.loadFromContent
//      必须把任务搬到 # 已完成任务，serialize 出来 [✓] 不出现在错误位置
//   3. 通过 store 内部 toggleTask / batchToggle / addTask 等修改 → serialize →
//      不变量必须仍然保持
//   4. 直接调 writeMarkdown 给出"干净"状态（post-migration）—— 不变量必须仍然成立
//
// 跑法：node scripts/check-completed-only.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskStore, COMPLETED_NAME, TRASH_NAME } from '../src/task-store.js';
import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';
import { parseMarkdown, CategoryKind } from '../src/markdown-parser.js';
import { writeMarkdown } from '../src/markdown-writer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 扫描 Markdown 文本，列出每一行 [✓]/[x]/[X] 出现的「章节归属」。
 * 顶部摘要段（# 当前任务 / # 重要任务）以及 # 已完成任务 / # 回收站
 * 之外的任何节都被记作 forbidden。
 */
function locateCompletedMarkers(md) {
  const findings = [];
  const lines = md.split('\n');
  // 栈：跟踪当前位置；h1 段里 h2 算子分类（只在 # 全部任务 容器下）
  let currentH1 = null;
  let currentH2 = null;
  for (const line of lines) {
    const h1Match = line.match(/^#\s+(.+?)\s*$/);
    const h2Match = line.match(/^##\s+(.+?)\s*$/);
    if (h1Match) {
      currentH1 = h1Match[1].trim();
      currentH2 = null;
    } else if (h2Match) {
      currentH2 = h2Match[1].trim();
    }
    const m = line.match(/^(\s*)-\s+\[(✓|x|X)\]/);
    if (m) {
      const marker = m[2];
      const inCompleted = currentH1 === COMPLETED_NAME;
      const inTrash = currentH1 === TRASH_NAME;
      // 顶部摘要段：h1 是「当前任务」或「重要任务」，没有 h2
      const inFrontMatter = currentH1 === '当前任务' || currentH1 === '重要任务';
      // 子分类（h2 在某个 h1 下）：含 # 全部任务 下的 ## 工作 / ## 未分类 等
      const inSubcategory = currentH2 !== null;
      // 「全部任务」容器本身：h1 但 h2 还没出来，下面的任务就是孤儿（应被迁移）
      const inOtherTasksContainer = currentH1 === '全部任务' && !currentH2;
      const forbidden = !(inCompleted || inTrash);
      const section = currentH2
        ? `${currentH1} > ${currentH2}`
        : currentH1;
      findings.push({
        marker,
        section,
        inFrontMatter,
        inSubcategory,
        inOtherTasksContainer,
        inCompleted,
        inTrash,
        forbidden
      });
    }
  }
  return findings;
}

console.log('\n[1] data/todo.example.md 必须满足不变量');

const examplePath = path.resolve(__dirname, '..', 'data', 'todo.example.md');
const exampleMd = fs.readFileSync(examplePath, 'utf8');
const exampleFindings = locateCompletedMarkers(exampleMd);
const exampleForbidden = exampleFindings.filter(f => f.forbidden);
check('example 文件里没有 forbidden 的 [✓]/[x]/[X]',
  exampleForbidden.length === 0,
  exampleForbidden.map(f => `[${f.marker}] in ${f.section}`).join(' / ') || '0 处违规');
check('example 文件至少有一条 [✓] 在 # 已完成任务（确保规则真在执行）',
  exampleFindings.some(f => f.inCompleted),
  exampleFindings.filter(f => f.inCompleted).map(f => `[${f.marker}] in ${f.section}`).join(' / '));

console.log('\n[2] 外部手敲 [✓] 到 ## 工作 / ## 学习 / ## 未分类 —— store.loadFromContent 必须迁移');

const MISPLACED = [
  '# 全部任务', '',
  '## 工作', '',
  '- [ ] 工作A', '',
  '- [✓] 工作B (用户手敲)', '',
  '## 学习', '',
  '- [✓] 学习C (用户手敲)', '',
  '## 未分类', '',
  '- [✓] 未分类D (用户手敲)', '',
  '# 已完成任务', '',
  '- [✓] 之前提交的', '',
  '# 回收站', '',
  '- [ ] 之前删的', ''
].join('\n');

const misplacedStore = makeStore(MISPLACED);
const misplacedSer = misplacedStore.serialize();
const misplacedFindings = locateCompletedMarkers(misplacedSer);
const misplacedForbidden = misplacedFindings.filter(f => f.forbidden);
check('外部手敲 [✓] 到 ## 子分类后，serialize 出来没有 forbidden 的 [✓]',
  misplacedForbidden.length === 0,
  misplacedForbidden.map(f => `[${f.marker}] in ${f.section}`).join(' / '));
// 迁移必须真的发生过：原本 4 条 completed 任务都得落到 # 已完成任务
check('迁移后 # 已完成任务 收齐所有 4 条 [✓] 任务',
  misplacedStore.categories
    .find(c => c.kind === CategoryKind.COMPLETED).tasks.length === 4,
  `实际 ${misplacedStore.categories.find(c => c.kind === CategoryKind.COMPLETED).tasks.length} 条`);

console.log('\n[3] 顶部镜像段（# 当前任务 / # 重要任务）不允许出现 [✓]');

// 真实生产状态下，completed=true 的任务会被 store 自动搬进 kind=COMPLETED，
// 而 collectCurrentTasks / collectImportantTasks 已经显式跳过 COMPLETED，
// 所以镜像段里绝无可能出现 [✓]。这里用 store.toggleTask 走完整链路验证。
const MIRROR_DOC = [
  '# 全部任务', '',
  '## 工作', '',
  '- [ ] 当前任务1', '',
  '- [ ] 重要任务1', '',
  '- [ ] 普通任务1', ''
].join('\n');
const mirrorStore = makeStore(MIRROR_DOC);
const workCatName = mirrorStore.categories
  .find(c => c.kind === CategoryKind.NORMAL).name;
const taskCurrent = mirrorStore.categories
  .find(c => c.kind === CategoryKind.NORMAL).tasks[0];
const taskImportant = mirrorStore.categories
  .find(c => c.kind === CategoryKind.NORMAL).tasks[1];
mirrorStore.updateTaskMeta(workCatName, taskCurrent.id, { current: true });
mirrorStore.updateTaskMeta(workCatName, taskImportant.id, { important: true });
// 现在勾选这两个任务 —— toggleTask 会把它们搬到 # 已完成任务
mirrorStore.toggleTask(workCatName, taskCurrent.id);
mirrorStore.toggleTask(workCatName, taskImportant.id);
const mirrorSer = mirrorStore.serialize();
const mirrorFindings = locateCompletedMarkers(mirrorSer);
const mirrorBugs = mirrorFindings.filter(f => f.inFrontMatter);
check('勾选当前/重要任务后，# 当前任务 / # 重要任务 镜像段不含 [✓]',
  mirrorBugs.length === 0,
  mirrorBugs.map(f => `[${f.marker}] in ${f.section}`).join(' / '));

console.log('\n[4] 干净状态下 writeMarkdown 输出仍然满足不变量');

// 模拟 post-migration 的状态：所有 completed=true 的任务都在 COMPLETED/TRASH 里。
// 不变量必须由 writer 在「干净输入」下自然成立 —— 这是 [✓] 不漏出去的最终防线。
const cleanCats = [
  { name: '全部任务', kind: CategoryKind.OTHER_TASKS, parentOtherTasks: false, tasks: [] },
  { name: '工作', kind: CategoryKind.NORMAL, parentOtherTasks: true, tasks: [
    { text: '写周报', completed: false, important: false, current: false }
  ]},
  { name: '未分类', kind: CategoryKind.NORMAL, parentOtherTasks: true, tasks: [
    { text: '看牙医', completed: false, important: false, current: false }
  ]},
  { name: '已完成任务', kind: CategoryKind.COMPLETED, parentOtherTasks: false, tasks: [
    { text: '提交过的工作', completed: true, important: false, current: false }
  ]},
  { name: '回收站', kind: CategoryKind.TRASH, parentOtherTasks: false, tasks: [
    { text: '之前删的', completed: false, important: false, current: false },
    { text: '已删且已完成的', completed: true, important: false, current: false }
  ]}
];
const cleanMd = writeMarkdown(cleanCats);
const cleanFindings = locateCompletedMarkers(cleanMd);
const cleanForbidden = cleanFindings.filter(f => f.forbidden);
check('writer 在干净状态下输出没有 forbidden 的 [✓]',
  cleanForbidden.length === 0,
  cleanForbidden.map(f => `[${f.marker}] in ${f.section}`).join(' / '));

console.log('\n[5] 顶部镜像段收集器排除 kind=COMPLETED');

const TOP_MIRROR_DOC = [
  '# 全部任务', '',
  '## 工作', '',
  '- [ ] 普通任务', '',
  '- [ ] 既当前又重要的任务', ''
].join('\n');
const topStore = makeStore(TOP_MIRROR_DOC);
const topWorkName = topStore.categories
  .find(c => c.kind === CategoryKind.NORMAL).name;
const topNormal = topStore.categories
  .find(c => c.kind === CategoryKind.NORMAL).tasks;
topStore.updateTaskMeta(topWorkName, topNormal[1].id, { current: true, important: true });
topStore.toggleTask(topWorkName, topNormal[1].id);
// 此时这条任务已搬到 # 已完成任务（kind=COMPLETED）
const topSer = topStore.serialize();
const topFindings = locateCompletedMarkers(topSer);
const topMirrorBugs = topFindings.filter(f => f.inFrontMatter);
check('勾选「既当前又重要」的任务后，# 当前任务 / # 重要任务 镜像段不含 [✓]',
  topMirrorBugs.length === 0,
  topMirrorBugs.map(f => `[${f.marker}] in ${f.section}`).join(' / '));
const topCompletedCount = topFindings.filter(f => f.inCompleted).length;
check('勾选后那条任务仅出现在 # 已完成任务 一次',
  topCompletedCount === 1,
  `实际 ${topCompletedCount} 次`);

console.log('\n[6] parser → 内部迁移 → writer 全链路');

// 把外部手敲的 [✓] 在 ## 工作 / ## 未分类 下的内容喂进 parser，模拟真实「打开文件」场景
const externalMd = [
  '# 全部任务', '',
  '## 工作', '',
  '- [✓] 完成的设计稿', '',
  '## 未分类', '',
  '- [✓] 买的书', '',
  '# 已完成任务', '',
  '- [✓] 之前提交的', '',
  '# 回收站', '',
  '- [ ] 之前删的', ''
].join('\n');
const externalParsed = parseMarkdown(externalMd);
// 模拟 _migrateCompletedTasksToCategory
const completedCat = externalParsed.find(c => c.kind === CategoryKind.COMPLETED);
if (completedCat) {
  for (const cat of externalParsed) {
    if (cat === completedCat) continue;
    if (cat.kind === CategoryKind.TRASH) continue;
    if (cat.kind === CategoryKind.OTHER_TASKS) continue;
    const moving = cat.tasks.filter(t => t.completed);
    const keep = cat.tasks.filter(t => !t.completed);
    cat.tasks = keep;
    for (const t of moving) {
      if (cat.parentOtherTasks && !t.originalCategory) {
        t.originalCategory = cat.name;
      }
    }
    completedCat.tasks.push(...moving);
  }
}
const externalOut = writeMarkdown(externalParsed);
const externalFindings = locateCompletedMarkers(externalOut);
const externalForbidden = externalFindings.filter(f => f.forbidden);
check('外部 [✓] 经 parser + 迁移 + writer 后无 forbidden',
  externalForbidden.length === 0,
  externalForbidden.map(f => `[${f.marker}] in ${f.section}`).join(' / '));

console.log(`\n结果：通过 ${summary.pass} / 失败 ${summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
