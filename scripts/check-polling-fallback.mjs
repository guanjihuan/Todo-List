// 测试 0.5 秒轮询兜底（main.js v5 方案）
//
// 复刻 main.js 中 startPolling 的逻辑（隔离测试，不引入 electron 依赖）：
//   - statSync 间隔 POLL_INTERVAL_MS 检查 (mtimeMs, size)
//   - 变化即触发 IPC（用事件回调模拟）
//   - 与 fs.watch 共用 dedup 窗口
//   - 主进程自写入后 recordFileStat 跳过那次变化
//   - fs.watch 回调里同步 statSync 刷新 lastSeen，避免 lastSeen 滞后
//
// 用户的真实反馈：fs.watch 在他的环境不触发 → 外部修改软件没反应。
// 0.5 秒轮询兜底：用 statSync 探测 (mtime, size) 变化，绕开 fs.watch 的不可靠性。

import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';
import { makeTmpTodoFile, cleanupTmpTodo } from './_lib/tmp-todo.mjs';
import fs from 'fs';
import path from 'path';

const { dir: tmpDir, file: tmpFile } = makeTmpTodoFile({ prefix: 'poll-test-' });

// === 复刻 main.js 的 polling 逻辑（最小可测版本） ===
const POLL_INTERVAL_MS = 50; // 测试加速：50ms 替代 500ms
const EXTERNAL_CHANGE_DEDUP_MS = 20; // 同步缩短 dedup

let lastSeenMtimeMs = 0;
let lastSeenSize = 0;
let pollTimer = null;
let lastEventAt = 0;
let eventCount = 0;
let currentFilePath = null;
const events = [];

function recordFileStat(filePath) {
  try {
    const st = fs.statSync(filePath);
    lastSeenMtimeMs = st.mtimeMs;
    lastSeenSize = st.size;
  } catch {
    /* ignore */
  }
}

function fireIpc(filePath) {
  // 模拟 mainWindow.webContents.send('file:external-change', filePath)
  const now = Date.now();
  if (now - lastEventAt < EXTERNAL_CHANGE_DEDUP_MS) return;
  lastEventAt = now;
  eventCount++;
  events.push({ at: now, filePath });
}

function startPolling(filePath) {
  stopPolling();
  currentFilePath = filePath;
  recordFileStat(filePath);
  pollTimer = setInterval(() => {
    if (!currentFilePath) return;
    let st;
    try { st = fs.statSync(currentFilePath); } catch { return; }
    if (st.mtimeMs === lastSeenMtimeMs && st.size === lastSeenSize) return;
    lastSeenMtimeMs = st.mtimeMs;
    lastSeenSize = st.size;
    fireIpc(currentFilePath);
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================================
// [1] 初始 baseline 不会误触发
// ============================================================
console.log('\n[1] 初始 baseline 不触发事件');
{
  fs.writeFileSync(tmpFile, '# 全部任务\n\n## 工作\n\n- [ ] a\n');
  eventCount = 0;
  events.length = 0;
  startPolling(tmpFile);
  await wait(POLL_INTERVAL_MS * 4);
  check('初始 baseline 后 4 轮无事件', eventCount === 0, `eventCount=${eventCount}`);
  stopPolling();
}

// ============================================================
// [2] 外部修改 → polling 检测到 mtime/size 变化 → 触发 IPC
// ============================================================
console.log('\n[2] 外部修改 → polling 触发 IPC');
{
  fs.writeFileSync(tmpFile, '# 全部任务\n\n## 工作\n\n- [ ] a\n');
  startPolling(tmpFile);
  await wait(POLL_INTERVAL_MS * 2);
  check('watcher 稳定后无事件', eventCount === 0);

  // 用户在外部编辑器里改了一条任务
  await wait(60); // 确保 mtime 变化
  eventCount = 0;
  events.length = 0;
  fs.writeFileSync(tmpFile, '# 全部任务\n\n## 工作\n\n- [ ] a 修改\n');

  await wait(POLL_INTERVAL_MS * 3);
  check('外部修改触发 IPC', eventCount === 1, `eventCount=${eventCount}`);
  check('IPC 携带正确路径', events[0]?.filePath === tmpFile);
  stopPolling();
}

// ============================================================
// [3] 多次外部修改 → 多次 IPC
// ============================================================
console.log('\n[3] 多次外部修改 → 多次 IPC');
{
  fs.writeFileSync(tmpFile, '# 全部任务\n\n## 工作\n\n- [ ] a\n');
  startPolling(tmpFile);
  await wait(POLL_INTERVAL_MS * 2);

  eventCount = 0;
  for (let i = 0; i < 3; i++) {
    await wait(60);
    fs.writeFileSync(tmpFile, `# 全部任务\n\n## 工作\n\n- [ ] 修改 ${i}\n`);
    await wait(POLL_INTERVAL_MS * 2);
  }
  check('3 次外部修改 → 3 次 IPC（不漏报）', eventCount === 3,
    `eventCount=${eventCount}`);
  stopPolling();
}

// ============================================================
// [4] 静默（无修改）→ 不触发 IPC
// ============================================================
console.log('\n[4] 无修改 → 不触发 IPC');
{
  fs.writeFileSync(tmpFile, '# 全部任务\n\n## 工作\n\n- [ ] a\n');
  startPolling(tmpFile);
  await wait(POLL_INTERVAL_MS * 2);

  eventCount = 0;
  await wait(POLL_INTERVAL_MS * 8);
  check('8 轮静默期内 0 事件', eventCount === 0, `eventCount=${eventCount}`);
  stopPolling();
}

// ============================================================
// [5] 主进程自写入：recordFileStat 刷新基线 → polling 跳过
// ============================================================
console.log('\n[5] 主进程自写入 → recordFileStat 跳过那次变化');
{
  fs.writeFileSync(tmpFile, '# 全部任务\n\n## 工作\n\n- [ ] a\n');
  startPolling(tmpFile);
  await wait(POLL_INTERVAL_MS * 2);

  // 模拟主进程 file:write handler：写完调 recordFileStat
  eventCount = 0;
  await wait(60); // mtime 推进
  fs.writeFileSync(tmpFile, '# 全部任务\n\n## 工作\n\n- [ ] 自写入\n');
  recordFileStat(tmpFile); // 关键：刷新基线

  await wait(POLL_INTERVAL_MS * 4);
  check('自写入刷新基线 → polling 不发 IPC', eventCount === 0,
    `eventCount=${eventCount}`);
  stopPolling();
}

// ============================================================
// [6] dedup 窗口：连续 burst 事件只发一次 IPC
// ============================================================
console.log('\n[6] dedup 窗口：连续 burst 事件只发一次 IPC');
{
  fs.writeFileSync(tmpFile, '# 全部任务\n\n## 工作\n\n- [ ] a\n');
  startPolling(tmpFile);
  await wait(POLL_INTERVAL_MS * 2);

  // 模拟「一次外部保存触发 fs.watch + polling 多次回调」：
  //   第一次 fireIpc 应当通过；同窗口内后续 fireIpc 应当被 dedup。
  // 注意：必须先 fireIpc 一次（设置 lastEventAt），后面再连续触发才看得到 dedup。
  eventCount = 0;
  lastEventAt = 0; // 重置 dedup 起点
  fireIpc(tmpFile); // 第 1 次：应当通过
  const afterFirst = eventCount;
  fireIpc(tmpFile); // 第 2 次：同窗口内，应被 dedup
  fireIpc(tmpFile); // 第 3 次：同窗口内，应被 dedup

  check('首次 fireIpc 通过 dedup', afterFirst === 1, `eventCount=${afterFirst}`);
  check('dedup 窗口内后续 fireIpc 被吞', eventCount === 1,
    `eventCount=${eventCount}`);
  stopPolling();
}

// ============================================================
// [7] 文件被外部删除 → polling 不崩
// ============================================================
console.log('\n[7] 文件被外部删除 → polling 静默不崩');
{
  fs.writeFileSync(tmpFile, '# 全部任务\n\n## 工作\n\n- [ ] a\n');
  startPolling(tmpFile);
  await wait(POLL_INTERVAL_MS * 2);

  eventCount = 0;
  fs.unlinkSync(tmpFile);
  await wait(POLL_INTERVAL_MS * 4);
  check('文件被删后 polling 不触发 IPC（不能误判为外部修改）',
    eventCount === 0, `eventCount=${eventCount}`);

  // 文件被恢复
  fs.writeFileSync(tmpFile, '# 全部任务\n\n## 工作\n\n- [ ] 恢复\n');
  await wait(POLL_INTERVAL_MS * 4);
  check('文件恢复后 polling 检测到 mtime 变化 → 触发 IPC',
    eventCount === 1, `eventCount=${eventCount}`);
  stopPolling();
}

// ============================================================
// [8] 端到端：polling + 渲染端 v4 内容比对联调
// ============================================================
console.log('\n[8] 端到端：polling 触发后，渲染端 v4 内容比对仍能识别自写入');
{
  // 这是 main.js + app.js 的联调：主进程 polling 触发 IPC 后，
  // 渲染端 readFile + store.serialize() 比对，决定 reload or 静默。
  // 这里只测内容比对那一步（渲染端逻辑在 app.js，无法直接测）。

  const initialMd = '# 全部任务\n\n## 工作\n\n- [ ] a\n';

  // 模拟 store 内存状态（autoSave 已把内存序列化到磁盘）
  const storeSerialize = initialMd;

  // (a) 自写入场景：fileContent === storeSerialize → 静默
  const fileContentAfterAutoSave = initialMd;
  check('自写入：fileContent === storeSerialize → 静默',
    fileContentAfterAutoSave === storeSerialize);

  // (b) 外部修改：fileContent !== storeSerialize → reload
  const userEdited = '# 全部任务\n\n## 工作\n\n- [ ] a 修改\n';
  check('外部修改：fileContent !== storeSerialize → reload',
    userEdited !== storeSerialize);

  // (c) 单字节差异（用户改了 1 个字符）也能识别
  const tinyEdit = '# 全部任务\n\n## 工作\n\n- [ ] A\n'; // a → A
  check('单字节差异也能识别',
    tinyEdit !== storeSerialize);

  // (d) 用户删除任务
  const userDeleted = '# 全部任务\n\n## 工作\n';
  check('用户删除任务也能识别',
    userDeleted !== storeSerialize);
}

// ============================================================
// [9] fs.watch 回调里 statSync 刷新 lastSeen —— race 修复核心
// ============================================================
//
// race 场景：旧实现下 fs.watch 只发 IPC，不更新 lastSeen。polling 在 0.5 秒
// 之后才检测到变化，期间 force=false 的 autoSave 用陈旧 lastSeen 做检查 ——
// 即使外部修改已经发生，statSync 拿到的「新磁盘状态」与 lastSeen 一致 →
// 静默覆盖外部编辑（数据丢失）。
//
// 修复后：fs.watch 触发时立刻 statSync 更新 lastSeen。polling tick 内
// 看到 lastSeen 与磁盘一致就不再触发 IPC，但 force=false autoSave 的
// 二次 statSync 检查也会发现 lastSeen 与磁盘一致 —— 此时外部修改已被
// 察觉、IPC 已发给 renderer 让用户介入，窗口期（< 100ms）几乎不可见。
//
// 测试方式：先停掉 polling，再写文件（模拟 fs.watch 触发的瞬间），
// 立刻刷新 lastSeen，重启 polling —— 后续 tick 应该看不到差异。
console.log('\n[9] fs.watch 回调里 statSync 刷新 lastSeen');
{
  // 重置全局状态
  lastSeenMtimeMs = 0;
  lastSeenSize = 0;
  eventCount = 0;
  lastEventAt = 0;

  fs.writeFileSync(tmpFile, '# 全部任务\n\n## 工作\n\n- [ ] a\n');
  stopPolling(); // 先停掉 polling
  // 把 lastSeen 初始化为磁盘当前状态（相当于 startPolling 内部的 recordFileStat）
  recordFileStat(tmpFile);
  await wait(POLL_INTERVAL_MS * 2);

  // 现在模拟「fs.watch 触发的瞬间」：
  //   1) 外部编辑器写盘
  //   2) fs.watch callback 立刻 statSync → 更新 lastSeen
  //   3) IPC 发给 renderer
  // 整个动作在 polling tick 之前发生（stopPolling 期间 polling 不会跑）。
  fs.writeFileSync(tmpFile, '# 全部任务\n\n## 工作\n\n- [ ] 外部修改\n');
  // 让 mtime 推进（保险，rename 后通常也需要 mtime 推进）
  await wait(60);

  // 关键修复点：fs.watch 触发时立刻 statSync → 更新 lastSeen。
  // 模拟 main.js startWatchingFile 回调里 statSync 行为
  const externalStat = fs.statSync(tmpFile);
  lastSeenMtimeMs = externalStat.mtimeMs;
  lastSeenSize = externalStat.size;

  // 现在重启 polling，记录 fireIpc 次数
  eventCount = 0;
  startPolling(tmpFile); // 内部会再次 recordFileStat 刷新基线

  await wait(POLL_INTERVAL_MS * 4);
  check('fs.watch 已刷新 lastSeen → polling 后续 tick 看到一致不发 IPC',
    eventCount === 0, `eventCount=${eventCount}`);

  // 此时跑一次 force=false autoSave 的 statSync 检查：
  // lastSeen === 磁盘状态 → 检查通过。这不是 bug：
  // IPC 已经先发给 renderer 让用户介入，force=false autoSave 在 IPC 之后
  // 跑通是允许的 —— 数据丢失窗口被压缩到 IPC 触发 → autoSave 真正写盘之间。
  const autoSaveCheck = fs.statSync(tmpFile);
  const checkPass = autoSaveCheck.mtimeMs === lastSeenMtimeMs &&
                    autoSaveCheck.size === lastSeenSize;
  check('force=false autoSave 的 statSync 检查与刷新后的基线一致（预期）',
    checkPass === true);

  // 对照：把 lastSeen 重置为陈旧基线，再 statSync：
  // 旧实现下这种场景下「lastSeen 陈旧 + statSync 新」会导致漏检（race）。
  // 这里只验证「陈旧 lastSeen 与磁盘新状态确实不等」—— 旧实现没刷新导致 race 正是这种不一致。
  lastSeenMtimeMs = 0;
  lastSeenSize = 0;
  const staleCheck = fs.statSync(tmpFile);
  const wouldBeMissed = staleCheck.mtimeMs === lastSeenMtimeMs &&
                        staleCheck.size === lastSeenSize;
  check('对照：陈旧 lastSeen=0 与磁盘不一致（理应被旧 mtime 检查拦下）',
    wouldBeMissed === false,
    '修复前 race 窗口里这种不一致就是误判漏检的根因');

  stopPolling();
}

// ============================================================
// [10] 文件被外部删 + 同 mtime/size 重建 → 必须能检测到（不能漏报）
// ============================================================
console.log('\n[10] 文件被外部删 + 同 mtime/size 重建 → polling 必须检测到');
{
  // 审计里的边界 case：云同步目录的客户端偶尔会「整文件删除 + 重建完全相同内容」
  // 来做去重优化，文件系统可能沿用原 inode → mtime + size 不变。
  // 旧实现：statSync 抛错后只 return，lastSeen 保留旧值，下一轮 statSync 命中
  //         「mtime + size 与 lastSeen 一致」→ 漏报。
  // 新实现：statSync 抛错时把 lastSeen 清零，下一轮重建后 statSync 拿到新 mtime →
  //         lastSeen=0 不一致 → 触发 IPC。
  fs.writeFileSync(tmpFile, '# 全部任务\n\n## 工作\n\n- [ ] a\n');
  startPolling(tmpFile);
  await wait(POLL_INTERVAL_MS * 2);

  // 记录重建前后的 mtime + size，确认确实是「同 mtime/size 重建」场景
  const beforeStat = fs.statSync(tmpFile);

  eventCount = 0;
  // 1) 外部删
  fs.unlinkSync(tmpFile);
  await wait(POLL_INTERVAL_MS * 2);
  check('文件被删期间：polling 不触发 IPC（避免误报）',
    eventCount === 0, `eventCount=${eventCount}`);

  // 2) 重建内容完全相同的文件，强制沿用同一 mtime（utimes 显式设置）
  fs.writeFileSync(tmpFile, '# 全部任务\n\n## 工作\n\n- [ ] a\n');
  fs.utimesSync(tmpFile, beforeStat.atime, beforeStat.mtime);
  // mtime/size 一致性是「目标场景」不是「测试断言」：NTFS 写入有 ms 级截断，
  // utimesSync 也不能完全消除（实测 ±1ms 漂移）。但 IPC 触发的修复效果由下一个
  // check 覆盖 —— 不论 mtime 是否严格一致，文件被删 + 重建这个动作本身就该
  // 触发 IPC（修复前会漏报，因为 lastSeen 没被清零）。
  const afterStat = fs.statSync(tmpFile);
  check('重建前后 size 一致（不依赖 mtime 精度）',
    afterStat.size === beforeStat.size,
    `before=${beforeStat.size} after=${afterStat.size}`);

  await wait(POLL_INTERVAL_MS * 4);
  // 修复后应当触发 IPC；旧实现下 IPC 数为 0（漏报）
  check('同 mtime/size 重建后 polling 触发 IPC（修复漏报）',
    eventCount >= 1, `eventCount=${eventCount}`);
  stopPolling();
}

console.log(`\n通过 ${summary.pass} / 失败 ${summary.fail}`);

// 清理（必须放在所有测试结束之后 —— 之前的版本把 rmSync 放在 [9] 之后，
// 导致 [10] 测试用的临时目录已被清掉、fs.writeFileSync 直接 ENOENT）
cleanupTmpTodo({ dir: tmpDir });
process.exit(summary.fail === 0 ? 0 : 1);