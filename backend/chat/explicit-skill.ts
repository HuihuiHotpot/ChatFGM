import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import type { ToolboxDefinition } from '../toolboxes/registry';
import { ChatStoreError } from './store';

const MAX_SKILL_BYTES = 128 * 1024;

export interface ExplicitSkillContext {
  name: string;
  skillPath: string;
  directory: string;
  body: string;
  input: { type: 'text'; text: string };
}

/**
 * The CLI only injects skill bodies for skills registered in CODEX_HOME. For
 * an in-place toolbox skill, the application reads the current SKILL.md on the
 * explicit `/skill` turn and sends it as context. Nothing is copied, installed
 * or unconditionally added to unrelated messages.
 */
export function explicitSkillContext(
  toolbox: ToolboxDefinition,
  text: string,
): ExplicitSkillContext | null {
  const match = text.match(/^\s*\/([A-Za-z0-9_.-]{1,80})\b/);
  if (!match) return null;
  const skill = toolbox.skills.find(
    (candidate) => candidate.name === match[1],
  );
  if (!skill) {
    const skillIssue = toolbox.issues.find(
      (issue) =>
        issue.includes(`技能「${match[1]}」`) ||
        issue.includes(`技能名称「${match[1]}」`),
    );
    if (skillIssue) {
      throw new ChatStoreError(
        'chat-skill-unavailable',
        `显式技能「${match[1]}」不可用：${skillIssue}`,
      );
    }
    throw new ChatStoreError(
      'chat-skill-not-found',
      `当前工具箱没有显式技能「${match[1]}」；未发送，请检查名称或技能文件。`,
    );
  }
  let fileStat;
  try {
    fileStat = lstatSync(skill.skillPath);
  } catch (error) {
    throw new ChatStoreError(
      'chat-skill-unavailable',
      `技能「${skill.name}」的 SKILL.md 已不存在，无法加载。`,
      { cause: error },
    );
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new ChatStoreError(
      'chat-skill-unavailable',
      `技能「${skill.name}」的 SKILL.md 不是可读取的普通文件。`,
    );
  }
  if (fileStat.size > MAX_SKILL_BYTES) {
    throw new ChatStoreError(
      'chat-skill-unavailable',
      `技能「${skill.name}」的 SKILL.md 超过 128 KiB，无法安全加载。`,
    );
  }
  let body: string;
  try {
    const realDirectory = realpathSync(skill.directory);
    const realSkillFile = realpathSync(skill.skillPath);
    const relative = path.relative(realDirectory, realSkillFile);
    if (
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      !statSync(realSkillFile).isFile()
    ) {
      throw new Error('skill file is outside its skill directory');
    }
    body = readFileSync(realSkillFile, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    throw new ChatStoreError(
      'chat-skill-unavailable',
      `无法读取技能「${skill.name}」的 SKILL.md。`,
      { cause: error },
    );
  }
  const inputText = [
    '[ChatFGM 原位技能调用]',
    `技能：${skill.name}`,
    `SKILL.md：${skill.skillPath}`,
    `技能目录：${skill.directory}`,
    '以下正文是本次显式调用时从磁盘读取的当前内容；未复制、未安装到全局技能目录。引用相对资源时一律以技能目录为基准。',
    '----- SKILL.md START -----',
    body.trimEnd(),
    '----- SKILL.md END -----',
  ].join('\n');
  return {
    name: skill.name,
    skillPath: skill.skillPath,
    directory: skill.directory,
    body,
    input: { type: 'text', text: inputText },
  };
}
