import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';
import { installApiStub } from './_lib/api-stub.mjs';
// 回归测试：状态栏 #status-meta 在保存完成后必须显示「已同步 HH:MM」
//
// 触发 bug 的姿势（app.js 第 178-192 行旧实现）：
//   _doAutoSave / saveNow 成功 → emit('saved') → 处理器把 #status-meta 写成
//   「已同步 HH:MM」
//   → 紧接着 emit('dirty', false) → 处理器把 textContent=''
//   用户看到的现象：保存之后状态栏空空的，好像没保存过。
//
// 修复：dirty(false) 处理器只在 isDirty=true 时覆写文本；saved 处理器独立
// 维护时间戳；新增 load 处理器在重新加载后清空状态栏。
//
// 跑法：node scripts/check-status-meta.mjs

// 桩 DOM：状态栏文本 + classList。最简化的 stub，不必仿真全部 DOM API。
let savedText = '';
let savedClasses = new Set();
const fakeMeta = {
  get textContent() { return savedText; },
  set textContent(v) { savedText = v; },
  classList: {
    toggle(c, on) { if (on) savedClasses.add(c); else savedClasses.delete(c); },
    add(c) { savedClasses.add(c); },
    remove(c) { savedClasses.delete(c); },
    contains(c) { return savedClasses.has(c); }
  }
};
globalThis.document = {
  getElementById: (id) => (id === 'status-meta' ? fakeMeta : null)
};

// 桩 window.api.notifyDirtyChanged（渲染端 → 主进程的 IPC）
const dirtyNotifications = [];
installApiStub({
  notifyDirtyChanged: (isDirty) => { dirtyNotifications.push(isDirty); }
});

const { TaskStore } = await import('../src/task-store.js');
const { CategoryKind } = await import('../src/markdown-parser.js');

// 把 app.js 里的 dirty/saved/load 处理器搬过来 —— 必须保持一致
function attachStatusMetaHandlers(store) {
  store.on('dirty', (isDirty) => {
    if (isDirty) fakeMeta.textContent = '未保存';
    fakeMeta.classList.toggle('dirty', isDirty);
    fakeMeta.classList.toggle('saved', !isDirty);
    globalThis.window.api.notifyDirtyChanged(isDirty);
  });
  store.on('saved', () => {
    const t = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    fakeMeta.textContent = `已同步 ${t}`;
    fakeMeta.classList.remove('dirty');
    fakeMeta.classList.add('saved');
  });
  store.on('load', () => {
    fakeMeta.textContent = '';
    fakeMeta.classList.remove('dirty');
    fakeMeta.classList.remove('saved');
  });
}

function resetMeta() {
  savedText = '';
  savedClasses = new Set();
  dirtyNotifications.length = 0;
}

// ============================================
console.log('[1] 自动保存完成后状态栏必须保留「已同步 HH:MM」');

{
  resetMeta();
  const store = new TaskStore();
  attachStatusMetaHandlers(store);
  store.filePath = '/tmp/test.md';
  store.categories = [
    { name: '未分类', kind: CategoryKind.NORMAL, tasks: [], parentOtherTasks: true, isSpecial: false, meta: null }
  ];

  store.addTask('未分类', '买牛奶');
  ok('addTask 后 textContent = 「未保存」', fakeMeta.textContent === '未保存',
    `实际 ${JSON.stringify(fakeMeta.textContent)}`);
  ok('addTask 后含 dirty 类、不含 saved 类',
    fakeMeta.classList.contains('dirty') && !fakeMeta.classList.contains('saved'),
    `classes=${[...savedClasses].join(',')}`);

  // 触发自动保存（800ms debounce flush）
  store._autoSave.flush();
  await new Promise(r => setTimeout(r, 30));

  // 关键断言：saved 写入的时间戳必须留下来
  if (fakeMeta.textContent.startsWith('已同步 ')) {
    ok('自动保存完成后 textContent 仍为「已同步 HH:MM」',
      true);
  } else {
    bad('自动保存完成后 textContent 仍为「已同步 HH:MM」',
      `实际 ${JSON.stringify(fakeMeta.textContent)}`);
  }
  ok('自动保存完成后 dirty 类已移除', !fakeMeta.classList.contains('dirty'),
    `classes=${[...savedClasses].join(',')}`);
  ok('自动保存完成后 saved 类已添加', fakeMeta.classList.contains('saved'),
    `classes=${[...savedClasses].join(',')}`);
  ok('notifyDirtyChanged(true → false) 被按序通知',
    JSON.stringify(dirtyNotifications) === '[true,false]',
    `实际 ${JSON.stringify(dirtyNotifications)}`);
}

// ============================================
console.log('\n[2] Ctrl+S (saveNow) 后状态栏同样保留时间戳');

{
  resetMeta();
  const store = new TaskStore();
  attachStatusMetaHandlers(store);
  store.filePath = '/tmp/test.md';
  store.categories = [
    { name: '未分类', kind: CategoryKind.NORMAL, tasks: [], parentOtherTasks: true, isSpecial: false, meta: null }
  ];

  store.addTask('未分类', '买牛奶');
  await store.saveNow();

  if (fakeMeta.textContent.startsWith('已同步 ')) {
    ok('saveNow 后 textContent 仍为「已同步 HH:MM」', true);
  } else {
    bad('saveNow 后 textContent 仍为「已同步 HH:MM」',
      `实际 ${JSON.stringify(fakeMeta.textContent)}`);
  }
}

// ============================================
console.log('\n[3] 编辑 → 保存 → 再编辑：状态栏正确切换「已同步 → 未保存」');

{
  resetMeta();
  const store = new TaskStore();
  attachStatusMetaHandlers(store);
  store.filePath = '/tmp/test.md';
  store.categories = [
    { name: '未分类', kind: CategoryKind.NORMAL, tasks: [], parentOtherTasks: true, isSpecial: false, meta: null }
  ];

  store.addTask('未分类', 'A');
  await store.saveNow();
  // 此时应为「已同步 HH:MM」
  const afterFirstSave = fakeMeta.textContent;
  if (!afterFirstSave.startsWith('已同步 ')) {
    bad('第一次 saveNow 后 textContent 应为「已同步 HH:MM」',
      `实际 ${JSON.stringify(afterFirstSave)}`);
  } else {
    ok('第一次 saveNow 后 textContent 为「已同步 HH:MM」', true);
  }

  store.addTask('未分类', 'B');
  // 现在应该是「未保存」
  if (fakeMeta.textContent === '未保存') {
    ok('再次编辑后 textContent 切回「未保存」', true);
  } else {
    bad('再次编辑后 textContent 应切回「未保存」',
      `实际 ${JSON.stringify(fakeMeta.textContent)}`);
  }
  ok('再次编辑后 dirty 类被添加', fakeMeta.classList.contains('dirty'),
    `classes=${[...savedClasses].join(',')}`);
}

// ============================================
console.log('\n[4] 重新加载文件后清掉旧的保存状态');

{
  resetMeta();
  const store = new TaskStore();
  attachStatusMetaHandlers(store);
  store.filePath = '/tmp/test.md';
  store.categories = [
    { name: '未分类', kind: CategoryKind.NORMAL, tasks: [], parentOtherTasks: true, isSpecial: false, meta: null }
  ];

  // 先走一次「保存」留下时间戳
  store.addTask('未分类', 'A');
  await store.saveNow();
  if (!fakeMeta.textContent.startsWith('已同步 ')) {
    bad('前序 saveNow 后 textContent 应为「已同步 HH:MM」',
      `实际 ${JSON.stringify(fakeMeta.textContent)}`);
  } else {
    ok('前序 saveNow 后 textContent 为「已同步 HH:MM」', true);
  }

  // 模拟「文件被外部修改 → 重新加载」
  store.loadFromContent(
    `# 全部任务\n\n## 未分类\n\n- [ ] C\n`,
    '/tmp/test.md'
  );
  if (fakeMeta.textContent === '') {
    ok('loadFromContent 后 textContent 清空', true);
  } else {
    bad('loadFromContent 后 textContent 应清空',
      `实际 ${JSON.stringify(fakeMeta.textContent)}`);
  }
  ok('loadFromContent 后 dirty/saved 类都清掉',
    !fakeMeta.classList.contains('dirty') && !fakeMeta.classList.contains('saved'),
    `classes=${[...savedClasses].join(',')}`);
}

// ============================================
console.log('\n[5] loadFromContent 后 dirty=false 被显式通知给监听者');

{
  resetMeta();
  const store = new TaskStore();
  attachStatusMetaHandlers(store);
  store.filePath = '/tmp/test.md';
  store.categories = [
    { name: '未分类', kind: CategoryKind.NORMAL, tasks: [], parentOtherTasks: true, isSpecial: false, meta: null }
  ];

  store.addTask('未分类', 'A');
  // 此时 dirtyNotifications 应有 true
  await store.saveNow();
  // 此时 dirtyNotifications 应有 true, false

  const before = [...dirtyNotifications];
  store.loadFromContent(
    `# 全部任务\n\n## 未分类\n\n- [ ] C\n`,
    '/tmp/test.md'
  );
  // loadFromContent 内部 _suppressDirty=true 期间已设 dirty=false；
  // finally 之后必须 emit('dirty', false)，否则 notifyDirtyChanged
  // 收不到这次复位，主进程在退出时仍可能误判状态
  if (dirtyNotifications.length > before.length &&
      dirtyNotifications[dirtyNotifications.length - 1] === false) {
    ok('loadFromContent 后有 dirty(false) 通知',
      true);
  } else {
    bad('loadFromContent 后应有 dirty(false) 通知',
      `before=${JSON.stringify(before)} after=${JSON.stringify(dirtyNotifications)}`);
  }
}

// ============================================
console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${summary.pass} / 失败 ${summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);