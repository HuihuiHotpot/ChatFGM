import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { DecodedText, TextEncoding, TextNewline } from './types';
import { decodeGb18030, encodeGb18030 } from './gb18030';

export class TextFileError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TextFileError';
    this.code = code;
  }
}

export function versionForBytes(
  bytes: Uint8Array,
  stat?: { dev: number; ino: number; size: number; mtimeMs: number; birthtimeMs: number },
): string {
  const hash = createHash('sha256').update(bytes);
  if (stat) {
    // Content alone cannot distinguish a same-byte external replacement.
    // Include Windows file-object state so an atomic replacement changes the
    // opaque token even when the bytes are identical.
    hash.update(
      `|file:${stat.dev}:${stat.ino}:${stat.size}:${Math.round(
        stat.mtimeMs,
      )}:${Math.round(stat.birthtimeMs)}`,
    );
  }
  return hash.digest('hex');
}

type FileStat = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
};

function statSnapshot(stat: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
}): FileStat {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    birthtimeMs: stat.birthtimeMs,
  };
}

function readAll(descriptor: number, size: number): Buffer {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const read = readSync(descriptor, bytes, offset, size - offset, offset);
    if (read <= 0) break;
    offset += read;
  }
  return bytes.subarray(0, offset);
}

/**
 * Reads a consistent prefix of a file that may still be written.
 *
 * A log or solver output is appended while the user reads it. Comparing the
 * stat before and after a `readFileSync` would report every growing file as an
 * external replacement. This reader accepts appended bytes (a prefix is a
 * truthful snapshot of what existed when the read began), retries once when a
 * same-size in-place rewrite is detected, and still rejects an identity change
 * (the path now points at another file) or a truncation.
 */
function readFileState(filePath: string): {
  bytes: Buffer;
  stat: FileStat;
} {
  let lstat: ReturnType<typeof lstatSync>;
  try {
    lstat = lstatSync(filePath);
    accessSync(filePath, constants.R_OK);
  } catch (error) {
    throw new TextFileError(
      'file-unreadable',
      `文件不可读：${filePath}`,
      { cause: error },
    );
  }
  if (!lstat.isFile() || lstat.isSymbolicLink()) {
    throw new TextFileError(
      'not-a-file',
      '目标不是可读取的普通文件。',
    );
  }
  let descriptor: number;
  try {
    descriptor = openSync(filePath, 'r');
  } catch (error) {
    throw new TextFileError(
      'file-unreadable',
      `文件读取失败：${filePath}`,
      { cause: error },
    );
  }
  try {
    let last: { bytes: Buffer; stat: FileStat } | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let before: FileStat;
      try {
        before = statSnapshot(fstatSync(descriptor));
      } catch (error) {
        throw new TextFileError(
          'file-unreadable',
          `文件读取失败：${filePath}`,
          { cause: error },
        );
      }
      let bytes: Buffer;
      try {
        bytes = readAll(descriptor, before.size);
      } catch (error) {
        throw new TextFileError(
          'file-unreadable',
          `文件读取失败：${filePath}`,
          { cause: error },
        );
      }
      let after: FileStat;
      try {
        after = statSnapshot(fstatSync(descriptor));
      } catch (error) {
        throw new TextFileError(
          'file-unreadable',
          `文件读取失败：${filePath}`,
          { cause: error },
        );
      }
      if (after.dev !== before.dev || after.ino !== before.ino) {
        throw new TextFileError(
          'file-changed',
          '文件在读取期间被外部替换，已拒绝使用不一致的内容。',
        );
      }
      if (after.size < before.size) {
        throw new TextFileError(
          'file-changed',
          '文件在读取期间被截短，已拒绝使用不一致的内容。',
        );
      }
      last = { bytes, stat: after };
      const appended = after.size > before.size;
      const rewritten = !appended && after.mtimeMs !== before.mtimeMs;
      // An append is an expected live-output pattern. A same-size rewrite may
      // be mid-write, so retry once before accepting the last read.
      if (!rewritten || attempt > 0) break;
    }
    if (!last) {
      throw new TextFileError(
        'file-unreadable',
        `文件读取失败：${filePath}`,
      );
    }
    return last;
  } finally {
    closeSync(descriptor);
  }
}

function detectNewline(value: string): TextNewline {
  if (value.includes('\r\n')) return '\r\n';
  if (value.includes('\r')) return '\r';
  return '\n';
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function decodeUtf16(body: Buffer, littleEndian: boolean): string {
  if (littleEndian) {
    // Node's utf16le decoder keeps unpaired surrogates instead of replacing
    // them, so an untouched file can be written back byte for byte.
    return body.toString('utf16le');
  }
  const swapped = Buffer.allocUnsafe(body.length - (body.length % 2));
  for (let index = 0; index + 1 < body.length; index += 2) {
    swapped[index] = body[index + 1];
    swapped[index + 1] = body[index];
  }
  return swapped.toString('utf16le');
}

function decodeUtf8Strict(bytes: Uint8Array): string {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  // Streaming mode drops an incomplete trailing sequence. It is shown by the
  // next read once the writer has emitted the remaining bytes.
  return decoder.decode(bytes, { stream: true });
}

function looksLikeUtf16Bom(bytes: Buffer): TextEncoding | null {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return 'utf-16le';
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return 'utf-16be';
  }
  return null;
}

function encodingLabel(encoding: TextEncoding): string {
  switch (encoding) {
    case 'utf-16le':
      return 'UTF-16 LE';
    case 'utf-16be':
      return 'UTF-16 BE';
    case 'gb18030':
      return 'GBK/GB18030';
    default:
      return 'UTF-8';
  }
}

/**
 * Decodes a text file while preserving its original encoding, BOM and newline
 * style. UTF-8 and UTF-16 (BOM) are authoritative. A file without a BOM is
 * treated as UTF-8 when valid, otherwise as GBK/GB18030. Bytes that belong to
 * an unfinished multi-byte character at the end of a live file are withheld
 * from this read rather than displayed as a replacement character.
 *
 * `strictTrailing` is used before writing: it rejects a file whose final byte
 * sequence is incomplete instead of silently dropping those bytes on save.
 */
export interface DecodeTextOptions {
  strictTrailing?: boolean;
}

function incompleteTrailingError(): TextFileError {
  return new TextFileError(
    'incomplete-trailing-bytes',
    '文件末尾存在未写完的多字节字符，继续保存会丢失磁盘上的原始字节。已取消保存；磁盘文件未修改，编辑内容仍保留。',
  );
}

function assertCompleteTrailing(
  body: Buffer,
  encoding: TextEncoding,
): void {
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    if (body.length % 2 !== 0) throw incompleteTrailingError();
    return;
  }
  try {
    const decoder = new TextDecoder(
      encoding === 'gb18030' ? 'gb18030' : 'utf-8',
      { fatal: true },
    );
    // Non-streaming decode rejects an incomplete final sequence. Streaming
    // mode above intentionally withheld it for the live preview.
    decoder.decode(body);
  } catch (error) {
    if (error instanceof TextFileError) throw error;
    const incomplete = incompleteTrailingError();
    throw new TextFileError(incomplete.code, incomplete.message, {
      cause: error,
    });
  }
}

export function decodeTextFile(
  filePath: string,
  options: DecodeTextOptions = {},
): DecodedText {
  const { bytes, stat } = readFileState(filePath);
  const utf16 = looksLikeUtf16Bom(bytes);
  if (utf16) {
    const body = bytes.subarray(2);
    if (options.strictTrailing) assertCompleteTrailing(body, utf16);
    let content: string;
    try {
      content = decodeUtf16(body, utf16 === 'utf-16le');
    } catch (error) {
      throw new TextFileError(
        'unsupported-encoding',
        `该文件不是有效的 ${encodingLabel(utf16)} 文本。`,
        { cause: error },
      );
    }
    return {
      content,
      version: versionForBytes(bytes, stat),
      bom: true,
      newline: detectNewline(content),
      encoding: utf16,
    };
  }

  const hasUtf8Bom =
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf;
  const body = hasUtf8Bom ? bytes.subarray(3) : bytes;
  if (body.includes(0)) {
    throw new TextFileError(
      'binary-content',
      '该文件包含二进制内容，不能按文本打开。',
    );
  }

  if (hasUtf8Bom) {
    let content: string;
    try {
      content = decodeUtf8Strict(body);
    } catch (error) {
      throw new TextFileError(
        'unsupported-encoding',
        '该文件带有 UTF-8 BOM，但不是有效的 UTF-8 文本，已拒绝打开以避免覆盖原文件。',
        { cause: error },
      );
    }
    if (options.strictTrailing) assertCompleteTrailing(body, 'utf-8');
    return {
      content,
      version: versionForBytes(bytes, stat),
      bom: true,
      newline: detectNewline(content),
      encoding: 'utf-8',
    };
  }

  try {
    const content = decodeUtf8Strict(body);
    if (options.strictTrailing) assertCompleteTrailing(body, 'utf-8');
    return {
      content,
      version: versionForBytes(bytes, stat),
      bom: false,
      newline: detectNewline(content),
      encoding: 'utf-8',
    };
  } catch (error) {
    if (error instanceof TextFileError) throw error;
    // Not valid UTF-8; try the common Chinese ANSI encoding.
  }

  try {
    const content = decodeGb18030(body);
    if (options.strictTrailing) assertCompleteTrailing(body, 'gb18030');
    return {
      content,
      version: versionForBytes(bytes, stat),
      bom: false,
      newline: detectNewline(content),
      encoding: 'gb18030',
    };
  } catch (error) {
    if (error instanceof TextFileError) throw error;
    throw new TextFileError(
      'unsupported-encoding',
      '该文件不是有效的 UTF-8、带 BOM 的 UTF-16 或 GBK/GB18030 文本，已拒绝打开以避免覆盖原文件。',
      { cause: error },
    );
  }
}

export interface EncodeTextOptions {
  encoding: TextEncoding;
  bom: boolean;
  newline: TextNewline;
}

function normalizeNewlines(content: string, newline: TextNewline): string {
  return content.replace(/\r\n|\r|\n/g, newline);
}

/**
 * Encodes text for writing back into its original encoding. The operation is
 * lossless: a character the encoding cannot represent raises `encoding-lossy`
 * and the caller keeps the original file untouched.
 */
export function encodeText(
  content: string,
  options: EncodeTextOptions,
): Buffer {
  const { encoding, newline } = options;
  const normalized = normalizeNewlines(content, newline);
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const littleEndianBody = Buffer.from(normalized, 'utf16le');
    if (encoding === 'utf-16le') {
      return Buffer.concat([Buffer.from([0xff, 0xfe]), littleEndianBody]);
    }
    const bigEndianBody = Buffer.allocUnsafe(littleEndianBody.length);
    for (let index = 0; index + 1 < littleEndianBody.length; index += 2) {
      bigEndianBody[index] = littleEndianBody[index + 1];
      bigEndianBody[index + 1] = littleEndianBody[index];
    }
    return Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndianBody]);
  }

  if (encoding === 'gb18030') {
    try {
      return Buffer.from(encodeGb18030(normalized));
    } catch (error) {
      throw new TextFileError(
        'encoding-lossy',
        '内容包含当前 GBK/GB18030 编码无法无损表示的字符，文件未保存。请改为另存为 UTF-8 后再编辑。',
        { cause: error },
      );
    }
  }

  if (hasLoneSurrogate(normalized)) {
    throw new TextFileError(
      'encoding-lossy',
      '内容包含无法用 UTF-8 无损写回的字符（不完整的代理项），文件未保存。',
    );
  }
  const body = Buffer.from(normalized, 'utf8');
  if (!options.bom) return body;
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]);
}

/** Backwards-compatible UTF-8-only entry point for existing callers. */
export function encodeUtf8Text(
  content: string,
  bom: boolean,
  newline: TextNewline,
): Buffer {
  return encodeText(content, { encoding: 'utf-8', bom, newline });
}

/**
 * Writes to a sibling temporary file and swaps it into place only after the
 * whole buffer was written. A failed write leaves the original file untouched.
 */
export function writeFileAtomically(
  targetPath: string,
  bytes: Uint8Array,
): void {
  const directory = path.dirname(targetPath);
  const temporaryPath = path.join(
    directory,
    `.chatfgm-save-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, bytes, { flag: 'wx' });
    renameSync(temporaryPath, targetPath);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original write error.
    }
    throw new TextFileError(
      'file-write-failed',
      `文件写入失败，原文件保持不变：${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

export function currentVersion(filePath: string): string {
  const { bytes, stat } = readFileState(filePath);
  return versionForBytes(bytes, stat);
}

/** Historical name kept for archived diagnostics and older imports. */
export const decodeUtf8File = decodeTextFile;
