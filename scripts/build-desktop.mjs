import { rm } from 'node:fs/promises';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const dist = path.join(projectRoot, 'dist');
const mainOutput = path.join(dist, 'main', 'main.js');
const preloadOutput = path.join(dist, 'preload', 'preload.cjs');
const screenshotPreloadOutput = path.join(
  dist,
  'preload',
  'screenshot-preload.cjs',
);
const h5WorkerOutput = path.join(dist, 'main', 'h5-worker.mjs');
const screenshotOverlaySource = path.join(
  projectRoot,
  'backend',
  'chat',
  'screenshot-overlay.html',
);
const screenshotOverlayOutput = path.join(
  dist,
  'screenshot',
  'overlay.html',
);

await rm(path.join(dist, 'main'), { recursive: true, force: true });
await rm(path.join(dist, 'preload'), { recursive: true, force: true });
await rm(path.join(dist, 'screenshot'), { recursive: true, force: true });

await build({
  entryPoints: [path.join(projectRoot, 'backend', 'main.ts')],
  outfile: mainOutput,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['electron'],
  sourcemap: 'external',
  legalComments: 'none',
  logLevel: 'info',
});

await build({
  entryPoints: [path.join(projectRoot, 'backend', 'preload.ts')],
  outfile: preloadOutput,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  sourcemap: 'external',
  legalComments: 'none',
  logLevel: 'info',
});

await build({
  entryPoints: [
    path.join(projectRoot, 'backend', 'chat', 'screenshot-preload.ts'),
  ],
  outfile: screenshotPreloadOutput,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  sourcemap: 'external',
  legalComments: 'none',
  logLevel: 'info',
});

await mkdir(path.dirname(screenshotOverlayOutput), { recursive: true });
await copyFile(screenshotOverlaySource, screenshotOverlayOutput);

await build({
  entryPoints: [path.join(projectRoot, 'backend', 'h5', 'worker.ts')],
  outfile: h5WorkerOutput,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: 'external',
  legalComments: 'none',
  logLevel: 'info',
});

console.log(`Built main:    ${path.relative(projectRoot, mainOutput)}`);
console.log(`Built preload: ${path.relative(projectRoot, preloadOutput)}`);
console.log(
  `Built shot:    ${path.relative(projectRoot, screenshotPreloadOutput)}`,
);
console.log(
  `Built overlay: ${path.relative(projectRoot, screenshotOverlayOutput)}`,
);
console.log(`Built H5:      ${path.relative(projectRoot, h5WorkerOutput)}`);

