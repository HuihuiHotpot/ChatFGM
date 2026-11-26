export type ViewerKind =
  | 'text'
  | 'markdown'
  | 'image'
  | 'csv'
  | 'html'
  | 'h5';

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  py: 'python',
  pyw: 'python',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  java: 'java',
  go: 'go',
  rs: 'rust',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  sql: 'sql',
  tex: 'latex',
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function viewerKindForFileName(name: string): ViewerKind {
  const extension = extensionOf(name);
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (extension === 'csv') return 'csv';
  if (extension === 'html' || extension === 'htm') return 'html';
  if (extension === 'h5' || extension === 'hdf5') return 'h5';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  return 'text';
}

export function languageForFileName(name: string): string {
  return LANGUAGE_BY_EXTENSION[extensionOf(name)] ?? 'plaintext';
}

export function isEditableViewer(kind: ViewerKind): boolean {
  return kind === 'text' || kind === 'markdown';
}

export function isTextContentViewer(kind: ViewerKind): boolean {
  return kind === 'text' || kind === 'markdown' || kind === 'csv';
}

export function isImageFileName(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

export function viewerKindLabel(kind: ViewerKind): string {
  switch (kind) {
    case 'image':
      return '图片';
    case 'csv':
      return 'CSV';
    case 'html':
      return 'HTML';
    case 'h5':
      return 'H5';
    case 'markdown':
      return 'Markdown';
    default:
      return '文本';
  }
}
