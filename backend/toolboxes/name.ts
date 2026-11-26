/**
 * A toolbox is addressed by a single folder name below `toolboxes/`. The name
 * is also the user-visible label, so any legal Windows directory name is
 * accepted except names that cannot be a real direct child directory.
 */
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

const MAX_TOOLBOX_NAME = 255;

/** Rejects path separators, traversal, Windows-invalid characters and device names. */
export function isValidToolboxFolderName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TOOLBOX_NAME) {
    return false;
  }
  if (value === '.' || value === '..') return false;
  if (/[<>:"/\\|?*]/.test(value)) return false;
  for (const character of value) {
    if (character.charCodeAt(0) < 32) return false;
  }
  // Windows strips trailing dots/spaces; such a name cannot round-trip as a folder.
  if (value.endsWith('.') || value.endsWith(' ')) return false;
  const base = value.split('.')[0]!.toLowerCase();
  if (RESERVED_NAMES.has(base)) return false;
  return true;
}

export function toolboxNameError(label = '工具箱名称'): string {
  return `${label}无效：必须是与 toolboxes/ 下一级文件夹同名的合法 Windows 文件夹名，不能包含路径分隔符、控制字符或设备名。`;
}

export { MAX_TOOLBOX_NAME };
