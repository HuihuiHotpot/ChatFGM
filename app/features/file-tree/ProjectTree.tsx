import { useEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react';
import { Button } from '../../components/ui/Button';
import { FileName } from '../../components/ui/FileName';
import { Modal } from '../../components/ui/Modal';
import type {
  FileTreeEntry,
  FileTreeEntryKind,
} from '../../services/capabilities';
import {
  dirtyDocumentsUnder,
  findEntry,
  isSelfOrDescendant,
  parentIdOf,
} from '../../state/workspace';
import type {
  ProjectSession,
  TreeClipboard,
} from '../../state/workspace';
import { TreeContextMenu } from './TreeContextMenu';
import type { TreeMenuNode } from './TreeContextMenu';
import './ProjectTree.css';

export interface TreeOperationFeedback {
  ok: boolean;
  message?: string;
  entryId?: string;
  ignored?: boolean;
}

export interface ProjectTreeProps {
  session: ProjectSession;
  onToggleExpanded: (entryId: string) => void;
  onSelect: (entryId: string | null) => void;
  onSetClipboard: (clipboard: TreeClipboard | null) => void;
  onOpenFile: (entry: FileTreeEntry) => void;
  onCreateEntry: (
    parentId: string | null,
    kind: FileTreeEntryKind,
    name: string,
  ) => Promise<TreeOperationFeedback>;
  onRenameEntry: (
    entryId: string,
    name: string,
  ) => Promise<TreeOperationFeedback>;
  onDeleteEntry: (entryId: string) => Promise<TreeOperationFeedback>;
  onPasteEntry: (
    targetFolderId: string | null,
    sourceEntryId: string,
    mode: 'cut' | 'copy',
  ) => Promise<TreeOperationFeedback>;
  onCopyPath: (path: string, isDirectory: boolean) => void;
  onReveal: (path: string, isDirectory: boolean) => void;
  onAddToChat?: (entry: FileTreeEntry) => void;
  onNotice: (
    message: string,
    tone?: 'neutral' | 'success' | 'error',
  ) => void;
}

interface EditingState {
  mode: 'create' | 'rename';
  kind: FileTreeEntryKind;
  parentId: string | null;
  entryId?: string;
  value: string;
  error: string;
  busy: boolean;
  focusKey: number;
}

interface MenuState {
  x: number;
  y: number;
  target:
    | { type: 'root' }
    | { type: 'entry'; entryId: string };
}

const INVALID_NAME = /[\\/:*?"<>|]/;

function TreeArrowIcon() {
  return (
    <svg
      className="tree-arrow-icon"
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4.5 2.5 8 6l-3.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      className="tree-folder-icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2 5A1.5 1.5 0 0 1 3.5 3.5h2.6L7.6 5.2h4.9A1.5 1.5 0 0 1 14 6.7v4.8a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      className="tree-file-icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4.2 1.9h4.4l3.2 3.2v8.9a.9.9 0 0 1-.9.9H4.2a.9.9 0 0 1-.9-.9V2.8a.9.9 0 0 1 .9-.9Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M8.4 2v3.2h3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function childEntries(
  session: ProjectSession,
  parentId: string | null,
): readonly FileTreeEntry[] {
  if (parentId === null) return session.tree;
  return findEntry(session.tree, parentId)?.children ?? [];
}

function validateName(
  session: ProjectSession,
  editing: EditingState,
  name: string,
): string {
  if (!name) return '名称不能为空';
  if (INVALID_NAME.test(name)) return '名称不能包含 \\ / : * ? " < > |';
  if (/^\.+$/.test(name)) return '名称无效';
  if (name.length > 120) return '名称过长';

  const siblings = childEntries(session, editing.parentId);
  const duplicated = siblings.some(
    (entry) =>
      entry.id !== editing.entryId &&
      entry.name.toLowerCase() === name.toLowerCase(),
  );
  return duplicated ? '同一位置已存在同名项目' : '';
}

function isEntryWithin(
  session: ProjectSession,
  ancestorId: string,
  entryId: string,
): boolean {
  if (ancestorId === entryId) return true;
  return isSelfOrDescendant(session.tree, ancestorId, entryId);
}

export function ProjectTree({
  session,
  onToggleExpanded,
  onSelect,
  onSetClipboard,
  onOpenFile,
  onCreateEntry,
  onRenameEntry,
  onDeleteEntry,
  onPasteEntry,
  onCopyPath,
  onReveal,
  onAddToChat,
  onNotice,
}: ProjectTreeProps) {
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileTreeEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const editRequestRef = useRef(0);
  const editFocusRef = useRef(0);
  const editBusyRef = useRef(false);
  const deleteRequestRef = useRef(0);
  const mountedRef = useRef(true);
  const focusRequestRef = useRef<string | null>(null);
  const focusSelectedAfterUpdateRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!editing) return;
    const input = editInputRef.current;
    if (!input) return;
    input.focus();
    if (editing.mode === 'create') {
      input.select();
      return;
    }
    const dot = editing.value.lastIndexOf('.');
    if (dot > 0) {
      input.setSelectionRange(0, dot);
    } else {
      input.select();
    }
    // The focus token deliberately drives focus on each new edit session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.focusKey]);

  useEffect(() => {
    const requestedId = focusRequestRef.current;
    if (!requestedId) {
      if (focusSelectedAfterUpdateRef.current && session.selectedId) {
        focusSelectedAfterUpdateRef.current = false;
        rowRefs.current.get(session.selectedId)?.focus();
      }
      return;
    }
    const row = rowRefs.current.get(requestedId);
    if (row) {
      focusRequestRef.current = null;
      row.focus();
    }
  }, [session.selectedId, session.tree]);

  function focusRow(entryId: string) {
    focusRequestRef.current = entryId;
  }

  function focusRowSoon(entryId: string) {
    window.setTimeout(() => {
      rowRefs.current.get(entryId)?.focus();
    }, 0);
  }

  function startCreate(
    parentId: string | null,
    kind: FileTreeEntryKind,
  ) {
    const parent = parentId ? findEntry(session.tree, parentId) : null;
    if (parentId && (!parent || parent.kind !== 'folder')) return;
    if (parentId && !session.expanded[parentId]) {
      onToggleExpanded(parentId);
    }
    editFocusRef.current += 1;
    setEditing({
      mode: 'create',
      kind,
      parentId,
      value: kind === 'folder' ? '新建文件夹' : '新建文件.txt',
      error: '',
      busy: false,
      focusKey: editFocusRef.current,
    });
  }

  function startRename(entry: FileTreeEntry) {
    onSelect(entry.id);
    editFocusRef.current += 1;
    setEditing({
      mode: 'rename',
      kind: entry.kind,
      parentId: parentIdOf(session.tree, entry.id),
      entryId: entry.id,
      value: entry.name,
      error: '',
      busy: false,
      focusKey: editFocusRef.current,
    });
  }

  function cancelEditing() {
    if (editBusyRef.current) return;
    editRequestRef.current += 1;
    setEditing(null);
  }

  function updateEditingValue(value: string) {
    setEditing((current) =>
      current
        ? {
            ...current,
            value,
            error: '',
          }
        : current,
    );
  }

  async function submitEditing() {
    const current = editing;
    if (!current || editBusyRef.current) return;
    const name = current.value.trim();
    const validationError = validateName(session, current, name);
    if (validationError) {
      setEditing({ ...current, error: validationError });
      return;
    }

    editBusyRef.current = true;
    editRequestRef.current += 1;
    const requestId = editRequestRef.current;
    setEditing({ ...current, busy: true, error: '' });

    try {
      const result =
        current.mode === 'create'
          ? await onCreateEntry(current.parentId, current.kind, name)
          : await onRenameEntry(current.entryId as string, name);

      if (!mountedRef.current || requestId !== editRequestRef.current) return;
      editBusyRef.current = false;

      if (!result.ok) {
        setEditing((value) =>
          value
            ? {
                ...value,
                busy: false,
                error: result.message ?? '操作失败，请重试。',
              }
            : value,
        );
        window.setTimeout(() => editInputRef.current?.focus(), 0);
        return;
      }

      setEditing(null);
      if (result.entryId) {
        focusRowSoon(result.entryId);
      } else {
        focusSelectedAfterUpdateRef.current = true;
      }
    } catch {
      if (!mountedRef.current || requestId !== editRequestRef.current) return;
      editBusyRef.current = false;
      setEditing((value) =>
        value
          ? {
              ...value,
              busy: false,
              error: '操作失败，请重试。',
            }
          : value,
      );
      window.setTimeout(() => editInputRef.current?.focus(), 0);
    }
  }

  function editKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitEditing();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelEditing();
    }
  }

  function handleEditBlur() {
    if (editBusyRef.current) return;
    cancelEditing();
  }

  function canPasteInto(targetFolderId: string | null): boolean {
    const clipboard = session.clipboard;
    if (!clipboard || !findEntry(session.tree, clipboard.entryId)) {
      return false;
    }
    if (targetFolderId === null) return true;
    const target = findEntry(session.tree, targetFolderId);
    if (!target || target.kind !== 'folder') return false;
    return !isSelfOrDescendant(
      session.tree,
      clipboard.entryId,
      targetFolderId,
    );
  }

  async function pasteInto(targetFolderId: string | null) {
    const clipboard = session.clipboard;
    if (!clipboard || session.pastePending) return;
    const result = await onPasteEntry(
      targetFolderId,
      clipboard.entryId,
      clipboard.mode,
    );
    if (!mountedRef.current || result.ignored) return;
    if (!result.ok) {
      onNotice(result.message ?? '粘贴失败，请重试。', 'error');
      return;
    }
    if (result.entryId) focusRow(result.entryId);
    if (result.entryId) focusRowSoon(result.entryId);
  }

  function copyEntry(entry: FileTreeEntry, mode: 'cut' | 'copy') {
    onSetClipboard({ mode, entryId: entry.id });
    onNotice(
      mode === 'cut' ? `已剪切「${entry.name}」。` : `已复制「${entry.name}」。`,
    );
  }

  function requestDelete(entry: FileTreeEntry) {
    setDeleteError('');
    setDeleting(false);
    setDeleteTarget(entry);
  }

  async function confirmDelete() {
    const target = deleteTarget;
    if (!target || deleting) return;
    setDeleting(true);
    setDeleteError('');
    deleteRequestRef.current += 1;
    const requestId = deleteRequestRef.current;
    const result = await onDeleteEntry(target.id);
    if (!mountedRef.current || requestId !== deleteRequestRef.current) return;
    setDeleting(false);
    if (!result.ok) {
      setDeleteError(result.message ?? '删除失败，请重试。');
      return;
    }
    setDeleteTarget(null);
    focusSelectedAfterUpdateRef.current = true;
    if (result.entryId) focusRowSoon(result.entryId);
  }

  function closeDeleteDialog() {
    if (deleting) return;
    deleteRequestRef.current += 1;
    setDeleteTarget(null);
    setDeleteError('');
  }

  function closeMenu(restoreFocus: boolean) {
    const current = menu;
    setMenu(null);
    if (!restoreFocus) return;
    if (
      current?.target.type === 'entry' &&
      current.target.entryId
    ) {
      rowRefs.current.get(current.target.entryId)?.focus();
    } else {
      scrollRef.current?.focus();
    }
  }

  function openNodeMenu(
    event: ReactMouseEvent,
    entry: FileTreeEntry,
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (editing) cancelEditing();
    onSelect(entry.id);
    setMenu({
      x: event.clientX,
      y: event.clientY,
      target: { type: 'entry', entryId: entry.id },
    });
  }

  function openRootMenu(event: ReactMouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest('.tree-row') || target.closest('.tree-rename')) return;
    event.preventDefault();
    if (editing) cancelEditing();
    onSelect(null);
    setMenu({
      x: event.clientX,
      y: event.clientY,
      target: { type: 'root' },
    });
  }

  function visibleRows(): HTMLElement[] {
    return Array.from(
      scrollRef.current?.querySelectorAll<HTMLElement>(
        '.tree-row[data-node-id]',
      ) ?? [],
    );
  }

  function focusRowWithKeyboard(row: HTMLElement, entryId: string) {
    onSelect(entryId);
    focusRow(entryId);
    row.focus();
  }

  function handleRowKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
    entry: FileTreeEntry,
  ) {
    if (editing) return;
    const key = event.key;
    const rows = visibleRows();
    const index = rows.indexOf(event.currentTarget);

    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      const next = rows[index + (key === 'ArrowDown' ? 1 : -1)];
      if (next?.dataset.nodeId) {
        focusRowWithKeyboard(next, next.dataset.nodeId);
      }
      return;
    }

    if (key === 'Home' || key === 'End') {
      event.preventDefault();
      const target =
        key === 'Home' ? rows[0] : rows[rows.length - 1];
      if (target?.dataset.nodeId) {
        focusRowWithKeyboard(target, target.dataset.nodeId);
      }
      return;
    }

    if (key === 'ArrowRight' && entry.kind === 'folder') {
      event.preventDefault();
      if (!session.expanded[entry.id]) {
        onToggleExpanded(entry.id);
        return;
      }
      const next = rows[index + 1];
      if (next?.dataset.nodeId) {
        focusRowWithKeyboard(next, next.dataset.nodeId);
      }
      return;
    }

    if (key === 'ArrowLeft' && entry.kind === 'folder') {
      event.preventDefault();
      if (session.expanded[entry.id]) {
        onToggleExpanded(entry.id);
        return;
      }
      const parentId = parentIdOf(session.tree, entry.id);
      if (parentId) {
        const parentRow = rowRefs.current.get(parentId);
        if (parentRow) focusRowWithKeyboard(parentRow, parentId);
      }
      return;
    }

    if (key === 'Enter') {
      event.preventDefault();
      if (entry.kind === 'folder') onToggleExpanded(entry.id);
      else onOpenFile(entry);
      return;
    }

    if (key === 'F2') {
      event.preventDefault();
      startRename(entry);
      return;
    }

    if (key === 'Delete') {
      event.preventDefault();
      requestDelete(entry);
      return;
    }

    if ((event.ctrlKey || event.metaKey) && /^[cCxXvV]$/.test(key)) {
      if (key === 'c' || key === 'C') {
        event.preventDefault();
        copyEntry(entry, 'copy');
      } else if (key === 'x' || key === 'X') {
        event.preventDefault();
        copyEntry(entry, 'cut');
      } else {
        event.preventDefault();
        const targetFolderId =
          entry.kind === 'folder'
            ? entry.id
            : parentIdOf(session.tree, entry.id);
        if (
          !session.pastePending &&
          canPasteInto(targetFolderId)
        ) {
          void pasteInto(targetFolderId);
        }
      }
      return;
    }

    if (key === 'ContextMenu' || (event.shiftKey && key === 'F10')) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      onSelect(entry.id);
      setMenu({
        x: rect.left + 24,
        y: rect.bottom,
        target: { type: 'entry', entryId: entry.id },
      });
    }
  }

  function menuFor(target: MenuState['target']): TreeMenuNode[] {
    if (target.type === 'root') {
      return [
        {
          label: '新建文件',
          onSelect: () => startCreate(null, 'file'),
        },
        {
          label: '新建文件夹',
          onSelect: () => startCreate(null, 'folder'),
        },
        {
          label: '粘贴',
          disabled: session.pastePending || !canPasteInto(null),
          onSelect: () => {
            void pasteInto(null);
          },
        },
        { separator: true },
        {
          label: '复制项目路径',
          onSelect: () => onCopyPath(session.project.path, true),
        },
        {
          label: '在资源管理器中打开',
          onSelect: () => onReveal(session.project.path, true),
        },
      ];
    }

    const entry = findEntry(session.tree, target.entryId);
    if (!entry) return [];
    const copyPathItem: TreeMenuNode = {
      label: '复制路径',
      onSelect: () =>
        onCopyPath(entry.path, entry.kind === 'folder'),
    };
    const revealItem: TreeMenuNode = {
      label: '在资源管理器中显示',
      onSelect: () =>
        onReveal(entry.path, entry.kind === 'folder'),
    };

    if (entry.kind === 'file') {
      return [
        {
          label: '打开',
          onSelect: () => onOpenFile(entry),
        },
        {
          label: '添加到对话',
          disabled: !onAddToChat,
          onSelect: () => onAddToChat?.(entry),
        },
        { separator: true },
        {
          label: '剪切',
          onSelect: () => copyEntry(entry, 'cut'),
        },
        {
          label: '复制',
          onSelect: () => copyEntry(entry, 'copy'),
        },
        { separator: true },
        {
          label: '重命名',
          onSelect: () => startRename(entry),
        },
        {
          label: '删除',
          danger: true,
          onSelect: () => requestDelete(entry),
        },
        { separator: true },
        copyPathItem,
        revealItem,
      ];
    }

    return [
      {
        label: '新建文件',
        onSelect: () => startCreate(entry.id, 'file'),
      },
      {
        label: '新建文件夹',
        onSelect: () => startCreate(entry.id, 'folder'),
      },
      {
        label: '添加到对话',
        disabled: !onAddToChat,
        onSelect: () => onAddToChat?.(entry),
      },
      { separator: true },
      {
        label: '剪切',
        onSelect: () => copyEntry(entry, 'cut'),
      },
      {
        label: '复制',
        onSelect: () => copyEntry(entry, 'copy'),
      },
      {
        label: '粘贴',
        disabled: session.pastePending || !canPasteInto(entry.id),
        onSelect: () => {
          void pasteInto(entry.id);
        },
      },
      { separator: true },
      {
        label: '重命名',
        onSelect: () => startRename(entry),
      },
      {
        label: '删除',
        danger: true,
        onSelect: () => requestDelete(entry),
      },
      { separator: true },
      copyPathItem,
      revealItem,
    ];
  }

  function renderEditInput() {
    return (
      <input
        ref={editInputRef}
        className="tree-rename"
        value={editing?.value ?? ''}
        maxLength={120}
        spellCheck={false}
        autoComplete="off"
        disabled={Boolean(editing?.busy)}
        aria-label={editing?.mode === 'rename' ? '重命名' : '新名称'}
        aria-invalid={editing?.error ? true : undefined}
        onChange={(event) => updateEditingValue(event.target.value)}
        onKeyDown={editKeyDown}
        onBlur={handleEditBlur}
      />
    );
  }

  function renderCreateRow(depth: number) {
    if (!editing || editing.mode !== 'create') return null;
    return (
      <li className="tree-item">
        <div className="tree-row" role="treeitem" aria-level={depth + 1}>
          <span className="tree-arrow-space" aria-hidden="true" />
          <span
            className={
              editing.kind === 'folder' ? 'tree-folder' : 'tree-file'
            }
          >
            {editing.kind === 'folder' ? <FolderIcon /> : <FileIcon />}
          </span>
          {renderEditInput()}
        </div>
        {editing.error ? (
          <p className="tree-hint" role="alert">
            {editing.error}
          </p>
        ) : null}
      </li>
    );
  }

  function renderEntry(entry: FileTreeEntry, depth: number): ReactNode {
    const isFolder = entry.kind === 'folder';
    const expanded = isFolder && Boolean(session.expanded[entry.id]);
    const selected = session.selectedId === entry.id;
    const isRenaming =
      editing?.mode === 'rename' && editing.entryId === entry.id;
    const cut =
      session.clipboard?.mode === 'cut' &&
      isEntryWithin(session, session.clipboard.entryId, entry.id);

    return (
      <li
        className={`tree-item${cut ? ' is-cut' : ''}`}
        key={entry.id}
      >
        <div
          ref={(element) => {
            if (element) rowRefs.current.set(entry.id, element);
            else rowRefs.current.delete(entry.id);
          }}
          className={`tree-row${selected ? ' is-selected' : ''}`}
          role="treeitem"
          data-node-id={entry.id}
          aria-level={depth + 1}
          aria-selected={selected}
          aria-expanded={isFolder ? expanded : undefined}
          tabIndex={selected ? 0 : -1}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            const target = event.target as HTMLElement;
            if (target.closest('.tree-rename')) return;
            if (target.closest('.tree-arrow')) {
              onSelect(entry.id);
              return;
            }
            onSelect(entry.id);
            event.currentTarget.focus();
          }}
          onContextMenu={(event) => openNodeMenu(event, entry)}
          onKeyDown={(event) => handleRowKeyDown(event, entry)}
        >
          {isFolder ? (
            <button
              type="button"
              className="tree-arrow"
              aria-expanded={expanded}
              aria-label={
                (expanded ? '折叠 ' : '展开 ') + entry.name
              }
              title={expanded ? '折叠' : '展开'}
              onClick={(event) => {
                event.stopPropagation();
                onToggleExpanded(entry.id);
              }}
            >
              <TreeArrowIcon />
            </button>
          ) : (
            <span className="tree-arrow-space" aria-hidden="true" />
          )}
          <span
            className={isFolder ? 'tree-folder' : 'tree-file'}
            aria-hidden="true"
          >
            {isFolder ? <FolderIcon /> : <FileIcon />}
          </span>
          {isRenaming ? (
            renderEditInput()
          ) : (
            <button
              type="button"
              className="tree-name"
              title={entry.path}
              aria-label={entry.name}
              onClick={() => onSelect(entry.id)}
              onDoubleClick={() => {
                if (isFolder) onToggleExpanded(entry.id);
                else onOpenFile(entry);
              }}
            >
              <FileName name={entry.name} />
            </button>
          )}
        </div>

        {isRenaming && editing?.error ? (
          <p className="tree-hint" role="alert">
            {editing.error}
          </p>
        ) : null}

        {expanded && (entry.children?.length ||
          (editing?.mode === 'create' && editing.parentId === entry.id)) ? (
          <ul className="tree-children" role="group">
            {(entry.children ?? []).map((child) =>
              renderEntry(child, depth + 1),
            )}
            {editing?.mode === 'create' &&
            editing.parentId === entry.id
              ? renderCreateRow(depth + 1)
              : null}
          </ul>
        ) : null}
      </li>
    );
  }

  const menuItems =
    menu && menuFor(menu.target);

  return (
    <div className="tree-viewport">
      <div
        ref={scrollRef}
        className="tree-scroll"
        tabIndex={-1}
        aria-label="项目目录树"
        onContextMenu={openRootMenu}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const target = event.target as HTMLElement;
          if (
            target.closest('.tree-row') ||
            target.closest('.tree-rename')
          ) {
            return;
          }
          onSelect(null);
        }}
      >
        {session.tree.length === 0 &&
        !(editing?.mode === 'create' && editing.parentId === null) ? (
          <p className="tree-empty">暂无内容</p>
        ) : (
          <ul className="tree" role="tree" aria-label="项目文件夹">
            {session.tree.map((entry) => renderEntry(entry, 0))}
            {editing?.mode === 'create' && editing.parentId === null
              ? renderCreateRow(0)
              : null}
          </ul>
        )}
      </div>

      {menu && menuItems ? (
        <TreeContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={closeMenu}
        />
      ) : null}

      <Modal
        open={deleteTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !deleting) closeDeleteDialog();
        }}
        title="删除确认"
        variant="compact"
        initialFocusRef={deleteCancelRef}
        closeOnOverlayClick={!deleting}
        closeOnEscape={!deleting}
        description={
          deleteTarget
            ? deleteTarget.kind === 'folder'
              ? `将永久删除文件夹「${deleteTarget.name}」及其全部内容，此操作不可撤销。`
              : `将永久删除文件「${deleteTarget.name}」，此操作不可撤销。`
            : ''
        }
        footer={
          <>
            <Button
              ref={deleteCancelRef}
              disabled={deleting}
              onClick={closeDeleteDialog}
            >
              取消
            </Button>
            <Button
              variant="primary"
              disabled={deleting}
              onClick={() => {
                void confirmDelete();
              }}
            >
              {deleting ? '正在删除…' : '删除'}
            </Button>
          </>
        }
      >
        {deleteTarget
          ? dirtyDocumentsUnder(session, deleteTarget.id).length > 0
            ? (
                <>
                  <p className="tree-confirm-note">
                    以下文件的未保存修改将丢失，标签页将关闭：
                  </p>
                  <ul className="tree-confirm-files">
                    {dirtyDocumentsUnder(session, deleteTarget.id).map(
                      (document) => (
                        <li key={document.identity}>{document.name}</li>
                      ),
                    )}
                  </ul>
                </>
              )
            : null
          : null}
        {deleteError ? (
          <p className="modal-error" role="alert">
            {deleteError}
          </p>
        ) : null}
      </Modal>
    </div>
  );
}
