import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import type {
  BinaryResource,
  ReadBinaryResourceInput,
  ServiceResult,
} from '../../services/capabilities';
import type {
  OpenDocument,
  TextViewState,
} from '../../state/workspace';
import { CodeEditor } from './CodeEditor';
import {
  decorateMarkdownDocument,
  renderMarkdown,
} from './markdown';
import { readBinaryResourceOnce } from './binary-resource';
import './viewers.css';

export interface MarkdownViewerProps {
  projectId: string;
  document: OpenDocument;
  active: boolean;
  readBinaryResource?: (
    input: ReadBinaryResourceInput,
  ) => Promise<ServiceResult<BinaryResource>>;
  onChange: (content: string) => void;
  onTextViewChange: (patch: Partial<TextViewState>) => void;
  onPreviewScroll: (scrollTop: number) => void;
}

interface LocalImageEntry {
  status: 'loading' | 'ready' | 'error';
  url?: string;
  message?: string;
}

export function MarkdownViewer({
  projectId,
  document,
  active,
  readBinaryResource,
  onChange,
  onTextViewChange,
  onPreviewScroll,
}: MarkdownViewerProps) {
  const previewRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const locationRef = useRef(document.path);
  const externalRevisionRef = useRef(document.externalRevision);
  const cacheRef = useRef(new Map<string, LocalImageEntry>());
  const activeSourcesRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const imageRequestVersionRef = useRef(0);
  const localImageLoadIdsRef = useRef(new Map<string, number>());
  const scrollFrameRef = useRef(0);
  const lastActivePreviewRef = useRef(false);
  const lastPreviewScrollRef = useRef(
    document.markdownView.previewScrollTop,
  );

  const rendered = useMemo(
    () => renderMarkdown(document.content),
    [document.content],
  );
  const mode = document.markdownView.mode;

  function showImageError(image: HTMLImageElement, message: string) {
    if (!image.isConnected) return;
    const fallback = window.document.createElement('span');
    fallback.className = 'md-image-fallback';
    fallback.textContent = `图片加载失败：${image.alt || message}`;
    fallback.title = message;
    image.replaceWith(fallback);
  }

  function applyImageSource(src: string, entry: LocalImageEntry) {
    const article = articleRef.current;
    if (!article) return;
    article
      .querySelectorAll<HTMLImageElement>('img[data-chatfgm-src]')
      .forEach((image) => {
        if (image.dataset.chatfgmSrc !== src) return;
        if (entry.status === 'ready' && entry.url) {
          image.onerror = () => {
            if (entry.url) URL.revokeObjectURL(entry.url);
            cacheRef.current.set(src, {
              status: 'error',
              message: '无法解码该图片',
            });
            showImageError(image, '无法解码该图片');
          };
          image.src = entry.url;
          image.dataset.imageState = 'ready';
          return;
        }
        if (entry.status === 'error') {
          showImageError(image, entry.message ?? '无法加载图片');
          return;
        }
        image.dataset.imageState = 'loading';
      });
  }

  function invalidateLocalImages() {
    imageRequestVersionRef.current += 1;
    localImageLoadIdsRef.current.clear();
    activeSourcesRef.current = new Set();
    for (const entry of cacheRef.current.values()) {
      if (entry.url) URL.revokeObjectURL(entry.url);
    }
    cacheRef.current.clear();
  }

  function syncLocalImages() {
    const article = articleRef.current;
    if (!article) return;
    const sources = new Set<string>();
    article
      .querySelectorAll<HTMLImageElement>('img[data-chatfgm-src]')
      .forEach((image) => {
        const src = image.dataset.chatfgmSrc;
        if (!src) return;
        sources.add(src);
        const cached = cacheRef.current.get(src);
        if (cached) applyImageSource(src, cached);
      });

    article.querySelectorAll<HTMLImageElement>('img[data-image-error]').forEach(
      (image) => {
        showImageError(
          image,
          image.dataset.imageError || '资源路径无效',
        );
      },
    );

    for (const [src, entry] of cacheRef.current) {
      if (sources.has(src)) continue;
      if (entry.url) URL.revokeObjectURL(entry.url);
      cacheRef.current.delete(src);
    }
    activeSourcesRef.current = sources;

    for (const src of sources) {
      if (cacheRef.current.has(src)) continue;
      if (!readBinaryResource) {
        cacheRef.current.set(src, {
          status: 'error',
          message: '当前环境不支持读取图片资源',
        });
        continue;
      }
      cacheRef.current.set(src, { status: 'loading' });
      applyImageSource(src, { status: 'loading' });
      const loadId =
        (localImageLoadIdsRef.current.get(src) ?? 0) + 1;
      localImageLoadIdsRef.current.set(src, loadId);
      void loadLocalImage(src, loadId);
    }
  }

  async function loadLocalImage(src: string, loadId: number) {
    if (!readBinaryResource) return;
    const requestVersion = imageRequestVersionRef.current;
    const result = await readBinaryResourceOnce(
      {
        projectId,
        fileIdentity: document.identity,
        relativePath: src,
      },
      readBinaryResource,
      document.path,
      `${document.identity}\u0000${document.externalRevision}`,
      document.instanceId,
    );
    if (
      !mountedRef.current ||
      requestVersion !== imageRequestVersionRef.current ||
      localImageLoadIdsRef.current.get(src) !== loadId
    ) {
      return;
    }
    if (result.status !== 'success') {
      const entry: LocalImageEntry = {
        status: 'error',
        message:
          result.status === 'error'
            ? result.message
            : '图片读取已取消',
      };
      cacheRef.current.set(src, entry);
      if (activeSourcesRef.current.has(src)) applyImageSource(src, entry);
      return;
    }
    const value = result.value;
    if (
      value.bytes.byteLength === 0 ||
      !value.mime.toLowerCase().startsWith('image/')
    ) {
      const entry: LocalImageEntry = {
        status: 'error',
        message: '返回的资源不是可显示的图片',
      };
      cacheRef.current.set(src, entry);
      if (activeSourcesRef.current.has(src)) applyImageSource(src, entry);
      return;
    }
    if (!activeSourcesRef.current.has(src)) {
      return;
    }
    const bytes = new Uint8Array(value.bytes);
    const url = URL.createObjectURL(
      new Blob([bytes.buffer as ArrayBuffer], { type: value.mime }),
    );
    const entry: LocalImageEntry = { status: 'ready', url };
    cacheRef.current.set(src, entry);
    applyImageSource(src, entry);
  }

  useLayoutEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    const locationChanged = locationRef.current !== document.path;
    locationRef.current = document.path;
    const revisionChanged =
      externalRevisionRef.current !== document.externalRevision;
    externalRevisionRef.current = document.externalRevision;
    // Replace the old image nodes before revoking their URLs.
    article.innerHTML = rendered.html;
    decorateMarkdownDocument(article);
    // A replaced markdown file may reference updated local resources; old
    // in-flight or cached image reads must not survive the new version.
    if (locationChanged || revisionChanged) invalidateLocalImages();
    syncLocalImages();
    // The generated HTML is sanitized by renderMarkdown. Local image URLs are
    // assigned only after the capability returns and are never user HTML.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendered, document.path, document.externalRevision]);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    const visible = active && mode === 'preview';
    if (!preview) return;
    if (visible && !lastActivePreviewRef.current) {
      preview.scrollTop = document.markdownView.previewScrollTop;
      lastPreviewScrollRef.current = preview.scrollTop;
    }
    lastActivePreviewRef.current = visible;
  }, [active, mode, document.markdownView.previewScrollTop]);

  useEffect(() => {
    mountedRef.current = true;
    const cache = cacheRef.current;
    return () => {
      mountedRef.current = false;
      imageRequestVersionRef.current += 1;
      if (scrollFrameRef.current) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
      onPreviewScroll(lastPreviewScrollRef.current);
      for (const entry of cache.values()) {
        if (entry.url) URL.revokeObjectURL(entry.url);
      }
      cache.clear();
    };
    // The cleanup flushes the last preview scroll to the owning project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handlePreviewScroll() {
    const preview = previewRef.current;
    if (!preview) return;
    lastPreviewScrollRef.current = preview.scrollTop;
    if (scrollFrameRef.current) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = 0;
      onPreviewScroll(lastPreviewScrollRef.current);
    });
  }

  return (
    <div className="markdown-viewer">
      <div
        className="markdown-source-pane"
        hidden={mode !== 'source'}
      >
        <CodeEditor
          document={document}
          active={active && mode === 'source'}
          ariaLabel={`Markdown 源码 ${document.name}`}
          onChange={onChange}
          onTextViewChange={onTextViewChange}
        />
      </div>
      <div
        ref={previewRef}
        className="md-preview"
        hidden={mode !== 'preview'}
        onScroll={handlePreviewScroll}
      >
        <article
          ref={articleRef}
          className="md-doc"
          data-markdown-preview="true"
        />
      </div>
    </div>
  );
}
