import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';

export interface SaveAsDialogProps {
  open: boolean;
  originalName: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (name: string) => void;
}

/**
 * Preserves a document whose original file was deleted or cannot be identified
 * after an external rename. It always writes a new file in the project root and
 * never overwrites an existing file.
 */
export function SaveAsDialog({
  open,
  originalName,
  busy,
  error,
  onClose,
  onSave,
}: SaveAsDialogProps) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const base = originalName.replace(/\.[^.]*$/, '');
    const extension = originalName.match(/\.[^.]*$/)?.[0] ?? '.txt';
    setName(`${base}-恢复${extension}`.slice(0, 120));
  }, [open, originalName]);
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title="另存恢复内容"
      description="原文件不可用。当前内容将另存到项目根目录。"
      initialFocusRef={inputRef}
      footer={
        <>
          <Button type="button" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy || name.trim().length === 0}
            onClick={() => onSave(name.trim())}
          >
            {busy ? '正在保存…' : '保存副本'}
          </Button>
        </>
      }
    >
      <label className="save-as-field">
        <span>文件名</span>
        <input
          ref={inputRef}
          type="text"
          value={name}
          maxLength={120}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {error ? (
        <p className="chat-inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
