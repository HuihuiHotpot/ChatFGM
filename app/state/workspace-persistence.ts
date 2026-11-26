import type {
  FileTreeEntry,
  ReadFileResult,
  ServiceResult,
} from '../services/capabilities';
import type {
  ProjectWorkspaceSnapshot,
  WorkspaceDocumentView,
  WorkspaceLayoutSnapshot,
  WorkspaceTabDraft,
  WorkspaceTabSnapshot,
} from '../services/workspace';
import { WORKSPACE_SNAPSHOT_VERSION } from '../services/workspace';
import type {
  CsvViewState,
  H5ViewState,
  ImageViewState,
  MarkdownModeState,
  OpenDocument,
  ProjectSession,
  TextViewState,
  TextNewline,
} from './workspace';
import {
  createDocument,
  findEntry,
  findFileByIdentity,
  liveFileEntries,
} from './workspace';
import {
  isTextContentViewer,
  viewerKindForFileName,
} from '../features/viewers/viewer-types';

export interface RestoreWorkspaceResult {
  session: ProjectSession;
  errors: string[];
}

export function layoutSnapshotFromState(layout: {
  leftVisible: boolean;
  rightVisible: boolean;
  leftWidth: number;
  rightWidth: number;
  customized: boolean;
}): WorkspaceLayoutSnapshot {
  return {
    leftVisible: layout.leftVisible,
    rightVisible: layout.rightVisible,
    leftWidth: Math.round(layout.leftWidth),
    rightWidth: Math.round(layout.rightWidth),
    customized: layout.customized,
  };
}

function viewState(document: OpenDocument): WorkspaceDocumentView {
  return {
    text: {
      scrollTop: document.textView.scrollTop,
      scrollLeft: document.textView.scrollLeft,
      selectionStart: document.textView.selectionStart,
      selectionEnd: document.textView.selectionEnd,
    },
    markdown: {
      mode: document.markdownView.mode,
      previewScrollTop: document.markdownView.previewScrollTop,
    },
    image: {
      fit: document.imageView.fit,
      zoom: document.imageView.zoom,
      scrollLeft: document.imageView.scrollLeft,
      scrollTop: document.imageView.scrollTop,
    },
    csv: {
      selectedRow: document.csvView.selectedRow,
      selectedCol: document.csvView.selectedCol,
      columnWidths: document.csvView.columnWidths,
      scrollTop: document.csvView.scrollTop,
      scrollLeft: document.csvView.scrollLeft,
    },
    h5: {
      currentDatasetPath: document.h5View.currentDatasetPath,
      selections: document.h5View.selections,
      widths: document.h5View.widths,
      scroll: document.h5View.scroll,
    },
  };
}

function draftFor(document: OpenDocument): WorkspaceTabDraft | undefined {
  if (!document.dirty) return undefined;
  return {
    content: document.content,
    savedContent: document.savedContent,
    ...(document.version ? { version: document.version } : {}),
    bom: document.bom,
    newline: document.newline,
  };
}

/**
 * Produces only the explicitly persisted fields. Transient viewer data such as
 * image natural sizes, HTML URLs/handles, H5 values, parsed CSV errors and
 * promises are deliberately absent.
 */
export function workspaceSnapshotFromSession(
  session: ProjectSession,
  options: {
    includeDrafts?: boolean;
    excludeIdentity?: string;
  } = {},
): ProjectWorkspaceSnapshot {
  const expandedIds = Object.entries(session.expanded)
    .filter(([id, expanded]) => expanded && findEntry(session.tree, id))
    .map(([id]) => id)
    .sort();
  const tabs: WorkspaceTabSnapshot[] = session.tabs
    .filter((document) => document.identity !== options.excludeIdentity)
    .filter(
      (document) =>
        (document.dirty && options.includeDrafts !== false) ||
        findFileByIdentity(session.tree, document.identity) !== null,
    )
    .map((document) => {
      const draft =
        options.includeDrafts === false ? undefined : draftFor(document);
      return {
        identity: document.identity,
        name: document.name,
        path: document.path,
        viewerKind: document.viewerKind,
        view: viewState(document),
        ...(draft ? { draft } : {}),
      };
    });
  return {
    version: WORKSPACE_SNAPSHOT_VERSION,
    expandedIds,
    selectedId:
      session.selectedId && findEntry(session.tree, session.selectedId)
        ? session.selectedId
        : null,
    activeIdentity: tabs.some(
      (tab) => tab.identity === session.activeIdentity,
    )
      ? session.activeIdentity
      : null,
    tabs,
  };
}

function clampNonnegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizeNewlines(value: string, newline: TextNewline): string {
  return value.replace(/\r\n|\r|\n/g, newline);
}

function draftMatchesDisk(
  draft: WorkspaceTabDraft,
  disk: ReadFileResult,
  savedVersion: string | undefined,
): boolean {
  if (!savedVersion || savedVersion !== disk.version) return false;
  if (draft.bom !== (disk.bom ?? false)) return false;
  return normalizeNewlines(draft.content, draft.newline) === disk.content;
}

function restoredTextView(
  view: OpenDocument['textView'],
  contentLength: number,
): TextViewState {
  const start = Math.min(
    contentLength,
    Math.max(0, Math.trunc(clampNonnegative(view.selectionStart))),
  );
  const end = Math.min(
    contentLength,
    Math.max(0, Math.trunc(clampNonnegative(view.selectionEnd))),
  );
  return {
    scrollTop: clampNonnegative(view.scrollTop),
    scrollLeft: clampNonnegative(view.scrollLeft),
    selectionStart: Math.min(start, end),
    selectionEnd: Math.max(start, end),
  };
}

function restoredMarkdown(
  view: OpenDocument['markdownView'],
): MarkdownModeState {
  return {
    mode: view.mode === 'source' ? 'source' : 'preview',
    previewScrollTop: clampNonnegative(view.previewScrollTop),
  };
}

function restoredImage(
  view: WorkspaceDocumentView['image'],
): ImageViewState {
  return {
    fit: view.fit === true,
    zoom: Math.min(8, Math.max(0.05, view.zoom || 1)),
    scrollLeft: clampNonnegative(view.scrollLeft),
    scrollTop: clampNonnegative(view.scrollTop),
    naturalWidth: 0,
    naturalHeight: 0,
  };
}

function restoredCsv(
  view: WorkspaceDocumentView['csv'],
): CsvViewState {
  return {
    selectedRow: Math.max(0, Math.trunc(clampNonnegative(view.selectedRow))),
    selectedCol: Math.max(0, Math.trunc(clampNonnegative(view.selectedCol))),
    columnWidths: view.columnWidths.map((width) =>
      Math.min(2000, Math.max(20, width)),
    ),
    scrollTop: clampNonnegative(view.scrollTop),
    scrollLeft: clampNonnegative(view.scrollLeft),
    rows: 0,
    columns: 0,
    parseError: '',
  };
}

function restoredH5(view: OpenDocument['h5View']): H5ViewState {
  return {
    currentDatasetPath: view.currentDatasetPath ?? null,
    selections: view.selections,
    widths: view.widths,
    scroll: view.scroll,
  };
}

function restoreView(
  document: OpenDocument,
  view: WorkspaceDocumentView,
): OpenDocument {
  return {
    ...document,
    textView: restoredTextView(view.text, document.content.length),
    markdownView: restoredMarkdown(view.markdown),
    imageView: restoredImage(view.image),
    csvView: restoredCsv(view.csv),
    h5View: restoredH5(view.h5),
  };
}

function findEntryByIdentity(
  tree: readonly FileTreeEntry[],
  identity: string,
): FileTreeEntry | null {
  return findFileByIdentity(tree, identity);
}

function chooseActiveTab(
  restoredTabs: readonly OpenDocument[],
  storedTabs: readonly WorkspaceTabSnapshot[],
  activeIdentity: string | null,
): string | null {
  if (restoredTabs.length === 0) return null;
  if (
    activeIdentity &&
    restoredTabs.some((tab) => tab.identity === activeIdentity)
  ) {
    return activeIdentity;
  }
  const index = storedTabs.findIndex(
    (tab) => tab.identity === activeIdentity,
  );
  if (index >= 0) {
    for (let cursor = index + 1; cursor < storedTabs.length; cursor += 1) {
      if (restoredTabs.some((tab) => tab.identity === storedTabs[cursor].identity)) {
        return storedTabs[cursor].identity;
      }
    }
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (restoredTabs.some((tab) => tab.identity === storedTabs[cursor].identity)) {
        return storedTabs[cursor].identity;
      }
    }
  }
  return restoredTabs[0]?.identity ?? null;
}

/**
 * Reconciles a saved project snapshot against the fresh disk tree. Clean files
 * are re-read; missing clean tabs are dropped; missing dirty drafts remain as
 * missing tabs and are never recreated on disk.
 */
export async function restoreWorkspaceSession(
  session: ProjectSession,
  workspace: ProjectWorkspaceSnapshot | null,
  options: {
    readFile: (
      identity: string,
    ) => Promise<ServiceResult<ReadFileResult>>;
    nextInstanceId: () => string;
    savedVersions?: Readonly<Record<string, string>>;
  },
): Promise<RestoreWorkspaceResult> {
  if (!workspace) {
    return { session, errors: [] };
  }
  const errors: string[] = [];
  const folderIds = new Set<string>();
  const collectFolders = (entries: readonly FileTreeEntry[]) => {
    for (const entry of entries) {
      if (entry.kind === 'folder') folderIds.add(entry.id);
      if (entry.children) collectFolders(entry.children);
    }
  };
  collectFolders(session.tree);

  const expanded: Record<string, boolean> = {};
  for (const id of workspace.expandedIds) {
    if (folderIds.has(id)) expanded[id] = true;
  }

  const restoredTabs: OpenDocument[] = [];
  const seen = new Set<string>();
  for (const saved of workspace.tabs) {
    if (seen.has(saved.identity)) continue;
    seen.add(saved.identity);
    const entry = findEntryByIdentity(session.tree, saved.identity);
    if (!entry && !saved.draft) continue;
    const name = entry?.name ?? saved.name;
    const path = entry?.path ?? saved.path;
    const kind = viewerKindForFileName(name);
    let document = createDocument(
      name,
      path,
      saved.identity,
      options.nextInstanceId(),
      '',
    );
    document = {
      ...document,
      viewerKind: kind,
      htmlView:
        kind === 'html'
          ? document.htmlView
          : document.htmlView,
    };
    if (saved.draft) {
      const draft = saved.draft;
      let disk: ReadFileResult | null = null;
      if (entry && isTextContentViewer(kind)) {
        const result = await options.readFile(saved.identity);
        if (result.status === 'success') {
          disk = result.value;
        } else {
          errors.push(
            `无法核对恢复副本「${name}」的磁盘版本：${
              result.status === 'error' ? result.message : '读取已取消'
            }`,
          );
        }
      }
      if (
        disk &&
        draftMatchesDisk(
          draft,
          disk,
          options.savedVersions?.[saved.identity],
        )
      ) {
        document = {
          ...document,
          content: disk.content,
          savedContent: disk.content,
          dirty: false,
          contentLoaded: true,
          missing: false,
          ...(disk.version ? { version: disk.version } : {}),
          bom: disk.bom ?? false,
          newline: disk.newline ?? '\n',
        };
      } else if (disk && draft.content === draft.savedContent) {
        document = {
          ...document,
          content: disk.content,
          savedContent: disk.content,
          dirty: false,
          contentLoaded: true,
          missing: false,
          ...(disk.version ? { version: disk.version } : {}),
          bom: disk.bom ?? false,
          newline: disk.newline ?? '\n',
        };
      } else {
        document = {
          ...document,
          content: draft.content,
          savedContent: draft.savedContent,
          dirty: draft.content !== draft.savedContent,
          contentLoaded: true,
          missing: !entry,
          ...(draft.version ? { version: draft.version } : {}),
          bom: draft.bom,
          newline: draft.newline,
        };
      }
    } else if (entry && isTextContentViewer(kind)) {
      const result = await options.readFile(saved.identity);
      if (result.status === 'success') {
        document = {
          ...document,
          content: result.value.content,
          savedContent: result.value.content,
          dirty: false,
          contentLoaded: true,
          missing: false,
          ...(result.value.version
            ? { version: result.value.version }
            : {}),
          bom: result.value.bom ?? false,
          newline: result.value.newline ?? '\n',
        };
      } else {
        errors.push(
          `无法读取「${name}」：${
            result.status === 'error' ? result.message : '读取已取消'
          }`,
        );
        // Do not leave an editable empty document behind. The stable file
        // identity remains in the tree; the normal open action retries the
        // real read and establishes the baseline/version only on success.
        continue;
      }
    }
    document = restoreView(document, saved.view);
    restoredTabs.push(document);
  }

  const selectedId =
    workspace.selectedId && findEntry(session.tree, workspace.selectedId)
      ? workspace.selectedId
      : null;
  return {
    session: {
      ...session,
      expanded,
      selectedId,
      tabs: restoredTabs,
      activeIdentity: chooseActiveTab(
        restoredTabs,
        workspace.tabs,
        workspace.activeIdentity,
      ),
    },
    errors,
  };
}

export function workspaceContainsDrafts(
  workspace: ProjectWorkspaceSnapshot,
): boolean {
  return workspace.tabs.some((tab) => Boolean(tab.draft));
}

export function cleanWorkspaceForQuit(
  session: ProjectSession,
): ProjectWorkspaceSnapshot {
  return workspaceSnapshotFromSession(session, { includeDrafts: false });
}

export function liveIdentities(session: ProjectSession): Set<string> {
  return new Set(
    liveFileEntries(session.tree)
      .map((entry) => entry.fileIdentity)
      .filter((identity): identity is string => Boolean(identity)),
  );
}
