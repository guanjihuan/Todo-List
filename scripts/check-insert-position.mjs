// 回归测试：「任务插入位置」设置（newTaskPosition / completedPosition /
// uncompletePosition / trashPosition / restorePosition 五件套）
//
// 用户偏好五类插入动作的落点：前面（front, 最新在最上）/ 后面（back, 最新在最下）。
// 五类动作分别是：
//   - 新增任务  (addTask / importTasksToCategory 的 pending 部分)
//   - 完成      (toggleTask 打勾 / batchToggleCompleted(true) / importTasksToCategory 的 completed 部分)
//   - 取消完成  (toggleTask 取消勾选 / restoreCompletedTask / batchToggleCompleted(false) / picker 强制降级)
//   - 删除      (deleteTask / batchDeleteTasks / clearCompleted)
//   - 恢复      (restoreTask 从回收站归位)
//
// 这份脚本直接构造 TaskStore + 桩 SettingsStore，验证：
//   1. 默认（不注入 settingsStore）= front，等价于 DEFAULT_SETTINGS。
//   2. settingsStore 注入后，按 *Position 的值决定 push / unshift。
//   3. 切换设置后再插入：仅新插入的任务受影响，已存在的任务不会被回溯重排。
//   4. SettingsStore 拒绝非法值（与 settings-store 的 VALID_VALUES 对齐）。
//   5. settingsStore.update 持久化设置后，TaskStore 立即读到新值（无需重启）。
//
// 跑法：node scripts/check-insert-position.mjs

import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { installApiStub } from './_lib/api-stub.mjs';

// TaskStore 的模块作用域会注册事件回调，但仅用到内存对象，没有副作用。
installApiStub();

const { TaskStore, OTHER_TASKS_NAME, COMPLETED_NAME, TRASH_NAME } = await import('../src/task-store.js');
const { SettingsStore } = await import('../src/settings-store.js');

// 简单桩：复刻 SettingsStore.get 的最小接口，行为上把 'newTaskPosition' 等字段
// 当作对象属性读取。TaskStore 不关心 SettingsStore 是不是 EventEmitter、不关心
// load()/update()，所以不实现事件也够用。
function makeSettingsStub(values = {}) {
  return {
    _values: { ...values },
    get(key) { return this._values[key]; }
  };
}

// 取分类下任务文本数组 —— 断言时只关心「顺序」与「文本」，不看 id / 标记字段。
function taskTexts(cat) {
  return (cat?.tasks || []).map(t => t.text);
}

// 取「已完成」分类下的任务文本。
function completedTexts(store) {
  const c = store.getCompletedCategory();
  return taskTexts(c);
}

// 取「回收站」分类下的任务文本。
function trashTexts(store) {
  const c = store.getTrashCategory();
  return taskTexts(c);
}

// ============================================
// 1. 默认行为：未注入 settingsStore → 等价于 'front'（最新在最上）
// ============================================
console.log('[1] 默认（未注入 settingsStore）→ 插入到列表前面');

{
  const store = new TaskStore();
  store.loadDefault(null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  // 新增任务：默认应该在最前面
  store.addTask('工作', 'A');
  store.addTask('工作', 'B');
  const workCat = store.getCategory('工作');
  check('未注入 settingsStore 时新增任务落到前面',
    JSON.stringify(taskTexts(workCat)) === JSON.stringify(['B', 'A']),
    `actual=${JSON.stringify(taskTexts(workCat))}`);

  // 完成：默认应该在「已完成任务」前面 —— 勾掉 A（位置 [1]），再勾掉 B（位置 [0]），
  // 期望 completedTexts 顺序 = [B, A]（最新完成的最上面）。
  store.toggleTask('工作', workCat.tasks[1].id); // 勾 A
  store.toggleTask('工作', workCat.tasks[0].id); // 勾 B
  check('未注入 settingsStore 时打勾任务按完成顺序落到「已完成」前面',
    JSON.stringify(completedTexts(store)) === JSON.stringify(['B', 'A']),
    `actual=${JSON.stringify(completedTexts(store))}`);

  // 删除：默认应该在「回收站」前面
  store.addTask('生活', 'X');
  store.addTask('生活', 'Y');
  const liveCat = store.getCategory('生活');
  // liveCat.tasks = [Y, X]（front 模式）。先删 Y（tasks[0]），再删 X（tasks[0]）
  store.deleteTask('生活', liveCat.tasks[0].id); // 删 Y
  store.deleteTask('生活', liveCat.tasks[0].id); // 删 X
  check('未注入 settingsStore 时删除任务按删除顺序落到「回收站」前面',
    JSON.stringify(trashTexts(store)) === JSON.stringify(['X', 'Y']),
    `actual=${JSON.stringify(trashTexts(store))}`);
}

// ============================================
// 2. 注入 settingsStore 后按 *Position 决定 push / unshift
// ============================================
console.log('\n[2] settingsStore.newTaskPosition="back" → 新增任务落到列表后面');

{
  const settings = makeSettingsStub({ newTaskPosition: 'back' });
  const store = new TaskStore({ settingsStore: settings });
  store.loadDefault(null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  store.addTask('工作', 'A');
  store.addTask('工作', 'B');
  const workCat = store.getCategory('工作');
  check('newTaskPosition=back 时新增任务按入参顺序落到末尾',
    JSON.stringify(taskTexts(workCat)) === JSON.stringify(['A', 'B']),
    `actual=${JSON.stringify(taskTexts(workCat))}`);
}

console.log('\n[3] settingsStore.completedPosition="back" → 完成的任务落到「已完成」后面');

{
  const settings = makeSettingsStub({ completedPosition: 'back' });
  const store = new TaskStore({ settingsStore: settings });
  store.loadDefault(null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  const workCat = store.getCategory('工作');
  store.addTask('工作', 'A');
  store.addTask('工作', 'B');
  // 工作顺序：默认 front → [B, A]。先勾 A（后入参 = 最新，但 front 模式下 [1]），
  // 再勾 B（最旧）→ back 模式下完成顺序：[A, B]（最早完成的在最上，最后完成的在最下）。
  store.toggleTask('工作', workCat.tasks[1].id); // 勾 A
  store.toggleTask('工作', workCat.tasks[0].id); // 勾 B
  check('completedPosition=back 时按完成顺序追加到「已完成」末尾',
    JSON.stringify(completedTexts(store)) === JSON.stringify(['A', 'B']),
    `actual=${JSON.stringify(completedTexts(store))}`);
}

console.log('\n[4] settingsStore.trashPosition="back" → 删除的任务落到「回收站」后面');

{
  const settings = makeSettingsStub({ trashPosition: 'back' });
  const store = new TaskStore({ settingsStore: settings });
  store.loadDefault(null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  store.addTask('工作', 'A');
  store.addTask('工作', 'B');
  const workCat = store.getCategory('工作');
  // 工作顺序：默认 front → [B, A]。先删 A（最新），再删 B（最旧）→ back 模式下
  // 回收站顺序：[A, B]（最新删除的... 等等，back 模式下"最新"在最下面）。
  // 等等，这里 user 期望"最新在最下"（back 模式语义）：先删 A → 在 [0]，再删 B → 追加在 [1]。
  store.deleteTask('工作', workCat.tasks[1].id); // 删 A
  store.deleteTask('工作', workCat.tasks[0].id); // 删 B
  check('trashPosition=back 时按删除顺序追加到「回收站」末尾',
    JSON.stringify(trashTexts(store)) === JSON.stringify(['A', 'B']),
    `actual=${JSON.stringify(trashTexts(store))}`);
}

// ============================================
// 5. 切换设置 → 下一条新插入立即生效，已存在的任务不重排
// ============================================
console.log('\n[5] 切换设置只影响新插入，已存在的任务不被回溯重排');

{
  const settings = makeSettingsStub({ newTaskPosition: 'front' });
  const store = new TaskStore({ settingsStore: settings });
  store.loadDefault(null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  store.addTask('工作', 'A');
  store.addTask('工作', 'B');
  const workCat = store.getCategory('工作');

  // 切到 'back'
  settings._values.newTaskPosition = 'back';
  store.addTask('工作', 'C');

  check('切到 back 后新插入的 C 落到末尾',
    JSON.stringify(taskTexts(workCat)) === JSON.stringify(['B', 'A', 'C']),
    `actual=${JSON.stringify(taskTexts(workCat))}`);

  // 再切回 'front'
  settings._values.newTaskPosition = 'front';
  store.addTask('工作', 'D');
  check('切回 front 后新插入的 D 落到最前，已存在的 [B, A, C] 不动',
    JSON.stringify(taskTexts(workCat)) === JSON.stringify(['D', 'B', 'A', 'C']),
    `actual=${JSON.stringify(taskTexts(workCat))}`);
}

// ============================================
// 6. 非法值被 TaskStore 兜底为 'front'（settingsStore 校验已经兜过，
//    这里再守一道防御：万一有人绕过 settingsStore 直接塞非法值进来）
// ============================================
console.log('\n[6] 非法 *Position 值被 TaskStore 兜底为 front');

{
  const settings = makeSettingsStub({ newTaskPosition: 'middle' /* 非法 */ });
  const store = new TaskStore({ settingsStore: settings });
  store.loadDefault(null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  store.addTask('工作', 'A');
  store.addTask('工作', 'B');
  const workCat = store.getCategory('工作');
  check('非法 newTaskPosition="middle" 兜底为 front（最新在最上）',
    JSON.stringify(taskTexts(workCat)) === JSON.stringify(['B', 'A']),
    `actual=${JSON.stringify(taskTexts(workCat))}`);
}

// ============================================
// 7. SettingsStore 自身拒绝非法值（与 settings-store 的 VALID_VALUES 对齐）
// ============================================
console.log('\n[7] SettingsStore 拒绝非法 *Position 值');

{
  const s = new SettingsStore();
  await s.update({ newTaskPosition: 'middle' });
  if (s.get('newTaskPosition') === 'front') {
    ok('update({newTaskPosition: "middle"}) 被忽略，保持默认 front');
  } else {
    bad('newTaskPosition 被非法值污染', `当前 ${JSON.stringify(s.get('newTaskPosition'))}`);
  }

  await s.update({ completedPosition: null });
  if (s.get('completedPosition') === 'front') {
    ok('update({completedPosition: null}) 被忽略');
  } else {
    bad('completedPosition 被 null 污染', `当前 ${JSON.stringify(s.get('completedPosition'))}`);
  }

  await s.update({ trashPosition: 'front' });
  if (s.get('trashPosition') === 'front') {
    ok('update({trashPosition: "front"}) 合法值生效');
  } else {
    bad('trashPosition 未生效', `当前 ${JSON.stringify(s.get('trashPosition'))}`);
  }
}

// ============================================
// 8. SettingsStore.update 后 TaskStore 立即读到新值（无需重启）
// ============================================
console.log('\n[8] SettingsStore.update 后下一次插入立即按新值生效');

{
  const s = new SettingsStore();
  const store = new TaskStore({ settingsStore: s });
  store.loadDefault(null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  await s.update({ newTaskPosition: 'back' });
  store.addTask('工作', 'A');
  store.addTask('工作', 'B');
  const workCat = store.getCategory('工作');
  check('update back 后插入按入参顺序追加',
    JSON.stringify(taskTexts(workCat)) === JSON.stringify(['A', 'B']),
    `actual=${JSON.stringify(taskTexts(workCat))}`);

  await s.update({ newTaskPosition: 'front' });
  store.addTask('工作', 'C');
  check('再 update 回 front 后新插入落到最前',
    JSON.stringify(taskTexts(workCat)) === JSON.stringify(['C', 'A', 'B']),
    `actual=${JSON.stringify(taskTexts(workCat))}`);
}

// ============================================
// 9. 批量路径同样遵守设置：importTasksToCategory 的 pending 部分用 newTaskPosition，
//    completed 部分用 completedPosition。
// ============================================
console.log('\n[9] importTasksToCategory 批量插入遵守 *Position 设置');

{
  const settings = makeSettingsStub({
    newTaskPosition: 'back',
    completedPosition: 'back'
  });
  const store = new TaskStore({ settingsStore: settings });
  store.loadDefault(null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  // 第一批：往「工作」导入 A、B、C（都是 pending）
  store.importTasksToCategory('工作', ['A', 'B', 'C']);
  const workCat = store.getCategory('工作');
  check('newTaskPosition=back 时批量 pending 按入参顺序落到末尾',
    JSON.stringify(taskTexts(workCat)) === JSON.stringify(['A', 'B', 'C']),
    `actual=${JSON.stringify(taskTexts(workCat))}`);

  // 第二批：往「生活」导入 - [x] 已完成（completed 部分）
  store.importTasksToCategory('生活', ['- [x] X', '- [x] Y', '- [x] Z']);
  check('completedPosition=back 时批量 completed 按入参顺序落到末尾',
    JSON.stringify(completedTexts(store)) === JSON.stringify(['X', 'Y', 'Z']),
    `actual=${JSON.stringify(completedTexts(store))}`);
}

console.log('\n[10] importTasksToCategory importPosition 默认模式：按入参顺序 + 插到最前');

{
  // 修复用户报告 bug 后：导入默认行为不再复用 newTaskPosition='front'（最后一行在最前），
  // 而是独立的 importPosition='order'（第一行在最前，按入参顺序）。这里验证新的默认。
  const settings = makeSettingsStub({});
  const store = new TaskStore({ settingsStore: settings });
  store.loadDefault(null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  store.importTasksToCategory('工作', ['A', 'B', 'C']);
  const workCat = store.getCategory('工作');
  // 入参顺序 A→B→C，order 模式（默认）→ unshift 整批 → A 在最前
  check('默认 importPosition=order：按入参顺序 + 插到最前（A 在最前）',
    JSON.stringify(taskTexts(workCat)) === JSON.stringify(['A', 'B', 'C']),
    `actual=${JSON.stringify(taskTexts(workCat))}`);

  // 显式设 importPosition='front' 验证旧 front 语义仍可用
  const settingsFront = makeSettingsStub({ importPosition: 'front' });
  const storeFront = new TaskStore({ settingsStore: settingsFront });
  storeFront.loadDefault(null);
  storeFront._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });
  storeFront.importTasksToCategory('工作', ['A', 'B', 'C']);
  check('显式 importPosition=front：倒序 unshift（C 在最前）',
    JSON.stringify(taskTexts(storeFront.getCategory('工作'))) === JSON.stringify(['C', 'B', 'A']),
    `actual=${JSON.stringify(taskTexts(storeFront.getCategory('工作')))}`);
}

// ============================================
// 11. 批量删除（batchDeleteTasks）和 clearCompleted 也遵守 trashPosition
// ============================================
console.log('\n[11] clearCompleted / batchDeleteTasks 遵守 trashPosition');

{
  // front（默认）
  const settingsFront = makeSettingsStub({ trashPosition: 'front' });
  const store1 = new TaskStore({ settingsStore: settingsFront });
  store1.loadDefault(null);
  store1._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });
  store1.addTask('工作', 'A');
  store1.addTask('工作', 'B');
  let workCat = store1.getCategory('工作');
  // 勾两条 → 都进「已完成」
  store1.toggleTask('工作', workCat.tasks[0].id);
  store1.toggleTask('工作', workCat.tasks[0].id);
  // clearCompleted → 两条都已完成 → 全部进 trash
  store1.clearCompleted();
  check('trashPosition=front 时 clearCompleted 把最新清走的排在最前',
    JSON.stringify(trashTexts(store1)) === JSON.stringify(['B', 'A']),
    `actual=${JSON.stringify(trashTexts(store1))}`);
}

{
  // back
  const settingsBack = makeSettingsStub({ trashPosition: 'back' });
  const store2 = new TaskStore({ settingsStore: settingsBack });
  store2.loadDefault(null);
  store2._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });
  store2.addTask('工作', 'A');
  store2.addTask('工作', 'B');
  let workCat = store2.getCategory('工作');
  store2.toggleTask('工作', workCat.tasks[0].id);
  store2.toggleTask('工作', workCat.tasks[0].id);
  store2.clearCompleted();
  check('trashPosition=back 时 clearCompleted 按清走顺序追加',
    JSON.stringify(trashTexts(store2)) === JSON.stringify(['A', 'B']),
    `actual=${JSON.stringify(trashTexts(store2))}`);
}

// ============================================
// 12. 恢复路径遵守 restorePosition / uncompletePosition
// ============================================
console.log('\n[12] restoreTask 遵守 restorePosition');

{
  // restorePosition=back：A 回到末尾
  const settings = makeSettingsStub({ restorePosition: 'back' });
  const store = new TaskStore({ settingsStore: settings });
  store.loadDefault(null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  store.addTask('工作', 'A');
  store.addTask('工作', 'B');
  const workCat = store.getCategory('工作');
  // 工作当前顺序 [B, A]（默认 front）。删 A（tasks[1]）
  store.deleteTask('工作', workCat.tasks[1].id);
  const trashCat = store.getTrashCategory();
  store.restoreTask(trashCat.tasks[0].id);
  check('restorePosition=back 时 A 回到「工作」末尾',
    JSON.stringify(taskTexts(workCat)) === JSON.stringify(['B', 'A']),
    `actual=${JSON.stringify(taskTexts(workCat))}`);
}

{
  // restorePosition=front（默认）：A 回到最前
  const settings = makeSettingsStub({ restorePosition: 'front' });
  const store = new TaskStore({ settingsStore: settings });
  store.loadDefault(null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  store.addTask('工作', 'A');
  store.addTask('工作', 'B');
  const workCat = store.getCategory('工作');
  // 工作当前顺序 [B, A]（默认 front）。删 A（tasks[1]）
  store.deleteTask('工作', workCat.tasks[1].id);
  const trashCat = store.getTrashCategory();
  store.restoreTask(trashCat.tasks[0].id);
  check('restorePosition=front 时 A 回到「工作」最前',
    JSON.stringify(taskTexts(workCat)) === JSON.stringify(['A', 'B']),
    `actual=${JSON.stringify(taskTexts(workCat))}`);
}

// ============================================
// 13. 取消完成（toggleTask 取消勾选 / restoreCompletedTask）遵守 uncompletePosition
// ============================================
console.log('\n[13] toggleTask 取消勾选 遵守 uncompletePosition');

{
  // uncompletePosition=back：取消勾选后追加到末尾
  const settings = makeSettingsStub({ uncompletePosition: 'back' });
  const store = new TaskStore({ settingsStore: settings });
  store.loadDefault(null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  store.addTask('工作', 'A');
  store.addTask('工作', 'B');
  const workCat = store.getCategory('工作');
  // 工作顺序 [B, A]。勾 A（tasks[1]）→ 进 completed
  store.toggleTask('工作', workCat.tasks[1].id);
  // 取消勾选 → 回到工作，uncompletePosition=back → 追加到末尾 → [B, A]
  const completedTaskId = store.getCompletedCategory().tasks[0].id;
  store.toggleTask(COMPLETED_NAME, completedTaskId);
  check('uncompletePosition=back 时取消勾选追加到「工作」末尾',
    JSON.stringify(taskTexts(workCat)) === JSON.stringify(['B', 'A']),
    `actual=${JSON.stringify(taskTexts(workCat))}`);
}

{
  // uncompletePosition=front（默认）：取消勾选后落到最前
  const settings = makeSettingsStub({ uncompletePosition: 'front' });
  const store = new TaskStore({ settingsStore: settings });
  store.loadDefault(null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  store.addTask('工作', 'A');
  store.addTask('工作', 'B');
  const workCat = store.getCategory('工作');
  // 工作顺序 [B, A]。勾 A → 进 completed
  store.toggleTask('工作', workCat.tasks[1].id);
  // 取消勾选 → 回到工作，front → unshift 到最前 → [A, B]
  const completedTaskId = store.getCompletedCategory().tasks[0].id;
  store.toggleTask(COMPLETED_NAME, completedTaskId);
  check('uncompletePosition=front 时取消勾选 unshift 到「工作」最前',
    JSON.stringify(taskTexts(workCat)) === JSON.stringify(['A', 'B']),
    `actual=${JSON.stringify(taskTexts(workCat))}`);
}

// ============================================
// 14. restoreCompletedTask（picker 已选好目标分类）遵守 uncompletePosition
// ============================================
console.log('\n[14] restoreCompletedTask 遵守 uncompletePosition');

{
  // uncompletePosition=front：restoreCompletedTask 走「未分类」时落到最前
  const settings = makeSettingsStub({ uncompletePosition: 'front' });
  const store = new TaskStore({ settingsStore: settings });
  store.loadDefault(null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  store.addTask('工作', 'A');
  store.addTask('工作', 'B');
  const workCat = store.getCategory('工作');
  // 工作顺序 [B, A]。勾 A → 进 completed
  store.toggleTask('工作', workCat.tasks[1].id);
  const completedTaskId = store.getCompletedCategory().tasks[0].id;
  // UI picker 选了「工作」—— restoreCompletedTask 直接落到「工作」最前
  store.restoreCompletedTask(completedTaskId, '工作');
  check('uncompletePosition=front 时 restoreCompletedTask 把 A 放到「工作」最前',
    JSON.stringify(taskTexts(workCat)) === JSON.stringify(['A', 'B']),
    `actual=${JSON.stringify(taskTexts(workCat))}`);
}

{
  // uncompletePosition=back：restoreCompletedTask 落到末尾
  const settings = makeSettingsStub({ uncompletePosition: 'back' });
  const store = new TaskStore({ settingsStore: settings });
  store.loadDefault(null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  store.addTask('工作', 'A');
  store.addTask('工作', 'B');
  const workCat = store.getCategory('工作');
  // 工作顺序 [B, A]。勾 A → 进 completed
  store.toggleTask('工作', workCat.tasks[1].id);
  const completedTaskId = store.getCompletedCategory().tasks[0].id;
  // restoreCompletedTask 直接落到「工作」末尾
  store.restoreCompletedTask(completedTaskId, '工作');
  check('uncompletePosition=back 时 restoreCompletedTask 把 A 放到「工作」末尾',
    JSON.stringify(taskTexts(workCat)) === JSON.stringify(['B', 'A']),
    `actual=${JSON.stringify(taskTexts(workCat))}`);
}

// ============================================
// 15. batchToggleCompleted(false) 遵守 uncompletePosition
// ============================================
console.log('\n[15] batchToggleCompleted(false) 遵守 uncompletePosition');

{
  // uncompletePosition=front：批量取消勾选按 parseOrder 倒序 unshift 到最前
  const settings = makeSettingsStub({ uncompletePosition: 'front' });
  const store = new TaskStore({ settingsStore: settings });
  store.loadDefault(null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  // 先在「工作」建 A、B、C（默认 front → tasks = [C, B, A]）
  store.addTask('工作', 'A');
  store.addTask('工作', 'B');
  store.addTask('工作', 'C');
  const workCat = store.getCategory('工作');
  // 全部勾到 completed —— taskRefs 形如 [{categoryName, taskId}, ...]
  const refs = workCat.tasks.map(t => ({ categoryName: '工作', taskId: t.id }));
  store.batchToggleCompleted(refs, true);
  // 把三条都取消勾选 → 它们按 parseOrder 倒序 unshift 到工作最前
  const completedCat = store.getCompletedCategory();
  const completedRefs = completedCat.tasks.map(t => ({ categoryName: '已完成任务', taskId: t.id }));
  store.batchToggleCompleted(completedRefs, false);
  check('uncompletePosition=front 时 batchToggleCompleted(false) 按 parseOrder 倒序 unshift',
    JSON.stringify(taskTexts(workCat)) === JSON.stringify(['C', 'B', 'A']),
    `actual=${JSON.stringify(taskTexts(workCat))}`);
}

{
  // uncompletePosition=back：批量取消勾选按 parseOrder 顺序追加到末尾
  const settings = makeSettingsStub({ uncompletePosition: 'back' });
  const store = new TaskStore({ settingsStore: settings });
  store.loadDefault(null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });

  store.addTask('工作', 'A');
  store.addTask('工作', 'B');
  store.addTask('工作', 'C');
  const workCat = store.getCategory('工作');
  const refs = workCat.tasks.map(t => ({ categoryName: '工作', taskId: t.id }));
  store.batchToggleCompleted(refs, true);
  const completedCat = store.getCompletedCategory();
  const completedRefs = completedCat.tasks.map(t => ({ categoryName: '已完成任务', taskId: t.id }));
  store.batchToggleCompleted(completedRefs, false);
  check('uncompletePosition=back 时 batchToggleCompleted(false) 按 parseOrder 追加',
    JSON.stringify(taskTexts(workCat)) === JSON.stringify(['A', 'B', 'C']),
    `actual=${JSON.stringify(taskTexts(workCat))}`);
}

// ============================================
console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${summary.pass} / 失败 ${summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);