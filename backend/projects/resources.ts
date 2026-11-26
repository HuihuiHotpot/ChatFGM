import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';
import type {
  BinaryResource,
  HtmlPreview,
  HtmlPreviewInput,
  ReadBinaryResourceInput,
  ReleaseHtmlPreviewInput,
} from '../ipc/capabilities';
import type { Logger } from '../platform/log';
import {
  assertNoLinks,
  assertPathInside,
  PathPolicyError,
} from '../filesystem/path-policy';
import { ProjectService } from './service';

export const MAX_BINARY_RESOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_HTML_RESOURCE_BYTES = 32 * 1024 * 1024;
export const HTML_PREVIEW_SCHEME = 'chatfgm-preview';

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

const MIME_BY_EXTENSION: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  map: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
};

export class ResourceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    code: string,
    message: string,
    status = 400,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ResourceError';
    this.code = code;
    this.status = status;
  }
}

function readStableFile(
  absolute: string,
  maxBytes: number,
  label: string,
): Buffer {
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(absolute);
  } catch (error) {
    throw new ResourceError(
      'resource-missing',
      `资源不存在：${label}`,
      404,
      { cause: error },
    );
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new ResourceError(
      'resource-not-file',
      `资源不是普通文件：${label}`,
      403,
    );
  }
  if (before.size > maxBytes) {
    throw new ResourceError(
      'resource-too-large',
      `资源超过 ${Math.floor(maxBytes / (1024 * 1024))} MB 限制：${label}`,
      413,
    );
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(absolute);
  } catch (error) {
    throw new ResourceError(
      'resource-unreadable',
      `资源读取失败：${label}`,
      403,
      { cause: error },
    );
  }
  let after: ReturnType<typeof lstatSync>;
  try {
    after = lstatSync(absolute);
  } catch (error) {
    throw new ResourceError(
      'resource-changed',
      `资源在读取期间发生变化：${label}`,
      409,
      { cause: error },
    );
  }
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new ResourceError(
      'resource-changed',
      `资源在读取期间发生变化：${label}`,
      409,
    );
  }
  return bytes;
}

function detectImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 6 &&
    (Buffer.from(bytes.subarray(0, 6)).toString('ascii') === 'GIF87a' ||
      Buffer.from(bytes.subarray(0, 6)).toString('ascii') === 'GIF89a')
  ) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (
    bytes.length >= 2 &&
    bytes[0] === 0x42 &&
    bytes[1] === 0x4d
  ) {
    return 'image/bmp';
  }
  if (bytes.length > 0) {
    const text = Buffer.from(bytes).toString('utf8');
    const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    if (
      /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(
        withoutBom,
      )
    ) {
      return 'image/svg+xml';
    }
  }
  return null;
}

function expectedImageMime(extension: string): string | null {
  return IMAGE_MIME_BY_EXTENSION[extension] ?? null;
}

function fileExtension(absolute: string): string {
  return path.extname(absolute).slice(1).toLowerCase();
}

function stripReferenceQuery(reference: string): string {
  const query = reference.search(/[?#]/);
  return query >= 0 ? reference.slice(0, query) : reference;
}

function decodeReference(reference: string): string {
  try {
    return decodeURIComponent(reference);
  } catch {
    throw new ResourceError(
      'invalid-resource-path',
      '资源路径包含无效的 URL 编码。',
    );
  }
}

function assertRelativeResourcePath(decoded: string, label: string): void {
  if (!decoded || decoded.includes('\u0000')) {
    throw new ResourceError(
      'invalid-resource-path',
      `${label}为空或包含非法字符。`,
    );
  }
  if (
    decoded.startsWith('/') ||
    decoded.startsWith('\\') ||
    path.win32.isAbsolute(decoded) ||
    /^[a-zA-Z]:[\\/]/.test(decoded) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded)
  ) {
    throw new ResourceError(
      'invalid-resource-path',
      `${label}必须是项目内相对路径。`,
      403,
    );
  }
}

/**
 * Resolves a Markdown/HTML reference relative to its document. The renderer
 * never supplies a path to the backend as an absolute path.
 */
export function resolveProjectReference(
  projectPath: string,
  documentPath: string,
  reference: string,
  label = '资源路径',
): { absolute: string; relative: string } {
  const withoutQuery = stripReferenceQuery(reference);
  const decoded = decodeReference(withoutQuery);
  assertRelativeResourcePath(decoded, label);
  const absolute = path.resolve(path.dirname(documentPath), decoded);
  try {
    assertPathInside(projectPath, absolute);
    assertNoLinks(projectPath, absolute);
  } catch (error) {
    if (error instanceof PathPolicyError) {
      throw new ResourceError(
        'path-outside-project',
        `${label}位于项目目录之外。`,
        403,
        { cause: error },
      );
    }
    throw error;
  }
  const relative = path.relative(projectPath, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new ResourceError(
      'path-outside-project',
      `${label}位于项目目录之外。`,
      403,
    );
  }
  return { absolute, relative };
}

function readImageResource(
  absolute: string,
  label: string,
): BinaryResource {
  const bytes = readStableFile(
    absolute,
    MAX_BINARY_RESOURCE_BYTES,
    label,
  );
  const extension = fileExtension(absolute);
  const expected = expectedImageMime(extension);
  if (!expected) {
    throw new ResourceError(
      'unsupported-image-format',
      `不支持的图片格式：${label}`,
      415,
    );
  }
  const detected = detectImageMime(bytes);
  if (!detected) {
    throw new ResourceError(
      'invalid-image-content',
      `无法识别图片内容或扩展名与内容不符：${label}`,
      415,
    );
  }
  if (detected !== expected) {
    throw new ResourceError(
      'image-extension-mismatch',
      `图片扩展名与内容不符：${label}`,
      415,
    );
  }
  return { bytes: new Uint8Array(bytes), mime: detected };
}

function mimeForPath(absolute: string): string {
  return (
    MIME_BY_EXTENSION[fileExtension(absolute)] ??
    'application/octet-stream'
  );
}

function encodeProjectRelativePath(relative: string): string {
  return relative
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

interface PreviewHandle {
  handle: string;
  projectId: string;
  fileIdentity: string;
  projectPath: string;
  createdAt: number;
}

export class ProjectResourceService {
  private readonly projectService: ProjectService;
  private readonly logger: Logger;
  private readonly previewHandles = new Map<string, PreviewHandle>();

  constructor(projectService: ProjectService, logger: Logger) {
    this.projectService = projectService;
    this.logger = logger;
  }

  readBinaryResource(
    input: ReadBinaryResourceInput,
  ): BinaryResource {
    const document = this.projectService.resolveFileEntry(
      input.projectId,
      input.fileIdentity,
    );
    if (input.relativePath !== undefined) {
      const target = resolveProjectReference(
        document.project.path,
        document.absolute,
        input.relativePath,
        '图片资源路径',
      );
      return readImageResource(target.absolute, target.relative);
    }
    return readImageResource(document.absolute, document.entry.name);
  }

  forgetProject(projectId: string): void {
    for (const [handle, preview] of this.previewHandles) {
      if (preview.projectId === projectId) this.previewHandles.delete(handle);
    }
  }

  getHtmlPreviewUrl(input: HtmlPreviewInput): HtmlPreview {
    const entry = this.projectService.resolveFileEntry(
      input.projectId,
      input.fileIdentity,
    );
    const extension = fileExtension(entry.absolute);
    if (extension !== 'html' && extension !== 'htm') {
      throw new ResourceError(
        'not-an-html-file',
        '所选文件不是 HTML 文件。',
        415,
      );
    }
    // Check the entry immediately so a successful response cannot point at a
    // missing/unreadable file.
    readStableFile(
      entry.absolute,
      MAX_HTML_RESOURCE_BYTES,
      entry.entry.name,
    );
    const handle = randomUUID().toLowerCase();
    this.previewHandles.set(handle, {
      handle,
      projectId: entry.project.id,
      fileIdentity: entry.entry.entryId,
      projectPath: entry.project.path,
      createdAt: Date.now(),
    });
    const relativePath = path.relative(
      entry.project.path,
      entry.absolute,
    );
    return {
      url: `${HTML_PREVIEW_SCHEME}://${handle}/${encodeProjectRelativePath(
        relativePath,
      )}`,
      handle,
    };
  }

  releaseHtmlPreview(input: ReleaseHtmlPreviewInput): null {
    const active = this.previewHandles.get(input.handle);
    if (!active) {
      // Releasing twice is harmless and must not affect another instance.
      return null;
    }
    if (
      active.projectId !== input.projectId ||
      active.fileIdentity !== input.fileIdentity
    ) {
      throw new ResourceError(
        'preview-handle-owner-mismatch',
        '预览句柄不属于当前项目或文件。',
        403,
      );
    }
    this.previewHandles.delete(input.handle);
    this.logger.info('html-preview-released', {
      projectId: input.projectId,
    });
    return null;
  }

  /**
   * Resolves a protocol request. A valid handle authenticates the project; the
   * URL path is still constrained to that project and never used as an
   * arbitrary absolute path.
   */
  readHtmlPreviewRequest(
    requestUrl: string,
  ): { bytes: Uint8Array; mime: string } {
    let parsed: URL;
    try {
      parsed = new URL(requestUrl);
    } catch (error) {
      throw new ResourceError(
        'invalid-preview-url',
        '网页预览地址无效。',
        400,
        { cause: error },
      );
    }
    if (
      parsed.protocol !== `${HTML_PREVIEW_SCHEME}:` ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !parsed.hostname
    ) {
      throw new ResourceError(
        'invalid-preview-url',
        '网页预览地址无效。',
        403,
      );
    }
    const active = this.previewHandles.get(parsed.hostname.toLowerCase());
    if (!active) {
      throw new ResourceError(
        'preview-handle-expired',
        '网页预览句柄已失效，请刷新。',
        404,
      );
    }
    const document = this.projectService.resolveFileEntry(
      active.projectId,
      active.fileIdentity,
    );
    if (document.project.path !== active.projectPath) {
      throw new ResourceError(
        'preview-handle-expired',
        '网页预览句柄已失效，请刷新。',
        404,
      );
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(parsed.pathname);
    } catch (error) {
      throw new ResourceError(
        'invalid-preview-path',
        '网页资源路径无效。',
        400,
        { cause: error },
      );
    }
    if (
      decodedPath.includes('\u0000') ||
      !decodedPath.startsWith('/') ||
      decodedPath.startsWith('//')
    ) {
      throw new ResourceError(
        'invalid-preview-path',
        '网页资源路径无效。',
        403,
      );
    }
    const relative = decodedPath.slice(1);
    if (
      !relative ||
      path.win32.isAbsolute(relative) ||
      /^[a-zA-Z]:[\\/]/.test(relative) ||
      relative.startsWith('\\\\')
    ) {
      throw new ResourceError(
        'invalid-preview-path',
        '网页资源路径无效。',
        403,
      );
    }
    const target = path.resolve(document.project.path, relative);
    try {
      assertPathInside(document.project.path, target);
      assertNoLinks(document.project.path, target);
    } catch (error) {
      throw new ResourceError(
        'path-outside-project',
        '网页资源位于项目目录之外。',
        403,
        { cause: error },
      );
    }
    const label = path.relative(document.project.path, target);
    const bytes = readStableFile(
      target,
      MAX_HTML_RESOURCE_BYTES,
      label,
    );
    return {
      bytes: new Uint8Array(bytes),
      mime: mimeForPath(target),
    };
  }
}

