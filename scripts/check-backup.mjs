import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';
import { installApiStub } from './_lib/api-stub.mjs';
// 每日备份开关 + SettingsStore 输入校验的回归测试。
//
// 触发 bug 的姿势与 check-settings.mjs 同源 —— 脏值穿过校验污染内存 + 配置文件：
//
//   1. update({ backupEnabled: 'true' })
//      旧实现下 theme / filter / sortBy / fontSize 走 VALID_VALUES 字符串枚举，
//      唯独 backupEnabled 是 boolean —— 如果 isValidValue 没单独分支处理，
//      字符串 'true' 就直接被吞掉变成 settings.backupEnabled === 'true'，
//      下次保存把脏值固化进 config.json。
//
//   2. 用户手工编辑 config.json，写成 backupEnabled: 1
//      加载端只校验 key 是否在 DEFAULT_SETTINGS 里 —— 数字 1 会进内存，
//      后续 update / persist 把它当合法值反复写入。
//
// 这份脚本同样构造 SettingsStore + 桩 api，验证以上姿势都被拦截，
// 并补一个 happy-path 验证持久化走的字段（lastBackupDate）不在
// DEFAULT_SETTINGS 里 —— 主进程直接通过 saveConfig() 写入，
// 不应该被渲染进程的 SettingsStore.update 路径覆盖。

installApiStub();

const { SettingsStore } = await import('../src/settings-store.js');

// ============================================
//  默认值
// ============================================
console.log('[1] 默认值');

{
  const s = new SettingsStore();
  if (s.get('backupEnabled') === true) ok('backupEnabled 默认值是 true（开箱即用）');
  else bad('backupEnabled 默认值错误', `当前 ${JSON.stringify(s.get('backupEnabled'))}`);
}

// ============================================
//  update() 输入校验
// ============================================
console.log('\n[2] update() 拒绝非 boolean 值');
// 默认是 true —— 任何非法输入必须被拒绝，且不污染内存（保持默认 true）。

{
  const s = new SettingsStore();
  await s.update({ backupEnabled: 'true' });
  if (s.get('backupEnabled') === true) ok("update({backupEnabled: 'true'}) 字符串被拒绝，默认 true 未被污染");
  else bad("backupEnabled 被字符串 'true' 污染", `当前 ${JSON.stringify(s.get('backupEnabled'))}`);
}

{
  const s = new SettingsStore();
  await s.update({ backupEnabled: 1 });
  if (s.get('backupEnabled') === true) ok('update({backupEnabled: 1}) 数字被拒绝，默认 true 未被污染');
  else bad('backupEnabled 被数字污染', `当前 ${JSON.stringify(s.get('backupEnabled'))}`);
}

{
  const s = new SettingsStore();
  await s.update({ backupEnabled: null });
  if (s.get('backupEnabled') === true) ok('update({backupEnabled: null}) null 被拒绝，默认 true 未被污染');
  else bad('backupEnabled 被 null 污染', `当前 ${JSON.stringify(s.get('backupEnabled'))}`);
}

{
  const s = new SettingsStore();
  await s.update({ backupEnabled: undefined });
  if (s.get('backupEnabled') === true) ok('update({backupEnabled: undefined}) undefined 被拒绝，默认 true 未被污染');
  else bad('backupEnabled 被 undefined 污染', `当前 ${JSON.stringify(s.get('backupEnabled'))}`);
}

{
  const s = new SettingsStore();
  await s.update({ backupEnabled: { evil: true } });
  if (s.get('backupEnabled') === true) ok('update({backupEnabled: object}) 对象被拒绝，默认 true 未被污染');
  else bad('backupEnabled 被对象污染', `当前 ${JSON.stringify(s.get('backupEnabled'))}`);
}

// ============================================
//  update() happy path —— 默认 true，所以「设 false」才有持久化意义
// ============================================
console.log('\n[3] update() 接受合法 boolean');

{
  const s = new SettingsStore();
  // 先切到 false 再切回 true：默认 true 直接发 true 会因「值未变」返回 false
  await s.update({ backupEnabled: false });
  const result = await s.update({ backupEnabled: true });
  if (s.get('backupEnabled') === true && result === true) {
    ok('update({backupEnabled: true}) 从 false 切回 true 生效');
  } else {
    bad('合法 true 未生效', JSON.stringify({ value: s.get('backupEnabled'), result }));
  }
}

{
  const s = new SettingsStore();
  await s.update({ backupEnabled: true });
  const result = await s.update({ backupEnabled: false });
  if (s.get('backupEnabled') === false && result === true) {
    ok('update({backupEnabled: false}) 从 true 切回 false 生效');
  } else {
    bad('切回 false 未生效', JSON.stringify({ value: s.get('backupEnabled'), result }));
  }
}

{
  const s = new SettingsStore();
  // 同样的值再发一次：update() 应该返回 false，不触发持久化（节省 IO）
  await s.update({ backupEnabled: true });
  const result = await s.update({ backupEnabled: true });
  if (result === false) ok('update({backupEnabled: true}) 同值再发返回 false');
  else bad('同值再发仍触发持久化', `返回 ${result}`);
}

// ============================================
//  load() 输入校验 —— 模拟配置文件被外部改成脏值
// ============================================
console.log('\n[4] load() 从脏配置恢复默认值');

{
  const s = new SettingsStore();
  const orig = globalThis.window.api.getSettings;
  globalThis.window.api.getSettings = async () => ({
    backupEnabled: 1,           // 数字：必须被拒绝（回退到默认 true）
    theme: 'light',             // 合法值：应保留
    fontSize: 'huge'            // 非法字符串：应回退到 medium
  });
  try {
    await s.load();
    const cur = s.all;
    if (cur.backupEnabled === true && cur.theme === 'light' && cur.fontSize === 'medium') {
      ok('脏 backupEnabled 回退到默认 true；合法 theme 保留；非法 fontSize 回退');
    } else {
      bad('load 污染或误伤', JSON.stringify(cur));
    }
  } finally {
    globalThis.window.api.getSettings = orig;
  }
}

{
  const s = new SettingsStore();
  const orig = globalThis.window.api.getSettings;
  globalThis.window.api.getSettings = async () => ({
    backupEnabled: true,
    lastBackupDate: '2026-08-22'  // 主进程维护的字段，不该被 load 路径意外处理
  });
  try {
    await s.load();
    const cur = s.all;
    if (cur.backupEnabled === true) {
      ok('合法 backupEnabled: true 被加载');
    } else {
      bad('backupEnabled: true 未生效', JSON.stringify(cur));
    }
    // lastBackupDate 不在 DEFAULT_SETTINGS 里 —— 即便持久化文件里有，load 也不该把它
    // 暴露到 settings 对象上（主进程直接从 appConfig 读，不依赖 SettingsStore）
    if (cur.lastBackupDate === undefined) {
      ok('lastBackupDate 未泄漏到 settings 对象（保留主进程独立访问）');
    } else {
      bad('lastBackupDate 泄漏到 settings', JSON.stringify(cur));
    }
  } finally {
    globalThis.window.api.getSettings = orig;
  }
}

// ============================================
//  update() 字段白名单 —— 未知字段被忽略
// ============================================
console.log('\n[5] 未知字段被忽略');

{
  const s = new SettingsStore();
  await s.update({ lastBackupDate: '2026-08-22', unknownField: 'x' });
  if (s.get('lastBackupDate') === undefined && s.get('unknownField') === undefined) {
    ok('update({lastBackupDate, unknownField}) 都被忽略');
  } else {
    bad('未知字段被写入', JSON.stringify({ lastBackupDate: s.get('lastBackupDate'), unknownField: s.get('unknownField') }));
  }
}

// ============================================
//  update() 与其它字段联动 —— 模拟设置对话框「完成」一次性提交多字段
// ============================================
console.log('\n[6] 与其它字段联动');

{
  const s = new SettingsStore();
  // 同时改 backupEnabled + theme + fontSize：模拟对话框 finish() 把多个 pending 值打包提交
  const result = await s.update({ backupEnabled: true, theme: 'light', fontSize: 'large' });
  const cur = s.all;
  if (result === true &&
      cur.backupEnabled === true &&
      cur.theme === 'light' &&
      cur.fontSize === 'large') {
    ok('update({backupEnabled, theme, fontSize}) 多字段同时生效');
  } else {
    bad('多字段联动异常', JSON.stringify(cur));
  }
}

{
  const s = new SettingsStore();
  // 与非法字段混合：合法字段应生效，非法字段应被丢弃
  await s.update({ backupEnabled: true, theme: 'rainbow', fontSize: 'huge' });
  const cur = s.all;
  if (cur.backupEnabled === true && cur.theme === 'dark' && cur.fontSize === 'medium') {
    ok('合法 backupEnabled 生效；非法 theme/fontSize 回退到默认');
  } else {
    bad('联动失败', JSON.stringify(cur));
  }
}

// ============================================
//  change 事件 —— 验证 update 触发的事件包含正确字段列表
// ============================================
console.log('\n[7] change 事件');

{
  const s = new SettingsStore();
  let captured = null;
  s.on('change', (e) => { captured = e; });
  // 默认 true —— 先切到 false（默认值改变 → 必触发 change）才能验证事件字段
  await s.update({ backupEnabled: false });
  captured = null; // 清掉上一次的事件
  await s.update({ backupEnabled: true });
  if (captured && Array.isArray(captured.changed) &&
      captured.changed.length === 1 && captured.changed[0] === 'backupEnabled') {
    ok('change 事件 reported backupEnabled');
  } else {
    bad('change 事件字段错误', JSON.stringify(captured));
  }
}

{
  const s = new SettingsStore();
  let captured = null;
  s.on('change', (e) => { captured = e; });
  // 全部非法 → updates 为空 → 不触发 change 事件
  await s.update({ backupEnabled: 'true', backupEnabled_evil: 1 });
  if (captured === null) {
    ok('全部非法时 change 事件不触发（避免无效 IO）');
  } else {
    bad('change 事件不该触发', JSON.stringify(captured));
  }
}

// ============================================
//  首次启动：主进程返回 {}（config.json 不存在）—— 兜底默认 true
//
//  复现的 bug 路径：loadConfig() 在磁盘上没 config.json 时返回 {}，
//  main 把 {} 透传给 renderer SettingsStore.load()。如果 renderer 端不
//  兜底，backupEnabled 就保持 undefined（falsy），结果主进程
//  maybeBackupToday 的 truthy 检查把 undefined 当成「禁用」——
//  新用户的备份机制永远不工作。
//
//  这里验的是 renderer 端的兜底（DEFAULT_SETTINGS 在 load 时填充），
//  main 端的兜底（DEFAULT_CONFIG）由 code review 保证 —— main.js 依赖
//  Electron API 不能直接 import 测试。
// ============================================
console.log('\n[8] 首次启动兜底');

{
  const s = new SettingsStore();
  const orig = globalThis.window.api.getSettings;
  globalThis.window.api.getSettings = async () => ({});  // 主进程：config.json 不存在
  try {
    await s.load();
    if (s.get('backupEnabled') === true) {
      ok('主进程返回 {} 时 backupEnabled 兜底到默认 true（保证备份机制激活）');
    } else {
      bad('首次启动兜底失败', `当前 ${JSON.stringify(s.get('backupEnabled'))}`);
    }
  } finally {
    globalThis.window.api.getSettings = orig;
  }
}

{
  const s = new SettingsStore();
  const orig = globalThis.window.api.getSettings;
  globalThis.window.api.getSettings = async () => ({ alwaysOnTop: true });  // 只有 alwaysOnTop，没 backupEnabled
  try {
    await s.load();
    if (s.get('backupEnabled') === true && s.get('alwaysOnTop') === true) {
      ok('部分字段缺失时 backupEnabled 仍兜底到 true，已设的 alwaysOnTop 保留');
    } else {
      bad('部分兜底失败', JSON.stringify({ backupEnabled: s.get('backupEnabled'), alwaysOnTop: s.get('alwaysOnTop') }));
    }
  } finally {
    globalThis.window.api.getSettings = orig;
  }
}

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${summary.pass} / 失败 ${summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
