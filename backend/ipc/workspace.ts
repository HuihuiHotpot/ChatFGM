import type { ServiceResult } from './capabilities';

export const WORKSPACE_SNAPSHOT_VERSION = 1 as const;
export const WORKSPACE_MAX_TABS = 200;
export const WORKSPACE_MAX_EXPANDED = 5000;
export const WORKSPACE_MAX_TEXT_BYTES = 32 * 1024 * 1024;
export const WORKSPACE_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
export const WORKSPACE_MAX_DATASETS = 5000;

export type WorkspaceViewerKind =
  | 'text'
  | 'markdown'
  | 'image'
  | 'csv'
  | 'html'
  | 'h5';

export interface WorkspaceLayoutSnapshot {
  leftVisible: boolean;
  rightVisible: boolean;
  leftWidth: number;
  rightWidth: number;
  customized: boolean;
}

export interface WorkspaceLayoutRecord {
  snapshot: WorkspaceLayoutSnapshot | null;
  revision: number;
}

export interface SaveWorkspaceLayoutInput {
  snapshot: WorkspaceLayoutSnapshot;
  expectedRevision: number;
}

export interface WorkspaceTextView {
  scrollTop: number;
  scrollLeft: number;
  selectionStart: number;
  selectionEnd: number;
}

export interface WorkspaceMarkdownView {
  mode: 'preview' | 'source';
  previewScrollTop: number;
}

export interface WorkspaceImageView {
  fit: boolean;
  zoom: number;
  scrollLeft: number;
  scrollTop: number;
}

export interface WorkspaceCsvView {
  selectedRow: number;
  selectedCol: number;
  columnWidths: number[];
  scrollTop: number;
  scrollLeft: number;
}

export interface WorkspaceH5View {
  currentDatasetPath: string | null;
  selections: Record<string, { row: number; col: number }>;
  widths: Record<string, number[]>;
  scroll: Record<string, { top: number; left: number }>;
}

export interface WorkspaceDocumentView {
  text: WorkspaceTextView;
  markdown: WorkspaceMarkdownView;
  image: WorkspaceImageView;
  csv: WorkspaceCsvView;
  h5: WorkspaceH5View;
}

export interface WorkspaceTabDraft {
  content: string;
  savedContent: string;
  version?: string;
  bom: boolean;
  newline: '\n' | '\r\n' | '\r';
}

export interface WorkspaceTabSnapshot {
  identity: string;
  name: string;
  path: string;
  viewerKind: WorkspaceViewerKind;
  view: WorkspaceDocumentView;
  /** Present only for an unsaved text recovery copy. */
  draft?: WorkspaceTabDraft;
}

export interface ProjectWorkspaceSnapshot {
  version: typeof WORKSPACE_SNAPSHOT_VERSION;
  expandedIds: string[];
  selectedId: string | null;
  activeIdentity: string | null;
  tabs: WorkspaceTabSnapshot[];
}

export interface ProjectWorkspaceRecord {
  snapshot: ProjectWorkspaceSnapshot | null;
  revision: number;
  /** Draft rows that were preserved because their payload is invalid. */
  corruptDraftIds?: string[];
  /** Tabs that could not be fully validated and were recovered leniently. */
  corruptTabIds?: string[];
  /** All damaged tabs, including identities that could not be read. */
  corruptTabCount?: number;
  /** Versions recorded by successful explicit file saves. */
  savedVersions?: Record<string, string>;
}

export interface LoadProjectWorkspaceInput {
  projectId: string;
}

export interface SaveProjectWorkspaceInput {
  projectId: string;
  snapshot: ProjectWorkspaceSnapshot;
  expectedRevision: number;
}

export interface SaveWorkspaceResult {
  revision: number;
}

export interface QuitRequestInput {
  allow: boolean;
}

export interface WorkspaceCapabilityGroup {
  loadLayout(): Promise<ServiceResult<WorkspaceLayoutRecord>>;
  saveLayout(
    input: SaveWorkspaceLayoutInput,
  ): Promise<ServiceResult<SaveWorkspaceResult>>;
  loadProjectWorkspace(
    input: LoadProjectWorkspaceInput,
  ): Promise<ServiceResult<ProjectWorkspaceRecord>>;
  saveProjectWorkspace(
    input: SaveProjectWorkspaceInput,
  ): Promise<ServiceResult<SaveWorkspaceResult>>;
  /** Main process asks the renderer to complete final state persistence. */
  onQuitRequested(listener: () => void): () => void;
  /** Must be called after the quit listener is installed. */
  markQuitReady(): Promise<ServiceResult<null>>;
  respondQuit(input: QuitRequestInput): Promise<ServiceResult<null>>;
}
