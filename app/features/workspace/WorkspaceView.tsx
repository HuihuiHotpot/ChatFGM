import type { Dispatch } from 'react';
import { PanelLayout } from '../../components/layout/PanelLayout';
import { ChatPanel } from '../chat/ChatPanel';
import type { ChatPanelProps } from '../chat/ChatPanel';
import {
  ChatBackgroundNotice,
} from '../chat/ChatBackgroundNotice';
import type {
  ChatBackgroundNoticeState,
} from '../chat/ChatBackgroundNotice';
import { ProjectTree } from '../file-tree/ProjectTree';
import type { ProjectTreeProps } from '../file-tree/ProjectTree';
import { WorkspaceTabs } from './WorkspaceTabs';
import type {
  DocumentRenderer,
} from './WorkspaceTabs';
import type { LayoutAction, LayoutState } from '../../state/layout';
import type {
  CsvViewState,
  H5ViewState,
  ImageViewState,
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
import './WorkspaceView.css';

export type WorkspaceTreeActions = Omit<ProjectTreeProps, 'session'>;

export interface WorkspaceTabActions {
  onActivateTab: (identity: string) => void;
  onCloseTab: (identity: string, trigger: HTMLElement | null) => void;
  onChangeDocument: (
    projectId: string,
    identity: string,
    content: string,
  ) => void;
  onSaveAs: (
    projectId: string,
    identity: string,
    instanceId: string,
  ) => void;
}

export interface WorkspaceViewerActions {
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
  onCopyValue: (value: string) => void;
}

export interface WorkspaceViewProps {
  layout: LayoutState;
  dispatch: Dispatch<LayoutAction>;
  session: ProjectSession;
  treeActions: WorkspaceTreeActions;
  tabActions: WorkspaceTabActions;
  viewerActions: WorkspaceViewerActions;
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
  chatPanel: ChatPanelProps;
  backgroundNotice: ChatBackgroundNoticeState | null;
  noticeBlocked: boolean;
  onViewBackgroundNotice: () => void;
}

function ProjectsPanel({
  session,
  treeActions,
}: {
  session: ProjectSession;
  treeActions: WorkspaceTreeActions;
}) {
  return (
    <section
      className="panel panel--projects"
      id="projects-panel"
      aria-labelledby="projects-title"
    >
      <div className="panel-label">
        <h2 className="panel-title" id="projects-title">
          项目目录
        </h2>
      </div>
      <div className="panel-body">
        <ProjectTree session={session} {...treeActions} />
      </div>
    </section>
  );
}

function WorkspacePanel({
  session,
  tabActions,
  viewerActions,
  renderDocument,
  readBinaryResource,
  listH5Datasets,
  readH5DatasetRange,
  backgroundNotice,
  noticeBlocked,
  onViewBackgroundNotice,
}: {
  session: ProjectSession;
  tabActions: WorkspaceTabActions;
  viewerActions: WorkspaceViewerActions;
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
  backgroundNotice: ChatBackgroundNoticeState | null;
  noticeBlocked: boolean;
  onViewBackgroundNotice: () => void;
}) {
  return (
    <section
      className="panel panel--workspace"
      id="workspace-panel"
      aria-label="工作区"
    >
      <WorkspaceTabs
        session={session}
        renderDocument={renderDocument}
        readBinaryResource={readBinaryResource}
        listH5Datasets={listH5Datasets}
        readH5DatasetRange={readH5DatasetRange}
        onActivateTab={tabActions.onActivateTab}
        onCloseTab={tabActions.onCloseTab}
        onChangeDocument={tabActions.onChangeDocument}
        onSaveAs={tabActions.onSaveAs}
        onTextViewChange={viewerActions.onTextViewChange}
        onMarkdownModeChange={viewerActions.onMarkdownModeChange}
        onPreviewScroll={viewerActions.onPreviewScroll}
        onImageViewChange={viewerActions.onImageViewChange}
        onCsvViewChange={viewerActions.onCsvViewChange}
        onH5ViewChange={viewerActions.onH5ViewChange}
        onRefreshHtml={viewerActions.onRefreshHtml}
        onCopyValue={viewerActions.onCopyValue}
      />
      {backgroundNotice ? (
        <ChatBackgroundNotice
          notice={backgroundNotice}
          blocked={noticeBlocked}
          onView={onViewBackgroundNotice}
        />
      ) : null}
    </section>
  );
}

export function WorkspaceView({
  layout,
  dispatch,
  session,
  treeActions,
  tabActions,
  viewerActions,
  renderDocument,
  readBinaryResource,
  listH5Datasets,
  readH5DatasetRange,
  chatPanel,
  backgroundNotice,
  noticeBlocked,
  onViewBackgroundNotice,
}: WorkspaceViewProps) {
  return (
    <PanelLayout
      layout={layout}
      dispatch={dispatch}
      left={
        <ProjectsPanel session={session} treeActions={treeActions} />
      }
      center={
        <WorkspacePanel
          session={session}
          tabActions={tabActions}
          viewerActions={viewerActions}
          renderDocument={renderDocument}
          readBinaryResource={readBinaryResource}
          listH5Datasets={listH5Datasets}
          readH5DatasetRange={readH5DatasetRange}
          backgroundNotice={backgroundNotice}
          noticeBlocked={noticeBlocked}
          onViewBackgroundNotice={onViewBackgroundNotice}
        />
      }
      right={<ChatPanel {...chatPanel} />}
    />
  );
}
