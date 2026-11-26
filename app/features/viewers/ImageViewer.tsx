import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useImperativeHandle,
} from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type {
  BinaryResource,
  ReadBinaryResourceInput,
  ServiceResult,
} from '../../services/capabilities';
import type { ImageViewState, OpenDocument } from '../../state/workspace';
import { readBinaryResourceOnce } from './binary-resource';
import { Button } from '../../components/ui/Button';
import './viewers.css';

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.25;
const IMAGE_PADDING = 16;

export interface ImageViewerHandle {
  fit: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

export interface ImageViewerProps {
  ref?: React.Ref<ImageViewerHandle>;
  projectId: string;
  document: OpenDocument;
  active: boolean;
  /** Bumped by the workspace when the same file changed on disk. */
  sourceRevision?: number;
  readBinaryResource?: (
    input: ReadBinaryResourceInput,
  ) => Promise<ServiceResult<BinaryResource>>;
  onViewStateChange: (patch: Partial<ImageViewState>) => void;
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

export function ImageViewer({
  ref,
  projectId,
  document,
  active,
  sourceRevision,
  readBinaryResource,
  onViewStateChange,
}: ImageViewerProps) {
  const viewRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const urlRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const activeRef = useRef(active);
  const fitRef = useRef(document.imageView.fit);
  const zoomRef = useRef(document.imageView.zoom);
  const naturalRef = useRef({
    width: document.imageView.naturalWidth,
    height: document.imageView.naturalHeight,
  });
  const lastScrollRef = useRef({
    left: document.imageView.scrollLeft,
    top: document.imageView.scrollTop,
  });
  const scrollFrameRef = useRef(0);
  const pendingAnchorRef = useRef<{
    ratioX: number;
    ratioY: number;
    x: number;
    y: number;
  } | null>(null);
  const panRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [error, setError] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [fit, setFit] = useState(document.imageView.fit);
  const [zoom, setZoom] = useState(document.imageView.zoom);
  const [natural, setNatural] = useState(naturalRef.current);
  activeRef.current = active;
  fitRef.current = fit;
  zoomRef.current = zoom;
  naturalRef.current = natural;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (scrollFrameRef.current) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
      onViewStateChange({
        scrollLeft: lastScrollRef.current.left,
        scrollTop: lastScrollRef.current.top,
        fit: fitRef.current,
        zoom: zoomRef.current,
        naturalWidth: naturalRef.current.width,
        naturalHeight: naturalRef.current.height,
      });
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
    // The cleanup flushes the last pan/zoom state to the owning project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!readBinaryResource) {
      setStatus('error');
      setError('当前环境不支持读取图片资源。');
      return;
    }
    let disposed = false;
    setStatus('loading');
    setError('');
    void (async () => {
      const result = await readBinaryResourceOnce(
        {
          projectId,
          fileIdentity: document.identity,
        },
        readBinaryResource,
        undefined,
        // A new file version must start its own read; joining the promise for
        // the previous version would display stale bytes as the new content.
        sourceRevision ?? 0,
        // Closing and reopening creates a new instance whose revision starts
        // at zero; it must not join the previous instance's pending read.
        document.instanceId,
      );
      if (!mountedRef.current || disposed) return;
      if (result.status !== 'success') {
        setStatus('error');
        setError(
          result.status === 'error'
            ? result.message
            : '图片读取已取消。',
        );
        return;
      }
      const value = result.value;
      if (
        value.bytes.byteLength === 0 ||
        !value.mime.toLowerCase().startsWith('image/')
      ) {
        setStatus('error');
        setError('返回的资源不是可显示的图片。');
        return;
      }
      const bytes = new Uint8Array(value.bytes);
      const nextUrl = URL.createObjectURL(
        new Blob([bytes.buffer as ArrayBuffer], { type: value.mime }),
      );
      const previousUrl = urlRef.current;
      urlRef.current = nextUrl;
      setUrl(nextUrl);
      if (previousUrl && previousUrl !== nextUrl) {
        URL.revokeObjectURL(previousUrl);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [document.identity, document.instanceId, projectId, readBinaryResource, sourceRevision, retryCount]);

  function persistScroll() {
    if (!activeRef.current) return;
    const view = viewRef.current;
    if (!view) return;
    lastScrollRef.current = {
      left: view.scrollLeft,
      top: view.scrollTop,
    };
    onViewStateChange({
      scrollLeft: view.scrollLeft,
      scrollTop: view.scrollTop,
      fit: fitRef.current,
      zoom: zoomRef.current,
      naturalWidth: naturalRef.current.width,
      naturalHeight: naturalRef.current.height,
    });
  }

  function scheduleScrollPersist() {
    if (!activeRef.current) return;
    const view = viewRef.current;
    if (view) {
      lastScrollRef.current = {
        left: view.scrollLeft,
        top: view.scrollTop,
      };
    }
    if (scrollFrameRef.current) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = 0;
      persistScroll();
    });
  }

  function centerImage() {
    const view = viewRef.current;
    if (!view) return;
    view.scrollLeft = Math.max(
      0,
      (view.scrollWidth - view.clientWidth) / 2,
    );
    view.scrollTop = Math.max(
      0,
      (view.scrollHeight - view.clientHeight) / 2,
    );
  }

  function computedFitZoom(): number {
    const view = viewRef.current;
    const size = naturalRef.current;
    if (!view || size.width <= 0 || size.height <= 0) return 1;
    const width = Math.max(1, view.clientWidth - IMAGE_PADDING * 2);
    const height = Math.max(1, view.clientHeight - IMAGE_PADDING * 2);
    return clampZoom(
      Math.min(width / size.width, height / size.height, 1),
    );
  }

  function applyFit(center = true) {
    const nextZoom = computedFitZoom();
    fitRef.current = true;
    zoomRef.current = nextZoom;
    setFit(true);
    setZoom(nextZoom);
    onViewStateChange({
      fit: true,
      zoom: nextZoom,
      naturalWidth: naturalRef.current.width,
      naturalHeight: naturalRef.current.height,
    });
    if (center) {
      window.requestAnimationFrame(() => {
        centerImage();
        persistScroll();
      });
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      fit: () => applyFit(true),
      zoomIn: () => zoomFromCenter(ZOOM_STEP),
      zoomOut: () => zoomFromCenter(1 / ZOOM_STEP),
    }),
    // The handle methods intentionally read current refs instead of rerendering
    // the parent on every pan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function zoomAt(nextZoom: number, anchor: { x: number; y: number }) {
    const image = imageRef.current;
    const view = viewRef.current;
    if (!image || !view) return;
    const before = image.getBoundingClientRect();
    if (before.width <= 0 || before.height <= 0) return;
    pendingAnchorRef.current = {
      ratioX: (anchor.x - before.left) / before.width,
      ratioY: (anchor.y - before.top) / before.height,
      x: anchor.x,
      y: anchor.y,
    };
    const clamped = clampZoom(nextZoom);
    fitRef.current = false;
    zoomRef.current = clamped;
    setFit(false);
    setZoom(clamped);
  }

  function zoomFromCenter(factor: number) {
    const view = viewRef.current;
    if (!view) return;
    const rect = view.getBoundingClientRect();
    zoomAt(zoomRef.current * factor, {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
  }

  useLayoutEffect(() => {
    const image = imageRef.current;
    const view = viewRef.current;
    const anchor = pendingAnchorRef.current;
    if (!image || !view || !anchor) return;
    pendingAnchorRef.current = null;
    const after = image.getBoundingClientRect();
    view.scrollLeft +=
      after.left + anchor.ratioX * after.width - anchor.x;
    view.scrollTop +=
      after.top + anchor.ratioY * after.height - anchor.y;
    persistScroll();
    // Persist only after the new image dimensions have been committed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  function handleImageLoad() {
    const image = imageRef.current;
    if (!image) return;
    const next = {
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
    if (next.width <= 0 || next.height <= 0) {
      handleImageError();
      return;
    }
    naturalRef.current = next;
    setNatural(next);
    setStatus('ready');
    onViewStateChange({
      naturalWidth: next.width,
      naturalHeight: next.height,
    });
    if (fitRef.current) {
      applyFit(true);
      return;
    }
    const view = viewRef.current;
    if (!view) return;
    view.scrollLeft = document.imageView.scrollLeft;
    view.scrollTop = document.imageView.scrollTop;
    lastScrollRef.current = {
      left: view.scrollLeft,
      top: view.scrollTop,
    };
    persistScroll();
  }

  function handleImageError() {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    setUrl(null);
    setStatus('error');
    setError('无法解码该图片。');
  }

  useLayoutEffect(() => {
    activeRef.current = active;
    if (!active || status !== 'ready') return;
    const view = viewRef.current;
    if (!view) return;
    if (fitRef.current) {
      applyFit(true);
      return;
    }
    // Hidden panes may reset scroll offsets when display:none is applied.
    // Re-apply the state owned by the project session, not the DOM's reset.
    view.scrollLeft = document.imageView.scrollLeft;
    view.scrollTop = document.imageView.scrollTop;
    lastScrollRef.current = {
      left: view.scrollLeft,
      top: view.scrollTop,
    };
    // Restore the saved pan only when this pane becomes visible again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, status]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!activeRef.current || !fitRef.current || status !== 'ready') {
        return;
      }
      applyFit(true);
    });
    observer.observe(view);
    return () => observer.disconnect();
    // Re-observe when readiness changes; fit mode is read from a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const viewportHeight = () => viewRef.current?.clientHeight ?? 1;
    function handleWheel(event: WheelEvent) {
      if (!activeRef.current || status !== 'ready') return;
      event.preventDefault();
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? viewportHeight()
            : 1;
      const delta = event.deltaY * unit;
      if (!delta) return;
      zoomAt(zoomRef.current * Math.exp(-delta * 0.0015), {
        x: event.clientX,
        y: event.clientY,
      });
    }
    view.addEventListener('wheel', handleWheel, { passive: false });
    return () => view.removeEventListener('wheel', handleWheel);
  }, [status]);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      status !== 'ready' ||
      event.pointerType === 'touch' ||
      event.button !== 0
    ) {
      return;
    }
    const view = viewRef.current;
    if (!view) return;
    panRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: view.scrollLeft,
      top: view.scrollTop,
    };
    view.setPointerCapture(event.pointerId);
    view.classList.add('is-panning');
    event.preventDefault();
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const pan = panRef.current;
    const view = viewRef.current;
    if (!pan || !view || event.pointerId !== pan.pointerId) return;
    view.scrollLeft = pan.left - (event.clientX - pan.x);
    view.scrollTop = pan.top - (event.clientY - pan.y);
    lastScrollRef.current = {
      left: view.scrollLeft,
      top: view.scrollTop,
    };
  }

  function handlePointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const pan = panRef.current;
    const view = viewRef.current;
    if (!pan || !view || event.pointerId !== pan.pointerId) return;
    if (view.hasPointerCapture(pan.pointerId)) {
      view.releasePointerCapture(pan.pointerId);
    }
    panRef.current = null;
    view.classList.remove('is-panning');
    persistScroll();
  }

  return (
    <div
      ref={viewRef}
      className={`image-view${status === 'ready' ? '' : ' is-message'}`}
      data-viewer-kind="image"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onLostPointerCapture={handlePointerEnd}
      onScroll={status === 'ready' ? scheduleScrollPersist : undefined}
    >
      {status === 'loading' ? (
        <div className="image-view-message" role="status">
          正在加载图片…
        </div>
      ) : null}
      {status === 'error' ? (
        <div className="image-view-message image-view-message--error" role="alert">
          <strong>{error || '图片加载失败'}</strong>
          {readBinaryResource ? (
            <Button onClick={() => setRetryCount((count) => count + 1)}>重试</Button>
          ) : null}
        </div>
      ) : null}
      {url ? (
        <img
          ref={imageRef}
          className="image-stage"
          src={url}
          alt={document.name}
          draggable={false}
          hidden={status !== 'ready'}
          style={
            natural.width > 0 && natural.height > 0
              ? {
                  width: `${Math.max(1, Math.round(natural.width * zoom))}px`,
                  height: `${Math.max(1, Math.round(natural.height * zoom))}px`,
                }
              : undefined
          }
          onLoad={handleImageLoad}
          onError={handleImageError}
        />
      ) : null}
    </div>
  );
}
