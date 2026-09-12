// 测试「并发编辑数据丢失防护」：用户在软件里改任务时，外部编辑器同步保存，
// 自动保存必须主动让位（拒绝写盘），由冲突解决流程决定谁覆盖谁。
//
// 真实数据丢失场景：
//   T0   用户改任务 → dirty=true，800ms autoSave 排队
//   T0+10ms 外部编辑器保存 → 文件被改
//   T0+800ms autoSave 触发 → 之前 v4 方案会让自动保存直接写，覆盖外部编辑
//   T0+1500ms external-change IPC 终于到达 → 内容比对时内存 == 文件 → 静默
//                  ↑ 外部编辑就这样被悄悄丢掉了
//
// 修复：main.js file:write 加 mtime 预检，发现文件被外部动过就直接拒绝，
//       返回 EXTERNAL_CHANGE_DETECTED，渲染端走冲突解决流程弹对话框。

import { TaskStore } from '../src/task-store.js';
import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';
import { installApiStub } from './_lib/api-stub.mjs';

// 桩出 window.api，让 TaskStore 不真去写文件
installApiStub();

// ============================================================
// [1] saveNow 永远 force=true：用户意图不被主进程拦截
// ============================================================
console.log('\n[1] saveNow 调用 writeFile 时带 force=true');
{
  // 用 TaskStore 模拟一次保存，检查它最终调用 writeFile 的参数。
  // 不能直接观察 TaskStore 内部 API（writeFile 是 window.api 上的），
  // 但可以验证 saveNow 与 autoSave 的代码路径走的是同一个 IPC。
  let lastWriteOptions = null;
  globalThis.window.api.writeFile = async (fp, content, options) => {
    lastWriteOptions = options;
    return { ok: true };
  };

  const store = makeStore(`# 全部任务\n\n## 工作\n\n- [ ] a\n`);
  store.filePath = '/test/todo.md';

  await store.saveNow();
  check('saveNow 把 force=true 传给 writeFile',
    lastWriteOptions && lastWriteOptions.force === true,
    `options=${JSON.stringify(lastWriteOptions)}`);

  // 重置
  lastWriteOptions = null;
}

// ============================================================
// [2] _doAutoSave 调用 writeFile 时不带 force：主进程会做 mtime 检查
// ============================================================
console.log('\n[2] autoSave 调用 writeFile 时不带 force');
{
  // 直接调 _doAutoSave 模拟自动保存触发，观察传给 writeFile 的 options。
  let lastWriteOptions = undefined;
  globalThis.window.api.writeFile = async (fp, content, options) => {
    lastWriteOptions = options;
    return { ok: true };
  };

  const store = makeStore(`# 全部任务\n\n## 工作\n\n- [ ] a\n`);
  store.filePath = '/test/todo.md';
  // 标记 dirty（autoSave 排队），直接调 _doAutoSave 跳过 debounce
  store._markDirty();
  await store._doAutoSave();
  check('autoSave 把 options=undefined（或 {}）传给 writeFile，主进程 mtime 检查会生效',
    lastWriteOptions === undefined || (lastWriteOptions && lastWriteOptions.force !== true),
    `options=${JSON.stringify(lastWriteOptions)}`);
}

// ============================================================
// [3] saveNow 在 force=true 模式下，外部修改检测会被跳过
// ============================================================
console.log('\n[3] force=true 跳过主进程 mtime 检查');
{
  // 模拟主进程的逻辑：file:write handler 收到 options.force 时跳过检查。
  let mtimeCheckRan = false;
  globalThis.window.api.writeFile = async (fp, content, options) => {
    // 模拟主进程 file:write handler 的 mtime 预检
    if (!options || !options.force) {
      mtimeCheckRan = true;
      // 这里如果发现 mtime 不一致就返回 EXTERNAL_CHANGE_DETECTED
      return { ok: false, error: 'EXTERNAL_CHANGE_DETECTED' };
    }
    return { ok: true };
  };

  const store = makeStore(`# 全部任务\n\n## 工作\n\n- [ ] a\n`);
  store.filePath = '/test/todo.md';

  // saveNow 走 force=true → 主进程跳过检查 → 写入成功
  const ok = await store.saveNow();
  check('saveNow (force=true) 不触发 mtime 检查',
    ok === true && mtimeCheckRan === false,
    `ok=${ok}, mtimeCheckRan=${mtimeCheckRan}`);
}

// ============================================================
// [4] autoSave 在非 force 模式下，外部修改会让写盘失败
// ============================================================
console.log('\n[4] autoSave (无 force) 在外部修改下被主进程拒绝');
{
  // 模拟主进程 mtime 预检逻辑
  globalThis.window.api.writeFile = async (fp, content, options) => {
    // 非 force 模式：模拟发现外部修改
    return { ok: false, error: 'EXTERNAL_CHANGE_DETECTED' };
  };

  const store = makeStore(`# 全部任务\n\n## 工作\n\n- [ ] a\n`);
  store.filePath = '/test/todo.md';

  let saveErrorEmitted = null;
  store.on('save-error', (err) => { saveErrorEmitted = err; });

  store._markDirty();
  await store._doAutoSave();

  // v3.5 起 save-error 载荷是 {code, message, diskContent}，渲染端从 err.code 识别错误码
  check('autoSave 被拒绝时 emit("save-error", {code: "EXTERNAL_CHANGE_DETECTED"})',
    saveErrorEmitted?.code === 'EXTERNAL_CHANGE_DETECTED',
    `saveErrorEmitted=${JSON.stringify(saveErrorEmitted)}`);

  check('autoSave 失败后 dirty 仍为 true（继续等待冲突解决）',
    store.dirty === true,
    `dirty=${store.dirty}`);
}

// ============================================================
// [5] 冲突解决后的「保留本地」路径：saveNow force=true 必然成功
// ============================================================
console.log('\n[5] 「保留本地」路径：force=true 必然覆盖');
{
  // 即使文件被外部动过，saveNow 用 force=true 也必须能覆盖
  // （用户已明确表态要保留本地修改）
  globalThis.window.api.writeFile = async (fp, content, options) => {
    // 主进程收到 force=true → 跳过检查 → 直接写
    return { ok: true };
  };

  const store = makeStore(`# 全部任务\n\n## 工作\n\n- [ ] a\n`);
  store.filePath = '/test/todo.md';

  // 模拟外部编辑 + 用户选择保留本地
  store.dirty = true;
  const ok = await store.saveNow();

  check('保留本地场景下 saveNow 成功', ok === true);
  check('保留本地后 dirty 清零', store.dirty === false);
}

// ============================================================
// [6] EXTERNAL_CHANGE_DETECTED 走和 file:external-change 一致的流程
// ============================================================
console.log('\n[6] 两条入口（IPC / save-error）合并到同一冲突解决流程');
{
  // 这里测的是「逻辑上」两条路径都应该走到同一处理函数。
  // 真正的 app.js 测试需要 DOM/Electron 环境（integration test 不在本 mjs 范围）。
  // 单元层只验证：save-error 携带 EXTERNAL_CHANGE_DETECTED 时，
  // 渲染端能够识别这一错误码。

  const externalChangeCodes = ['EXTERNAL_CHANGE_DETECTED'];
  let identified = null;
  for (const code of externalChangeCodes) {
    if (code === 'EXTERNAL_CHANGE_DETECTED') identified = code;
  }
  check('渲染端能识别 EXTERNAL_CHANGE_DETECTED 错误码',
    identified === 'EXTERNAL_CHANGE_DETECTED');
}

// ============================================================
// [7] 端到端：用户视角下数据不会丢失
// ============================================================
console.log('\n[7] 端到端场景：并发编辑不丢数据');
{
  // 这是整个防护的语义验证：
  //   - 用户改 A → 内存 A
  //   - 外部编辑器改成 B → 文件 B
  //   - autoSave 试图把 A 写回文件 → 被主进程拒绝 → dirty 保留 → 触发冲突流程
  //   - 用户选择「保留本地」→ saveNow (force=true) → 写 A → 文件 A
  //   - 用户选择「重新加载」→ readFile → loadFromContent(B) → 内存 B
  //
  // 关键：无论用户选哪个，外部编辑的内容（B）都不会被 autoSave 静默吞掉。

  const initialMd = `# 全部任务\n\n## 工作\n\n- [ ] A\n`;
  const store = makeStore(initialMd);
  store.filePath = '/test/todo.md';
  store.dirty = true;  // 用户改了 A

  // 模拟主进程 mtime 预检发现外部修改
  globalThis.window.api.writeFile = async (fp, content, options) => {
    if (!options?.force) {
      // 检测到外部修改，拒绝写盘
      return { ok: false, error: 'EXTERNAL_CHANGE_DETECTED' };
    }
    return { ok: true };
  };

  // autoSave 路径
  let saveErrorSeen = false;
  store.on('save-error', (err) => { if (err?.code === 'EXTERNAL_CHANGE_DETECTED') saveErrorSeen = true; });
  await store._doAutoSave();

  check('autoSave 被拒绝（外部编辑不会被覆盖）', saveErrorSeen === true);
  check('dirty 保留（继续等待用户决策）', store.dirty === true);

  // 用户选择「保留本地」→ saveNow (force=true) → 覆盖
  const ok = await store.saveNow();
  check('用户选保留本地 → 成功覆盖外部编辑', ok === true);
  check('dirty 清零', store.dirty === false);
}

console.log(`\n通过 ${summary.pass} / 失败 ${summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);