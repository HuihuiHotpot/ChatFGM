import type { FileTreeEntry } from '../../services/capabilities';

export const WORKFLOW_TOOLBOX = 'counterflowDiffusionFlame';

export const WORKFLOW_STAGES = [
  ['A', '机理准备'],
  ['B', '火焰面计算'],
  ['C', '制表'],
  ['D', '先验验证'],
  ['E', '报告编写'],
] as const;

type WorkflowStage = (typeof WORKFLOW_STAGES)[number][0];

export interface WorkflowProgress {
  stage: WorkflowStage | '0' | 'missing' | 'unknown' | 'unreadable';
  completed: ReadonlySet<WorkflowStage>;
}

export function findCaseDict(tree: readonly FileTreeEntry[]): FileTreeEntry | undefined {
  const directory = tree.find((entry) =>
    entry.kind === 'folder' && entry.name.toLowerCase() === '0-casedict',
  );
  return directory?.children?.find((entry) =>
    entry.kind === 'file' && entry.name.toLowerCase() === 'casedict',
  );
}

function isStage(value: string): value is WorkflowStage {
  return WORKFLOW_STAGES.some(([stage]) => stage === value);
}

const DICTIONARY_TOKEN = /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[{}()[\];]|(?:\/(?![/*])|[^\s{}()[\];/"'])+/gu;
const CLOSING_TOKEN = new Map([['{', '}'], ['(', ')'], ['[', ']']]);

// Values end at a semicolon or at the closing brace of a dictionary block.
// Skip full values so a nested key or a word in another field is never read as a key.
function readEntry(tokens: readonly string[], name: string): string[] | undefined {
  let index = 0;
  while (index < tokens.length) {
    const key = tokens[index++];
    if (key === ';') continue;
    const start = index;
    const dictionary = tokens[start] === '{';
    const closing: string[] = [];
    while (index < tokens.length) {
      const token = tokens[index];
      if (token === ';' && closing.length === 0) break;
      const expected = CLOSING_TOKEN.get(token);
      if (expected) closing.push(expected);
      else if (token === closing.at(-1)) closing.pop();
      index += 1;
      if (dictionary && closing.length === 0) break;
    }
    if (key === name) {
      const terminated = dictionary ? closing.length === 0 : tokens[index] === ';';
      return terminated ? tokens.slice(start, index) : [];
    }
    if (tokens[index] === ';') index += 1;
  }
  return undefined;
}

export function readWorkflowProgress(content: string): WorkflowProgress {
  const tokens = (content.match(DICTIONARY_TOKEN) ?? [])
    .filter((token) => !token.startsWith('//') && !token.startsWith('/*'));
  const value = readEntry(tokens, 'workflowState');
  const completed = new Set<WorkflowStage>();
  if (value?.length === 1 && value[0] === '0') return { stage: '0', completed };

  const extensions = readEntry(tokens, 'extensions');
  if (extensions?.[0] === '{') {
    const list = readEntry(extensions.slice(1, -1), 'completedWorkflowStages');
    if (list?.[0] === '(' && list.at(-1) === ')') {
      const stages = list.slice(1, -1);
      if (stages.every(isStage)) stages.forEach((stage) => completed.add(stage));
    }
  }
  const stage = value?.length === 1 && isStage(value[0])
    ? value[0]
    : value === undefined ? 'missing' : 'unknown';
  return { stage, completed };
}
