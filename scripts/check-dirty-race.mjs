import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';
import { installApiStub } from './_lib/api-stub.mjs';
// 回归测试：脏标记竞态 ——「await writeFile 期间用户又改了」必须保留 dirty
//
// v4 起去掉 800ms debounce 改为全实时同步：
//   用户改 A → _markDirty → 立即 _scheduleAutoSave → _doAutoSave 启动 →
//   序列化（含 A）→ await writeFile（期间用户改 B / C / D → _markDirty 只
//   设 dirty=true + 推 _dirtyVersion + 设 _needsResave=true，因为有 in-flight）
//   → writeFile 返回 → 版本检查发现快照不含最新 → 不清 dirty，
//   finally 检测 _needsResave → 立即再启动一次 _doAutoSave 把累积改动写出去。
//
// 旧机制（800ms debounce）的关键回归仍是 v4 的核心不变：
//   in-flight 期间的用户改动**必须**最终落盘，绝不能因为 dirty 被误清而丢。
//
// 跑法：node scripts/check-dirty-race.mjs

// 桩出 window.api，把 writeFile 换成可手动控制的 Promise，
// 这样能精确卡在「await writeFile 期间」注入下一次 _markDirty。
let writeFileResolver;
const calls = { writeFile: 0 };
installApiStub({
  writeFile: (_path, _content) => {
    calls.writeFile++;
    return new Promise((resolve) => { writeFileResolver = resolve; });
  }
});

const { TaskStore } = await import('../src/task-store.js');
const { CategoryKind } = await import('../src/markdown-parser.js');

// ============================================
// [1] _doAutoSave 路径：await writeFile 期间有修改 → 保留 dirty
// ============================================
console.log('\n[1] _doAutoSave 路径下「await 期间修改」必须保留 dirty');

{
  const store = new TaskStore();
  store.filePath = '/tmp/dirty-race-test.md';
  // 直接 addTask 触发 _markDirty 路径
  store.categories = [
    { name: '未分类', kind: CategoryKind.NORMAL, tasks: [], parentOtherTasks: true, isSpecial: false, meta: null }
  ];
  // 用内部 API 触发一次"修改"，让 _markDirty 把 _dirtyVersion 推到 1
  store.addTask('未分类', 'A');
  ok('首次 addTask 后 dirty 为 true', store.dirty === true);
  ok('首次 addTask 后 _dirtyVersion = 1', store._dirtyVersion === 1);

  // 把 debounce 定时器立刻 flush 掉，让 _doAutoSave 走到 await writeFile 那一行
  store._autoSave.flush();
  // 此时 writeFile 已发起，calls.writeFile 应为 1；_doAutoSave 还在等 resolver
  ok('flush 后 writeFile 被调用一次', calls.writeFile === 1);

  // 「用户在 await 期间又改东西」：再次 addTask —— 只走 _markDirty，不推 _writeGeneration
  store.addTask('未分类', 'B');
  ok('await 期间 addTask 后 dirty 仍为 true', store.dirty === true);
  ok('await 期间 addTask 后 _dirtyVersion = 2', store._dirtyVersion === 2);
  // 关键：_writeGeneration 仍是 1（没有新 save 启动）—— 这是 bug 触发条件
  ok('_writeGeneration 仍为 1（没有新 save 接力）', store._writeGeneration === 1);

  // 释放 writeFile —— 让第一次 _doAutoSave 醒来
  writeFileResolver({ ok: true });
  // 给 microtask 几次 tick 让 await 后的代码跑完
  await new Promise(r => setTimeout(r, 20));

  // 关键断言：dirty 必须仍为 true —— 否则 B 永远写不出去
  if (store.dirty === true) {
    ok('await 回来后 dirty 仍为 true（修复有效）', true);
  } else {
    bad('await 回来后 dirty 仍为 true（修复有效）', `dirty=${store.dirty}, _dirtyVersion=${store._dirtyVersion}`);
  }
}

// ============================================
// [2] saveNow 路径：await writeFile 期间有修改 → 保留 dirty
// ============================================
console.log('\n[2] saveNow 路径下「await 期间修改」必须保留 dirty');

{
  // 重置桩
  calls.writeFile = 0;
  let resolver2;
  globalThis.window.api.writeFile = () => {
    calls.writeFile++;
    return new Promise((resolve) => { resolver2 = resolve; });
  };

  const store = new TaskStore();
  store.filePath = '/tmp/dirty-race-saveNow.md';
  store.categories = [
    { name: '未分类', kind: CategoryKind.NORMAL, tasks: [], parentOtherTasks: true, isSpecial: false, meta: null }
  ];

  // 启动 saveNow（不 await —— 让它走到 await writeFile 后挂起）
  const savePromise = store.saveNow();
  ok('saveNow 启动后 writeFile 被调用', calls.writeFile === 1);

  // await 期间模拟用户改动
  store.addTask('未分类', 'X');
  ok('await 期间 addTask 后 dirty 为 true', store.dirty === true);
  ok('await 期间 _dirtyVersion 已 +1', store._dirtyVersion === 1);

  // 释放 + 等 saveNow 收尾
  resolver2({ ok: true });
  await savePromise;
  await new Promise(r => setTimeout(r, 20));

  if (store.dirty === true) {
    ok('saveNow await 回来后 dirty 仍为 true（修复有效）', true);
  } else {
    bad('saveNow await 回来后 dirty 仍为 true（修复有效）', `dirty=${store.dirty}`);
  }
}

// ============================================
// [3] 正常路径：await 期间无修改 → 仍正确清 dirty（防止误伤）
// ============================================
console.log('\n[3] 正常路径（无并发修改）必须正确清 dirty —— 别把修复写成永不清');

{
  calls.writeFile = 0;
  let resolver3;
  globalThis.window.api.writeFile = () => {
    calls.writeFile++;
    return new Promise((resolve) => { resolver3 = resolve; });
  };

  const store = new TaskStore();
  store.filePath = '/tmp/dirty-race-clean.md';
  store.categories = [
    { name: '未分类', kind: CategoryKind.NORMAL, tasks: [], parentOtherTasks: true, isSpecial: false, meta: null }
  ];

  let savedEmitted = false;
  store.on('saved', () => { savedEmitted = true; });

  store.addTask('未分类', 'Y');
  store._autoSave.flush();
  ok('flush 后 writeFile 被调用', calls.writeFile === 1);

  // 不再做任何修改，直接释放
  resolver3({ ok: true });
  await new Promise(r => setTimeout(r, 20));

  if (store.dirty === false) {
    ok('正常路径下 dirty 被正确清掉', true);
  } else {
    bad('正常路径下 dirty 被正确清掉', `dirty=${store.dirty}`);
  }
  if (savedEmitted) {
    ok('正常路径下 emit 了 saved 事件', true);
  } else {
    bad('正常路径下 emit 了 saved 事件');
  }
}

// ============================================
// [4] cancelPendingSave 仍要让 in-flight 过期（回归测试现有行为）
// ============================================
console.log('\n[4] cancelPendingSave 让 in-flight 写过期，dirty 保留');

{
  calls.writeFile = 0;
  let resolver4;
  globalThis.window.api.writeFile = () => {
    calls.writeFile++;
    return new Promise((resolve) => { resolver4 = resolve; });
  };

  const store = new TaskStore();
  store.filePath = '/tmp/dirty-race-cancel.md';
  store.categories = [
    { name: '未分类', kind: CategoryKind.NORMAL, tasks: [], parentOtherTasks: true, isSpecial: false, meta: null }
  ];

  store.addTask('未分类', 'Z');
  store._autoSave.flush();
  ok('flush 后 writeFile 被调用', calls.writeFile === 1);

  // 模拟「文件被外部改了」 → 取消 pending
  store.cancelPendingSave();
  // _writeGeneration 在 cancelPendingSave 里被 +1，所以已不再是 1
  ok('cancel 后 _writeGeneration 已被推过（in-flight 失效）', store._writeGeneration > 1);

  // 释放 writeFile —— 已取消，dirty 必须保留
  resolver4({ ok: true });
  await new Promise(r => setTimeout(r, 20));

  if (store.dirty === true) {
    ok('cancel 后 dirty 被保留', true);
  } else {
    bad('cancel 后 dirty 被保留', `dirty=${store.dirty}`);
  }
}

// ============================================
// [5] v4 全实时同步：单次 addTask 立即触发 writeFile（无 800ms 等待）
// ============================================
console.log('\n[5] 单次 addTask 立即触发 writeFile（无 debounce 延迟）');

{
  calls.writeFile = 0;
  let resolver5;
  globalThis.window.api.writeFile = (_path, _content) => {
    calls.writeFile++;
    return new Promise((resolve) => { resolver5 = resolve; });
  };

  const store = new TaskStore();
  store.filePath = '/tmp/real-time-sync.md';
  store.categories = [
    { name: '未分类', kind: CategoryKind.NORMAL, tasks: [], parentOtherTasks: true, isSpecial: false, meta: null }
  ];

  store.addTask('未分类', '即时');
  // 关键：addTask 一返回 writeFile 就已经发起 —— 不再等 800ms
  ok('addTask 后立即触发 writeFile（无 debounce 延迟）', calls.writeFile === 1,
    `calls.writeFile=${calls.writeFile}`);

  // 收尾：释放 resolver 让 save 完成
  resolver5({ ok: true });
  await new Promise(r => setTimeout(r, 20));
  ok('保存完成后 dirty 被清掉', store.dirty === false, `dirty=${store.dirty}`);
}

// ============================================
// [6] v4 尾随写：in-flight 期间多次 addTask，finally 自动补一次写覆盖最新状态
// ============================================
console.log('\n[6] in-flight 期间累积改动 → finally 自动补一次写（覆盖最新状态）');

{
  calls.writeFile = 0;
  // 用队列收集 resolver，避免后续尾随写无法 release 导致悬挂
  const resolvers = [];
  globalThis.window.api.writeFile = (_path, content) => {
    calls.writeFile++;
    const capturedContent = content;
    return new Promise((resolve) => {
      resolvers.push({ resolve, capturedContent });
    });
  };

  const store = new TaskStore();
  store.filePath = '/tmp/trailing-save.md';
  store.categories = [
    { name: '未分类', kind: CategoryKind.NORMAL, tasks: [], parentOtherTasks: true, isSpecial: false, meta: null }
  ];

  // 第 1 次：直接 addTask 触发第一次 writeFile
  store.addTask('未分类', 'A');
  ok('addTask A 后 writeFile 被立即调用', calls.writeFile === 1);

  // in-flight 期间：连续改 3 次 —— 应走 _needsResave 路径，**不**起新 writeFile
  store.addTask('未分类', 'B');
  store.addTask('未分类', 'C');
  store.addTask('未分类', 'D');
  ok('in-flight 期间 3 次 addTask 后 writeFile 仍 = 1（被合并）',
    calls.writeFile === 1, `calls.writeFile=${calls.writeFile}`);
  ok('in-flight 期间 _writeGeneration 仍 = 1（没新 save 启动）',
    store._writeGeneration === 1);
  ok('in-flight 期间 _dirtyVersion = 4（addTask 4 次）',
    store._dirtyVersion === 4);

  // 释放第一次写：finally 应触发尾随写
  resolvers[0].resolve({ ok: true });
  await new Promise(r => setTimeout(r, 20));
  ok('第一次释放后 writeFile 被尾随启动一次（共 2 次）',
    calls.writeFile === 2, `calls.writeFile=${calls.writeFile}`);
  ok('尾随写启动后 _writeGeneration = 2',
    store._writeGeneration === 2);
  ok('第一次释放后 dirty 仍 = true（尾随写尚未完成）',
    store.dirty === true);

  // 释放尾随写：这次应包含 ABCD 全部内容
  const trailingContent = resolvers[1].capturedContent;
  ok('尾随写的内容含 A/B/C/D 全部 4 条任务',
    trailingContent.includes('A') &&
    trailingContent.includes('B') &&
    trailingContent.includes('C') &&
    trailingContent.includes('D'),
    `内容预览: ${trailingContent.slice(0, 200)}`);

  resolvers[1].resolve({ ok: true });
  await new Promise(r => setTimeout(r, 20));
  ok('尾随写完成后 dirty 被清掉', store.dirty === false,
    `dirty=${store.dirty}`);
  ok('无更多 _needsResave → writeFile 共 2 次（不多次重复）',
    calls.writeFile === 2, `calls.writeFile=${calls.writeFile}`);
}

console.log(`\n通过 ${summary.pass} / 失败 ${summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
