import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import {
  desktopAppArgs,
  desktopEnvironment,
  electronExecutable,
  projectRoot,
} from './desktop-runtime.mjs';

const viteConfig = fileURLToPath(
  new URL('../vite.config.ts', import.meta.url),
);
const buildScript = fileURLToPath(
  new URL('./build-desktop.mjs', import.meta.url),
);
let server;
let child;
let childExited = false;
let stopping = false;

async function stop(code) {
  if (stopping) return;
  stopping = true;
  if (child && !childExited) {
    child.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (server) {
    await server.close().catch(() => {});
  }
  process.exit(code);
}

try {
  console.log('Building Electron main and preload…');
  const buildResult = spawnSync(process.execPath, [buildScript], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (buildResult.status !== 0) {
    throw new Error('Electron 主进程或 preload 构建失败。');
  }

  server = await createServer({
    configFile: viteConfig,
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
    },
  });
  await server.listen();
  const localUrl = server.resolvedUrls?.local?.[0];
  if (!localUrl) throw new Error('Vite 未提供本地开发服务器地址。');
  console.log(`Vite ready: ${localUrl}`);
  server.printUrls();

  const environment = desktopEnvironment({
    CHATFGM_MODE: 'development',
    CHATFGM_DEV_SERVER_URL: localUrl,
  });
  // CHATFGM_TEST_ROOT may be supplied by the automated development-start
  // check. It is not set for normal development runs, which use ChatFGM-dev.

  child = spawn(electronExecutable, desktopAppArgs(), {
    cwd: projectRoot,
    env: environment,
    stdio: 'inherit',
  });

  child.once('error', (error) => {
    console.error(`无法启动 Electron：${error.message}`);
    void stop(1);
  });
  child.once('exit', (code) => {
    childExited = true;
    console.log('Electron exited; stopping Vite.');
    void stop(code ?? 0);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log(`Received ${signal}; stopping desktop development session.`);
      void stop(0);
    });
  }
} catch (error) {
  console.error('桌面开发启动失败：');
  console.error(error instanceof Error ? error.message : String(error));
  console.error('请确认 127.0.0.1:5173 未被其他程序占用。');
  await stop(1);
}
