import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  desktopAppArgs,
  desktopEnvironment,
  electronExecutable,
  projectRoot,
} from './desktop-runtime.mjs';

const requiredFiles = [
  path.join(projectRoot, 'dist', 'main', 'main.js'),
  path.join(projectRoot, 'dist', 'preload', 'preload.cjs'),
  path.join(projectRoot, 'dist', 'renderer', 'index.html'),
];

const missing = requiredFiles.filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error('缺少桌面构建产物，请先运行 npm run build:desktop：');
  for (const file of missing) console.error(`  - ${path.relative(projectRoot, file)}`);
  process.exit(1);
}

const environment = desktopEnvironment({ CHATFGM_MODE: 'production' });
delete environment.CHATFGM_DEV_SERVER_URL;
delete environment.CHATFGM_TEST_ROOT;
delete environment.CHATFGM_TEST_SKIP_ERROR_DIALOGS;

console.log('Starting ChatFGM in production build mode (no Vite server).');
const child = spawn(electronExecutable, desktopAppArgs(), {
  cwd: projectRoot,
  env: environment,
  stdio: 'inherit',
});

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  process.exit(code);
}

child.once('error', (error) => {
  console.error(`无法启动 Electron：${error.message}`);
  finish(1);
});

child.once('exit', (code, signal) => {
  if (signal) console.error(`Electron 被信号 ${signal} 终止。`);
  else if (code !== 0) console.error(`Electron 退出码：${code}`);
  finish(code ?? 1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill();
  });
}
