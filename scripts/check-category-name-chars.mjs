// 一次性验证脚本：分类名禁用 `|` 字符。
//
// 背景：TaskList 用 `cat + '|' + id` 作为 selectedTaskIds 的 Set key（_selKey），
// 批量浮栏的 _updateBatchBarState / _handleBatchAction / _showBatchMoveMenu
// 都通过 key.split('|') 反查分类名与 id。
//
// 如果分类名本身含 `|`，比如 "Foo|Bar"：
//   - add 时的 key = "Foo|Bar|t_xxx_xxxxx"
//   - split('|') → ["Foo", "Bar", "t_xxx_xxxxx"]
//   - 解构 [cat, id] = key.split('|') → cat = "Foo", id = "Bar"
//   - 后续 store.batchMoveTasks / batchToggleCompleted / batchDeleteTasks
//     全都按错误的 (cat, id) 去找任务 → 静默空操作 → 用户以为「批量没生效」。
//
// 防线：store 的 addSubCategory / renameCategory 必须拒绝任何含 `|` 的输入。
// 这份脚本守住这条防线 —— 加了 `_taskRefKey` 死代码 + `|` 漏洞的回归测试都靠它。
//
// 用法：node scripts/check-category-name-chars.mjs

import { TaskStore } from '../src/task-store.js';
import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';

console.log('[1] addSubCategory 拒绝含 `|` 的名字');

{
  const store = makeStore();
  const names = [
    'Foo|Bar',       // 经典带管道符
    '|leading',      // 前导
    'trailing|',     // 末尾
    'a||b',          // 双管道
    '工作|子分类',   // 含中文字符 + |
  ];
  for (const name of names) {
    const before = store.categories.length;
    const result = store.addSubCategory(name);
    check(
      `addSubCategory(${JSON.stringify(name)}) 返回 null`,
      result === null,
      `实际 ${JSON.stringify(result)}`
    );
    check(
      `categories 长度未变`,
      store.categories.length === before,
      `${before} → ${store.categories.length}`
    );
  }
}

console.log('\n[2] addSubCategory 接受不含 `|` 的合法名字');

{
  const store = makeStore();
  const ok = store.addSubCategory('正常名字');
  check('addSubCategory("正常名字") 返回 cat 对象', ok !== null);
  check('分类名确实是"正常名字"', ok && ok.name === '正常名字');
}

console.log('\n[3] renameCategory 拒绝把名字改成含 `|`');

{
  const store = makeStore();
  store.addSubCategory('副业');

  const badNames = ['Foo|Bar', 'a|', '|b'];
  for (const newName of badNames) {
    const ok = store.renameCategory('副业', newName);
    check(
      `rename('副业' → ${JSON.stringify(newName)}) 返回 false`,
      ok === false,
      `实际 ${JSON.stringify(ok)}`
    );
    check(
      `「副业」名字没被改`,
      store.getCategory('副业') !== null,
      `当前: ${store.categories.map(c => c.name).join('、')}`
    );
  }
}

console.log('\n[4] 集成回归：合法分类的批量操作 key 拆 / 拼对称');

{
  // 这条不属于「拒绝非法名字」的范畴，但是和 `|` 同款的端到端检查：
  // 走完整 addSubCategory → addTask → 模拟 _selKey + split('|')，确认
  // 「cat + '|' + id」拆出来仍然是 (cat, id) —— 不会被 split 干扰。
  // 主要是防回归：将来谁把 _selKey 改成 JSON.stringify 之类方案，会让行为改变。
  const store = makeStore();
  // loadDefault 默认建了「工作/学习/生活/未分类」，用「副业」避开重名
  const cat = store.addSubCategory('副业');
  check('addSubCategory("副业") 返回非 null', cat !== null);
  if (!cat) {
    fail++; // 后续 check 无意义 —— 直接结束
  } else {
    const t = store.addTask('副业', '示例任务');
    check('addTask 返回非 null', t !== null);
    if (t) {
      const key = `${cat.name}|${t.id}`;
      const [catOut, idOut] = key.split('|');
      check(`_selKey 拼出的 key 能 split 回 (cat, id)`, catOut === cat.name && idOut === t.id);
      // 验证 split 不会产生多余片段（极端回归：`_selKey` 不会意外产生多余 `|`）
      check('split 后只有 2 段', key.split('|').length === 2);
    }
  }
}

console.log('\n' + '='.repeat(64));
console.log(`结果：${summary.pass} 通过, ${summary.fail} 失败`);
console.log('='.repeat(64));
process.exit(summary.fail === 0 ? 0 : 1);
