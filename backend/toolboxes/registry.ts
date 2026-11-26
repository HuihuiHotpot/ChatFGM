import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';

/**
 * A toolbox is identified by its folder name below the application
 * `toolboxes/` directory. The folder name is simultaneously the stable type
 * identifier and the user-visible label; there is no metadata file and no
 * separate id/label mapping.
 */
export interface ToolboxSkill {
  name: string;
  description: string;
  /** Absolute path to the real SKILL.md, read on demand by the Agent. */
  skillPath: string;
  /** Directory that relative skill resource paths resolve against. */
  directory: string;
}

export interface ToolboxDefinition {
  name: string;
  directory: string;
  standardCasePath: string;
  /** Null when the toolbox has no AGENTS.md. */
  agentsPath: string | null;
  toolsPath: string;
  skills: readonly ToolboxSkill[];
  /** Non-fatal resource findings for this toolbox. */
  issues: readonly string[];
  /** Set when the toolbox cannot be used to create or run a project. */
  error?: string;
}

/**
 * A successfully loaded toolbox. AGENTS.md is read once here so ordinary chat
 * turns reuse the same in-process content instead of touching the disk again.
 */
export interface LoadedToolbox extends ToolboxDefinition {
  /** AGENTS.md content captured at load time; null when the toolbox has none. */
  agentsText: string | null;
}

export interface ToolboxIssue {
  name: string;
  message: string;
}

export interface ToolboxScanResult {
  root: string;
  toolboxes: readonly ToolboxDefinition[];
  /** Toolboxes that are discoverable but unusable or partially damaged. */
  issues: readonly ToolboxIssue[];
}

export class ToolboxError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ToolboxError';
    this.code = code;
  }
}

const MAX_AGENTS_BYTES = 256 * 1024;
const MAX_SKILL_FILE_BYTES = 128 * 1024;

export function resolveToolboxRoot(appPath: string): string {
  return path.join(appPath, 'toolboxes');
}

function isLink(stat: Stats): boolean {
  return stat.isSymbolicLink();
}

function readRegularFile(
  filePath: string,
  maxBytes: number,
): string | null {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || isLink(stat) || stat.size > maxBytes) return null;
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function parseFrontmatter(raw: string): {
  name: string;
  description: string;
} {
  const match = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { name: '', description: '' };
  const values: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!field) continue;
    let value = field[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[field[1]!] = value;
  }
  return {
    name: values.name ?? '',
    description: values.description ?? '',
  };
}

function scanSkills(
  toolboxDirectory: string,
  issues: string[],
): ToolboxSkill[] {
  const skillsDirectory = path.join(toolboxDirectory, 'skills');
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(skillsDirectory);
  } catch {
    return [];
  }
  if (!stat.isDirectory() || isLink(stat)) {
    issues.push('skills 不是普通目录，已忽略。');
    return [];
  }
  let entries;
  try {
    entries = readdirSync(skillsDirectory, { withFileTypes: true });
  } catch {
    issues.push('skills 目录无法读取。');
    return [];
  }
  const skills: ToolboxSkill[] = [];
  const seen = new Set<string>();
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name, 'zh-CN'),
  )) {
    if (!entry.name || entry.name.startsWith('.')) continue;
    const directory = path.join(skillsDirectory, entry.name);
    let childStat: ReturnType<typeof lstatSync>;
    try {
      childStat = lstatSync(directory);
    } catch {
      issues.push(`技能「${entry.name}」无法读取。`);
      continue;
    }
    if (isLink(childStat)) {
      issues.push(`技能「${entry.name}」是链接，已拒绝。`);
      continue;
    }
    if (!childStat.isDirectory()) continue;
    const skillPath = path.join(directory, 'SKILL.md');
    const raw = readRegularFile(skillPath, MAX_SKILL_FILE_BYTES);
    if (raw === null) {
      issues.push(`技能「${entry.name}」缺少可读的 SKILL.md。`);
      continue;
    }
    const metadata = parseFrontmatter(raw);
    const name = (metadata.name || entry.name).trim();
    const description = metadata.description.trim();
    if (!description) {
      issues.push(`技能「${entry.name}」缺少描述。`);
    }
    if (seen.has(name)) {
      issues.push(`技能名称「${name}」重复，已保留第一个。`);
      continue;
    }
    seen.add(name);
    skills.push({
      name,
      description,
      skillPath,
      directory,
    });
  }
  return skills;
}

function readToolbox(directory: string, name: string): ToolboxDefinition {
  const issues: string[] = [];
  let fatal: string | undefined;

  const standardCasePath = path.join(directory, 'standardCase');
  try {
    const stat = lstatSync(standardCasePath);
    if (!stat.isDirectory() || isLink(stat)) {
      throw new Error('not a plain directory');
    }
  } catch {
    fatal = `工具箱「${name}」缺少可用的 standardCase 目录。`;
  }

  const agentsPath = path.join(directory, 'AGENTS.md');
  let agents: string | null = null;
  try {
    const stat = lstatSync(agentsPath);
    if (stat.isFile() && !isLink(stat)) {
      if (stat.size > MAX_AGENTS_BYTES) {
        issues.push('AGENTS.md 超过 256 KiB，未加载。');
      } else {
        agents = agentsPath;
      }
    } else {
      issues.push('AGENTS.md 不是普通文件，已忽略。');
    }
  } catch {
    // AGENTS.md is optional.
  }

  const toolsPath = path.join(directory, 'tools');
  try {
    const stat = lstatSync(toolsPath);
    if (!stat.isDirectory() || isLink(stat)) {
      issues.push('tools 不是普通目录，已忽略。');
    }
  } catch {
    // tools is optional.
  }

  const skills = scanSkills(directory, issues);
  return {
    name,
    directory,
    standardCasePath,
    agentsPath: agents,
    toolsPath,
    skills,
    issues,
    ...(fatal ? { error: fatal } : {}),
  };
}

interface ToolboxRootListing {
  root: string;
  entries: Dirent[];
}

function listToolboxRoot(appPath: string): ToolboxRootListing {
  const root = resolveToolboxRoot(appPath);
  let rootStat: ReturnType<typeof lstatSync>;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    throw new ToolboxError('toolbox-root-missing', `找不到工具箱目录：${root}`, {
      cause: error,
    });
  }
  if (!rootStat.isDirectory() || isLink(rootStat)) {
    throw new ToolboxError(
      'toolbox-root-invalid',
      `工具箱位置不是普通目录：${root}`,
    );
  }

  try {
    return {
      root,
      entries: readdirSync(root, { withFileTypes: true }),
    };
  } catch (error) {
    throw new ToolboxError(
      'toolbox-root-unreadable',
      `无法读取工具箱目录：${root}`,
      { cause: error },
    );
  }
}

/**
 * Loads one toolbox by folder name without scanning the other toolboxes.
 * Discovery still uses `scanToolboxes`; the execution path only reads the
 * toolbox its project is bound to.
 */
export function loadToolboxDefinition(
  appPath: string,
  name: string,
): ToolboxDefinition {
  if (
    typeof name !== 'string' ||
    !name ||
    name === '.' ||
    name === '..' ||
    name.startsWith('.')
  ) {
    throw new ToolboxError('toolbox-missing', `工具箱「${String(name)}」不存在。`);
  }
  const { root, entries } = listToolboxRoot(appPath);
  const folded = name.toLocaleLowerCase('en-US');
  const entry =
    entries.find((candidate) => candidate.name === name) ??
    entries.find(
      (candidate) =>
        candidate.name.toLocaleLowerCase('en-US') === folded,
    );
  if (!entry || !entry.name) {
    throw new ToolboxError('toolbox-missing', `工具箱「${name}」不存在。`);
  }
  const directory = path.join(root, entry.name);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(directory);
  } catch (error) {
    throw new ToolboxError(
      'toolbox-invalid',
      `工具箱「${entry.name}」无法读取。`,
      { cause: error },
    );
  }
  if (isLink(stat)) {
    throw new ToolboxError(
      'toolbox-invalid',
      `工具箱「${entry.name}」是链接，已拒绝加载。`,
    );
  }
  if (!stat.isDirectory()) {
    throw new ToolboxError('toolbox-missing', `工具箱「${name}」不存在。`);
  }
  return readToolbox(directory, entry.name);
}

/**
 * Scans one level below the application `toolboxes/` directory. A damaged
 * toolbox is reported individually and never makes the healthy ones
 * unavailable. Symbolic links and junctions are rejected at every level.
 */
export function scanToolboxes(appPath: string): ToolboxScanResult {
  const { root, entries } = listToolboxRoot(appPath);

  const toolboxes: ToolboxDefinition[] = [];
  const issues: ToolboxIssue[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name, 'zh-CN'),
  )) {
    const name = entry.name;
    if (!name || name.startsWith('.')) continue;
    const directory = path.join(root, name);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(directory);
    } catch {
      issues.push({
        name,
        message: `工具箱「${name}」无法读取，已忽略。`,
      });
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (isLink(stat)) {
      issues.push({
        name,
        message: `工具箱「${name}」是链接，已拒绝加载。`,
      });
      continue;
    }
    const definition = readToolbox(directory, name);
    toolboxes.push(definition);
    if (definition.error) {
      issues.push({ name, message: definition.error });
    }
    for (const issue of definition.issues) {
      issues.push({ name, message: issue });
    }
  }
  if (toolboxes.length === 0 && issues.length === 0) {
    throw new ToolboxError(
      'toolbox-list-empty',
      '未发现可用的 Flamelet 工具箱。请按约定在 toolboxes/ 下新建工具箱文件夹。',
    );
  }
  return { root, toolboxes, issues };
}

export function findToolbox(
  definitions: readonly ToolboxDefinition[],
  name: string,
): ToolboxDefinition | undefined {
  return (
    definitions.find((definition) => definition.name === name) ??
    definitions.find(
      (definition) =>
        definition.name.toLocaleLowerCase('en-US') ===
        name.toLocaleLowerCase('en-US'),
    )
  );
}

export function requireToolbox(
  definitions: readonly ToolboxDefinition[],
  name: string,
): ToolboxDefinition {
  const toolbox = findToolbox(definitions, name);
  if (!toolbox) {
    throw new ToolboxError(
      'toolbox-missing',
      `项目绑定的工具箱「${name}」已不存在或已改名；不会自动绑定其他工具箱。`,
    );
  }
  if (toolbox.error) {
    throw new ToolboxError('toolbox-invalid', toolbox.error);
  }
  return toolbox;
}

/** Current AGENTS.md content, or null when the toolbox has none. */
export function readToolboxAgents(
  toolbox: ToolboxDefinition,
): string | null {
  if (!toolbox.agentsPath) return null;
  return readRegularFile(toolbox.agentsPath, MAX_AGENTS_BYTES);
}
