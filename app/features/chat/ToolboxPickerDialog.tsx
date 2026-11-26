import { useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import type { ToolboxOption } from '../../services/capabilities';

export interface ToolboxPickerDialogProps {
  open: boolean;
  loading: boolean;
  error: string;
  toolboxes: readonly ToolboxOption[];
  busy: boolean;
  onClose: () => void;
  onBind: (toolboxId: string) => void;
}

/**
 * Minimal toolbox chooser for an unbound project. It only stores the selected
 * folder type; it never initializes standardCase or overwrites project files.
 */
export function ToolboxPickerDialog({
  open,
  loading,
  error,
  toolboxes,
  busy,
  onClose,
  onBind,
}: ToolboxPickerDialogProps) {
  const [selected, setSelected] = useState('');
  const firstRef = useRef<HTMLButtonElement>(null);
  const usable = toolboxes.filter((toolbox) => !toolbox.error);
  const current =
    usable.find((toolbox) => toolbox.id === selected) ?? usable[0] ?? null;
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title="选择 Flamelet 工具箱"
      initialFocusRef={firstRef}
      footer={
        <>
          <Button type="button" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!current || busy}
            onClick={() => {
              if (current) onBind(current.id);
            }}
            data-testid="bind-toolbox"
          >
            {busy ? '正在绑定…' : '绑定'}
          </Button>
        </>
      }
    >
      <div className="toolbox-picker">
        {loading ? (
          <p className="chat-loading" role="status">
            正在扫描工具箱…
          </p>
        ) : null}
        {error ? (
          <p className="chat-inline-error" role="alert">
            {error}
          </p>
        ) : null}
        {!loading && toolboxes.length === 0 ? (
          <p className="chat-empty-hint">
            toolboxes/ 下暂无工具箱。
          </p>
        ) : null}
        <ul className="toolbox-picker-list">
          {toolboxes.map((toolbox, index) => {
            const active = current?.id === toolbox.id;
            return (
              <li key={toolbox.id}>
                <button
                  ref={index === 0 ? firstRef : undefined}
                  type="button"
                  className={`toolbox-picker-item${
                    active ? ' is-active' : ''
                  }`}
                  aria-pressed={active}
                  disabled={Boolean(toolbox.error)}
                  title={toolbox.error}
                  onClick={() => setSelected(toolbox.id)}
                >
                  <span className="toolbox-picker-name">{toolbox.label}</span>
                  {toolbox.error ? (
                    <span className="toolbox-picker-error">
                      {toolbox.error}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}
