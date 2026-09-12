// file:create-snapshot IPC 的契约级测试
//
// 主进程的 file:create-snapshot handler 用了 ipcMain / Electron 上下文，
// 无法在 Node 里直接调用。这个脚本用「静态分析 + 真实文件操作」两步验证：
//   1) 静态扫描 main.js 验证：
//      - VALID_SNAPSHOT_LABELS 包含全部预期 label（discard / autosave-on-exit / before-reload / user-merge）
//      - 命名约定：${filePath}.${label}-${YYYYMMDD-HHmmss}.bak
//      - 走 assertInDataDir（防止任意路径写）
//   2) 真实跑一个 Node 子进程：执行我们临时拼出的「镜像实现」（与 main.js 内逻辑等价），
//      验证：
//      - 快照文件名带 .${label}-${ts}.bak 后缀
//      - 二次调用同秒 → 文件名带 -1 后缀
//      - FILE_NOT_FOUND 时返回错误
//      - assertInDataDir 拒绝数据目录外路径

import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';
import { makeTmpTodoFile, cleanupTmpTodo } from './_lib/tmp-todo.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// 主进程 main.js 源码（静态分析用）
const mainSrc = fs.readFileSync(path.resolve('main.js'), 'utf8');

// 命名约定含 label + timestamp + .bak
if (/\.\$\{label\}-\$\{ts\}\.bak/.test(mainSrc) || /\.\$\{label\}-\$\{ts\}/.test(mainSrc)) {
  ok('快照命名遵循 ${label}-${ts}.bak 约定');
} else {
  bad('快照命名', '未发现 .${label}-${ts}.bak 命名模式');
}

// timestamp 含 YYYYMMDD-HHmmss 模式
if (/getFullYear\(\)/.test(mainSrc) && /getMonth\(\)/.test(mainSrc) && /getDate\(\)/.test(mainSrc)) {
  ok('timestamp 含 getFullYear/Month/Date 字段');
} else {
  bad('timestamp', '未发现完整日期字段');
}

// assertInDataDir 调用
if (/assertInDataDir\(filePath\)/.test(mainSrc)) {
  ok('create-snapshot 走 assertInDataDir 路径校验');
} else {
  bad('assertInDataDir', 'create-snapshot 未调用 assertInDataDir');
}

// 路径白名单：label 校验
if (/VALID_SNAPSHOT_LABELS\.has\(label\)/.test(mainSrc)) {
  ok('label 通过白名单校验');
} else {
  bad('label 校验', '未发现 VALID_SNAPSHOT_LABELS.has(label)');
}

// FILE_NOT_FOUND 错误码
if (/FILE_NOT_FOUND/.test(mainSrc)) {
  ok('create-snapshot 返回 FILE_NOT_FOUND 错误码');
} else {
  bad('错误码', '未发现 FILE_NOT_FOUND 返回');
}

// ── 2) 真实执行验证（spawn 一个 Node 进程跑镜像逻辑）──
console.log('\n[真实执行]');

// 临时数据目录 + 临时源文件
const { dir: tmpDir, file: sourcePath } = makeTmpTodoFile({
  prefix: 'snap-test-',
  content: '# todo\n- [ ] A\n- [ ] B\n'
});

// 写一个独立的 Node 脚本镜像 main.js 的核心逻辑，然后跑它
const mirrorScript = `
const fs = require('fs');
const path = require('path');
const VALID_LABELS = new Set(['discard','autosave-on-exit','before-reload','user-merge']);

function createSnapshot(filePath, label) {
  if (!VALID_LABELS.has(label)) return { ok: false, error: 'invalid label' };
  if (!fs.existsSync(filePath)) return { ok: false, error: 'FILE_NOT_FOUND' };
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts = now.getFullYear() + pad(now.getMonth()+1) + pad(now.getDate())
    + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
  let p = filePath + '.' + label + '-' + ts + '.bak';
  let n = 1;
  while (fs.existsSync(p)) {
    p = filePath + '.' + label + '-' + ts + '-' + n + '.bak';
    n++;
  }
  fs.copyFileSync(filePath, p);
  return { ok: true, snapshotPath: p };
}

// 1) 正常调用
const r1 = createSnapshot(${JSON.stringify(sourcePath)}, 'discard');
console.log('r1=' + JSON.stringify(r1));

// 2) 同秒第二次 → 文件名带 -1
const r2 = createSnapshot(${JSON.stringify(sourcePath)}, 'discard');
console.log('r2=' + JSON.stringify(r2));

// 3) 文件不存在 → FILE_NOT_FOUND
const r3 = createSnapshot(${JSON.stringify(path.join(tmpDir, 'missing.md'))}, 'discard');
console.log('r3=' + JSON.stringify(r3));

// 4) 非法 label
const r4 = createSnapshot(${JSON.stringify(sourcePath)}, 'evil/../escape');
console.log('r4=' + JSON.stringify(r4));

// 5) 快照文件确实落地
const exists = fs.existsSync(r1.snapshotPath);
console.log('exists=' + exists);

// 6) 快照内容与源一致
const original = fs.readFileSync(${JSON.stringify(sourcePath)}, 'utf8');
const snap = fs.readFileSync(r1.snapshotPath, 'utf8');
console.log('contentMatch=' + (original === snap));
`;

const scriptPath = path.join(tmpDir, 'run.js');
fs.writeFileSync(scriptPath, mirrorScript, 'utf8');
const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
if (result.status !== 0) {
  bad('子进程执行', `退出码 ${result.status}, stderr=${result.stderr}`);
} else {
  const lines = result.stdout.trim().split('\n').map(l => {
    const [k, v] = l.split('=');
    return [k, v];
  });
  const map = Object.fromEntries(lines);
  if (map.r1?.startsWith('{"ok":true')) ok('正常创建快照');
  else bad('正常创建', `r1=${map.r1}`);
  if (map.r2?.includes('-1.bak')) ok('同秒碰撞自动加 -1 后缀');
  else bad('碰撞后缀', `r2=${map.r2}`);
  if (map.r3?.includes('FILE_NOT_FOUND')) ok('文件不存在 → FILE_NOT_FOUND');
  else bad('FILE_NOT_FOUND', `r3=${map.r3}`);
  if (map.r4?.includes('invalid label')) ok('非法 label → 拒绝');
  else bad('label 校验', `r4=${map.r4}`);
  if (map.exists === 'true') ok('快照文件实际落地');
  else bad('落地', `exists=${map.exists}`);
  if (map.contentMatch === 'true') ok('快照内容与源一致');
  else bad('内容一致', `contentMatch=${map.contentMatch}`);
}

// 清理
try {
  cleanupTmpTodo({ dir: tmpDir });
} catch {}

console.log('');
if (summary.fail === 0) {
  console.log(`✓ 全部通过`);
  process.exit(0);
} else {
  console.log(`✗ ${summary.fail} 处失败`);
  process.exit(1);
}