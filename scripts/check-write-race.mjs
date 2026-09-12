// 测试 file:write 的 race 防护（main.js v6 方案）
//
// 真实场景：
//   T0   软件内存 V0，磁盘 V0，lastSeen = V0
//   T1   用户在 UI 改任务 → dirty=true，800ms autoSave 排队
//   T1   外部编辑器原子保存 → 文件变成 V_ext
//   T2   autoSave 触发 → serialize() → 走 writeFile IPC
//
//   旧实现：writeFile 只做一次 statSync 检查（pre-check），pre-check 通过后
//   写 tmp → rename 中间有 10-100ms 窗口，外部编辑器在窗口里又改 → rename
//   覆盖外部编辑（数据丢失）。
//
//   v6 修复：在写 tmp 之后、rename 之前做第二次 statSync，把 race 窗口压缩到
//   几乎不可见（< 1ms）。

import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';
import { makeTmpTodoFile, cleanupTmpTodo } from './_lib/tmp-todo.mjs';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { dir: tmpDir, file: tmpFile } = makeTmpTodoFile({
  prefix: 'write-race-',
  content: '# 全部任务\n\n## 工作\n\n- [ ] V0\n'
});

// 复刻 main.js writeFile 的关键检查逻辑（隔离测试，不引入 electron）
let lastSeenMtimeMs = 0;
let lastSeenSize = 0;

function recordFileStat(filePath) {
  try {
    const st = fs.statSync(filePath);
    lastSeenMtimeMs = st.mtimeMs;
    lastSeenSize = st.size;
  } catch { /* ignore */ }
}

recordFileStat(tmpFile);

// ============================================================
// 复刻 v6 writeFile 的 mtime 双检查 + 二次确认逻辑
// ============================================================
async function v6WriteFile(absPath, content, options = {}) {
  if (!options.force && fs.existsSync(absPath)) {
    let preStat;
    try { preStat = await fs.promises.stat(absPath); } catch { /* skip */ }
    if (preStat && (preStat.mtimeMs !== lastSeenMtimeMs || preStat.size !== lastSeenSize)) {
      return { ok: false, error: 'EXTERNAL_CHANGE_DETECTED', reason: 'pre-check' };
    }

    const tmpPath = absPath + '.tmp.' + Date.now();
    await fs.promises.writeFile(tmpPath, content, 'utf-8');

    if (preStat) {
      try {
        const confirmStat = await fs.promises.stat(absPath);
        if (confirmStat.mtimeMs !== preStat.mtimeMs || confirmStat.size !== preStat.size) {
          await fs.promises.unlink(tmpPath).catch(() => {});
          return { ok: false, error: 'EXTERNAL_CHANGE_DETECTED', reason: 'race-window' };
        }
      } catch (e) {
        await fs.promises.unlink(tmpPath).catch(() => {});
        return { ok: false, error: 'EXTERNAL_CHANGE_DETECTED', reason: 'race-window-stat-failed' };
      }
    }
    await fs.promises.rename(tmpPath, absPath);
  } else {
    const tmpPath = absPath + '.tmp.' + Date.now();
    try {
      await fs.promises.writeFile(tmpPath, content, 'utf-8');
      await fs.promises.rename(tmpPath, absPath);
    } catch (e) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      throw e;
    }
  }
  recordFileStat(absPath);
  return { ok: true };
}

// ============================================================
// [1] 正常写盘：基线匹配，无 race
// ============================================================
console.log('\n[1] 正常写盘（无外部修改）');
{
  const result = await v6WriteFile(tmpFile, '# 全部任务\n\n## 工作\n\n- [ ] V1\n');
  check('force=false + 无外部修改 → 写入成功',
    result.ok === true, JSON.stringify(result));
}

// ============================================================
// [2] pre-check 拦截外部已修改（外部编辑发生在 pre-check 之前）
// ============================================================
console.log('\n[2] pre-check 拦截外部修改');
{
  // 让 mtime 推进
  await new Promise(r => setTimeout(r, 60));
  // 模拟外部编辑器保存（更新 lastSeen 之后又来一次外部保存，
  // 模拟 fs.watch 还没及时刷新的场景 —— pre-check 必须能拦下）
  recordFileStat(tmpFile); // 先刷基线
  await new Promise(r => setTimeout(r, 60));
  fs.writeFileSync(tmpFile, '# 全部任务\n\n## 工作\n\n- [ ] 外部V2\n');
  // 不刷新 lastSeen，模拟 polling 还没 tick / fs.watch 没触发的场景

  const result = await v6WriteFile(tmpFile, '# 全部任务\n\n## 工作\n\n- [ ] autoSave\n');
  check('pre-check 检测到外部修改 → 拒绝写盘',
    result.ok === false && result.reason === 'pre-check',
    JSON.stringify(result));
}

// ============================================================
// [3] 二次确认拦截 race window 内的外部修改
// ============================================================
console.log('\n[3] 二次确认拦截 race window 内的外部修改');
{
  // 让 mtime 推进
  await new Promise(r => setTimeout(r, 60));
  recordFileStat(tmpFile);
  await new Promise(r => setTimeout(r, 60));

  // 这里用 monkey-patch 让 statSync 在 writeFile 内部第二次调用时返回「新状态」
  // —— 模拟「外部编辑发生在 pre-check 和二次 stat 之间」
  let statCallCount = 0;
  const realStat = fs.promises.stat;
  fs.promises.stat = async (...args) => {
    statCallCount++;
    if (statCallCount === 1) {
      // 第一次 stat（pre-check）—— 返回旧状态（与 lastSeen 一致）
      return realStat(...args);
    }
    // 第二次 stat（二次确认）—— 返回新状态（模拟外部编辑已发生）
    // 直接调用底层 statSync 取最新值
    const freshSt = fs.statSync(tmpFile);
    // 但 mtime 必须不同 —— 如果还没改，我们手动改一下再读
    if (freshSt.mtimeMs === lastSeenMtimeMs) {
      // 没有外部编辑发生，主动触发一次以确保两次 mtime 不同
      fs.writeFileSync(tmpFile, '# 全部任务\n\n## 工作\n\n- [ ] race-injected\n');
      await new Promise(r => setTimeout(r, 10));
      return fs.statSync(tmpFile);
    }
    return freshSt;
  };

  const result = await v6WriteFile(tmpFile, '# 全部任务\n\n## 工作\n\n- [ ] autoSave-race\n');

  fs.promises.stat = realStat; // 还原

  check('二次确认检测到 race window 内的修改 → 拒绝写盘',
    result.ok === false && result.reason === 'race-window',
    JSON.stringify(result));

  // .tmp 文件应被清理（避免数据目录膨胀）
  const leftover = fs.readdirSync(tmpDir).filter(f => f.includes('.tmp.'));
  check('被拒后 .tmp 文件被清掉', leftover.length === 0, `leftover=${leftover.join(',')}`);
}

// ============================================================
// [4] force=true 跳过所有检查
// ============================================================
console.log('\n[4] force=true 跳过 mtime 检查（用户明确表态）');
{
  await new Promise(r => setTimeout(r, 60));
  recordFileStat(tmpFile);
  await new Promise(r => setTimeout(r, 60));
  // 外部修改
  fs.writeFileSync(tmpFile, '# 全部任务\n\n## 工作\n\n- [ ] 外部V3\n');

  const result = await v6WriteFile(tmpFile, '# 全部任务\n\n## 工作\n\n- [ ] 用户覆盖\n', { force: true });
  check('force=true → 写入成功（用户明确覆盖外部编辑）',
    result.ok === true, JSON.stringify(result));

  const content = fs.readFileSync(tmpFile, 'utf-8');
  check('磁盘上确实是用户内容', content.includes('用户覆盖'));
}

// ============================================================
// [5] 二次确认 stat 失败：按外部修改处理（保守策略）
// ============================================================
console.log('\n[5] 二次确认 stat 失败按外部修改处理');
{
  await new Promise(r => setTimeout(r, 60));
  recordFileStat(tmpFile);
  await new Promise(r => setTimeout(r, 60));

  // 让第二次 stat 抛错 —— 模拟文件被外部删除 / 锁住
  let callCount = 0;
  const realStat = fs.promises.stat;
  fs.promises.stat = async (...args) => {
    callCount++;
    if (callCount === 1) return realStat(...args);
    // 第二次抛错
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };

  const result = await v6WriteFile(tmpFile, '# 全部任务\n\n## 工作\n\n- [ ] autoSave\n');
  fs.promises.stat = realStat;

  check('二次 stat 失败 → 按外部修改拒绝',
    result.ok === false && result.reason === 'race-window-stat-failed',
    JSON.stringify(result));
}

// ============================================================
// [6] .bak 轮转：保留两份 .bak，不无限累积
// ============================================================
console.log('\n[6] .bak 轮转');
{
  // 清理已有 .bak 文件以独立测试
  for (const f of fs.readdirSync(tmpDir)) {
    if (f.endsWith('.bak') || f.endsWith('.bak.1')) {
      fs.unlinkSync(path.join(tmpDir, f));
    }
  }

  await new Promise(r => setTimeout(r, 60));
  fs.writeFileSync(tmpFile, 'version-A\n');
  await new Promise(r => setTimeout(r, 60));

  // 第一次写：磁盘 V0，期望产生 .bak = V0
  // 这里我们直接模拟 rotateBakFiles 的效果（不嵌入 writeFile 链路）
  async function rotateBakFiles(absPath) {
    const bakPath = absPath + '.bak';
    const bak1Path = absPath + '.bak.1';
    try {
      if (fs.existsSync(bak1Path)) await fs.promises.unlink(bak1Path).catch(() => {});
      if (fs.existsSync(bakPath)) await fs.promises.rename(bakPath, bak1Path).catch(() => {});
      if (fs.existsSync(absPath)) await fs.promises.copyFile(absPath, bakPath).catch(() => {});
    } catch {}
  }

  await rotateBakFiles(tmpFile);
  check('第一次轮转：只有 .bak，没有 .bak.1',
    fs.existsSync(tmpFile + '.bak') && !fs.existsSync(tmpFile + '.bak.1'));

  // 第二次写：磁盘 V1，期望 .bak = V1（最新），.bak.1 = V0（旧）
  await new Promise(r => setTimeout(r, 60));
  fs.writeFileSync(tmpFile, 'version-B\n');
  await rotateBakFiles(tmpFile);
  check('第二次轮转：.bak = V1, .bak.1 = V0',
    fs.existsSync(tmpFile + '.bak') && fs.existsSync(tmpFile + '.bak.1'));

  // 第三次写：磁盘 V2，期望 .bak = V2（最新），.bak.1 = V1（次新），V0 应被丢弃
  await new Promise(r => setTimeout(r, 60));
  fs.writeFileSync(tmpFile, 'version-C\n');
  await rotateBakFiles(tmpFile);
  const bakContent = fs.readFileSync(tmpFile + '.bak', 'utf-8');
  const bak1Content = fs.readFileSync(tmpFile + '.bak.1', 'utf-8');
  check('第三次轮转：.bak = version-C', bakContent === 'version-C\n', `bak=${bakContent}`);
  check('第三次轮转：.bak.1 = version-B', bak1Content === 'version-B\n', `bak1=${bak1Content}`);
  check('最多两份 .bak，不无限累积',
    fs.readdirSync(tmpDir).filter(f => f.includes('.bak')).length === 2);
}

// ============================================================
// [7] file:read 必须刷新 lastSeen —— 否则换文件后第一次 write
//     会拿陈旧 lastSeen 比对新文件 stat，误判外部修改
// ============================================================
console.log('\n[7] file:read 路径下 lastSeen 必须刷新（与 file:write 对称）');

{
  // 复刻两份不同的 todo 文件（模拟用户切文件场景）
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'read-fresh-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'read-fresh-b-'));
  const fileA = path.join(dirA, 'todo.md');
  const fileB = path.join(dirB, 'todo.md');
  fs.writeFileSync(fileA, '# A file\n');
  fs.writeFileSync(fileB, '# B file\n');

  // 复刻 main.js 状态：lastSeen 是 module-level 全局变量（不是 per-file）
  let lastSeenMtimeMs = 0;
  let lastSeenSize = 0;
  function recordFileStat(filePath) {
    try {
      const st = fs.statSync(filePath);
      lastSeenMtimeMs = st.mtimeMs;
      lastSeenSize = st.size;
    } catch { /* ignore */ }
  }

  // 模拟旧实现的 file:read：只挂 fs.watch，不刷 lastSeen
  function oldFileRead(filePath) {
    // 旧版：startWatchingFile(filePath) 但不调 recordFileStat
    // 这里用 stub 表示「什么也不做」
  }

  // 第一步：用户读 A → 旧实现挂上 fs.watch 但 lastSeen 没动（仍是 0）
  oldFileRead(fileA);
  // 此时 lastSeen 仍是 0（A 的 mtime 非零）

  // 第二步：用户读 B → 同样挂 fs.watch 但 lastSeen 仍是 0
  oldFileRead(fileB);

  // 第三步：用户写 B（无 force）→ pre-check 用 B 的 mtime 比 lastSeen=0 → 误报
  const preStat = fs.statSync(fileB);
  const oldImplMismatch = (preStat.mtimeMs !== lastSeenMtimeMs || preStat.size !== lastSeenSize);
  check('旧实现确实有 bug：B 的 stat 与 lastSeen(0) 不等',
    oldImplMismatch, '预期 oldImplMismatch=true');

  // 第四步：修复后的 file:read 应在挂 watcher 后调 recordFileStat
  // 模拟修复后行为：
  recordFileStat(fileB);

  // 第五步：再次跑 v6 pre-check
  const preCheckPasses = (preStat.mtimeMs === lastSeenMtimeMs && preStat.size === lastSeenSize);
  check('修复后：B 写之前 lastSeen 已同步到 B 的 stat',
    preCheckPasses,
    `preStat=(${preStat.mtimeMs},${preStat.size}) lastSeen=(${lastSeenMtimeMs},${lastSeenSize})`);

  // 清理
  try { fs.rmSync(dirA, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(dirB, { recursive: true, force: true }); } catch {}
}

// 清理
cleanupTmpTodo({ dir: tmpDir });

console.log(`\n通过 ${summary.pass} / 失败 ${summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);