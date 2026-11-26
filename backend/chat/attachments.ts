import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { dialog, nativeImage, type BrowserWindow } from 'electron';
import type {
  ChatAttachment,
  ChatAttachmentKind,
  ChatReference,
  SelectChatAttachmentInput,
} from '../ipc/capabilities';
import type { Logger } from '../platform/log';
import type { ProjectService } from '../projects/service';
import {
  AttachmentPreviewRegistry,
  type AttachmentPreviewResolution,
} from './attachment-preview';
import { CHAT_LIMITS } from './limits';
import type {
  ChatAttachmentRecord,
  ChatStore,
} from './store';

export interface ScreenshotProvider {
  capture(): Promise<{
    png: Uint8Array;
    width: number;
    height: number;
  } | null>;
}

export interface AttachmentServiceOptions {
  store: ChatStore;
  projectService: ProjectService;
  logger: Logger;
  userDataPath: string;
  getMainWindow: () => BrowserWindow | undefined;
  screenshot: ScreenshotProvider;
}

interface ImageInfo {
  mime: string;
  extension: string;
  width: number;
  height: number;
}

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.log',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.ps1',
  '.sh',
  '.bat',
  '.cmd',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.f',
  '.f90',
  '.for',
  '.tex',
  '.bib',
]);

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
]);

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(value)) {
    throw new Error(`${label}无效。`);
  }
  return value;
}

function safeOriginalName(value: string): string {
  const name = path
    .basename(value)
    .split('')
    .filter((character) => character.charCodeAt(0) >= 32)
    .join('')
    .trim();
  if (!name) return '附件';
  return name.length > 200 ? name.slice(0, 200) : name;
}

function detectImage(bytes: Uint8Array): ImageInfo | null {
  let mime = '';
  let extension = '';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    mime = 'image/png';
    extension = '.png';
  } else if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    mime = 'image/jpeg';
    extension = '.jpg';
  } else if (
    bytes.length >= 6 &&
    (String.fromCharCode(...bytes.slice(0, 6)) === 'GIF87a' ||
      String.fromCharCode(...bytes.slice(0, 6)) === 'GIF89a')
  ) {
    mime = 'image/gif';
    extension = '.gif';
  } else if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    mime = 'image/webp';
    extension = '.webp';
  } else if (
    bytes.length >= 2 &&
    bytes[0] === 0x42 &&
    bytes[1] === 0x4d
  ) {
    mime = 'image/bmp';
    extension = '.bmp';
  }
  if (!mime) return null;
  const image = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  if (width <= 0 || height <= 0) return null;
  if (
    width > CHAT_LIMITS.imageDimension ||
    height > CHAT_LIMITS.imageDimension
  ) {
    throw new Error(
      `图片尺寸 ${width}×${height} 超过 ${CHAT_LIMITS.imageDimension} 像素上限。`,
    );
  }
  return { mime, extension, width, height };
}

function decodeText(bytes: Uint8Array): string {
  if (bytes.includes(0)) {
    throw new Error('文件包含二进制内容，当前只支持 UTF-8 文本附件。');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  } catch {
    throw new Error('文件不是有效的 UTF-8 文本，未导入。');
  }
  if (text.length > CHAT_LIMITS.textAttachmentBytes) {
    throw new Error(
      `文本内容超过 ${CHAT_LIMITS.textAttachmentBytes} 字符上限。`,
    );
  }
  return text;
}

export class AttachmentService {
  private readonly store: ChatStore;
  private readonly projectService: ProjectService;
  private readonly logger: Logger;
  private readonly root: string;
  private readonly getMainWindow: () => BrowserWindow | undefined;
  private readonly screenshot: ScreenshotProvider;
  readonly previews: AttachmentPreviewRegistry;

  constructor(options: AttachmentServiceOptions) {
    this.store = options.store;
    this.projectService = options.projectService;
    this.logger = options.logger;
    this.root = path.join(options.userDataPath, 'chat-attachments');
    this.getMainWindow = options.getMainWindow;
    this.screenshot = options.screenshot;
    this.previews = new AttachmentPreviewRegistry(
      async (projectId, attachmentId) =>
        this.resolvePreview(projectId, attachmentId),
    );
    mkdirSync(this.root, { recursive: true });
  }

  dispose(): void {
    this.previews.dispose();
  }

  async select(
    input: SelectChatAttachmentInput,
  ): Promise<ChatAttachment | null> {
    const conversation = this.store.getConversation(
      input.projectId,
      input.conversationId,
    );
    if (!conversation) {
      throw new Error('对话不存在或不属于当前项目。');
    }
    this.projectService.getProjectRoot(input.projectId);
    if (input.kind === 'screenshot') {
      const capture = await this.screenshot.capture();
      if (!capture) return null;
      return this.importBuffer({
        projectId: input.projectId,
        conversationId: input.conversationId,
        originalName: `截图 ${new Date()
          .toISOString()
          .replace(/[:.]/g, '-')}.png`,
        kind: 'screenshot',
        bytes: capture.png,
        forcedImage: true,
      });
    }
    const window = this.getMainWindow();
    const imageOnly = input.kind === 'image';
    const options = {
      title: imageOnly ? '选择图片' : '选择要加入对话的文件',
      properties: ['openFile'] as Array<'openFile'>,
      filters: imageOnly
        ? [
            {
              name: '图片',
              extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
            },
          ]
        : [
            {
              name: '文本或图片',
              extensions: [
                'txt',
                'md',
                'markdown',
                'csv',
                'tsv',
                'json',
                'yaml',
                'yml',
                'toml',
                'ini',
                'log',
                'xml',
                'html',
                'htm',
                'css',
                'js',
                'ts',
                'py',
                'ps1',
                'sh',
                'c',
                'h',
                'cpp',
                'hpp',
                'f90',
                'tex',
                'png',
                'jpg',
                'jpeg',
                'gif',
                'webp',
                'bmp',
              ],
            },
            { name: '所有文件', extensions: ['*'] },
          ],
    };
    const selected = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (selected.canceled || selected.filePaths.length !== 1) return null;
    return this.importFile({
      projectId: input.projectId,
      conversationId: input.conversationId,
      sourcePath: selected.filePaths[0]!,
      requestedKind: input.kind,
    });
  }

  resolvePreview(
    projectId: string,
    attachmentId: string,
  ): AttachmentPreviewResolution | null {
    const record = this.store.getAttachment(projectId, attachmentId);
    if (!record) return null;
    try {
      const bytes = readFileSync(this.absolutePath(record));
      if (bytes.byteLength !== record.byteSize) return null;
      return { bytes, mime: record.mime };
    } catch {
      return null;
    }
  }

  releasePreview(projectId: string, token: string): void {
    this.previews.release(projectId, token);
  }

  enrichReferences(
    projectId: string,
    conversationId: string,
    references: readonly ChatReference[],
  ): ChatReference[] {
    return references.map((reference) => {
      if (reference.kind !== 'attachment' || !reference.attachmentId) {
        return { ...reference };
      }
      const record = this.store.getAttachment(
        projectId,
        reference.attachmentId,
      );
      if (!record || record.conversationId !== conversationId) {
        return { ...reference, invalid: true };
      }
      const enriched: ChatReference = {
        ...reference,
        name: record.originalName,
        mime: record.mime,
        invalid: false,
      };
      if (record.mime.startsWith('image/')) {
        const preview = this.previews.issue({
          projectId,
          conversationId,
          attachmentId: record.id,
          mime: record.mime,
        });
        enriched.preview = preview;
      } else {
        delete enriched.preview;
      }
      return enriched;
    });
  }

  getText(record: ChatAttachmentRecord): string {
    const bytes = this.readVerified(record);
    if (bytes.byteLength > CHAT_LIMITS.textAttachmentBytes) {
      throw new Error(
        `文本附件「${record.originalName}」超过 ${CHAT_LIMITS.textAttachmentBytes} 字节上限，未发送。`,
      );
    }
    return decodeText(bytes);
  }

  getImagePath(record: ChatAttachmentRecord): {
    path: string;
    width: number;
    height: number;
  } {
    const bytes = this.readVerified(record);
    const image = detectImage(bytes);
    if (!image) {
      throw new Error(
        `附件「${record.originalName}」不是受支持的图片，未发送。`,
      );
    }
    if (!record.mime.startsWith('image/')) {
      throw new Error(`附件「${record.originalName}」不是图片。`);
    }
    return {
      path: this.absolutePath(record),
      width: image.width,
      height: image.height,
    };
  }

  get(projectId: string, attachmentId: string): ChatAttachmentRecord | null {
    return this.store.getAttachment(projectId, attachmentId);
  }

  absolutePath(record: ChatAttachmentRecord): string {
    const base = path.join(
      this.root,
      safeSegment(record.projectId, '项目标识'),
      safeSegment(record.conversationId, '对话标识'),
    );
    const absolute = path.resolve(base, record.storageName);
    const relative = path.relative(path.resolve(base), absolute);
    if (
      !relative ||
      relative.startsWith('..') ||
      path.isAbsolute(relative)
    ) {
      throw new Error('附件存储路径无效。');
    }
    return absolute;
  }

  private readVerified(record: ChatAttachmentRecord): Buffer {
    const absolute = this.absolutePath(record);
    let bytes: Buffer;
    try {
      const info = lstatSync(absolute);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error('附件存储对象不是普通文件。');
      }
      bytes = readFileSync(absolute);
    } catch (error) {
      throw new Error(
        `附件「${record.originalName}」的受控副本不可读：${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    if (bytes.byteLength !== record.byteSize) {
      throw new Error(`附件「${record.originalName}」的副本大小与记录不一致。`);
    }
    if (digest(bytes) !== record.sha256) {
      throw new Error(`附件「${record.originalName}」的副本摘要与记录不一致。`);
    }
    return bytes;
  }

  private async importFile(input: {
    projectId: string;
    conversationId: string;
    sourcePath: string;
    requestedKind: ChatAttachmentKind;
  }): Promise<ChatAttachment> {
    let resolved: string;
    try {
      resolved = realpathSync.native(input.sourcePath);
    } catch {
      throw new Error('所选文件不存在或不可访问。');
    }
    const info = lstatSync(resolved);
    if (!info.isFile()) {
      throw new Error('所选对象不是普通文件。');
    }
    if (info.size > CHAT_LIMITS.imageAttachmentBytes) {
      throw new Error(
        `文件超过 ${CHAT_LIMITS.imageAttachmentBytes} 字节上限，未导入。`,
      );
    }
    const bytes = readFileSync(resolved);
    if (bytes.byteLength > CHAT_LIMITS.imageAttachmentBytes) {
      throw new Error(
        `文件超过 ${CHAT_LIMITS.imageAttachmentBytes} 字节上限，未导入。`,
      );
    }
    return this.importBuffer({
      projectId: input.projectId,
      conversationId: input.conversationId,
      originalName: safeOriginalName(path.basename(resolved)),
      kind: input.requestedKind,
      bytes,
    });
  }

  private importBuffer(input: {
    projectId: string;
    conversationId: string;
    originalName: string;
    kind: ChatAttachmentKind;
    bytes: Uint8Array;
    forcedImage?: boolean;
  }): ChatAttachment {
    // A native picker/capture can complete after a confirmed replacement.
    // Recheck ownership before creating any new cache file.
    this.projectService.getProjectRoot(input.projectId);
    if (!this.store.getConversation(input.projectId, input.conversationId)) {
      throw new Error('对话已不存在，附件未导入。');
    }
    if (input.bytes.byteLength > CHAT_LIMITS.imageAttachmentBytes) {
      throw new Error(
        `附件超过 ${CHAT_LIMITS.imageAttachmentBytes} 字节上限，未导入。`,
      );
    }
    const image = detectImage(input.bytes);
    const extension = path.extname(input.originalName).toLowerCase();
    let mime: string;
    let kind: 'file' | 'image' | 'screenshot' =
      input.kind === 'screenshot' ? 'screenshot' : 'file';
    let width: number | undefined;
    let height: number | undefined;
    let storageExtension: string;
    if (image) {
      mime = image.mime;
      kind = 'image';
      width = image.width;
      height = image.height;
      storageExtension = image.extension;
    } else if (input.forcedImage) {
      throw new Error('截图数据不是受支持的图片。');
    } else {
      if (input.kind === 'image') {
        throw new Error('所选文件不是受支持的图片。');
      }
      if (
        extension &&
        !TEXT_EXTENSIONS.has(extension) &&
        !IMAGE_EXTENSIONS.has(extension)
      ) {
        throw new Error(
          '当前只支持 UTF-8 文本和常见图片附件；其他二进制文件未导入。',
        );
      }
      if (
        input.bytes.byteLength > CHAT_LIMITS.textAttachmentBytes
      ) {
        throw new Error(
          `文本附件超过 ${CHAT_LIMITS.textAttachmentBytes} 字节上限，未导入。`,
        );
      }
      decodeText(input.bytes);
      mime = extension === '.md' || extension === '.markdown'
        ? 'text/markdown'
        : 'text/plain';
      storageExtension = extension && TEXT_EXTENSIONS.has(extension)
        ? extension
        : '.txt';
    }
    const targetDirectory = path.join(
      this.root,
      safeSegment(input.projectId, '项目标识'),
      safeSegment(input.conversationId, '对话标识'),
    );
    mkdirSync(targetDirectory, { recursive: true });
    const storageName = `${randomUUID()}${storageExtension}`;
    const absolute = path.join(targetDirectory, storageName);
    try {
      const fd = openSync(absolute, 'wx', 0o600);
      try {
        writeSync(fd, input.bytes);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      throw new Error(
        `附件副本写入失败：${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    let record: ChatAttachmentRecord;
    try {
      record = this.store.insertAttachment({
        projectId: input.projectId,
        conversationId: input.conversationId,
        originalName: input.originalName,
        kind,
        mime,
        byteSize: input.bytes.byteLength,
        sha256: digest(input.bytes),
        storageName,
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
      });
    } catch (error) {
      try {
        if (existsSync(absolute)) unlinkSync(absolute);
      } catch {
        this.logger.warn('chat-attachment-cleanup-failed', {
          message: 'attachment-copy-cleanup-failed',
        });
      }
      throw error;
    }
    this.logger.info('chat-attachment-imported', {
      kind: record.kind,
      bytes: record.byteSize,
      width: record.width ?? 0,
      height: record.height ?? 0,
    });
    const attachment: ChatAttachment = {
      id: record.id,
      name: record.originalName,
      kind: record.kind,
      mime: record.mime,
      displayPath: record.originalName,
    };
    if (record.mime.startsWith('image/')) {
      const preview = this.previews.issue({
        projectId: record.projectId,
        conversationId: record.conversationId,
        attachmentId: record.id,
        mime: record.mime,
      });
      attachment.previewUrl = preview.url;
      attachment.previewToken = preview.token;
    }
    return attachment;
  }
}
