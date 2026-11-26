import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const electronExecutable = require('electron');

/**
 * `ELECTRON_RUN_AS_NODE` is sometimes present in host shells. Electron then
 * runs as Node and no window or app lifecycle is available, so every desktop
 * launch removes it explicitly.
 */
export function desktopEnvironment(overrides = {}) {
  const environment = { ...process.env, ...overrides };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.ELECTRON_NO_ATTACH_CONSOLE;
  return environment;
}

export function desktopAppArgs() {
  return [projectRoot];
}

export function relativeToRoot(target) {
  return path.relative(projectRoot, target);
}
