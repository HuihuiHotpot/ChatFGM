import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from 'react';
import type { ProjectInfo } from '../../types';
import type {
  CsvViewState,
  H5ViewState,
  ImageViewState,
  OpenDocument,
  ProjectSession,
  TextViewState,
} from '../../state/workspace';
import type {
  BinaryResource,
  H5Dataset,
  H5DatasetRange,
  ListH5DatasetsInput,
  ReadBinaryResourceInput,
  ReadH5RangeInput,
  ServiceResult,
} from '../../services/capabilities';
import { FileName } from '../../components/ui/FileName';
import { DocumentViewer } from '../viewers/DocumentViewer';
import type { ImageViewerHandle } from '../viewers/ImageViewer';
import './WorkspaceTabs.css';

export interface DocumentRendererProps {
  project: ProjectInfo;
  document: OpenDocument;
  onChange: (content: string) => void;
}

export type DocumentRenderer = (
  props: DocumentRendererProps,
) => ReactNode;

export interface WorkspaceTabsProps {
  session: ProjectSession;
  renderDocument?: DocumentRenderer;
  readBinaryResource?: (
    input: ReadBinaryResourceInput,
  ) => Promise<ServiceResult<BinaryResource>>;
  listH5Datasets?: (
    input: ListH5DatasetsInput,
  ) => Promise<ServiceResult<{
    datasets: readonly H5Dataset[];
    fileInfo?: string;
  }>>;
  readH5DatasetRange?: (
    input: ReadH5RangeInput,
  ) => Promise<ServiceResult<H5DatasetRange>>;
  onActivateTab: (identity: string) => void;
  onCloseTab: (identity: string, trigger: HTMLElement | null) => void;
  onChangeDocument: (
    projectId: string,
    identity: string,
    content: string,
  ) => void;
  onTextViewChange: (
    projectId: string,
    identity: string,
    patch: Partial<TextViewState>,
  ) => void;
  onMarkdownModeChange: (
    projectId: string,
    identity: string,
    mode: 'preview' | 'source',
  ) => void;
  onPreviewScroll: (
    projectId: string,
    identity: string,
    scrollTop: number,
  ) => void;
  onImageViewChange: (
    projectId: string,
    identity: string,
    patch: Partial<ImageViewState>,
  ) => void;
  onCsvViewChange: (
    projectId: string,
    identity: string,
    instanceId: string,
    patch: Partial<CsvViewState>,
  ) => void;
  onH5ViewChange: (
    projectId: string,
    identity: string,
    instanceId: string,
    patch: Partial<H5ViewState>,
  ) => void;
  onRefreshHtml: (
    projectId: string,
    identity: string,
    instanceId: string,
  ) => void;
  onSaveAs: (
    projectId: string,
    identity: string,
    instanceId: string,
  ) => void;
  onCopyValue: (value: string) => void;
}

function CloseIcon() {
  return (
    <svg
      className="tab-close-icon"
      viewBox="0 0 10 10"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2 2l6 6M8 2l-6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ScrollArrow({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg
      className="tab-scroll-icon"
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
    >
      {direction === 'left' ? (
        <path
          d="M7.4 2.6 4 6l3.4 3.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M4.6 2.6 8 6l-3.4 3.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

const TAB_SCROLL_STEP = 180;

function ZoomOutIcon() {
  return (
    <svg
      className="image-tool-icon"
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M3 6h6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ZoomInIcon() {
  return (
    <svg
      className="image-tool-icon"
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M3 6h6M6 3v6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      className="html-tool-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M21 12a9 9 0 1 1-2.64-6.36"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M21 3v6h-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function WorkspaceTabs({
  session,
  renderDocument,
  readBinaryResource,
  listH5Datasets,
  readH5DatasetRange,
  onActivateTab,
  onCloseTab,
  onChangeDocument,
  onTextViewChange,
  onMarkdownModeChange,
  onPreviewScroll,
  onImageViewChange,
  onCsvViewChange,
  onH5ViewChange,
  onRefreshHtml,
  onSaveAs,
  onCopyValue,
}: WorkspaceTabsProps) {
  const tabStripRef = useRef<HTMLDivElement>(null);
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const imageViewerRefs = useRef(
    new Map<string, ImageViewerHandle>(),
  );
  const [scrollState, setScrollState] = useState({
    overflowing: false,
    atStart: true,
    atEnd: true,
  });
  const activeDocument =
    session.tabs.find(
      (document) => document.identity === session.activeIdentity,
    ) ?? null;

  const hasTabs = session.tabs.length > 0;
  const activeImageView =
    activeDocument?.viewerKind === 'image'
      ? activeDocument.imageView
      : null;

  function activeImageHandle(): ImageViewerHandle | null {
    if (!activeDocument || activeDocument.viewerKind !== 'image') {
      return null;
    }
    return imageViewerRefs.current.get(activeDocument.identity) ?? null;
  }

  function updateScrollState() {
    const strip = tabStripRef.current;
    if (!strip) return;
    const max = strip.scrollWidth - strip.clientWidth;
    const overflowing = max > 1;
    setScrollState({
      overflowing,
      atStart: strip.scrollLeft <= 1,
      atEnd: strip.scrollLeft >= max - 1,
    });
  }

  function ensureActiveVisible() {
    const strip = tabStripRef.current;
    const active = session.activeIdentity
      ? tabButtonRefs.current.get(session.activeIdentity)?.parentElement
      : null;
    if (!strip || !active) return;
    const stripRect = strip.getBoundingClientRect();
    const rect = active.getBoundingClientRect();
    if (rect.width >= stripRect.width - 2) {
      strip.scrollLeft += rect.left - stripRect.left;
      return;
    }
    if (rect.left < stripRect.left) {
      strip.scrollLeft -= stripRect.left - rect.left + 12;
    } else if (rect.right > stripRect.right) {
      strip.scrollLeft += rect.right - stripRect.right + 12;
    }
  }

  const refreshActiveVisibility = useCallback(
    () => {
      ensureActiveVisible();
      updateScrollState();
    },
    // These functions intentionally read refs and the current active tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.activeIdentity],
  );

  useLayoutEffect(() => {
    ensureActiveVisible();
    updateScrollState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.tabs, session.activeIdentity]);

  useEffect(() => {
    const strip = tabStripRef.current;
    if (!strip) return;
    const observer = new ResizeObserver(() => {
      refreshActiveVisibility();
    });
    observer.observe(strip);
    return () => observer.disconnect();
  }, [refreshActiveVisibility]);

  function activateTab(identity: string) {
    onActivateTab(identity);
    window.requestAnimationFrame(() => {
      tabButtonRefs.current.get(identity)?.focus();
    });
  }

  function handleTabKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    identity: string,
  ) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = session.tabs.findIndex(
      (document) => document.identity === identity,
    );
    if (index === -1 || session.tabs.length === 0) return;
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const next =
      session.tabs[
        (index + direction + session.tabs.length) % session.tabs.length
      ];
    if (!next) return;
    onActivateTab(next.identity);
    window.requestAnimationFrame(() => {
      tabButtonRefs.current.get(next.identity)?.focus();
    });
  }

  return (
    <>
      <div className="panel-label workspace-label">
        {hasTabs ? (
          <>
            {scrollState.overflowing ? (
              <button
                type="button"
                className="tab-scroll"
                title="向左滚动标签"
                aria-label="向左滚动标签"
                disabled={scrollState.atStart}
                onClick={() => {
                  tabStripRef.current?.scrollBy({
                    left: -TAB_SCROLL_STEP,
                    behavior: 'smooth',
                  });
                }}
              >
                <ScrollArrow direction="left" />
              </button>
            ) : null}
            <div
              ref={tabStripRef}
              className="tab-strip"
              role="tablist"
              aria-label="打开的文件"
              onScroll={updateScrollState}
            >
              {session.tabs.map((document) => {
                const active = document.identity === session.activeIdentity;
                return (
                  <div
                    className={`tab${active ? ' is-active' : ''}`}
                    role="presentation"
                    key={document.identity}
                  >
                    <button
                      ref={(element) => {
                        if (element) {
                          tabButtonRefs.current.set(
                            document.identity,
                            element,
                          );
                        } else {
                          tabButtonRefs.current.delete(document.identity);
                        }
                      }}
                      type="button"
                      className="tab-main"
                      role="tab"
                      id={`workspace-tab-${document.identity}`}
                      aria-selected={active}
                      aria-controls={
                        renderDocument
                          ? 'workspace-document-host'
                          : `workspace-document-${document.instanceId}`
                      }
                      tabIndex={active ? 0 : -1}
                      title={document.path}
                      aria-label={document.dirty ? `${document.name} 未保存` : document.name}
                      onClick={() => activateTab(document.identity)}
                      onKeyDown={(event) =>
                        handleTabKeyDown(event, document.identity)
                      }
                    >
                      <FileName name={document.name} className="tab-label" />
                      {document.dirty ? (
                        <span
                          className="tab-dot"
                          title="未保存"
                          aria-label="未保存"
                        />
                      ) : null}
                    </button>
                    <button
                      type="button"
                      className="tab-close"
                      title="关闭"
                      aria-label={`关闭 ${document.name}`}
                      onClick={(event) =>
                        onCloseTab(document.identity, event.currentTarget)
                      }
                    >
                      <CloseIcon />
                    </button>
                  </div>
                );
              })}
            </div>
            {scrollState.overflowing ? (
              <button
                type="button"
                className="tab-scroll"
                title="向右滚动标签"
                aria-label="向右滚动标签"
                disabled={scrollState.atEnd}
                onClick={() => {
                  tabStripRef.current?.scrollBy({
                    left: TAB_SCROLL_STEP,
                    behavior: 'smooth',
                  });
                }}
              >
                <ScrollArrow direction="right" />
              </button>
            ) : null}
            {activeDocument &&
            (activeDocument.viewerKind === 'markdown' ||
              activeDocument.viewerKind === 'csv' ||
              activeDocument.viewerKind === 'html' ||
              activeImageView) ? (
              <div className="workspace-actions">
                {activeDocument.viewerKind === 'markdown' ? (
                  <div
                    className="view-switch"
                    role="group"
                    aria-label="Markdown 显示模式"
                  >
                    <button
                      type="button"
                      className="view-switch-button"
                      aria-pressed={
                        activeDocument.markdownView.mode === 'preview'
                      }
                      title="渲染预览"
                      onClick={() =>
                        onMarkdownModeChange(
                          session.project.id,
                          activeDocument.identity,
                          'preview',
                        )
                      }
                    >
                      预览
                    </button>
                    <button
                      type="button"
                      className="view-switch-button"
                      aria-pressed={
                        activeDocument.markdownView.mode === 'source'
                      }
                      title="Markdown 源码"
                      onClick={() =>
                        onMarkdownModeChange(
                          session.project.id,
                          activeDocument.identity,
                          'source',
                        )
                      }
                    >
                      源码
                    </button>
                  </div>
                ) : null}
                {activeDocument.viewerKind === 'csv' && !activeDocument.csvView.parseError ? (
                  <span
                    className="csv-meta"
                    title={`按文件原始内容统计：共 ${activeDocument.csvView.rows} 行、${activeDocument.csvView.columns} 列`}
                  >
                    {activeDocument.csvView.rows} 行 ·{' '}
                    {activeDocument.csvView.columns} 列
                  </span>
                ) : null}
                {activeDocument.viewerKind === 'html' &&
                (renderDocument || activeDocument.htmlView.status !== 'error') ? (
                  <>
                    {activeDocument.externalUpdate ? (
                      <span className="html-external-hint-text" role="status">
                        文件已更新
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="html-tool"
                      title="刷新网页"
                      aria-label="刷新网页"
                      disabled={
                        activeDocument.htmlView.status === 'loading' ||
                        activeDocument.htmlView.refreshLoading
                      }
                      aria-busy={
                        activeDocument.htmlView.status === 'loading' ||
                        activeDocument.htmlView.refreshLoading
                          ? 'true'
                          : undefined
                      }
                      onClick={() =>
                        onRefreshHtml(
                          session.project.id,
                          activeDocument.identity,
                          activeDocument.instanceId,
                        )
                      }
                    >
                      <RefreshIcon />
                    </button>
                  </>
                ) : null}
                {activeImageView ? (
                  <div
                    className="image-tools"
                    role="group"
                    aria-label="图片缩放"
                  >
                    <button
                      type="button"
                      className="image-tool"
                      title="缩小"
                      aria-label="缩小"
                      onClick={() => activeImageHandle()?.zoomOut()}
                    >
                      <ZoomOutIcon />
                    </button>
                    <span
                      className="image-zoom-value"
                      title="当前缩放比例"
                    >
                      {Math.round(activeImageView.zoom * 100)}%
                    </span>
                    <button
                      type="button"
                      className="image-tool"
                      title="放大"
                      aria-label="放大"
                      onClick={() => activeImageHandle()?.zoomIn()}
                    >
                      <ZoomInIcon />
                    </button>
                    <button
                      type="button"
                      className="image-tool image-tool--fit"
                      title="适应窗口"
                      aria-label="适应窗口"
                      onClick={() => activeImageHandle()?.fit()}
                    >
                      适应窗口
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {activeDocument &&
            activeDocument.missing &&
            activeDocument.dirty ? (
              <div className="workspace-actions">
                <button
                  type="button"
                  className="tab-save-as"
                  title="原文件已不可用，将内容另存为新文件"
                  onClick={() =>
                    onSaveAs(
                      session.project.id,
                      activeDocument.identity,
                      activeDocument.instanceId,
                    )
                  }
                  data-testid="tab-save-as"
                >
                  另存为
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="workspace-heading">
            <h2 className="panel-title" id="workspace-title">
              工作区
            </h2>
          </div>
        )}
      </div>

      <div className="panel-body" id="workspace-body">
        {activeDocument ? (
          renderDocument ? (
            <div
              className="document-host"
              id="workspace-document-host"
              role="tabpanel"
              aria-labelledby={`workspace-tab-${activeDocument.identity}`}
              data-document-identity={activeDocument.identity}
            >
              {renderDocument({
                project: session.project,
                document: activeDocument,
                onChange: (content) =>
                  onChangeDocument(
                    session.project.id,
                    activeDocument.identity,
                    content,
                  ),
              })}
            </div>
          ) : (
            <div
              className="document-stack"
              id="workspace-document-host"
            >
              {session.tabs.map((document) => {
                const active =
                  document.identity === session.activeIdentity;
                return (
                  <div
                    key={document.instanceId}
                    id={`workspace-document-${document.instanceId}`}
                    className="document-pane"
                    role="tabpanel"
                    aria-labelledby={`workspace-tab-${document.identity}`}
                    hidden={!active}
                    data-document-identity={document.identity}
                    data-viewer-kind={document.viewerKind}
                  >
                    <DocumentViewer
                      projectId={session.project.id}
                      document={document}
                      active={active}
                      readBinaryResource={readBinaryResource}
                      listH5Datasets={listH5Datasets}
                      readH5DatasetRange={readH5DatasetRange}
                      onChange={(content) =>
                        onChangeDocument(
                          session.project.id,
                          document.identity,
                          content,
                        )
                      }
                      onTextViewChange={(patch) =>
                        onTextViewChange(
                          session.project.id,
                          document.identity,
                          patch,
                        )
                      }
                      onPreviewScroll={(scrollTop) =>
                        onPreviewScroll(
                          session.project.id,
                          document.identity,
                          scrollTop,
                        )
                      }
                      onImageViewChange={(patch) =>
                        onImageViewChange(
                          session.project.id,
                          document.identity,
                          patch,
                        )
                      }
                      onCsvViewChange={(patch) =>
                        onCsvViewChange(
                          session.project.id,
                          document.identity,
                          document.instanceId,
                          patch,
                        )
                      }
                      onH5ViewChange={(patch) =>
                        onH5ViewChange(
                          session.project.id,
                          document.identity,
                          document.instanceId,
                          patch,
                        )
                      }
                      onCopyValue={onCopyValue}
                      onRefreshHtml={() =>
                        onRefreshHtml(session.project.id, document.identity, document.instanceId)
                      }
                      imageRef={(handle) => {
                        if (handle) {
                          imageViewerRefs.current.set(
                            document.identity,
                            handle,
                          );
                        } else {
                          imageViewerRefs.current.delete(
                            document.identity,
                          );
                        }
                      }}
                    />
                  </div>
                );
              })}
            </div>
          )
        ) : (
          <p className="workspace-empty" id="workspace-empty">
            选择文件
          </p>
        )}
      </div>
    </>
  );
}


