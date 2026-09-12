#!/usr/bin/env node
/**
 * 启动脚本：
 * 1. 自动清理可能影响 Electron 运行的环境变量（ELECTRON_RUN_AS_NODE）
 * 2. Windows 控制台切换 UTF-8 代码页（避免中文日志乱码）
 * 3. 过滤 Chromium 启动时无害的 GPU cache 警告
 *
 * 已知问题：
 * - ELECTRON_RUN_AS_NODE=1 会让 electron.exe 表现成 Node（窗口不显示）
 * - Windows 控制台默认 GBK 导致中文乱码
 * - Chromium 在某些 Windows 用户目录上无法迁移旧 cache（无害警告）
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');

// 清理环境变量（让 Electron 真正作为 Electron 运行）
delete process.env.ELECTRON_RUN_AS_NODE;

// Windows：把控制台切换到 UTF-8 代码页（65001），避免中文日志乱码
if (process.platform === 'win32') {
  try {
    spawnSync('cmd.exe', ['/c', 'chcp', '65001', '>', 'nul'], {
      stdio: 'ignore',
      shell: false
    });
  } catch (e) {
    // 忽略
  }
}

// electron 模块在 Node 环境下返回路径字符串（这就是 Electron 的位置）
const electronBin = require('electron');
const projectRoot = path.resolve(__dirname, '..');

// Electron 启动参数
const ELECTRON_FLAGS = [
  '--disable-gpu-cache',
  '--disable-features=CalculateNativeWinOcclusion'
];

const args = [
  ...ELECTRON_FLAGS,
  ...(process.env.TODO_DEVTOOLS === '1' ? ['--remote-debugging-port=9222', '--remote-allow-origins=*'] : []),
  projectRoot,
  ...process.argv.slice(2)
];

// 过滤掉 Chromium 启动时的良性警告（这些不影响功能，但会污染控制台）
const BENIGN_ERROR_PATTERNS = [
  /Unable to move the cache/i,
  /Unable to create cache/i,
  /Gpu Cache Creation failed/i,
  /disk_cache\.cc/i
];

function filterLine(line) {
  return !BENIGN_ERROR_PATTERNS.some(re => re.test(line));
}

console.log('[launch] 启动 Electron:', electronBin);
console.log('[launch] 项目路径:', projectRoot);

// 启动 Electron，过滤 stderr 中的良性警告
const child = spawn(electronBin, args, {
  stdio: ['inherit', 'inherit', 'pipe'], // 单独接管 stderr 以便过滤
  env: process.env,
  windowsHide: false
});

// 逐行过滤 stderr
if (child.stderr) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: child.stderr });
  rl.on('line', (line) => {
    if (filterLine(line)) {
      process.stderr.write(line + '\n');
    }
  });
}

child.on('close', (code) => {
  process.exit(code ?? 0);
});

['SIGINT', 'SIGTERM'].forEach(signal => {
  process.on(signal, () => child.kill(signal));
});