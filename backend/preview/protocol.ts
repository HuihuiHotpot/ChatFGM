import { protocol } from 'electron';
import type { Logger } from '../platform/log';
import { CHAT_ATTACHMENT_PREVIEW_SCHEME } from '../chat/attachment-preview';
import {
  HTML_PREVIEW_SCHEME,
  ProjectResourceService,
  ResourceError,
} from '../projects/resources';

const PREVIEW_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

/**
 * Must run before app.ready. The custom scheme is standard so relative URL
 * resolution, JSON fetch and URL path normalization behave consistently.
 */
export function installPreviewScheme(): void {
  // All privileged schemes must be registered together before app.ready.
  // A second call to registerSchemesAsPrivileged would replace the list and
  // drop the HTML preview's fetch/CORS privileges.
  protocol.registerSchemesAsPrivileged([
    {
      scheme: HTML_PREVIEW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
    {
      scheme: CHAT_ATTACHMENT_PREVIEW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);
}

function response(
  status: number,
  body: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...PREVIEW_CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export function registerPreviewProtocol(
  resources: ProjectResourceService,
  logger: Logger,
): void {
  protocol.handle(HTML_PREVIEW_SCHEME, async (request) => {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: PREVIEW_CORS_HEADERS,
      });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return response(405, 'Method Not Allowed', {
        Allow: 'GET, HEAD, OPTIONS',
      });
    }
    try {
      const resource = resources.readHtmlPreviewRequest(request.url);
      const headers = {
        'Content-Type': resource.mime,
        'Content-Length': String(resource.bytes.byteLength),
        ...PREVIEW_CORS_HEADERS,
      };
      if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers });
      }
      return new Response(resource.bytes as unknown as BodyInit, {
        status: 200,
        headers,
      });
    } catch (error) {
      if (error instanceof ResourceError) {
        logger.warn('html-preview-request-rejected', {
          code: error.code,
          status: error.status,
        });
        return response(error.status, error.message);
      }
      logger.error('html-preview-request-failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return response(500, '网页预览资源读取失败。');
    }
  });
}

