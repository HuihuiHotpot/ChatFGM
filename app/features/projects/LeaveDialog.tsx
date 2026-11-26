import { useRef } from 'react';
import type { ReactNode } from 'react';
import type { RunningTask } from '../../services/capabilities';
import type { OpenDocument } from '../../state/workspace';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import './LeaveDialog.css';

export type LeavePurpose = 'close' | 'open' | 'create' | 'quit';
export type LeaveBusyKind =
  | 'saving'
  | 'stopping'
  | 'opening'
  | 'creating';

export interface LeaveDialogProps {
  open: boolean;
  purpose: LeavePurpose;
  projectName: string;
  targetName?: string;
  unsavedDocuments: readonly OpenDocument[];
  tasks: readonly RunningTask[];
  tasksStatus: 'loading' | 'ready' | 'error';
  tasksError: string;
  /** The registered project directory was removed outside ChatFGM. */
  directoryMissing: boolean;
  directoryPath: string;
  /** Visible reason when the directory exists but cannot be read. */
  directoryMessage: string;
  busyKind: LeaveBusyKind | null;
  error: string;
  progress: string;
  returnFocusTarget?: HTMLElement | null;
  onCancel: () => void;
  onStopTasks: () => void;
  onSaveAndContinue: () => void;
  onDiscardAndContinue: () => void;
  onContinue: () => void;
}

export function LeaveDialog({
  open,
  purpose,
  projectName,
  targetName,
  unsavedDocuments,
  tasks,
  tasksStatus,
  tasksError,
  directoryMissing,
  directoryPath,
  directoryMessage,
  busyKind,
  error,
  progress,
  returnFocusTarget,
  onCancel,
  onStopTasks,
  onSaveAndContinue,
  onDiscardAndContinue,
  onContinue,
}: LeaveDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const busy = busyKind !== null;
  const tasksKnown = tasksStatus === 'ready';
  const hasRunningTasks = tasks.length > 0;
  const blockedByTasks = !tasksKnown || hasRunningTasks;
  const hasUnsaved = unsavedDocuments.length > 0;
  const canCancel = !busy;

  let message: ReactNode;
  if (purpose === 'quit') {
    message = projectName ? (
      <>
        将关闭项目 <strong>{projectName}</strong>。
      </>
    ) : (
      <>即将退出 ChatFGM。</>
    );
  } else if (purpose === 'close') {
    message = (
      <>
        将关闭项目 <strong>{projectName}</strong>。
      </>
    );
  } else if (purpose === 'open') {
    message = (
      <>
        打开 <strong>{targetName ?? ''}</strong> 将关闭当前项目{' '}
        <strong>{projectName}</strong>。
      </>
    );
  } else {
    message = (
      <>
        新建项目将关闭 <strong>{projectName}</strong>。
      </>
    );
  }

  const isQuit = purpose === 'quit';
  return (
    <Modal
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && canCancel) onCancel();
      }}
      title={isQuit ? '退出 ChatFGM' : '离开当前项目'}
      description={message}
      initialFocusRef={cancelRef}
      returnFocusTarget={returnFocusTarget}
      closeOnOverlayClick={canCancel}
      closeOnEscape={canCancel}
      className="leave-dialog"
      footer={
        <>
          <Button ref={cancelRef} disabled={!canCancel} onClick={onCancel}>
            取消
          </Button>
          {hasUnsaved ? (
            directoryMissing ? (
              <Button
                variant="primary"
                disabled={busy || blockedByTasks}
                onClick={onDiscardAndContinue}
              >
                {isQuit ? '不保存并退出' : '不保存并继续'}
              </Button>
            ) : (
              <>
                <Button
                  disabled={busy || blockedByTasks}
                  onClick={onDiscardAndContinue}
                >
                  {isQuit ? '不保存并退出' : '不保存并继续'}
                </Button>
                <Button
                  variant="primary"
                  disabled={busy || blockedByTasks}
                  onClick={onSaveAndContinue}
                >
                  {isQuit ? '保存并退出' : '保存并继续'}
                </Button>
              </>
            )
          ) : (
            <Button
              variant="primary"
              disabled={busy || blockedByTasks}
              onClick={onContinue}
            >
              {isQuit ? '退出' : '继续'}
            </Button>
          )}
        </>
      }
    >
      {hasUnsaved ? (
        <section className="leave-section" aria-labelledby="leave-unsaved-title">
          <h3 className="leave-section-title" id="leave-unsaved-title">
            未保存的文件
          </h3>
          <ul className="leave-list">
            {unsavedDocuments.map((document) => (
              <li key={document.identity}>
                {document.name}
                <span className="leave-list-meta">{document.path}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {directoryMissing ? (
        <section
          className="leave-section leave-directory-missing"
          aria-labelledby="leave-directory-title"
        >
          <h3 className="leave-section-title" id="leave-directory-title">
            项目目录已删除
          </h3>
          <p className="leave-section-hint">
            <strong>{directoryPath}</strong> 已不存在，无法保存文件。
          </p>
          {hasUnsaved ? (
            <p className="leave-section-hint leave-directory-warning">
              继续{isQuit ? '退出' : '关闭'}将丢弃上述未保存的修改。
            </p>
          ) : null}
        </section>
      ) : null}

      {!directoryMissing && directoryMessage ? (
        <p className="modal-error" role="alert">
          {directoryMessage}
        </p>
      ) : null}

      {tasksStatus !== 'ready' || hasRunningTasks || tasksError ? (
        <section className="leave-section" aria-labelledby="leave-running-title">
          <h3 className="leave-section-title" id="leave-running-title">
            运行中的任务
          </h3>
          {tasksStatus === 'loading' ? (
            <p className="leave-section-hint">正在同步运行中的任务…</p>
          ) : null}
          {tasksStatus === 'error' ? (
            <p className="modal-error" role="alert">
              {tasksError || '无法获取运行中的任务状态。'}
            </p>
          ) : null}
          {hasRunningTasks ? (
            <>
              <p className="leave-section-hint">
                停止以下任务后才能继续。
              </p>
              <ul className="leave-list">
                {tasks.map((task) => (
                  <li key={task.id}>
                    {task.title}
                    <span className="leave-list-meta">
                      {task.status ?? '运行中'}
                    </span>
                  </li>
                ))}
              </ul>
              <Button
                className="leave-stop"
                disabled={busy || tasksStatus !== 'ready'}
                onClick={onStopTasks}
              >
                {busyKind === 'stopping' ? '正在停止…' : '停止任务'}
              </Button>
            </>
          ) : null}
        </section>
      ) : null}

      {error ? (
        <p className="modal-error" role="alert">
          {error}
        </p>
      ) : null}

      {progress ? (
        <p className="leave-progress" role="status">
          {progress}
        </p>
      ) : null}

      {hasUnsaved && !directoryMissing ? (
        <p className="leave-section-hint">不保存将丢弃这些修改。</p>
      ) : null}
    </Modal>
  );
}
