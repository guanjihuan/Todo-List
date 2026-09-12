// 跨脚本共享：统一的断言 / 计数 / 退出 helper。
//
// 之前散落在 ~25 个脚本里的断言模式有 3 种：
//   1) check(name, cond, detail='') + pass/fail 计数（大多数）
//   2) ok(name) / fail(name, msg) + failed 计数（少数）
//   3) 自定义 ok/bad + 自己的计数器（settings / backup / status-meta）
//
// 这里统一提供：
//   - check(name, cond, detail?)  —— 主流风格：条件断言，detail 是失败时的诊断
//   - ok(name) / bad(name, msg)   —— 风格 2 / 3 的兼容入口（适合「手动构造失败信息」）
//   - printSummary(label)         —— 打印「通过 X / 失败 Y」并按需 exit
//   - summary 对象                 —— 共享计数器，避免每个脚本各定义 pass/fail
//
// 用法：
//   import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
//   check('某断言', cond, '可选失败详情');
//   ...
//   printSummary('check-batch-ops');

export const summary = { pass: 0, fail: 0 };

/**
 * 主流断言：cond 为真则通过，否则打印失败 + 可选详情。
 * @param {string} name
 * @param {boolean} cond
 * @param {string} [detail]
 */
export function check(name, cond, detail = '') {
  if (cond) {
    summary.pass++;
    console.log(`  ✓ ${name}`);
  } else {
    summary.fail++;
    const tail = detail ? ` — ${detail}` : '';
    console.log(`  ✗ ${name}${tail}`);
  }
}

/**
 * 显式 ok：用于「不需要断言条件，直接报告通过」的场景。
 * 兼容旧脚本里的 ok() 风格。
 * @param {string} name
 */
export function ok(name) {
  summary.pass++;
  console.log(`  ✓ ${name}`);
}

/**
 * 显式 bad：用于「手动构造失败信息」的场景（错误细节比条件断言更复杂时）。
 * 兼容旧脚本里的 fail()/bad() 风格。
 * @param {string} name
 * @param {string} [msg]
 */
export function bad(name, msg = '') {
  summary.fail++;
  const tail = msg ? `: ${msg}` : '';
  console.log(`  ✗ ${name}${tail}`);
}

/**
 * 打印「通过 X / 失败 Y」总结行。
 * exitOnFail=true 时若有失败则以 exit 1 退出（脚本默认应这么用）。
 *
 * @param {string} [label] - 总结行前的标签，例如脚本名
 * @param {boolean} [exitOnFail=true]
 */
export function printSummary(label = '', exitOnFail = true) {
  const head = label ? `${label} — ` : '';
  console.log(`\n${head}通过 ${summary.pass} / 失败 ${summary.fail}`);
  if (exitOnFail && summary.fail > 0) {
    process.exit(1);
  }
}

/**
 * 重置计数器 —— 脚本里想做多轮隔离断言时调用。
 * 大多数脚本不需要：进程结束就 exit，counter 自然释放。
 */
export function resetSummary() {
  summary.pass = 0;
  summary.fail = 0;
}
