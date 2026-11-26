export interface DiskNode {
  name: string;
  relativePath: string;
  absolutePath: string;
  kind: 'file' | 'folder';
  children: DiskNode[];
  /** File stat facts used to detect external content changes. */
  mtimeMs?: number;
  byteSize?: number;
}

export type TextNewline = '\n' | '\r\n' | '\r';

/** Text encodings ChatFGM can read and write back without losing bytes. */
export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';

export interface DecodedText {
  content: string;
  version: string;
  bom: boolean;
  newline: TextNewline;
  /** The encoding the file was read with; saves reuse it. */
  encoding: TextEncoding;
}
