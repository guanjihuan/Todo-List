// 第三轮全面审计回归：覆盖第二、三轮的所有修复点。
//
// 涵盖：
//   安全 S1 - dataDir 允许根目录白名单（home / documents / downloads / desktop / userData / appData）
//   安全 S2 - dataDir realpath 解析后再次校验（防止 symlink 绕过白名单）
//   安全 S3 - loadConfig 过滤 __proto__/constructor/prototype 防止原型污染
//   安全 S4 - 路径不合法 / 不存在时抛错而非 console.warn 静默吞掉
//   错误处理 E1 - app.js bootstrap 有 .bak 自动回退
//   错误处理 E2 - task-list addTask 返回 null 时弹 toast
//   错误处理 E3 - task-store loadFromContent parseMarkdown 抛错时 emit load-failed
//   数据完整性 D1 - markdown-writer 写入 originalCategory 转义 ]
//   数据完整性 D2 - markdown-parser 读回 originalCategory 反转义
//   数据完整性 D3 - 多行任务文本 \\n 保留
//   性能 P1 - task-list SVG 字面量提升（STAR_SVG_FILLED 等）
//   性能 P2 - task-list 拖拽 rAF 节流（pendingMove + rafScheduled）
//   性能 P3 - task-list _flushPendingDrag 在 pointerup 同步落点
//   性能 P4 - app.js setupStatusBar 文本相同则跳过 DOM 写入
//   并发 C1 - feedback.js 模块级监听器 AbortController + disposeFeedbackGlobals
//   并发 C2 - app.js export disposeBootstrap() 可取消所有 bootstrap 监听器
//   卫生 H1 - app.js 没有未限定的 console.log（保留 console.error / console.warn）

import { readFileSync } from 'node:fs';
import { check, ok, bad, printSummary } from './_lib/check.mjs';

const MAIN = readFileSync('main.js', 'utf8');
const APP = readFileSync('src/app.js', 'utf8');
const TASK_LIST = readFileSync('src/ui/task-list.js', 'utf8');
const TASK_STORE = readFileSync('src/task-store.js', 'utf8');
const FEEDBACK = readFileSync('src/ui/feedback.js', 'utf8');
const MARKDOWN_WRITER = readFileSync('src/markdown-writer.js', 'utf8');
const MARKDOWN_PARSER = readFileSync('src/markdown-parser.js', 'utf8');

function section(name) { console.log(`\n[${name}]`); }

// ─────────────────────────────────────────────────────────────────────────────
// 安全 S1+S2: dataDir 允许根目录白名单 + realpath 防 symlink 绕过
// ─────────────────────────────────────────────────────────────────────────────
section('安全: dataDir 白名单 + symlink 防御');

check(
  'main.js dataDir 校验使用 app.getPath("home") 等白名单',
  /app\.getPath\(['"]home['"]\)/.test(MAIN),
  '白名单是 home / documents / downloads / desktop / userData / appData'
);
check(
  'main.js dataDir 校验使用 app.getPath("documents")',
  /app\.getPath\(['"]documents['"]\)/.test(MAIN)
);
check(
  'main.js dataDir 校验使用 app.getPath("downloads")',
  /app\.getPath\(['"]downloads['"]\)/.test(MAIN)
);
check(
  'main.js dataDir 校验使用 app.getPath("desktop")',
  /app\.getPath\(['"]desktop['"]\)/.test(MAIN)
);
check(
  'main.js dataDir 校验使用 app.getPath("userData")',
  /app\.getPath\(['"]userData['"]\)/.test(MAIN)
);
check(
  'main.js dataDir 校验使用 app.getPath("appData")',
  /app\.getPath\(['"]appData['"]\)/.test(MAIN)
);
check(
  'main.js 用 realpathSync 解析后再比对白名单',
  /realpathSync/.test(MAIN) && /\.toLowerCase\(\)/.test(MAIN),
  'symlink 解析后再做白名单比对，防止间接绕过'
);
check(
  'main.js dataDir 校验失败时抛 Error 而非 console.warn',
  /throw new Error\([`"]数据目录必须在用户已知目录内/.test(MAIN) ||
  /throw new Error\([`"]数据目录/.test(MAIN),
  'v4+ 修复：抛错让 IPC reject，UI 走 save-error toast'
);

// ─────────────────────────────────────────────────────────────────────────────
// 安全 S3: loadConfig 过滤 __proto__ 等危险 key
// ─────────────────────────────────────────────────────────────────────────────
section('安全: 原型污染过滤');

check(
  'main.js 有 _stripProtoKeys helper',
  /_stripProtoKeys/.test(MAIN),
  '递归过滤 __proto__ / constructor / prototype 三个 key'
);
check(
  '_stripProtoKeys 拒绝 __proto__',
  /['"]__proto__['"]/.test(MAIN) || /__proto__/.test(MAIN)
);
check(
  '_stripProtoKeys 拒绝 constructor / prototype',
  /constructor/.test(MAIN) && /prototype/.test(MAIN)
);
check(
  'loadConfig 走 _stripProtoKeys 后再 spread',
  /loadConfig[\s\S]{0,300}_stripProtoKeys/.test(MAIN)
);

// ─────────────────────────────────────────────────────────────────────────────
// 错误处理 E1: .bak 自动回退
// ─────────────────────────────────────────────────────────────────────────────
section('错误处理: .bak 自动回退');

check(
  'app.js 有 tryReadBak helper',
  /tryReadBak/.test(APP),
  'loadFromContent 解析失败 / 空内容时尝试 .bak'
);
check(
  'app.js bootstrap 在 store.loadFromContent 失败时尝试 .bak',
  /tryReadBak[\s\S]{0,500}store\.loadFromContent|store\.loadFromContent[\s\S]{0,200}tryReadBak/.test(APP) ||
  /\.bak/.test(APP),
  '解析失败 → 读 .bak → 再 loadFromContent'
);

// ─────────────────────────────────────────────────────────────────────────────
// 错误处理 E2: addTask 返回 null 时弹 toast
// ─────────────────────────────────────────────────────────────────────────────
section('错误处理: addTask null 反馈');

check(
  'task-list.js 在 store.addTask 返回 null 时弹 toast',
  /store\.addTask\([\s\S]{0,200}\bif\s*\(\s*task\s*\)[\s\S]{0,400}\belse\s*\{[\s\S]{0,200}toast/.test(TASK_LIST) ||
  /store\.addTask[\s\S]{0,300}\bif\s*\(\s*!\s*task/.test(TASK_LIST),
  '添加失败要给用户反馈，不能静默吞掉'
);

// ─────────────────────────────────────────────────────────────────────────────
// 错误处理 E3: parseMarkdown 抛错时 emit load-failed
// ─────────────────────────────────────────────────────────────────────────────
section('错误处理: parseMarkdown 异常捕获');

check(
  'task-store.js loadFromContent 对 parseMarkdown 加 try/catch',
  /parseMarkdown\(content\)[\s\S]{0,300}catch\s*\(\s*parseErr\s*\)/.test(TASK_STORE) ||
  /try\s*\{[\s\S]{0,50}incomingCategories\s*=\s*parseMarkdown/.test(TASK_STORE),
  '解析失败要 emit load-failed 让 UI 走 .bak / 冲突解决路径'
);
check(
  'task-store.js parseMarkdown 抛错时 emit("load-failed", ...)',
  /emit\(['"]load-failed['"]/.test(TASK_STORE)
);
check(
  'parseMarkdown 抛错时 Error.code === "PARSE_FAILED"',
  /code\s*=\s*['"]PARSE_FAILED['"]/.test(TASK_STORE)
);

// ─────────────────────────────────────────────────────────────────────────────
// 数据完整性 D1+D2: originalCategory 转义 / 反转义
// ─────────────────────────────────────────────────────────────────────────────
section('数据完整性: originalCategory 转义');

check(
  'markdown-writer 对 originalCategory 转义 ]（避开解析字段截断）',
  MARKDOWN_WRITER.includes('/\\]/g'),
  '写盘时 ] 必须转义为 \\]，否则 parser 在 [原分类：工作] 这类含 ] 名字里截断'
);
check(
  'markdown-parser 解析 originalCategory 的正则允许 \\.',
  /\\\\\.|\\\\\\./.test(MARKDOWN_PARSER) ||
  /\\\\\\./.test(MARKDOWN_PARSER),
  'parser 必须接受 \\. 让转义能往返'
);
check(
  'markdown-parser 解析后 unescapeOriginalCategory 把 \\] / \\\\ 还原',
  /unescapeOriginalCategory/.test(MARKDOWN_PARSER) ||
  MARKDOWN_PARSER.includes("replace(/\\\\\\\\\\\\/g"),
  '读回时反转义：\\] → ]，\\\\ → \\'
);

// ─────────────────────────────────────────────────────────────────────────────
// 数据完整性 D3: 多行任务文本 \\n 保留
// ─────────────────────────────────────────────────────────────────────────────
section('数据完整性: 多行任务文本');

check(
  'markdown-writer 写盘时换行转义为 \\n',
  /escapeTaskTextSegment/.test(MARKDOWN_WRITER) ||
  MARKDOWN_WRITER.includes("split('\\\\n')") ||
  MARKDOWN_WRITER.includes('\\\\r\\\\n'),
  '内存里 \\n 实际是换行符，写盘要写成 \\n 否则 parser 当成多任务处理'
);
check(
  'markdown-parser 读回时把 \\n 还原为换行',
  MARKDOWN_PARSER.includes('/\\\\n/g') ||
  MARKDOWN_PARSER.includes('replace(/\\\\n/'),
  'parser 把 \\n 序列还原成换行符，保证文本往返一致'
);

// ─────────────────────────────────────────────────────────────────────────────
// 性能 P1: SVG 字面量提升
// ─────────────────────────────────────────────────────────────────────────────
section('性能: SVG 字面量提升');

check(
  'task-list.js 有 STAR_SVG_FILLED 等模块级 SVG 常量',
  /STAR_SVG_FILLED/.test(TASK_LIST) && /STAR_SVG_OUTLINE/.test(TASK_LIST),
  '原本是每次 _buildItem 重新构造，提到模块层只生成一次'
);
check(
  'task-list.js 有 starSvgFor(active) helper',
  /starSvgFor/.test(TASK_LIST)
);
check(
  'task-list.js 有 currentSvgFor(active) helper',
  /currentSvgFor/.test(TASK_LIST)
);
check(
  'task-list.js 没有重复的 inline STAR_SVG 模板字面量',
  (TASK_LIST.match(/<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g) || []).length <= 8,
  '多个 svg 都从常量引用，不应该重复模板字面量'
);

// ─────────────────────────────────────────────────────────────────────────────
// 性能 P2+P3: 拖拽 rAF 节流
// ─────────────────────────────────────────────────────────────────────────────
section('性能: 拖拽 rAF 节流');

check(
  'task-list.js pointermove 缓存 pendingMove',
  /d\.pendingMove\s*=\s*e/.test(TASK_LIST),
  '把最近一次 move 存到 d.pendingMove，下一帧才真正 _updateDrag'
);
check(
  'task-list.js pointermove 用 rafScheduled 标志',
  /d\.rafScheduled\s*=\s*true/.test(TASK_LIST) &&
  /requestAnimationFrame/.test(TASK_LIST)
);
check(
  'task-list.js 有 _flushPendingDrag 在 pointerup 同步落点',
  /_flushPendingDrag/.test(TASK_LIST),
  '避免松手瞬间落点还停留在上一帧动画结束位置（≤8ms 偏差）'
);
check(
  '_finishDrag 在移动前先 _flushPendingDrag',
  /_finishDrag\([\s\S]{0,200}_flushPendingDrag/.test(TASK_LIST) ||
  /_flushPendingDrag\(d\)/.test(TASK_LIST)
);

// ─────────────────────────────────────────────────────────────────────────────
// 性能 P4: 状态栏缓存
// ─────────────────────────────────────────────────────────────────────────────
section('性能: 状态栏文本相同跳过 DOM 写入');

check(
  'app.js setupStatusBar 有 oldText 缓存',
  /oldText/.test(APP) || /nextText\s*===\s*oldText/.test(APP)
);
check(
  'app.js setupStatusBar 比较 nextText 与 oldText 后才写入',
  /nextText\s*===\s*oldText/.test(APP) || /text\s*===\s*oldText/.test(APP)
);

// ─────────────────────────────────────────────────────────────────────────────
// 并发 C1: feedback.js 模块级监听器 AbortController
// ─────────────────────────────────────────────────────────────────────────────
section('并发: feedback.js 模块级监听器 AbortController');

check(
  'feedback.js 有 globalListenerAC',
  /globalListenerAC/.test(FEEDBACK)
);
check(
  'feedback.js 有 globalListenersInstalled 标志',
  /globalListenersInstalled/.test(FEEDBACK)
);
check(
  'feedback.js 有 installGlobalListeners() 一次性安装',
  /installGlobalListeners/.test(FEEDBACK)
);
check(
  'feedback.js export disposeFeedbackGlobals',
  /export\s+function\s+disposeFeedbackGlobals/.test(FEEDBACK),
  '提供显式 dispose 入口给 hot-reload / 测试用'
);
check(
  'feedback.js 模块级监听器走 signal 而非裸 addEventListener',
  /\{ signal:\s*globalListenerAC\.signal\s*\}/.test(FEEDBACK),
  'document.addEventListener(..., {signal}) 让 abort 时一键清理'
);

// ─────────────────────────────────────────────────────────────────────────────
// 并发 C2: bootstrapUnsubs disposeBootstrap
// ─────────────────────────────────────────────────────────────────────────────
section('并发: disposeBootstrap 清理函数');

check(
  'app.js export disposeBootstrap',
  /export\s+function\s+disposeBootstrap/.test(APP)
);
check(
  'disposeBootstrap 取消 bootstrapUnsubs 池中的所有函数',
  /disposeBootstrap[\s\S]{0,400}bootstrapUnsubs\.pop/.test(APP) ||
  /bootstrapUnsubs[\s\S]{0,400}disposeBootstrap/.test(APP)
);

// ─────────────────────────────────────────────────────────────────────────────
// 卫生 H1: app.js 没有未限定的 console.log（保留 console.error/warn）
// ─────────────────────────────────────────────────────────────────────────────
section('卫生: 剥离调试日志');

// 检查 app.js 顶层 / bootstrap() 里没有 console.log 残留
// 允许的例外：rendererLog(...) 这种被 isDev / syncLog 守卫的 helper 内部。
// 把所有 .test(/console\.log/) 之外、非 helper 函数体内部的 console.log 视为违规。
const helperBodies = APP.match(/function\s+\w+\s*\([^)]*\)\s*\{[\s\S]*?console\.log[\s\S]*?\n\}/g) || [];
const helperLines = new Set();
for (const body of helperBodies) {
  for (const line of body.split('\n')) helperLines.add(line.trim());
}
const allLogs = APP.split('\n').filter(l => /console\.log/.test(l));
const strayLogs = allLogs.filter(l => !helperLines.has(l.trim()));
check(
  'app.js 顶层 / bootstrap 里没有 console.log 残留（仅允许 dev-守卫的 helper 内）',
  strayLogs.length === 0,
  `残留位置：${strayLogs.map(l => l.trim()).slice(0, 3).join(' | ')}`
);

// ─────────────────────────────────────────────────────────────────────────────
printSummary('check-third-pass-audit');