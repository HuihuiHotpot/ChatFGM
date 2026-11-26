import {
  accessSync,
  constants,
  lstatSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

export class PathPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PathPolicyError';
    this.code = code;
  }
}

export function normalizePathKey(value: string): string {
  return value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

export function canonicalExistingPath(value: string): string {
  try {
    return realpathSync.native(path.resolve(value));
  } catch (error) {
    throw new PathPolicyError(
      'path-unavailable',
      `路径不存在或无法读取：${value}`,
      { cause: error },
    );
  }
}

export function assertExistingDirectory(value: string): string {
  const original = path.resolve(value);
  let originalStat: ReturnType<typeof lstatSync>;
  try {
    originalStat = lstatSync(original);
  } catch (error) {
    throw new PathPolicyError(
      'path-unavailable',
      `路径不存在或无法读取：${value}`,
      { cause: error },
    );
  }
  if (originalStat.isSymbolicLink()) {
    throw new PathPolicyError(
      'link-not-supported',
      '当前版本不跟随符号链接或 junction。',
    );
  }
  const resolved = canonicalExistingPath(original);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(resolved);
    accessSync(resolved, constants.R_OK);
  } catch (error) {
    throw new PathPolicyError(
      'path-unreadable',
      `目录不可读：${value}`,
      { cause: error },
    );
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new PathPolicyError(
      'not-a-directory',
      `所选路径不是普通文件夹：${value}`,
    );
  }
  return resolved;
}

export function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(normalizePathKey(root), normalizePathKey(target));
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export function assertPathInside(root: string, target: string): void {
  if (!isPathInside(root, target)) {
    throw new PathPolicyError(
      'path-outside-project',
      '目标路径超出当前项目目录。',
    );
  }
}

/**
 * Rejects a symlink or junction on every existing component. This intentionally
 * does not follow links: a link inside a project must never become an escape
 * hatch or a recursion loop.
 */
export function assertNoLinks(
  root: string,
  target: string,
  includeTarget = true,
): void {
  assertPathInside(root, target);
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative) return;
  const components = relative.split(path.sep);
  let current = path.resolve(root);
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    const isLast = index === components.length - 1;
    if (!includeTarget && isLast) break;
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new PathPolicyError(
          'link-not-supported',
          '当前版本不跟随符号链接或 junction。',
        );
      }
    } catch (error) {
      if (error instanceof PathPolicyError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new PathPolicyError(
        'path-unreadable',
        `无法检查路径：${current}`,
        { cause: error },
      );
    }
  }
}

export function validateEntryName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new PathPolicyError('invalid-name', '名称不能为空。');
  }
  if (trimmed.length > 120) {
    throw new PathPolicyError('invalid-name', '名称过长。');
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new PathPolicyError('invalid-name', '名称无效。');
  }
  // Windows forbids these characters and all C0 control characters.
  // eslint-disable-next-line no-control-regex
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(trimmed)) {
    throw new PathPolicyError(
      'invalid-name',
      '名称不能包含 \\ / : * ? " < > | 或控制字符。',
    );
  }
  if (/[. ]$/.test(trimmed)) {
    throw new PathPolicyError(
      'invalid-name',
      '名称不能以点或空格结尾。',
    );
  }
  const base = trimmed.split('.')[0].toLowerCase();
  if (RESERVED_NAMES.has(base)) {
    throw new PathPolicyError(
      'invalid-name',
      `名称「${trimmed}」是 Windows 保留名称。`,
    );
  }
  return trimmed;
}

export function relativePathOf(root: string, absolute: string): string {
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new PathPolicyError('path-outside-project', '目标路径超出项目目录。');
  }
  return relative;
}

export function isDirectoryEmpty(directory: string): boolean {
  return (
    lstatSync(directory).isDirectory() &&
    readdirSync(directory).length === 0
  );
}
