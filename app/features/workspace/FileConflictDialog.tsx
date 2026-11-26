import { useRef } from 'react';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';

export interface FileConflictDialogProps {
  open: boolean;
  fileName: string;
  message: string;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onReload: () => void;
  onOverwrite: () => void;
}

/**
 * External-save conflict. Closing or cancelling keeps the editor content and
 * undo state. Overwriting is only confirmed for the version displayed when the
 * conflict was detected; a further disk change conflicts again.
 */
export function FileConflictDialog({
  open,
  fileName,
  message,
  busy,
  error,
  onCancel,
  onReload,
  onOverwrite,
}: FileConflictDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
      title="文件冲突"
      description={message}
      initialFocusRef={cancelRef}
      footer={
        <>
          <Button ref={cancelRef} type="button" onClick={onCancel} disabled={busy}>
            取消并保留编辑
          </Button>
          <Button type="button" onClick={onReload} disabled={busy}>
            重新载入磁盘
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy}
            onClick={onOverwrite}
            data-testid="conflict-overwrite"
          >
            覆盖保存
          </Button>
        </>
      }
    >
      <div className="file-conflict">
        <p>
          重新载入会丢弃 <strong>{fileName}</strong> 的未保存编辑。覆盖保存会替换磁盘内容。
        </p>
        {error ? (
          <p className="chat-inline-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
