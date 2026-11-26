import { useRef } from 'react';
import type { OpenDocument } from '../../state/workspace';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import './TabCloseDialog.css';

export interface TabCloseDialogProps {
  open: boolean;
  document: OpenDocument | null;
  saving: boolean;
  error: string;
  returnFocusTarget?: HTMLElement | null;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}

export function TabCloseDialog({
  open,
  document,
  saving,
  error,
  returnFocusTarget,
  onCancel,
  onDiscard,
  onSave,
}: TabCloseDialogProps) {
  const saveRef = useRef<HTMLButtonElement>(null);

  return (
    <Modal
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !saving) onCancel();
      }}
      title="关闭文件"
      description={
        document
          ? `「${document.name}」有未保存的修改。不保存将丢弃这些修改。`
          : ''
      }
      initialFocusRef={saveRef}
      returnFocusTarget={returnFocusTarget}
      closeOnOverlayClick={!saving}
      closeOnEscape={!saving}
      className="tab-close-dialog"
      footer={
        <>
          <Button disabled={saving} onClick={onCancel}>
            取消
          </Button>
          <Button disabled={saving} onClick={onDiscard}>
            不保存并关闭
          </Button>
          <Button
            ref={saveRef}
            variant="primary"
            disabled={saving}
            onClick={onSave}
          >
            {saving ? '正在保存…' : '保存并关闭'}
          </Button>
        </>
      }
    >
      {error ? (
        <p className="modal-error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
