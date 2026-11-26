import type {
  FileChange,
  FileTreeEntry,
  ProjectSnapshot,
  TreeMutationResult,
} from '../services/capabilities';
import type { ProjectInfo } from '../types';
import {
  isTextContentViewer,
  viewerKindForFileName,
} from '../features/viewers/viewer-types';
import type { ViewerKind } from '../features/viewers/viewer-types';

export interface TextViewState {
  scrollTop: number;
  scrollLeft: number;
  selectionStart: number;
  selectionEnd: number;
}

export interface MarkdownModeState {
  mode: 'preview' | 'source';
  previewScrollTop: number;
}

export interface ImageViewState {
  fit: boolean;
  zoom: number;
  scrollLeft: number;
  scrollTop: number;
  naturalWidth: number;
  naturalHeight: number;
}

export interface CsvViewState {
  selectedRow: number;
  selectedCol: number;
  columnWidths: number[];
  scrollTop: number;
  scrollLeft: number;
  rows: number;
  columns: number;
  parseError: string;
}

export interface H5Selection {
  row: number;
  col: number;
}

export interface H5ViewState {
  currentDatasetPath: string | null;
  selections: Record<string, H5Selection>;
  widths: Record<string, number[]>;
  scroll: Record<string, { top: number; left: number }>;
}

export type HtmlPreviewStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface HtmlViewState {
  previewUrl: string | null;
  previewHandle: string | null;
  /**
   * Incremented only after a successful preview refresh. It is part of the
   * iframe key so an identical URL still navigates to a fresh page.
   */
  previewRevision: number;
  status: HtmlPreviewStatus;
  error: string;
  refreshLoading: boolean;
  refreshError: string;
  generation: number;
}

export function createHtmlViewState(): HtmlViewState {
  return {
    previewUrl: null,
    previewHandle: null,
    previewRevision: 0,
    status: 'idle',
    error: '',
    refreshLoading: false,
    refreshError: '',
    generation: 0,
  };
}

export type TextNewline = '\n' | '\r\n' | '\r';

export interface OpenDocument {
  identity: string;
  instanceId: string;
  name: string;
  path: string;
  viewerKind: ViewerKind;
  content: string;
  savedContent: string;
  dirty: boolean;
  contentLoaded: boolean;
  version?: string;
  bom: boolean;
  newline: TextNewline;
  /** The disk entry disappeared while unsaved edits were retained. */
  missing: boolean;
  /** An external Agent write changed the file while it was open. */
  externalUpdate: boolean;
  /** Bumped for viewers that must re-read the same identity. */
  externalRevision: number;
  textView: TextViewState;
  markdownView: MarkdownModeState;
  imageView: ImageViewState;
  csvView: CsvViewState;
  h5View: H5ViewState;
  htmlView: HtmlViewState;
}

export interface TreeClipboard {
  mode: 'cut' | 'copy';
  entryId: string;
}

export interface ProjectSession {
  project: ProjectInfo;
  tree: readonly FileTreeEntry[];
  expanded: Record<string, boolean>;
  selectedId: string | null;
  tabs: OpenDocument[];
  activeIdentity: string | null;
  clipboard: TreeClipboard | null;
  pastePending: boolean;
}

export type SessionAction =
  | { type: 'toggle-expanded'; entryId: string }
  | { type: 'select'; entryId: string | null }
  | { type: 'set-clipboard'; clipboard: TreeClipboard | null }
  | { type: 'set-paste-pending'; pending: boolean }
  | { type: 'open-document'; document: OpenDocument }
  | { type: 'activate-document'; identity: string }
  | {
      type: 'update-document-content';
      identity: string;
      content: string;
    }
  | {
      type: 'invalidate-document-resources';
      identity: string;
      instanceId: string;
    }
  | {
      type: 'update-text-view';
      identity: string;
      patch: Partial<TextViewState>;
    }
  | {
      type: 'set-markdown-mode';
      identity: string;
      mode: MarkdownModeState['mode'];
    }
  | {
      type: 'set-markdown-preview-scroll';
      identity: string;
      scrollTop: number;
    }
  | {
      type: 'update-image-view';
      identity: string;
      patch: Partial<ImageViewState>;
    }
  | {
      type: 'update-csv-view';
      identity: string;
      instanceId: string;
      patch: Partial<CsvViewState>;
    }
  | {
      type: 'update-h5-view';
      identity: string;
      instanceId: string;
      patch: Partial<H5ViewState>;
    }
  | {
      type: 'update-html-view';
      identity: string;
      instanceId: string;
      patch: Partial<HtmlViewState>;
    }
  | {
      type: 'mark-document-saved';
      identity: string;
      instanceId: string;
      savedContent: string;
      version?: string;
    }
  | {
      type: 'hydrate-document';
      identity: string;
      instanceId: string;
      content: string;
      version?: string;
      bom?: boolean;
      newline?: TextNewline;
    }
  | { type: 'mark-all-documents-saved' }
  | { type: 'close-document'; identity: string }
  | { type: 'discard-unsaved' }
  | {
      type: 'apply-tree-result';
      result: TreeMutationResult;
      selectionId?: string | null;
      expandToId?: string | null;
      clearClipboard?: boolean;
      preserveDirtyDeleted?: boolean;
    }
  | {
      type: 'sync-project';
      snapshot: ProjectSnapshot;
      changedFileIdentities: readonly string[];
      deletedFileIdentities: readonly string[];
    }
  | {
      type: 'apply-external-content';
      identity: string;
      instanceId: string;
      content: string;
      version?: string;
      bom?: boolean;
      newline?: TextNewline;
    }
  | {
      type: 'clear-external-update';
      identity: string;
      instanceId: string;
    }
  | {
      type: 'reload-document';
      identity: string;
      instanceId: string;
      content: string;
      version?: string;
      bom?: boolean;
      newline?: TextNewline;
    };

export function createProjectSession(
  snapshot: ProjectSnapshot,
): ProjectSession {
  const expanded: Record<string, boolean> = {};
  for (const entry of snapshot.tree) {
    if (entry.kind === 'folder') expanded[entry.id] = true;
  }

  return {
    project: snapshot.project,
    tree: snapshot.tree,
    expanded,
    selectedId: null,
    tabs: [],
    activeIdentity: null,
    clipboard: null,
    pastePending: false,
  };
}

export function createDocument(
  name: string,
  path: string,
  identity: string,
  instanceId: string,
  content: string,
  metadata: {
    version?: string;
    bom?: boolean;
    newline?: TextNewline;
  } = {},
): OpenDocument {
  const viewerKind = viewerKindForFileName(name);
  return {
    identity,
    instanceId,
    name,
    path,
    viewerKind,
    content,
    savedContent: content,
    dirty: false,
    contentLoaded: isTextContentViewer(viewerKind),
    ...(metadata.version ? { version: metadata.version } : {}),
    bom: metadata.bom ?? false,
    newline: metadata.newline ?? '\n',
    missing: false,
    externalUpdate: false,
    externalRevision: 0,
    textView: {
      scrollTop: 0,
      scrollLeft: 0,
      selectionStart: 0,
      selectionEnd: 0,
    },
    markdownView: {
      mode: 'preview',
      previewScrollTop: 0,
    },
    imageView: {
      fit: true,
      zoom: 1,
      scrollLeft: 0,
      scrollTop: 0,
      naturalWidth: 0,
      naturalHeight: 0,
    },
    csvView: {
      selectedRow: 0,
      selectedCol: 0,
      columnWidths: [],
      scrollTop: 0,
      scrollLeft: 0,
      rows: 0,
      columns: 0,
      parseError: '',
    },
    h5View: {
      currentDatasetPath: null,
      selections: {},
      widths: {},
      scroll: {},
    },
    htmlView: createHtmlViewState(),
  };
}

export function activeDocument(
  session: ProjectSession,
): OpenDocument | null {
  if (!session.activeIdentity) return null;
  return (
    session.tabs.find(
      (document) => document.identity === session.activeIdentity,
    ) ?? null
  );
}

export function findEntry(
  entries: readonly FileTreeEntry[],
  entryId: string,
): FileTreeEntry | null {
  for (const entry of entries) {
    if (entry.id === entryId) return entry;
    if (entry.children) {
      const found = findEntry(entry.children, entryId);
      if (found) return found;
    }
  }
  return null;
}

export function findEntryByPath(
  entries: readonly FileTreeEntry[],
  path: string,
): FileTreeEntry | null {
  const key = path.toLowerCase();
  for (const entry of entries) {
    if (entry.path.toLowerCase() === key) return entry;
    if (entry.children) {
      const found = findEntryByPath(entry.children, path);
      if (found) return found;
    }
  }
  return null;
}

export function findFileByIdentity(
  entries: readonly FileTreeEntry[],
  identity: string,
): FileTreeEntry | null {
  for (const entry of entries) {
    if (
      entry.kind === 'file' &&
      entry.fileIdentity === identity
    ) {
      return entry;
    }
    if (entry.children) {
      const found = findFileByIdentity(entry.children, identity);
      if (found) return found;
    }
  }
  return null;
}

export function fileEntriesUnder(
  entries: readonly FileTreeEntry[],
  entryId: string,
): FileTreeEntry[] {
  const entry = findEntry(entries, entryId);
  if (!entry) return [];
  const files: FileTreeEntry[] = [];
  function visit(current: FileTreeEntry) {
    if (current.kind === 'file') {
      files.push(current);
      return;
    }
    for (const child of current.children ?? []) visit(child);
  }
  visit(entry);
  return files;
}

export function parentIdOf(
  entries: readonly FileTreeEntry[],
  entryId: string,
  parentId: string | null = null,
): string | null {
  for (const entry of entries) {
    if (entry.id === entryId) return parentId;
    if (entry.children) {
      const found = parentIdOf(entry.children, entryId, entry.id);
      if (found !== null) return found;
    }
  }
  return null;
}

export function entryPathIds(
  entries: readonly FileTreeEntry[],
  entryId: string,
  ancestors: string[] = [],
): string[] | null {
  for (const entry of entries) {
    if (entry.id === entryId) return [...ancestors, entry.id];
    if (entry.children) {
      const found = entryPathIds(entry.children, entryId, [
        ...ancestors,
        entry.id,
      ]);
      if (found) return found;
    }
  }
  return null;
}

export function isSelfOrDescendant(
  entries: readonly FileTreeEntry[],
  ancestorId: string,
  entryId: string,
): boolean {
  const ancestor = findEntry(entries, ancestorId);
  if (!ancestor || ancestor.kind !== 'folder') return false;
  function contains(current: FileTreeEntry): boolean {
    if (current.id === entryId) return true;
    return (current.children ?? []).some(contains);
  }
  return contains(ancestor);
}

export function dirtyDocumentsUnder(
  session: ProjectSession,
  entryId: string,
): OpenDocument[] {
  const identities = new Set(
    fileEntriesUnder(session.tree, entryId)
      .map((entry) => entry.fileIdentity)
      .filter((identity): identity is string => Boolean(identity)),
  );
  return session.tabs.filter(
    (document) =>
      document.dirty && identities.has(document.identity),
  );
}

export function liveFileEntries(
  entries: readonly FileTreeEntry[],
): FileTreeEntry[] {
  const files: FileTreeEntry[] = [];
  function visit(list: readonly FileTreeEntry[]) {
    for (const entry of list) {
      if (entry.kind === 'file') files.push(entry);
      if (entry.children) visit(entry.children);
    }
  }
  visit(entries);
  return files;
}

function chooseActiveAfterRemoval(
  previousTabs: readonly OpenDocument[],
  previousActive: string | null,
  nextTabs: readonly OpenDocument[],
): string | null {
  if (nextTabs.length === 0) return null;
  if (
    previousActive &&
    nextTabs.some((document) => document.identity === previousActive)
  ) {
    return previousActive;
  }

  const nextIdentities = new Set(
    nextTabs.map((document) => document.identity),
  );
  const previousIndex = previousTabs.findIndex(
    (document) => document.identity === previousActive,
  );
  if (previousIndex === -1) return nextTabs[0]?.identity ?? null;

  for (let index = previousIndex + 1; index < previousTabs.length; index += 1) {
    if (nextIdentities.has(previousTabs[index].identity)) {
      return previousTabs[index].identity;
    }
  }
  for (let index = previousIndex - 1; index >= 0; index -= 1) {
    if (nextIdentities.has(previousTabs[index].identity)) {
      return previousTabs[index].identity;
    }
  }
  return nextTabs[0]?.identity ?? null;
}

function validateClipboard(
  clipboard: TreeClipboard | null,
  tree: readonly FileTreeEntry[],
): TreeClipboard | null {
  if (!clipboard) return null;
  return findEntry(tree, clipboard.entryId) ? clipboard : null;
}

function applyTreeResult(
  session: ProjectSession,
  result: TreeMutationResult,
  selectionId: string | null | undefined,
  expandToId: string | null | undefined,
  clearClipboard: boolean | undefined,
  preserveDirtyDeleted: boolean | undefined,
): ProjectSession {
  const fileByIdentity = new Map(
    liveFileEntries(result.tree)
      .filter(
        (entry): entry is FileTreeEntry & { fileIdentity: string } =>
          Boolean(entry.fileIdentity),
      )
      .map((entry) => [entry.fileIdentity, entry]),
  );
  const changeByIdentity = new Map<string, FileChange>(
    result.changes.map((change) => [change.identity, change]),
  );

  const nextTabs = session.tabs.flatMap((document) => {
    const change = changeByIdentity.get(document.identity);
    if (change?.kind === 'deleted') {
      return preserveDirtyDeleted && document.dirty
        ? [{ ...document, missing: true }]
        : [];
    }
    const file = fileByIdentity.get(document.identity);
    if (!file) {
      return document.dirty
        ? [{ ...document, missing: true }]
        : [];
    }
    const nextKind = viewerKindForFileName(file.name);
    return [
      {
        ...document,
        name: file.name,
        path: file.path,
        viewerKind: nextKind,
        missing: false,
        htmlView:
          document.viewerKind === 'html' && nextKind !== 'html'
            ? createHtmlViewState()
            : document.htmlView,
      },
    ];
  });

  const activeIdentity = chooseActiveAfterRemoval(
    session.tabs,
    session.activeIdentity,
    nextTabs,
  );

  const folderIds = new Set<string>();
  function collectFolders(entries: readonly FileTreeEntry[]) {
    for (const entry of entries) {
      if (entry.kind === 'folder') folderIds.add(entry.id);
      if (entry.children) collectFolders(entry.children);
    }
  }
  collectFolders(result.tree);

  const expanded: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(session.expanded)) {
    if (value && folderIds.has(id)) expanded[id] = true;
  }
  if (expandToId) {
    const pathIds = entryPathIds(result.tree, expandToId);
    if (pathIds) {
      for (const id of pathIds.slice(0, -1)) expanded[id] = true;
    }
  }

  let selectedId: string | null = null;
  if (selectionId !== undefined) {
    selectedId =
      selectionId && findEntry(result.tree, selectionId)
        ? selectionId
        : null;
  } else if (
    session.selectedId &&
    findEntry(result.tree, session.selectedId)
  ) {
    selectedId = session.selectedId;
  } else if (result.targetEntryId) {
    selectedId = result.targetEntryId;
  }

  const clipboard = clearClipboard
    ? null
    : validateClipboard(session.clipboard, result.tree);

  return {
    ...session,
    tree: result.tree,
    expanded,
    selectedId,
    tabs: nextTabs,
    activeIdentity,
    clipboard,
  };
}

/**
 * Applies a fresh disk snapshot to an already cached project session. Valid
 * tabs keep their editing/view state; tabs whose files disappeared are only
 * dropped when they have no unsaved content. A dirty orphan stays visible so
 * the UI can explain the loss instead of silently discarding the edit.
 */
export function refreshProjectSession(
  session: ProjectSession,
  snapshot: ProjectSnapshot,
): ProjectSession {
  const fileByIdentity = new Map(
    liveFileEntries(snapshot.tree)
      .filter(
        (entry): entry is FileTreeEntry & { fileIdentity: string } =>
          Boolean(entry.fileIdentity),
      )
      .map((entry) => [entry.fileIdentity, entry]),
  );
  const nextTabs = session.tabs.flatMap((document) => {
    const file = fileByIdentity.get(document.identity);
    if (!file) {
      return document.dirty
        ? [{ ...document, missing: true }]
        : [];
    }
    const nextKind = viewerKindForFileName(file.name);
    return [
      {
        ...document,
        name: file.name,
        path: file.path,
        viewerKind: nextKind,
        missing: false,
        htmlView:
          document.viewerKind === 'html' && nextKind !== 'html'
            ? createHtmlViewState()
            : document.htmlView,
      },
    ];
  });
  const activeIdentity = chooseActiveAfterRemoval(
    session.tabs,
    session.activeIdentity,
    nextTabs,
  );
  const folderIds = new Set<string>();
  const collectFolders = (entries: readonly FileTreeEntry[]) => {
    for (const entry of entries) {
      if (entry.kind === 'folder') folderIds.add(entry.id);
      if (entry.children) collectFolders(entry.children);
    }
  };
  collectFolders(snapshot.tree);
  const expanded: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(session.expanded)) {
    if (value && folderIds.has(id)) expanded[id] = true;
  }
  return {
    ...session,
    project: {
      ...session.project,
      ...snapshot.project,
    },
    tree: snapshot.tree,
    expanded,
    selectedId:
      session.selectedId && findEntry(snapshot.tree, session.selectedId)
        ? session.selectedId
        : null,
    tabs: nextTabs,
    activeIdentity,
    clipboard: validateClipboard(session.clipboard, snapshot.tree),
    pastePending: session.pastePending,
  };
}

export function sessionReducer(
  session: ProjectSession,
  action: SessionAction,
): ProjectSession {
  switch (action.type) {
    case 'toggle-expanded':
      return {
        ...session,
        expanded: {
          ...session.expanded,
          [action.entryId]: !session.expanded[action.entryId],
        },
      };

    case 'select':
      return { ...session, selectedId: action.entryId };

    case 'set-clipboard':
      return { ...session, clipboard: action.clipboard };

    case 'set-paste-pending':
      return { ...session, pastePending: action.pending };

    case 'open-document': {
      const existing = session.tabs.find(
        (document) =>
          document.identity === action.document.identity,
      );
      if (existing) {
        return { ...session, activeIdentity: existing.identity };
      }
      return {
        ...session,
        tabs: [...session.tabs, action.document],
        activeIdentity: action.document.identity,
      };
    }

    case 'activate-document':
      return session.tabs.some(
        (document) => document.identity === action.identity,
      )
        ? { ...session, activeIdentity: action.identity }
        : session;

    case 'update-document-content': {
      const tabs = session.tabs.map((document) => {
        if (document.identity !== action.identity) return document;
        return {
          ...document,
          content: action.content,
          dirty: action.content !== document.savedContent,
        };
      });
      return { ...session, tabs };
    }

    case 'update-text-view': {
      const tabs = session.tabs.map((document) =>
        document.identity === action.identity
          ? {
              ...document,
              textView: { ...document.textView, ...action.patch },
            }
          : document,
      );
      return { ...session, tabs };
    }

    case 'set-markdown-mode': {
      const tabs = session.tabs.map((document) =>
        document.identity === action.identity
          ? {
              ...document,
              markdownView: {
                ...document.markdownView,
                mode: action.mode,
              },
            }
          : document,
      );
      return { ...session, tabs };
    }

    case 'set-markdown-preview-scroll': {
      const tabs = session.tabs.map((document) =>
        document.identity === action.identity
          ? {
              ...document,
              markdownView: {
                ...document.markdownView,
                previewScrollTop: action.scrollTop,
              },
            }
          : document,
      );
      return { ...session, tabs };
    }

    case 'update-image-view': {
      const tabs = session.tabs.map((document) =>
        document.identity === action.identity
          ? {
              ...document,
              imageView: {
                ...document.imageView,
                ...action.patch,
              },
            }
          : document,
      );
      return { ...session, tabs };
    }

    case 'update-csv-view': {
      const tabs = session.tabs.map((document) =>
        document.identity === action.identity &&
        document.instanceId === action.instanceId
          ? {
              ...document,
              csvView: { ...document.csvView, ...action.patch },
            }
          : document,
      );
      return { ...session, tabs };
    }

    case 'update-h5-view': {
      const tabs = session.tabs.map((document) =>
        document.identity === action.identity &&
        document.instanceId === action.instanceId
          ? {
              ...document,
              h5View: { ...document.h5View, ...action.patch },
            }
          : document,
      );
      return { ...session, tabs };
    }

    case 'update-html-view': {
      const tabs = session.tabs.map((document) =>
        document.identity === action.identity &&
        document.instanceId === action.instanceId
          ? {
              ...document,
              htmlView: { ...document.htmlView, ...action.patch },
            }
          : document,
      );
      return { ...session, tabs };
    }

    case 'mark-document-saved': {
      const tabs = session.tabs.map((document) => {
        if (
          document.identity !== action.identity ||
          document.instanceId !== action.instanceId
        ) {
          return document;
        }
        return {
          ...document,
          savedContent: action.savedContent,
          ...(action.version ? { version: action.version } : {}),
          dirty: document.content !== action.savedContent,
        };
      });
      return { ...session, tabs };
    }

    case 'hydrate-document': {
      const tabs = session.tabs.map((document) => {
        if (
          document.identity !== action.identity ||
          document.instanceId !== action.instanceId ||
          document.contentLoaded ||
          document.dirty
        ) {
          return document;
        }
        return {
          ...document,
          content: action.content,
          savedContent: action.content,
          dirty: false,
          contentLoaded: true,
          ...(action.version ? { version: action.version } : {}),
          bom: action.bom ?? document.bom,
          newline: action.newline ?? document.newline,
          missing: false,
        };
      });
      return { ...session, tabs };
    }

    case 'mark-all-documents-saved': {
      return {
        ...session,
        tabs: session.tabs.map((document) =>
          document.dirty
            ? {
                ...document,
                savedContent: document.content,
                dirty: false,
              }
            : document,
        ),
      };
    }

    case 'close-document': {
      const nextTabs = session.tabs.filter(
        (document) => document.identity !== action.identity,
      );
      if (nextTabs.length === session.tabs.length) return session;
      return {
        ...session,
        tabs: nextTabs,
        activeIdentity: chooseActiveAfterRemoval(
          session.tabs,
          session.activeIdentity,
          nextTabs,
        ),
      };
    }

    case 'discard-unsaved':
      return {
        ...session,
        tabs: session.tabs.map((document) =>
          document.dirty
            ? {
                ...document,
                content: document.savedContent,
                dirty: false,
              }
            : document,
        ),
      };

    case 'apply-tree-result':
      return applyTreeResult(
        session,
        action.result,
        action.selectionId,
        action.expandToId,
        action.clearClipboard,
        action.preserveDirtyDeleted,
      );

    case 'sync-project': {
      const refreshed = refreshProjectSession(session, action.snapshot);
      const changed = new Set(action.changedFileIdentities);
      const deleted = new Set(action.deletedFileIdentities);
      return {
        ...refreshed,
        // Keep unsaved edits exactly as they are; no automatic overwrite.
        tabs: refreshed.tabs.map((document) => {
          if (deleted.has(document.identity) && document.dirty) {
            return {
              ...document,
              missing: true,
              externalUpdate: false,
            };
          }
          if (changed.has(document.identity)) {
            return {
              ...document,
              externalUpdate: true,
              externalRevision: document.externalRevision + 1,
            };
          }
          return document;
        }),
      };
    }

    case 'apply-external-content':
      return {
        ...session,
        tabs: session.tabs.map((document) => {
          if (
            document.identity !== action.identity ||
            document.instanceId !== action.instanceId ||
            document.dirty
          ) {
            return document;
          }
          return {
            ...document,
            content: action.content,
            savedContent: action.content,
            contentLoaded: true,
            dirty: false,
            missing: false,
            externalUpdate: false,
            externalRevision: document.externalRevision + 1,
            ...(action.version !== undefined
              ? { version: action.version }
              : {}),
            ...(action.bom !== undefined ? { bom: action.bom } : {}),
            ...(action.newline !== undefined
              ? { newline: action.newline }
              : {}),
          };
        }),
      };

    case 'invalidate-document-resources':
      return {
        ...session,
        tabs: session.tabs.map((document) =>
          document.identity === action.identity &&
          document.instanceId === action.instanceId
            ? {
                ...document,
                externalRevision: document.externalRevision + 1,
              }
            : document,
        ),
      };

    case 'reload-document':
      return {
        ...session,
        tabs: session.tabs.map((document) => {
          if (
            document.identity !== action.identity ||
            document.instanceId !== action.instanceId
          ) {
            return document;
          }
          return {
            ...document,
            content: action.content,
            savedContent: action.content,
            contentLoaded: true,
            dirty: false,
            missing: false,
            externalUpdate: false,
            externalRevision: document.externalRevision + 1,
            ...(action.version !== undefined
              ? { version: action.version }
              : {}),
            ...(action.bom !== undefined ? { bom: action.bom } : {}),
            ...(action.newline !== undefined
              ? { newline: action.newline }
              : {}),
          };
        }),
      };

    case 'clear-external-update':
      return {
        ...session,
        tabs: session.tabs.map((document) =>
          document.identity === action.identity &&
          document.instanceId === action.instanceId
            ? { ...document, externalUpdate: false }
            : document,
        ),
      };

    default:
      return session;
  }
}



