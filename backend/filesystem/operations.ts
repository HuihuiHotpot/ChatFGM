import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';

export class FileOperationError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FileOperationError';
    this.code = code;
  }
}

export function pathExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new FileOperationError(
      'path-unreadable',
      `无法检查路径：${target}`,
      { cause: error },
    );
  }
}

export function createEmptyFile(target: string): void {
  try {
    const descriptor = openSync(target, 'wx');
    closeSync(descriptor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new FileOperationError('already-exists', '同一位置已存在同名项目。');
    }
    throw new FileOperationError(
      'create-failed',
      `新建文件失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function createDirectory(target: string): void {
  try {
    mkdirSync(target, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new FileOperationError('already-exists', '同一位置已存在同名项目。');
    }
    throw new FileOperationError(
      'create-failed',
      `新建文件夹失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function renamePath(
  source: string,
  target: string,
  options: { allowSameEntry?: boolean } = {},
): void {
  if (!options.allowSameEntry && pathExists(target)) {
    throw new FileOperationError('already-exists', '同一位置已存在同名项目。');
  }
  try {
    renameSync(source, target);
  } catch (error) {
    throw new FileOperationError(
      'move-failed',
      `移动失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function removePath(target: string): void {
  try {
    rmSync(target, { recursive: true, force: false });
  } catch (error) {
    throw new FileOperationError(
      'delete-failed',
      `删除失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function cleanup(paths: readonly string[]): void {
  for (const target of [...paths].reverse()) {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // The caller reports the original failure; cleanup is best effort.
    }
  }
}

interface CopyOptions {
  skipGitkeep?: boolean;
}

function copyEntry(
  source: string,
  target: string,
  created: string[],
  options: CopyOptions,
): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(source);
  } catch (error) {
    throw new FileOperationError(
      'copy-failed',
      `无法读取源项目：${source}`,
      { cause: error },
    );
  }
  if (stat.isSymbolicLink()) {
    throw new FileOperationError(
      'link-not-supported',
      '当前版本不复制符号链接或 junction。',
    );
  }
  if (options.skipGitkeep && stat.isFile() && path.basename(source) === '.gitkeep') {
    return;
  }
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: false });
    created.push(target);
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      copyEntry(
        path.join(source, entry.name),
        path.join(target, entry.name),
        created,
        options,
      );
    }
    return;
  }
  if (!stat.isFile()) {
    throw new FileOperationError(
      'copy-failed',
      '只支持复制普通文件和文件夹。',
    );
  }
  try {
    copyFileSync(source, target, 1); // COPYFILE_EXCL
    created.push(target);
  } catch (error) {
    throw new FileOperationError(
      'copy-failed',
      `复制文件失败：${source}`,
      { cause: error },
    );
  }
}

/**
 * Copies the template skeleton into an already-empty directory. Only paths
 * created by this call are removed on failure.
 */
export function initializeSkeleton(
  source: string,
  target: string,
): string[] {
  const created: string[] = [];
  try {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const sourcePath = path.join(source, entry.name);
      const targetPath = path.join(target, entry.name);
      copyEntry(sourcePath, targetPath, created, { skipGitkeep: true });
    }
    return created;
  } catch (error) {
    cleanup(created);
    if (error instanceof FileOperationError) throw error;
    throw new FileOperationError(
      'initialize-failed',
      `初始化项目失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function cleanupPaths(paths: readonly string[]): void {
  cleanup(paths);
}

export function copyPath(source: string, target: string): void {
  const created: string[] = [];
  try {
    copyEntry(source, target, created, {});
  } catch (error) {
    cleanup(created);
    if (error instanceof FileOperationError) throw error;
    throw new FileOperationError(
      'copy-failed',
      `复制失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
