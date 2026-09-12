// 回归测试：H6 — picker 路径尝试次数上限 + 降级为 fallback
//
// 背景：toggleTask 在「原分类丢失 → picker 分支」时返回 restoreHint，UI 弹
// 选择器让用户选目标分类。但如果用户反复 toggle 同一任务（原分类持续丢
// 失 / 用户反复取消 picker），picker 会被反复触发，可能进入死循环或内存
// 累积。修复：store 内部记 _pickerAttempts[taskId]，超过 _PICKER_ATTEMPT_LIMIT
// 后强制降级为 fallback（落「未分类」），避免 picker 风暴。
//
// 跑法：node scripts/check-picker-timeout.mjs

import { check, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';

const BASE_DOC = `# 全部任务

## 工作

- [ ] 写周报

## 学习

- [ ] 看 Rust 入门

## 未分类

`;

// ── [1] 第一次 picker 命中 ──
console.log('\n[1] 首次 picker：原分类丢失 → restoreHint.kind === "picker"');

{
  const store = makeStore(BASE_DOC);
  const workCat = store.getCategory('工作');
  const task = workCat.tasks.find(t => t.text === '写周报');
  store.toggleTask('工作', task.id);  // 勾选 → 进「已完成任务」

  // 删除「工作」→ 让原分类丢失
  store.deleteCategory('工作');

  const r = store.toggleTask('已完成任务', task.id);
  check('首次 picker 路径返回 restoreHint.kind === "picker"',
    r && r.restoreHint && r.restoreHint.kind === 'picker',
    `restoreHint=${JSON.stringify(r?.restoreHint)}`);
  check('picker 带 missing = "工作"',
    r && r.restoreHint && r.restoreHint.missing === '工作');
}

// ── [2] 同一任务反复 toggle（picker 不收敛）→ 降级为 fallback ──
console.log('\n[2] picker 不收敛时降级为 fallback');

{
  const store = makeStore(BASE_DOC);
  const workCat = store.getCategory('工作');
  const task = workCat.tasks.find(t => t.text === '写周报');

  // 让任务进入「已完成任务」，再删工作 → 进入 picker 路径
  store.toggleTask('工作', task.id);
  store.deleteCategory('工作');

  // 反复 toggle 同一任务（picker 不收敛 —— 用户反复取消选择对话框）
  // 记录每次的 restoreHint，直到出现 fallback（不要用「最后一次」——
  // fallback 触发后任务已搬到「未分类」，后续 toggleTask 返回值可能不再带 restoreHint）
  let fallbackResult = null;
  const hintTrace = [];
  for (let i = 0; i < 6 && !fallbackResult; i++) {
    const r = store.toggleTask('已完成任务', task.id);
    hintTrace.push(r?.restoreHint?.kind || 'no-result');
    if (r?.restoreHint?.kind === 'fallback') fallbackResult = r;
  }

  // 断言：循环内出现了至少一次 fallback
  check('循环内出现 fallback（picker 降级）',
    fallbackResult !== null,
    `hint trace: ${hintTrace.join(' → ')}`);
  check('fallback restoreHint 带 forceDowngrade=true',
    fallbackResult && fallbackResult.restoreHint && fallbackResult.restoreHint.forceDowngrade === true,
    `restoreHint=${JSON.stringify(fallbackResult?.restoreHint)}`);
  // 兜底：任务应落到「未分类」
  check('降级后任务落到「未分类」',
    store.getCategory('未分类').tasks.some(t => t.text === '写周报'));
}

// ── [3] 不同任务互不干扰 ──
console.log('\n[3] 不同任务的 picker 计数独立');

{
  const store = makeStore(BASE_DOC);
  const workCat = store.getCategory('工作');
  const studyCat = store.getCategory('学习');
  const t1 = workCat.tasks.find(t => t.text === '写周报');
  const t2 = studyCat.tasks.find(t => t.text === '看 Rust 入门');

  // 两条都 toggle 进「已完成任务」
  store.toggleTask('工作', t1.id);
  store.toggleTask('学习', t2.id);

  // 删「工作」让 t1 走 picker
  store.deleteCategory('工作');
  store.toggleTask('已完成任务', t1.id);  // 1 次 picker
  store.toggleTask('已完成任务', t1.id);  // 2 次 picker（picker 不动任务）
  store.toggleTask('已完成任务', t1.id);  // 3 次 picker

  // t2 此时 picker 计数应独立（仍是 0）
  const r2 = store.toggleTask('已完成任务', t2.id);
  // t2 的原分类「学习」还在 → 走 category 分支（不是 picker）
  check('独立任务互不干扰 —— t2 走 category 分支',
    r2 && r2.restoreHint && r2.restoreHint.kind === 'category',
    `r2.restoreHint=${JSON.stringify(r2?.restoreHint)}`);
}

printSummary('check-picker-timeout');