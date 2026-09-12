// 验证修复后菜单/调色板/toast 的字号在 small/medium/large 三档下都合理
import { readFileSync } from 'fs';

const css = readFileSync('src/styles.css', 'utf8');

// 抓取 [data-font-size=...] 块里 --font-sm 的值
const tiers = ['small', 'medium', 'large'];
const sizes = {};
for (const t of tiers) {
  const re = new RegExp(`\\[data-font-size="${t}"\\][^{]*\\{[^}]*--font-sm:\\s*([0-9.]+px)`);
  const m = css.match(re);
  if (m) sizes[t] = m[1];
}
console.log('font-sm 各档:', sizes);

// 这些元素的基础定义
const targets = ['.more-menu-item', '.context-menu', '.command-palette-item', '.toast'];
for (const sel of targets) {
  const re = new RegExp(`${sel.replace('.', '\\.')}\\s*\\{[^}]*font-size:\\s*([^;}]+)`);
  const m = css.match(re);
  console.log(sel, '→', m ? m[1].trim() : '(继承自父级)');
}
