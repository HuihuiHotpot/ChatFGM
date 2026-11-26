import type { OpenDocument } from '../../state/workspace';
import { Button } from '../../components/ui/Button';
import './viewers.css';

export interface HtmlViewerProps {
  document: OpenDocument;
  active: boolean;
  onRefresh: () => void;
}

export function HtmlViewer({
  document,
  onRefresh,
}: HtmlViewerProps) {
  const state = document.htmlView;
  const ready = state.status === 'ready' && Boolean(state.previewUrl);
  return (
    <div
      className="html-view"
      data-viewer-kind="html"
      data-html-view-mount={ready ? 'true' : undefined}
      data-html-status={state.status}
      aria-busy={
        state.status === 'loading' || state.refreshLoading
          ? 'true'
          : undefined
      }
    >
      {!ready && (state.status === 'loading' || state.status === 'idle') ? (
        <div className="html-state" role="status">
          加载中…
        </div>
      ) : null}
      {!ready && state.status === 'error' ? (
        <div className="html-state html-state--error" role="alert">
          <strong>{state.error || '无法加载网页预览'}</strong>
          <Button
            onClick={onRefresh}
            disabled={state.refreshLoading}
          >
            重试
          </Button>
        </div>
      ) : null}
    </div>
  );
}
