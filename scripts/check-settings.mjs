import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';
import { installApiStub } from './_lib/api-stub.mjs';
// 设置存储的回归测试：覆盖 update() 和 load() 的输入校验路径。
//
// 触发 bug 的两种姿势，都靠「脏值穿过校验、污染内存 + 配置文件」来静默损坏用户设置：
//
//   1. update({ theme: null })
//      旧实现只校验「值 !== 当前值」和「key 在 DEFAULT_SETTINGS 中」，于是 theme
//      被设成 null。resolveTheme() 能兜底返回 'dark'，但 this._settings.theme
//      仍是 null，下一次 setSortBy 等比较触发意外分支；更糟的是下次保存会把脏
//      theme: null 写入 config.json —— 旧用户的设置从此永久损坏。
//
//   2. 用户手工编辑 config.json，写成 `theme: null` 或 `fontSize: "huge"`
//      加载端只按 key 字段过滤，不校验值类型 / 是否在枚举内 —— 同样的污染路径，
//      只是触发位置从 update 换到了 load。
//
// 这份脚本直接构造 SettingsStore 实例 + 桩 api，逐项验证上述姿势都被拦截。
// 跑法：node scripts/check-settings.mjs

// 同 check-imports：SettingsStore 的模块作用域会注册事件回调，但仅用到
// 内存对象，没有副作用。installApiStub() 默认就是空实现。
installApiStub();

const { SettingsStore } = await import('../src/settings-store.js');

// ============================================
//  update() 输入校验
// ============================================
console.log('[1] update() 拒绝非法值');

{
  const s = new SettingsStore();
  await s.update({ theme: null });
  if (s.get('theme') === 'dark') ok('update({theme: null}) 被忽略，theme 保持 dark');
  else bad('theme 被 null 污染', `当前 ${JSON.stringify(s.get('theme'))}`);
}

{
  const s = new SettingsStore();
  await s.update({ theme: undefined });
  if (s.get('theme') === 'dark') ok('update({theme: undefined}) 被忽略');
  else bad('theme 被 undefined 污染', `当前 ${JSON.stringify(s.get('theme'))}`);
}

{
  const s = new SettingsStore();
  await s.update({ filter: 42 });
  if (s.get('filter') === 'all') ok('update({filter: 42}) 数字被拒绝');
  else bad('filter 被数字污染', `当前 ${JSON.stringify(s.get('filter'))}`);
}

{
  const s = new SettingsStore();
  await s.update({ fontSize: 'huge' });
  if (s.get('fontSize') === 'medium') ok('update({fontSize: "huge"}) 枚举外字符串被拒绝');
  else bad('fontSize 被非法字符串污染', `当前 ${JSON.stringify(s.get('fontSize'))}`);
}

{
  const s = new SettingsStore();
  await s.update({ sortBy: { evil: true } });
  if (s.get('sortBy') === 'manual') ok('update({sortBy: object}) 对象被拒绝');
  else bad('sortBy 被对象污染', `当前 ${JSON.stringify(s.get('sortBy'))}`);
}

{
  const s = new SettingsStore();
  await s.update({ __proto__: { theme: 'light' } });
  // 原型污染：__proto__ 不是 own property，Object.entries 不该枚举它
  if (s.get('theme') === 'dark') ok('update({__proto__}) 原型污染被拒绝');
  else bad('theme 被原型污染', `当前 ${JSON.stringify(s.get('theme'))}`);
}

{
  const s = new SettingsStore();
  await s.update({ unknownField: 'value' });
  if (s.get('unknownField') === undefined) ok('update({unknownField}) 未知字段被忽略');
  else bad('未知字段被写入', `当前 ${JSON.stringify(s.get('unknownField'))}`);
}

// dataDir 单独测：null 是合法语义（恢复默认），字符串也合法
{
  const s = new SettingsStore();
  await s.update({ dataDir: null });
  if (s.get('dataDir') === null) ok('update({dataDir: null}) 保留 null（恢复默认语义）');
  else bad('dataDir: null 被错误拒绝', `当前 ${JSON.stringify(s.get('dataDir'))}`);
}

{
  const s = new SettingsStore();
  await s.update({ dataDir: 'D:/Tasks' });
  if (s.get('dataDir') === 'D:/Tasks') ok('update({dataDir: "D:/Tasks"}) 字符串路径生效');
  else bad('dataDir 字符串路径未生效', `当前 ${JSON.stringify(s.get('dataDir'))}`);
}

{
  const s = new SettingsStore();
  await s.update({ dataDir: 123 });
  if (s.get('dataDir') === null) ok('update({dataDir: 123}) 数字被拒绝（保持 null）');
  else bad('dataDir 数字污染', `当前 ${JSON.stringify(s.get('dataDir'))}`);
}

// 合法值的 happy path
{
  const s = new SettingsStore();
  const result = await s.update({ theme: 'light', fontSize: 'large' });
  if (s.get('theme') === 'light' && s.get('fontSize') === 'large' && result === true) {
    ok('update({theme: "light", fontSize: "large"}) 合法值生效并返回 true');
  } else {
    bad('合法值未生效', JSON.stringify({ theme: s.get('theme'), fontSize: s.get('fontSize'), result }));
  }
}

// ============================================
//  load() 输入校验 —— 模拟配置文件被外部改成脏值
// ============================================
console.log('\n[2] load() 从脏配置恢复默认值');

{
  const s = new SettingsStore();
  s._settings = {};  // 重置，确保 load 是从主进程取数
  // 临时替换 api 返回脏配置
  const orig = globalThis.window.api.getSettings;
  globalThis.window.api.getSettings = async () => ({
    theme: null,
    filter: 42,
    sortBy: 'random',
    fontSize: 'huge',
    dataDir: 'D:/Real'        // 合法值，应保留
  });
  try {
    await s.load();
    const cur = s.all;
    if (cur.theme === 'dark' &&
        cur.filter === 'all' &&
        cur.sortBy === 'manual' &&
        cur.fontSize === 'medium' &&
        cur.dataDir === 'D:/Real') {
      ok('脏 theme/filter/sortBy/fontSize 全部回退到默认值；合法 dataDir 保留');
    } else {
      bad('load 污染了设置', JSON.stringify(cur));
    }
  } finally {
    globalThis.window.api.getSettings = orig;
  }
}

{
  const s = new SettingsStore();
  const orig = globalThis.window.api.getSettings;
  globalThis.window.api.getSettings = async () => ({
    theme: 'light',
    filter: 'pending',           // 老 enum 值，load 端应迁移到 'current'
    extraGarbage: 'ignored',
    __proto__: { theme: 'dark' }  // 原型污染：load 端同样要抗
  });
  try {
    await s.load();
    const cur = s.all;
    if (cur.theme === 'light' && cur.filter === 'current' && cur.extraGarbage === undefined) {
      ok('合法字段生效；老 enum（pending→current）自动迁移；未知字段忽略；原型污染无效');
    } else {
      bad('load 表现异常', JSON.stringify(cur));
    }
  } finally {
    globalThis.window.api.getSettings = orig;
  }
}

// ============================================
console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${summary.pass} / 失败 ${summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
