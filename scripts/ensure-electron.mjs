import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Some npm versions no longer run dependency lifecycle scripts by default.
 * That leaves the electron package without its downloaded binary, so this
 * project-level postinstall finishes the official Electron installer when it
 * is missing. It is a no-op for production installs without devDependencies.
 */
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const electronPackage = path.join(projectRoot, 'node_modules', 'electron');
const packageJsonPath = path.join(electronPackage, 'package.json');

if (!existsSync(packageJsonPath)) {
  process.exit(0);
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const versionFile = path.join(electronPackage, 'dist', 'version');
const pathFile = path.join(electronPackage, 'path.txt');
const versionMatches =
  existsSync(versionFile) &&
  readFileSync(versionFile, 'utf8').trim() === packageJson.version;
const executablePath = existsSync(pathFile)
  ? readFileSync(pathFile, 'utf8').trim()
  : '';
const isInstalled =
  versionMatches &&
  executablePath !== '' &&
  existsSync(path.join(electronPackage, 'dist', executablePath));

if (isInstalled) {
  process.exit(0);
}

console.log(`Installing Electron ${packageJson.version} binary…`);
const result = spawnSync(
  process.execPath,
  [path.join(electronPackage, 'install.js')],
  { stdio: 'inherit', cwd: projectRoot },
);
if (result.error) {
  console.error(`Electron install failed: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
