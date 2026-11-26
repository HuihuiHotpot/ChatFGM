import { useLayoutEffect, useRef } from 'react';
import {
  invalidProjectCreationFolder,
  PROJECT_PATH_HAN_ERROR,
} from '../../../backend/ipc/project-creation-path';
import type { FolderSelection, ToolboxOption } from '../../services/capabilities';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import './NewProjectDialog.css';

export interface ProjectRebuildConfirmationView {
  mode: 'overwrite' | 'recreate';
  existingProjectIds: readonly string[];
}

export interface NewProjectDialogProps {
  open: boolean;
  folder: FolderSelection | null;
  folderPath?: string;
  toolboxes: readonly ToolboxOption[];
  selectedToolboxId: string | null;
  toolboxesLoading: boolean;
  toolboxesError: string;
  pickingFolder: boolean;
  submitting: boolean;
  error: string;
  rebuildConfirmation?: ProjectRebuildConfirmationView | null;
  onConfirmRebuild: () => void;
  returnFocusTarget?: HTMLElement | null;
  onClose: () => void;
  onBrowse: () => void;
  onToolboxChange: (toolboxId: string) => void;
  onCreate: () => void;
}

export function NewProjectDialog({
  open,
  folder,
  folderPath,
  toolboxes,
  selectedToolboxId,
  toolboxesLoading,
  toolboxesError,
  pickingFolder,
  submitting,
  error,
  rebuildConfirmation,
  onConfirmRebuild,
  returnFocusTarget,
  onClose,
  onBrowse,
  onToolboxChange,
  onCreate,
}: NewProjectDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const busy = pickingFolder || submitting;
  const invalidPath = invalidProjectCreationFolder(folder);
  const noToolboxes =
    !toolboxesLoading && !toolboxesError && toolboxes.length === 0;
  const canCreate =
    !busy &&
    !toolboxesLoading &&
    !toolboxesError &&
    toolboxes.length > 0 &&
    Boolean(selectedToolboxId) &&
    Boolean(folder) &&
    !invalidPath;
  const selectedToolbox =
    toolboxes.find((toolbox) => toolbox.id === selectedToolboxId) ?? null;
  const targetPath = folderPath ?? folder?.path ?? '';
  const hasExistingProject =
    (folder?.existingProjectIds?.length ?? 0) > 0 ||
    Boolean(folder?.existingProjectId);
  const isNonEmpty = folder?.directoryEmpty === false;
  const confirming = rebuildConfirmation ?? null;
  const isConfirming = confirming !== null;

  useLayoutEffect(() => {
    if (open && isConfirming) cancelRef.current?.focus();
  }, [open, isConfirming]);

  return (
    <Modal
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onClose();
      }}
      title={
        confirming
          ? confirming.mode === 'recreate'
            ? '重新创建项目'
            : '覆盖并新建项目'
          : '新建项目'
      }
      initialFocusRef={isConfirming ? cancelRef : undefined}
      returnFocusTarget={returnFocusTarget}
      closeOnOverlayClick={!busy}
      closeOnEscape={!busy}
      className="new-project-dialog"
      footer={
        <>
          <Button ref={cancelRef} disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={!canCreate}
            onClick={confirming ? onConfirmRebuild : onCreate}
          >
            {submitting
              ? '正在创建…'
              : confirming
                ? confirming.mode === 'recreate'
                  ? '重新创建'
                  : '覆盖并创建'
                : '创建项目'}
          </Button>
        </>
      }
    >
      {confirming ? (
        <>
          <p className="modal-target-path">{targetPath}</p>
          {confirming.mode === 'overwrite' ? (
            <p className="modal-hint">
              将删除文件夹中的全部旧内容，并用
              {selectedToolbox ? `「${selectedToolbox.label}」` : '所选 Flamelet 类型'}
              重建项目。
            </p>
          ) : null}
          {confirming.existingProjectIds.length > 0 ? (
            <p className="modal-hint">
              将清除旧项目的对话、草稿和恢复状态。
            </p>
          ) : null}
          <p className="modal-hint modal-overwrite-hint">此操作不可撤销。</p>
          {error ? (
            <p className="modal-error" role="alert">
              {error}
            </p>
          ) : null}
        </>
      ) : <>
      <div className="modal-field">
        <label className="modal-label" htmlFor="project-toolbox">
          Flamelet 类型
        </label>
        {toolboxesLoading ? (
          <select
            className="form-select"
            id="project-toolbox"
            disabled
            value=""
            onChange={() => undefined}
          >
            <option value="">正在加载 Flamelet 工具箱…</option>
          </select>
        ) : toolboxes.length > 0 ? (
          <select
            className="form-select"
            id="project-toolbox"
            value={selectedToolboxId ?? ''}
            disabled={busy}
            onChange={(event) => onToolboxChange(event.target.value)}
          >
            {toolboxes.map((toolbox) => (
              <option
                key={toolbox.id}
                value={toolbox.id}
                disabled={Boolean(toolbox.error)}
                title={toolbox.error}
              >
                {toolbox.error
                  ? `${toolbox.label}（不可用：${toolbox.error}）`
                  : toolbox.label}
              </option>
            ))}
          </select>
        ) : null}
        {noToolboxes ? (
          <p className="modal-hint">未发现可用的 Flamelet 工具箱</p>
        ) : null}
        {toolboxesError ? (
          <p className="modal-error" role="alert">
            {toolboxesError}
          </p>
        ) : null}
      </div>

      <div className="modal-field">
        <label className="modal-label" htmlFor="project-path">
          项目文件夹
        </label>
        <div className="modal-path-row">
          <input
            className="form-input"
            id="project-path"
            type="text"
            value={folder?.path ?? ''}
            placeholder="选择项目文件夹"
            readOnly
            spellCheck={false}
            autoComplete="off"
            aria-invalid={invalidPath || undefined}
            aria-describedby={invalidPath ? 'project-path-error' : undefined}
          />
          <Button
            disabled={busy || toolboxesLoading || toolboxes.length === 0}
            onClick={onBrowse}
          >
            {pickingFolder ? '正在选择…' : '浏览'}
          </Button>
        </div>
        {invalidPath ? (
          <p id="project-path-error" className="modal-error" role="alert">
            {PROJECT_PATH_HAN_ERROR.message}
          </p>
        ) : isNonEmpty || hasExistingProject ? (
          <p className="modal-hint modal-overwrite-hint">
            {isNonEmpty
              ? hasExistingProject
                ? '覆盖将删除文件夹中的全部旧内容，并清除旧项目的对话、草稿和恢复状态。'
                : '覆盖将删除文件夹中的全部旧内容。'
              : '重新创建将清除旧项目的对话、草稿和恢复状态。'}
          </p>
        ) : null}
      </div>

      {error ? (
        <p className="modal-error" role="alert">
          {error}
        </p>
      ) : null}
      </>}
    </Modal>
  );
}
