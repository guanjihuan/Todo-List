// 回归：任务文本里中文与英文/数字之间必须有视觉间隙（盘古之白）。
//
// 历史 bug：任务内容渲染时是 escapeHtml(task.text) 直出，中西文紧贴在一起，
// 「修复bug123的API调用」这种混排读起来非常挤（汉字是全角方块，字母数字是
// 比例宽度，两者之间没有天然的视觉呼吸位）。
//
// 为什么不用 CSS：text-autospace: ideograph-alpha 才是正解，但 Electron 28
// 对应 Chromium 120，那时候还没实现，纯 CSS 方案在本项目里无法落地。
//
// 修复：src/utils/dom.js 的 escapeHtmlAutospace() 在转义时于中西文边界插入
// 空的 <span class="cjk-gap">，靠 CSS padding-right 撑出间隙。
//
// 三条不能破的约束（也是这个脚本主要盯的地方）：
//   1) 间隙元素必须是「空标签」—— 任务双击编辑时是把 textContent 灌回 input，
//      真插入空格 / 细空格字符会污染用户的原始内容，保存后凭空多出空格。
//   2) 拆分必须在 escapeHtml 之前做 —— 否则 "&amp;" 里的字母被当成西文，
//      间隙元素会插进 HTML 实体内部，把实体打断成乱码。
//   3) .cjk-gap 只能用 padding 撑宽，不能用 inline-block 的 width 或 margin。
//      已完成任务的 .task-text 带 line-through，按 CSS 规范祖先的 text-decoration
//      不会画过 inline-block 这类原子行内盒，margin 区域同样不画 —— 那样删除线
//      会在每个间隙处断成一截一截。padding 区域会被画到，删除线保持连续。
//
// 覆盖：dom.js 的纯函数行为（可直接 import，无 DOM 依赖）+ task-list.js 接线
// + styles.css 的 .cjk-gap 规则。
//
// 用法：node scripts/check-cjk-autospace.mjs

import { readFileSync } from 'node:fs';
import { check, printSummary } from './_lib/check.mjs';
import {
  escapeHtml,
  escapeHtmlAutospace,
  needsCjkGap,
  CJK_GAP_HTML,
} from '../src/utils/dom.js';

const GAP = CJK_GAP_HTML;

// ── 1. needsCjkGap 的边界判定 ────────────────────────────────────────────
check('中文 → 字母 需要间隙', needsCjkGap('文', 'a') === true);
check('字母 → 中文 需要间隙', needsCjkGap('a', '文') === true);
check('中文 → 数字 需要间隙', needsCjkGap('文', '1') === true);
check('数字 → 中文 需要间隙', needsCjkGap('1', '文') === true);
check('假名 → 字母 需要间隙', needsCjkGap('ア', 'x') === true);

check('中文 → 中文 不加间隙', needsCjkGap('中', '文') === false);
check('字母 → 字母 不加间隙', needsCjkGap('a', 'b') === false);
check('CJK 标点不加间隙（。后接字母）', needsCjkGap('。', 'a') === false);
check('全角括号不加间隙', needsCjkGap('（', 'a') === false);
check('西文标点不加间隙（中文后接句点）', needsCjkGap('文', '.') === false);
check('空串安全', needsCjkGap('', 'a') === false && needsCjkGap('a', '') === false);

// ── 2. escapeHtmlAutospace 的输出 ───────────────────────────────────────
check(
  '典型混排：修复bug123的API调用',
  escapeHtmlAutospace('修复bug123的API调用')
    === `修复${GAP}bug123${GAP}的${GAP}API${GAP}调用`,
  escapeHtmlAutospace('修复bug123的API调用')
);
check('纯中文不动', escapeHtmlAutospace('修复调用') === '修复调用');
check('纯英文不动', escapeHtmlAutospace('fix the bug') === 'fix the bug');
check('已有空格处不再加间隙', escapeHtmlAutospace('修复 bug') === '修复 bug');
check('单字符安全', escapeHtmlAutospace('中') === '中');
check('空值安全', escapeHtmlAutospace('') === '' && escapeHtmlAutospace(null) === '');

// 约束 2：先拆分后转义。实体内部一旦被插入间隙就是乱码。
const amp = escapeHtmlAutospace('中文&英文');
check(
  '转义顺序正确：& 变实体且实体内部无间隙',
  amp.includes('&amp;') && !/&[a-z]*<span/.test(amp),
  amp
);
check(
  '尖括号仍被转义（不产生可注入标签）',
  escapeHtmlAutospace('中<script>x</script>文').includes('&lt;script&gt;'),
  escapeHtmlAutospace('中<script>x</script>文')
);
// 任何输入下，除了我们自己插入的间隙元素，不应出现别的裸标签。
const dirty = escapeHtmlAutospace('中"文\'a<b>&c中');
check(
  '除间隙元素外无其它标签',
  dirty.split(GAP).join('').indexOf('<') === -1,
  dirty
);

// 约束 1：间隙元素必须是空标签（不贡献任何 textContent）。
check(
  '间隙元素是空标签（无文本内容、无 &nbsp;）',
  /^<span class="cjk-gap"><\/span>$/.test(GAP),
  GAP
);
const stripped = escapeHtmlAutospace('修复bug的API').split(GAP).join('');
check(
  '去掉间隙元素后与纯转义结果完全一致（原文未被改写）',
  stripped === escapeHtml('修复bug的API'),
  stripped
);

// ── 3. task-list.js 接线 ────────────────────────────────────────────────
const taskList = readFileSync('src/ui/task-list.js', 'utf8');

check(
  'task-list.js 从 dom.js 引入了 autospace helper',
  taskList.includes('escapeHtmlAutospace')
    && taskList.includes('needsCjkGap')
    && taskList.includes('CJK_GAP_HTML')
);
check(
  '任务文本渲染不再用裸 escapeHtml(s.text)',
  !taskList.includes('escapeHtml(s.text)'),
  '搜索高亮分段里仍有 escapeHtml(s.text)，中西文间隙会丢'
);
// 跨段边界的间隙必须落在 <mark> 外面，否则会被高亮背景染成一小块色。
const markIdx = taskList.indexOf('<mark>${inner}</mark>');
const gapIdx = taskList.lastIndexOf('CJK_GAP_HTML', markIdx);
check(
  '跨段间隙插在 <mark> 之外',
  markIdx > 0 && gapIdx > 0 && gapIdx < markIdx,
  `mark@${markIdx} gap@${gapIdx}`
);

// ── 4. styles.css 的 .cjk-gap 规则 ──────────────────────────────────────
const css = readFileSync('src/styles.css', 'utf8');
const ruleMatch = css.match(/\.cjk-gap\s*\{([^}]*)\}/);
check('.cjk-gap 规则存在', !!ruleMatch);

if (ruleMatch) {
  const body = ruleMatch[1];
  check('.cjk-gap 用 padding 撑宽', /padding(-right|-inline-end)?\s*:/.test(body), body);
  // 约束 3：inline-block / margin 都会把已完成任务的删除线打断。
  check('.cjk-gap 不是 inline-block', !/display\s*:\s*inline-block/.test(body), body);
  check('.cjk-gap 不用 margin 撑宽', !/margin/.test(body), body);
  check('.cjk-gap 不用 width 撑宽', !/width\s*:/.test(body), body);
}

printSummary('check-cjk-autospace');
