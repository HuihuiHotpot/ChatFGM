import { randomBytes } from 'node:crypto';
import { protocol } from 'electron';
import { CHAT_LIMITS } from './limits';
import type { Logger } from '../platform/log';

export const CHAT_ATTACHMENT_PREVIEW_SCHEME = 'chatfgm-attachment';

export interface AttachmentPreviewTarget {
  projectId: string;
  conversationId: string;
  attachmentId: string;
  mime: string;
}

interface PreviewEntry extends AttachmentPreviewTarget {
  expiresAt: number;
}

export interface AttachmentPreviewResolution {
  bytes: Uint8Array;
  mime: string;
}

/**
 * Opaque, expiring preview handles. A handle only authorizes reading one
 * imported attachment copy; it never contains a filesystem path.
 */
export class AttachmentPreviewRegistry {
  private readonly entries = new Map<string, PreviewEntry>();
  private readonly resolveAttachment: (
    projectId: string,
    attachmentId: string,
  ) => Promise<AttachmentPreviewResolution | null>;

  constructor(
    resolveAttachment: (
      projectId: string,
      attachmentId: string,
    ) => Promise<AttachmentPreviewResolution | null>,
  ) {
    this.resolveAttachment = resolveAttachment;
  }

  issue(target: AttachmentPreviewTarget): {
    url: string;
    token: string;
  } {
    this.prune();
    if (this.entries.size >= CHAT_LIMITS.previewTokens) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest === 'string') this.entries.delete(oldest);
    }
    const token = randomBytes(24).toString('hex');
    this.entries.set(token, {
      ...target,
      expiresAt: Date.now() + CHAT_LIMITS.previewTokenTtlMs,
    });
    return {
      token,
      url: `${CHAT_ATTACHMENT_PREVIEW_SCHEME}://preview/${token}`,
    };
  }

  release(projectId: string, token: string): boolean {
    const entry = this.entries.get(token);
    if (!entry || entry.projectId !== projectId) return false;
    this.entries.delete(token);
    return true;
  }

  revokeProject(projectId: string): void {
    for (const [token, entry] of this.entries) {
      if (entry.projectId === projectId) this.entries.delete(token);
    }
  }

  async resolve(
    token: string,
  ): Promise<AttachmentPreviewResolution | null> {
    const entry = this.entries.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(token);
      return null;
    }
    const result = await this.resolveAttachment(
      entry.projectId,
      entry.attachmentId,
    );
    if (!result) return null;
    return {
      bytes: result.bytes,
      mime: result.mime || entry.mime,
    };
  }

  dispose(): void {
    this.entries.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(token);
    }
  }
}

/**
 * The attachment scheme is registered together with the HTML preview scheme in
 * backend/preview/protocol.ts; Electron only keeps one privileged-scheme list.
 */

const PREVIEW_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Access-Control-Allow-Origin': '*',
};

export function registerAttachmentPreviewProtocol(
  registry: AttachmentPreviewRegistry,
  logger: Logger,
): void {
  protocol.handle(CHAT_ATTACHMENT_PREVIEW_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD', ...PREVIEW_HEADERS },
      });
    }
    const token = (() => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== 'preview') return null;
        return url.pathname.replace(/^\/+/, '');
      } catch {
        return null;
      }
    })();
    if (!token || !/^[a-f0-9]{48}$/.test(token)) {
      return new Response('Not Found', { status: 404 });
    }
    try {
      const resolution = await registry.resolve(token);
      if (!resolution) {
        return new Response('Not Found', { status: 404 });
      }
      const headers = {
        'Content-Type': resolution.mime,
        'Content-Length': String(resolution.bytes.byteLength),
        ...PREVIEW_HEADERS,
      };
      if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers });
      }
      return new Response(resolution.bytes as unknown as BodyInit, {
        status: 200,
        headers,
      });
    } catch (error) {
      logger.warn('chat-attachment-preview-failed', {
        message: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      });
      return new Response('Preview Unavailable', {
        status: 404,
        headers: PREVIEW_HEADERS,
      });
    }
  });
}
