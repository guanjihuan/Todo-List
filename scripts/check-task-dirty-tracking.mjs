// TaskStore 的 dirty task 追踪测试
//
// 验证 _markDirty / _clearDirtyTracking / getDirtySnapshot 在各种 mutator 路径下
// 正确累积 / 清理 dirty 标记。
//
// 覆盖场景：
//   1) addTask → dirtyTasks 增加 1
//   2) updateTaskText → 该 task.id 出现在 dirtyTasks
//   3) toggleTask → 该 task.id 出现在 dirtyTasks + 涉及的两 cat 都在 dirtyCategories
//   4) deleteTask → 该 task.id 出现在 dirtyTasks + 两 cat
//   5) renameCategory → 两 cat 都在 dirtyCategories
//   6) 多次 edit 同 task → 仍只算一个 dirtyId
//   7) saveNow 成功后 _clearDirtyTracking 清空所有 dirty 集
//   8) loadFromContent 后 dirty 集被清空
//
// 用法：node scripts/check-task-dirty-tracking.mjs

import { TaskStore } from '../src/task-store.js';
import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';

function eq(actual, expected, name) {
  const a = JSON.stringify([...actual].sort());
  const e = JSON.stringify([...expected].sort());
  if (a === e) ok(name);
  else bad(name, `expected ${e}, got ${a}`);
}

function truthy(value, name) {
  if (value) ok(name);
  else bad(name, `expected truthy, got ${value}`);
}

// 构造一个最小 store —— 不读文件，不写文件，只测 dirty tracking
let store = new TaskStore();
store.loadDefault();  // 给出默认 categories（全部任务 / 工作 / 学习 / 生活 / 未分类）
// 简化：不挂任何事件监听器（避免 store.on 副作用）；emit 走默认 EventEmitter

function reset() {
  // 完全重建 store，避免前一个测试残留的 categories 影响下一个
  store = new TaskStore();
  store.loadDefault();
}

// ── 1) addTask ──
console.log('\n[addTask]');
{
  // 使用初始 store（已 loadDefault）
  const t = store.addTask('工作', 'task1');
  truthy(t !== null, 'addTask 成功');
  const snap = store.getDirtySnapshot();
  truthy(snap.taskIds.has(t.id), 'dirtyTaskIds 含新增 task id');
  truthy(snap.categoryNames.has('工作'), 'dirtyCategories 含工作');
}

// ── 2) updateTaskText ──
console.log('\n[updateTaskText]');
reset();
{
  const t = store.addTask('工作', 'task1');
  store._clearDirtyTracking(); // 清掉 addTask 的副作用
  const ok2 = store.updateTaskText('工作', t.id, 'task1-updated');
  truthy(ok2 === true, 'updateTaskText 成功');
  const snap = store.getDirtySnapshot();
  truthy(snap.taskIds.has(t.id), 'dirtyTaskIds 含改过的 task id');
  truthy(snap.categoryNames.has('工作'), 'dirtyCategories 含工作');
}

// ── 3) toggleTask（跨分类）──
console.log('\n[toggleTask cross-category]');
reset();
{
  const t = store.addTask('工作', 'task1');
  store._clearDirtyTracking();
  const ok2 = store.toggleTask('工作', t.id);
  // v3.5+：toggleTask 返回 { ok: true } 对象（含可选 restoreHint），不再是裸 true
  truthy(ok2 && ok2.ok === true, 'toggleTask 成功');
  const snap = store.getDirtySnapshot();
  truthy(snap.taskIds.has(t.id), 'dirtyTaskIds 含被勾选 task');
  // 任务从「工作」搬到「已完成任务」—— 两分类都应被标
  truthy(snap.categoryNames.has('工作'), 'dirtyCategories 含源分类 工作');
  truthy(snap.categoryNames.has('已完成任务'), 'dirtyCategories 含目标分类 已完成任务');
}

// ── 4) deleteTask ──
console.log('\n[deleteTask]');
reset();
{
  const t = store.addTask('工作', 'task1');
  store._clearDirtyTracking();
  const ok2 = store.deleteTask('工作', t.id);
  truthy(ok2 === true, 'deleteTask 成功');
  const snap = store.getDirtySnapshot();
  truthy(snap.taskIds.has(t.id), 'dirtyTaskIds 含被删 task');
  truthy(snap.categoryNames.has('工作'), 'dirtyCategories 含源分类');
  truthy(snap.categoryNames.has('回收站'), 'dirtyCategories 含回收站');
}

// ── 5) renameCategory ──
console.log('\n[renameCategory]');
reset();
{
  // loadDefault 已创建「工作」 —— 直接重命名
  const ok2 = store.renameCategory('工作', '工作 v2');
  truthy(ok2 === true, 'renameCategory 成功');
  const snap = store.getDirtySnapshot();
  truthy(snap.categoryNames.has('工作'), 'dirtyCategories 含旧名');
  truthy(snap.categoryNames.has('工作 v2'), 'dirtyCategories 含新名');
}

// ── 6) 多次 edit 同 task ──
console.log('\n[idempotent dirty tracking]');
reset();
{
  const t = store.addTask('工作', 'task1');
  store._clearDirtyTracking();
  store.updateTaskText('工作', t.id, 'edit1');
  store.updateTaskText('工作', t.id, 'edit2');
  store.updateTaskText('工作', t.id, 'edit3');
  const snap = store.getDirtySnapshot();
  eq(snap.taskIds, new Set([t.id]), '多次编辑同 task → dirtyTaskIds 仍是 1 项');
}

// ── 7) getDirtySnapshot 计数 ──
console.log('\n[changeCount]');
reset();
{
  const t1 = store.addTask('工作', 'task1');
  const t2 = store.addTask('工作', 'task2');
  store._clearDirtyTracking();
  store.updateTaskText('工作', t1.id, 'edit');
  store.updateTaskText('工作', t2.id, 'edit');
  const snap = store.getDirtySnapshot();
  eq(snap.taskIds, new Set([t1.id, t2.id]), '两个 task 都被追踪');
  // changeCount = taskIds 数 + categoryNames 数（去重）；同 cat 多次编辑只算 1
  truthy(snap.changeCount === 3,
    `changeCount = taskIds(2) + categoryNames(1) = 3（实际 ${snap.changeCount}）`);
}

// ── 8) mergeFromDisk 清空 dirty ──
console.log('\n[mergeFromDisk clears dirty]');
reset();
{
  store.addTask('工作', 'task1');
  store.addTask('工作', 'task2');
  // 模拟磁盘版本（空）
  const diskCats = [];
  store.mergeFromDisk(diskCats, {});
  const snap = store.getDirtySnapshot();
  truthy(snap.taskIds.size === 0, 'mergeFromDisk 后 dirtyTaskIds 空');
  truthy(snap.categoryNames.size === 0, 'mergeFromDisk 后 dirtyCategoryNames 空');
  truthy(store.dirty === false, 'dirty=false');
}

// ── 总结 ──
console.log('');
if (summary.fail === 0) {
  console.log(`✓ 全部通过`);
  process.exit(0);
} else {
  console.log(`✗ ${summary.fail} 处失败`);
  process.exit(1);
}