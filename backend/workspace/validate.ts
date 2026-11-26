import type {
  ProjectWorkspaceSnapshot,
  WorkspaceCsvView,
  WorkspaceDocumentView,
  WorkspaceH5View,
  WorkspaceImageView,
  WorkspaceLayoutSnapshot,
  WorkspaceMarkdownView,
  WorkspaceTabDraft,
  WorkspaceTabSnapshot,
  WorkspaceTextView,
  WorkspaceViewerKind,
} from '../ipc/workspace';
import {
  WORKSPACE_MAX_DATASETS,
  WORKSPACE_MAX_EXPANDED,
  WORKSPACE_MAX_PAYLOAD_BYTES,
  WORKSPACE_MAX_TABS,
  WORKSPACE_MAX_TEXT_BYTES,
  WORKSPACE_SNAPSHOT_VERSION,
} from '../ipc/workspace';

export class WorkspaceStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkspaceStoreError';
    this.code = code;
  }
}

type ObjectValue = Record<string, unknown>;

function fail(code: string, message: string): never {
  throw new WorkspaceStoreError(code, message);
}

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid-workspace', `${label}必须是对象。`);
  }
  return value as ObjectValue;
}

function string(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty = true,
): string {
  if (typeof value !== 'string') {
    fail('invalid-workspace', `${label}必须是字符串。`);
  }
  if (!allowEmpty && value.length === 0) {
    fail('invalid-workspace', `${label}不能为空。`);
  }
  if (value.length > maxLength) {
    fail('invalid-workspace', `${label}超过长度限制。`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    fail('invalid-workspace', `${label}必须是布尔值。`);
  }
  return value;
}

function integer(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    fail('invalid-workspace', `${label}必须是 ${min}..${max} 的整数。`);
  }
  return value;
}

function numberInRange(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    fail('invalid-workspace', `${label}超出允许范围。`);
  }
  return value;
}

function stringOrNull(
  value: unknown,
  label: string,
  maxLength: number,
): string | null {
  if (value === null) return null;
  return string(value, label, maxLength, false);
}

function stringArray(
  value: unknown,
  label: string,
  maxLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maxLength) {
    fail('invalid-workspace', `${label}必须是长度不超过 ${maxLength} 的数组。`);
  }
  return value.map((item, index) =>
    string(item, `${label}[${index}]`, 4096, false),
  );
}

function union<T extends string>(
  value: unknown,
  label: string,
  values: readonly T[],
): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    fail('invalid-workspace', `${label}必须是 ${values.join(' / ')} 之一。`);
  }
  return value as T;
}

function textView(value: unknown): WorkspaceTextView {
  const view = object(value, 'view.text');
  return {
    scrollTop: numberInRange(view.scrollTop, 'text.scrollTop', 0, 1e9),
    scrollLeft: numberInRange(view.scrollLeft, 'text.scrollLeft', 0, 1e9),
    selectionStart: integer(view.selectionStart, 'text.selectionStart', 0, 1e9),
    selectionEnd: integer(view.selectionEnd, 'text.selectionEnd', 0, 1e9),
  };
}

function markdownView(value: unknown): WorkspaceMarkdownView {
  const view = object(value, 'view.markdown');
  return {
    mode: union(view.mode, 'markdown.mode', ['preview', 'source']),
    previewScrollTop: numberInRange(
      view.previewScrollTop,
      'markdown.previewScrollTop',
      0,
      1e9,
    ),
  };
}

function imageView(value: unknown): WorkspaceImageView {
  const view = object(value, 'view.image');
  return {
    fit: boolean(view.fit, 'image.fit'),
    zoom: numberInRange(view.zoom, 'image.zoom', 0.05, 8),
    scrollLeft: numberInRange(view.scrollLeft, 'image.scrollLeft', 0, 1e9),
    scrollTop: numberInRange(view.scrollTop, 'image.scrollTop', 0, 1e9),
  };
}

function widths(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length > 512) {
    fail('invalid-workspace', `${label}必须是长度不超过 512 的数组。`);
  }
  return value.map((item, index) =>
    numberInRange(item, `${label}[${index}]`, 20, 2000),
  );
}

function csvView(value: unknown): WorkspaceCsvView {
  const view = object(value, 'view.csv');
  return {
    selectedRow: integer(view.selectedRow, 'csv.selectedRow', 0, 1e7),
    selectedCol: integer(view.selectedCol, 'csv.selectedCol', 0, 1e7),
    columnWidths: widths(view.columnWidths, 'csv.columnWidths'),
    scrollTop: numberInRange(view.scrollTop, 'csv.scrollTop', 0, 1e9),
    scrollLeft: numberInRange(view.scrollLeft, 'csv.scrollLeft', 0, 1e9),
  };
}

function h5View(value: unknown): WorkspaceH5View {
  const view = object(value, 'view.h5');
  const selectionsRaw = object(view.selections, 'h5.selections');
  const widthsRaw = object(view.widths, 'h5.widths');
  const scrollRaw = object(view.scroll, 'h5.scroll');
  if (
    Object.keys(selectionsRaw).length > WORKSPACE_MAX_DATASETS ||
    Object.keys(widthsRaw).length > WORKSPACE_MAX_DATASETS ||
    Object.keys(scrollRaw).length > WORKSPACE_MAX_DATASETS
  ) {
    fail('invalid-workspace', 'H5 状态条目超过限制。');
  }
  const selections: WorkspaceH5View['selections'] = {};
  for (const [key, entry] of Object.entries(selectionsRaw)) {
    if (key.length > 4096) fail('invalid-workspace', 'H5 数据集路径过长。');
    const selection = object(entry, `h5.selections.${key}`);
    selections[key] = {
      row: integer(selection.row, 'h5.selection.row', 0, 1e7),
      col: integer(selection.col, 'h5.selection.col', 0, 1e7),
    };
  }
  const h5Widths: WorkspaceH5View['widths'] = {};
  for (const [key, entry] of Object.entries(widthsRaw)) {
    if (key.length > 4096) fail('invalid-workspace', 'H5 数据集路径过长。');
    h5Widths[key] = widths(entry, 'h5.widths');
  }
  const scroll: WorkspaceH5View['scroll'] = {};
  for (const [key, entry] of Object.entries(scrollRaw)) {
    if (key.length > 4096) fail('invalid-workspace', 'H5 数据集路径过长。');
    const position = object(entry, 'h5.scroll');
    scroll[key] = {
      top: numberInRange(position.top, 'h5.scroll.top', 0, 1e9),
      left: numberInRange(position.left, 'h5.scroll.left', 0, 1e9),
    };
  }
  return {
    currentDatasetPath:
      view.currentDatasetPath === null
        ? null
        : string(view.currentDatasetPath, 'h5.currentDatasetPath', 4096, false),
    selections,
    widths: h5Widths,
    scroll,
  };
}

function documentView(value: unknown): WorkspaceDocumentView {
  const view = object(value, 'view');
  return {
    text: textView(view.text),
    markdown: markdownView(view.markdown),
    image: imageView(view.image),
    csv: csvView(view.csv),
    h5: h5View(view.h5),
  };
}

function draft(value: unknown): WorkspaceTabDraft {
  const entry = object(value, 'draft');
  const content = string(entry.content, 'draft.content', WORKSPACE_MAX_TEXT_BYTES);
  const savedContent = string(
    entry.savedContent,
    'draft.savedContent',
    WORKSPACE_MAX_TEXT_BYTES,
  );
  if (
    Buffer.byteLength(content, 'utf8') + Buffer.byteLength(savedContent, 'utf8') >
    WORKSPACE_MAX_PAYLOAD_BYTES
  ) {
    fail('invalid-workspace', '恢复副本超过大小限制。');
  }
  return {
    content,
    savedContent,
    ...(entry.version !== undefined
      ? { version: string(entry.version, 'draft.version', 256, false) }
      : {}),
    bom: boolean(entry.bom, 'draft.bom'),
    newline: union(entry.newline, 'draft.newline', ['\n', '\r\n', '\r']),
  };
}

const VIEWER_KINDS: readonly WorkspaceViewerKind[] = [
  'text',
  'markdown',
  'image',
  'csv',
  'html',
  'h5',
];

function tab(value: unknown): WorkspaceTabSnapshot {
  const entry = object(value, 'tab');
  return {
    identity: string(entry.identity, 'tab.identity', 256, false),
    name: string(entry.name, 'tab.name', 260, false),
    path: string(entry.path, 'tab.path', 4096, false),
    viewerKind: union(entry.viewerKind, 'tab.viewerKind', VIEWER_KINDS),
    view: documentView(entry.view),
    ...(entry.draft !== undefined ? { draft: draft(entry.draft) } : {}),
  };
}

function assertPayloadSize(value: unknown): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    fail('invalid-workspace', '工作区状态无法序列化。');
  }
  if (Buffer.byteLength(encoded, 'utf8') > WORKSPACE_MAX_PAYLOAD_BYTES) {
    fail('invalid-workspace', '工作区状态超过大小限制。');
  }
}

export function parseLayoutSnapshot(value: unknown): WorkspaceLayoutSnapshot {
  const entry = object(value, 'layout');
  assertPayloadSize(entry);
  return {
    leftVisible: boolean(entry.leftVisible, 'layout.leftVisible'),
    rightVisible: boolean(entry.rightVisible, 'layout.rightVisible'),
    leftWidth: integer(entry.leftWidth, 'layout.leftWidth', 0, 10_000),
    rightWidth: integer(entry.rightWidth, 'layout.rightWidth', 0, 10_000),
    customized: boolean(entry.customized, 'layout.customized'),
  };
}

export function parseProjectWorkspace(
  value: unknown,
): ProjectWorkspaceSnapshot {
  const entry = object(value, 'workspace');
  if (entry.version !== WORKSPACE_SNAPSHOT_VERSION) {
    fail('invalid-workspace', '工作区快照版本不受支持。');
  }
  const expandedIds = stringArray(
    entry.expandedIds,
    'workspace.expandedIds',
    WORKSPACE_MAX_EXPANDED,
  );
  if (new Set(expandedIds).size !== expandedIds.length) {
    fail('invalid-workspace', 'expandedIds 不能重复。');
  }
  if (!Array.isArray(entry.tabs) || entry.tabs.length > WORKSPACE_MAX_TABS) {
    fail('invalid-workspace', '工作区标签数量超过限制。');
  }
  const tabs = entry.tabs.map(tab);
  if (new Set(tabs.map((item) => item.identity)).size !== tabs.length) {
    fail('invalid-workspace', '工作区标签身份不能重复。');
  }
  const selectedId = stringOrNull(entry.selectedId, 'workspace.selectedId', 256);
  const activeIdentity = stringOrNull(
    entry.activeIdentity,
    'workspace.activeIdentity',
    256,
  );
  if (
    activeIdentity !== null &&
    !tabs.some((item) => item.identity === activeIdentity)
  ) {
    fail('invalid-workspace', '活动标签不在标签列表中。');
  }
  const snapshot: ProjectWorkspaceSnapshot = {
    version: WORKSPACE_SNAPSHOT_VERSION,
    expandedIds,
    selectedId,
    activeIdentity,
    tabs,
  };
  assertPayloadSize(snapshot);
  return snapshot;
}

function defaultView(): WorkspaceDocumentView {
  return {
    text: {
      scrollTop: 0,
      scrollLeft: 0,
      selectionStart: 0,
      selectionEnd: 0,
    },
    markdown: { mode: 'preview', previewScrollTop: 0 },
    image: { fit: true, zoom: 1, scrollLeft: 0, scrollTop: 0 },
    csv: {
      selectedRow: 0,
      selectedCol: 0,
      columnWidths: [],
      scrollTop: 0,
      scrollLeft: 0,
    },
    h5: {
      currentDatasetPath: null,
      selections: {},
      widths: {},
      scroll: {},
    },
  };
}

export interface CorruptWorkspaceTab {
  /** Stable identity when the identity field itself is still readable. */
  identity: string | null;
  /** True when the tab was recovered with defaults, false when skipped. */
  recovered: boolean;
  /** Invalid fields, for diagnostics and persistence metadata. */
  fields: string[];
  /** Original tab object for traceability. */
  raw: unknown;
  /** The identity is shared by another tab and cannot identify one tab. */
  collision?: boolean;
}

function lenientTab(value: unknown): {
  tab: WorkspaceTabSnapshot | null;
  identity: string | null;
  recovered: boolean;
  fields: string[];
  raw: unknown;
} {
  let entry: ObjectValue;
  try {
    entry = object(value, 'tab');
  } catch {
    return {
      tab: null,
      identity: null,
      recovered: false,
      fields: ['tab'],
      raw: value,
    };
  }
  const fields: string[] = [];
  let identity: string | null = null;
  try {
    identity = string(entry.identity, 'tab.identity', 256, false);
  } catch {
    fields.push('identity');
  }
  let name: string | null = null;
  try {
    name = string(entry.name, 'tab.name', 260, false);
  } catch {
    fields.push('name');
  }
  let tabPath: string | null = null;
  try {
    tabPath = string(entry.path, 'tab.path', 4096, false);
  } catch {
    fields.push('path');
  }
  let viewerKind: WorkspaceViewerKind | null = null;
  try {
    viewerKind = union(
      entry.viewerKind,
      'tab.viewerKind',
      VIEWER_KINDS,
    ) as WorkspaceViewerKind;
  } catch {
    fields.push('viewerKind');
  }
  if (
    identity === null ||
    name === null ||
    tabPath === null ||
    viewerKind === null
  ) {
    return {
      tab: null,
      identity,
      recovered: false,
      fields,
      raw: value,
    };
  }
  let view: WorkspaceDocumentView;
  try {
    view = documentView(entry.view);
  } catch {
    view = defaultView();
    fields.push('view');
  }
  let parsedDraft: WorkspaceTabDraft | undefined;
  if (entry.draft !== undefined) {
    try {
      parsedDraft = draft(entry.draft);
    } catch {
      parsedDraft = undefined;
      fields.push('draft');
    }
  }
  return {
    tab: {
      identity,
      name,
      path: tabPath,
      viewerKind,
      view,
      ...(parsedDraft ? { draft: parsedDraft } : {}),
    },
    identity,
    recovered: true,
    fields,
    raw: value,
  };
}

/**
 * Load-time parser. A malformed tab/view is isolated so healthy tabs can
 * still be restored. Skipped tabs are reported with their readable identity
 * (when available) so callers can protect the related recovery body.
 */
export function parseProjectWorkspaceLenient(
  value: unknown,
  resolveIdentityName?: (identity: string) => string | null,
): {
  snapshot: ProjectWorkspaceSnapshot;
  corruptTabIds: string[];
  corruptTabCount: number;
  corruptTabs: CorruptWorkspaceTab[];
  identityCollision: boolean;
} {
  const entry = object(value, 'workspace');
  if (entry.version !== WORKSPACE_SNAPSHOT_VERSION) {
    fail('invalid-workspace', '工作区快照版本不受支持。');
  }
  if (!Array.isArray(entry.tabs) || entry.tabs.length > WORKSPACE_MAX_TABS) {
    fail('invalid-workspace', '工作区标签数量超过限制。');
  }
  let expandedIds: string[];
  try {
    expandedIds = stringArray(
      entry.expandedIds,
      'workspace.expandedIds',
      WORKSPACE_MAX_EXPANDED,
    );
  } catch {
    expandedIds = [];
  }
  const tabs: WorkspaceTabSnapshot[] = [];
  const corruptTabIds: string[] = [];
  const corruptTabs: CorruptWorkspaceTab[] = [];
  const byIdentity = new Map<
    string,
    Array<ReturnType<typeof lenientTab>>
  >();
  let identityCollision = false;
  for (const rawTab of entry.tabs) {
    const parsed = lenientTab(rawTab);
    if (parsed.identity === null) {
      corruptTabs.push({
        identity: null,
        recovered: false,
        fields: parsed.fields.length > 0 ? parsed.fields : ['identity'],
        raw: rawTab,
      });
      continue;
    }
    const group = byIdentity.get(parsed.identity) ?? [];
    group.push(parsed);
    byIdentity.set(parsed.identity, group);
  }
  for (const [identity, group] of byIdentity) {
    if (group.length > 1) {
      identityCollision = true;
      let chosen: ReturnType<typeof lenientTab> | null = null;
      const expected = resolveIdentityName?.(identity) ?? null;
      const matching = expected
        ? group.filter((item) => item.tab?.name === expected)
        : [];
      if (matching.length === 1) chosen = matching[0] ?? null;
      if (chosen?.tab) tabs.push(chosen.tab);
      for (const item of group) {
        corruptTabs.push({
          identity,
          recovered: item === chosen,
          fields:
            item === chosen
              ? [...item.fields, 'duplicateIdentity']
              : [
                  ...(item.fields.length > 0 ? item.fields : []),
                  'duplicateIdentity',
                ],
          raw: item.raw,
          collision: true,
        });
      }
      if (!corruptTabIds.includes(identity)) corruptTabIds.push(identity);
      continue;
    }
    const parsed = group[0]!;
    if (!parsed.tab) {
      corruptTabs.push({
        identity,
        recovered: false,
        fields:
          parsed.fields.length > 0 ? parsed.fields : ['tab'],
        raw: parsed.raw,
      });
      corruptTabIds.push(identity);
      continue;
    }
    tabs.push(parsed.tab);
    if (parsed.fields.length > 0) {
      corruptTabIds.push(identity);
      corruptTabs.push({
        identity,
        recovered: true,
        fields: parsed.fields,
        raw: parsed.raw,
      });
    }
  }
  const selectedId =
    entry.selectedId === null
      ? null
      : typeof entry.selectedId === 'string'
        ? entry.selectedId
        : null;
  const rawActive =
    typeof entry.activeIdentity === 'string' ? entry.activeIdentity : null;
  const activeIdentity =
    rawActive && tabs.some((tab) => tab.identity === rawActive)
      ? rawActive
      : null;
  return {
    snapshot: {
      version: WORKSPACE_SNAPSHOT_VERSION,
      expandedIds,
      selectedId,
      activeIdentity,
      tabs,
    },
    corruptTabIds,
    corruptTabCount: corruptTabs.length,
    corruptTabs,
    identityCollision,
  };
}

export function parseDraftPayload(value: unknown): WorkspaceTabDraft {
  return draft(value);
}

export function parseRevision(value: unknown, label: string): number {
  return integer(value, label, 0, Number.MAX_SAFE_INTEGER);
}

export function parseLoadProjectInput(value: unknown): string {
  const entry = object(value, 'workspace request');
  return string(entry.projectId, 'projectId', 256, false);
}
