import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../platform/log';
import type { DiskNode } from './types';
import { PathPolicyError } from './path-policy';

function sortedEntries(directory: string) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    throw new PathPolicyError(
      'directory-unreadable',
      `无法读取目录：${directory}`,
      { cause: error },
    );
  }
  return entries.sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) {
      return left.isDirectory() ? -1 : 1;
    }
    return left.name.localeCompare(right.name, 'zh-CN', {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

/**
 * Reads a real project tree. `.gitkeep` is a template placeholder and is never
 * exposed. Links are skipped rather than followed, so a link cannot escape the
 * project or create a cycle.
 */
export function scanDiskTree(
  root: string,
  logger?: Logger,
): DiskNode[] {
  const visit = (
    directory: string,
    relativeDirectory: string,
    ancestors: ReadonlySet<string>,
  ): DiskNode[] => {
    const nodes: DiskNode[] = [];
    for (const entry of sortedEntries(directory)) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(absolutePath);
      } catch (error) {
        throw new PathPolicyError(
          'path-unreadable',
          `无法读取目录项：${relativePath}`,
          { cause: error },
        );
      }
      if (stat.isSymbolicLink()) {
        logger?.warn('project-symlink-skipped', { path: relativePath });
        continue;
      }
      if (stat.isDirectory()) {
        const key = path.resolve(absolutePath).toLowerCase();
        if (ancestors.has(key)) {
          logger?.warn('project-link-cycle-skipped', { path: relativePath });
          continue;
        }
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(key);
        nodes.push({
          name: entry.name,
          relativePath,
          absolutePath,
          kind: 'folder',
          children: visit(absolutePath, relativePath, nextAncestors),
        });
      } else if (stat.isFile()) {
        nodes.push({
          name: entry.name,
          relativePath,
          absolutePath,
          kind: 'file',
          children: [],
          mtimeMs: stat.mtimeMs,
          byteSize: stat.size,
        });
      } else {
        logger?.warn('project-special-file-skipped', { path: relativePath });
      }
    }
    return nodes;
  };

  const rootKey = path.resolve(root).toLowerCase();
  return visit(root, '', new Set([rootKey]));
}

export function flattenDiskTree(nodes: readonly DiskNode[]): DiskNode[] {
  const result: DiskNode[] = [];
  const visit = (list: readonly DiskNode[]) => {
    for (const node of list) {
      result.push(node);
      visit(node.children);
    }
  };
  visit(nodes);
  return result;
}
