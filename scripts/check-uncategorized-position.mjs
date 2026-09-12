// 一次性验证脚本：「未分类」必须始终排在子分类数组的末尾，
// 新建的子分类不能挤到「未分类」下面。
//
// 背景：之前 addSubCategory 用「容器之后最后一个 parentOtherTasks 之后」定位插入点，
// 当「未分类」已经是最后一个 parentOtherTasks 时，新分类会被插入到「未分类」之后，
// 用户体验就是「我新建的分类怎么跑到兜底下面了」。
//
// 修复后 addSubCategory 优先把新分类插到「未分类」之前；只有「未分类」不存在时
// 才退回到「容器之后最后一个 parentOtherTasks 之后」的旧位置。
//
// 用法：node scripts/check-uncategorized-position.mjs

import { TaskStore, UNCATEGORIZED_NAME } from '../src/task-store.js';
import { check, ok, bad, summary, printSummary } from './_lib/check.mjs';
import { makeStore } from './_lib/store-fixture.mjs';

console.log('[1] loadDefault 默认结构：「未分类」在子分类末尾');

{
  const store = makeStore();
  const subs = store.getSubCategories().map(c => c.name);
  check(`子分类顺序 = 工作 / 学习 / 生活 / 未分类`, JSON.stringify(subs) === '["工作","学习","生活","未分类"]',
    `实际：${JSON.stringify(subs)}`);
  check(`最后一位是「${UNCATEGORIZED_NAME}」`, subs[subs.length - 1] === UNCATEGORIZED_NAME);
}

console.log('\n[2] 新建子分类应插在「未分类」之前，不应把它挤到中间');

{
  const store = makeStore();
  // 第一次：默认已有 工作/学习/生活/未分类
  const before = store.getSubCategories().map(c => c.name);
  check(`新建前：「${UNCATEGORIZED_NAME}」在末尾`, before[before.length - 1] === UNCATEGORIZED_NAME);

  store.addSubCategory('副业');

  const after = store.getSubCategories().map(c => c.name);
  check(`新建后：「${UNCATEGORIZED_NAME}」仍在末尾`, after[after.length - 1] === UNCATEGORIZED_NAME,
    `实际：${JSON.stringify(after)}`);
  check(`新建后：「副业」在「${UNCATEGORIZED_NAME}」之前`,
    after.indexOf('副业') < after.indexOf(UNCATEGORIZED_NAME),
    `实际：${JSON.stringify(after)}`);
  check(`新建后：原有顺序 工作 / 学习 / 生活 / 副业 / ${UNCATEGORIZED_NAME} 全部保持`,
    JSON.stringify(after) === '["工作","学习","生活","副业","未分类"]',
    `实际：${JSON.stringify(after)}`);
}

console.log('\n[3] 多次新建：新分类依次插在「未分类」之前');

{
  const store = makeStore();
  store.addSubCategory('副业');
  store.addSubCategory('阅读');
  store.addSubCategory('运动');

  const subs = store.getSubCategories().map(c => c.name);
  check(`连续新建后，「${UNCATEGORIZED_NAME}」仍在末尾`,
    subs[subs.length - 1] === UNCATEGORIZED_NAME,
    `实际：${JSON.stringify(subs)}`);
  check(`新建分类按创建顺序排在「${UNCATEGORIZED_NAME}」之前`,
    JSON.stringify(subs) === '["工作","学习","生活","副业","阅读","运动","未分类"]',
    `实际：${JSON.stringify(subs)}`);
}

console.log('\n[4] 「未分类」不存在时退回旧逻辑（容器之后最后一个 parentOtherTasks 之后）');

{
  const store = new TaskStore();
  // 手动构造一个没有「未分类」的场景：只有容器 + 工作 + 学习（人为删掉「未分类」）
  // 这里直接调 _ensureBaseStructure 之外的路径会违反不变量，所以走更稳的办法：
  // 把所有 parentOtherTasks 重命名（包括「未分类」），让它的 c.name !== UNCATEGORIZED_NAME，
  // addSubCategory 的 findIndex 就会找不到，从而走旧逻辑。
  store.loadDefault(null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });
  // 把「未分类」改名为「临时」（不能直接 renameCategory —— 它会拒绝，
  // 所以这里直接修改 cat.name）。模拟「文件里没有「未分类」这个魔法名」的状态。
  const unCat = store.categories.find(c => c.parentOtherTasks && c.name === UNCATEGORIZED_NAME);
  if (unCat) unCat.name = '临时';

  store.addSubCategory('副业');
  const subs = store.getSubCategories().map(c => c.name);
  // 没有「未分类」魔法名时，新分类应该走"容器之后最后一个 parentOtherTasks 之后"的旧路径
  check(`「未分类」魔法名不存在时，新分类追加到 parentOtherTasks 末尾`,
    subs[subs.length - 1] === '副业',
    `实际：${JSON.stringify(subs)}`);
}

console.log('\n[5] 加载文件时把「未分类」从中间拉到末尾（_normalizeOrder 兜底）');

{
  // 手工编辑的文件 / 旧版迁移残留都可能让「未分类」落在中间。
  // _normalizeOrder 是唯一兜底 —— 加在子分类末尾，与 reorderSubCategory 在运行时侧
  // 阻止「未分类」被拖走形成对称（运行时守入口，加载时归位）。
  const content = `# 全部任务

## 工作
- [ ] 工作1

## 学习
- [ ] 学习1

## ${UNCATEGORIZED_NAME}
- [ ] 兜底1

## 生活
- [ ] 生活1
`;
  const store = new TaskStore();
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });
  store.loadFromContent(content, null);
  const subs = store.getSubCategories().map(c => c.name);
  check(`加载后「${UNCATEGORIZED_NAME}」在末尾`, subs[subs.length - 1] === UNCATEGORIZED_NAME,
    `实际：${JSON.stringify(subs)}`);
  check(`加载后其它子分类的相对顺序保持`,
    JSON.stringify(subs.slice(0, -1)) === '["工作","学习","生活"]',
    `实际：${JSON.stringify(subs.slice(0, -1))}`);
}

console.log('\n[6] loadFromContent 软合并分支也会归位「未分类」');

{
  // 模拟「外部编辑把「未分类」放中间，用户合并磁盘改动」的场景 —— 合并结果里
  // 「未分类」也被 _normalizeOrder 拉回末尾。
  const store = new TaskStore();
  store.loadDefault(null);
  store._autoSave = Object.assign(() => {}, { cancel() {}, flush() {} });
  // 内存里现在顺序是 工作 / 学习 / 生活 / 未分类
  // 模拟磁盘版本：把「未分类」挪到中间（解析器读到的样子）
  const diskContent = `# 全部任务

## 工作
- [ ] 工作-磁盘版

## ${UNCATEGORIZED_NAME}
- [ ] 兜底-磁盘版

## 学习
- [ ] 学习-磁盘版

## 生活
- [ ] 生活-磁盘版
`;
  // 用 mergeResolutions 走软合并分支（addSubCategory 测试不到这条路径）
  store.loadFromContent(diskContent, null, {
    mergeResolutions: { '__all__': 'a' }
  });
  const subs = store.getSubCategories().map(c => c.name);
  check(`软合并后「${UNCATEGORIZED_NAME}」在末尾`, subs[subs.length - 1] === UNCATEGORIZED_NAME,
    `实际：${JSON.stringify(subs)}`);
}

console.log('\n' + '='.repeat(64));
console.log(`结果：${summary.pass} 通过, ${summary.fail} 失败`);
console.log('='.repeat(64));
process.exit(summary.fail === 0 ? 0 : 1);