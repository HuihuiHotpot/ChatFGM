import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import type { ChatApproval } from '../../services/capabilities';

export interface ChatApprovalDialogProps {
  open: boolean;
  conversationTitle: string;
  approvals: readonly ChatApproval[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onRespond: (approvalId: string, decision: 'approve' | 'deny') => void;
}

const KIND_LABEL: Record<ChatApproval['kind'], string> = {
  command: '命令执行',
  'file-change': '文件变更',
  permissions: '额外权限',
};

/**
 * Approval review. Closing the dialog (button, overlay or Escape) only
 * suspends the request: it never implies approval or denial. The renderer sends
 * the opaque approval id and a decision, never a modified command or path.
 */
export function ChatApprovalDialog({
  open,
  conversationTitle,
  approvals,
  busy,
  error,
  onClose,
  onRespond,
}: ChatApprovalDialogProps) {
  const [selectedId, setSelectedId] = useState<string>('');
  const laterRef = useRef<HTMLButtonElement>(null);
  const pending = approvals.filter((approval) => approval.status === 'pending');
  const selected =
    pending.find((approval) => approval.id === selectedId) ?? pending[0] ?? null;

  useEffect(() => {
    if (!open) return;
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [open, selected, selectedId]);

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title="审批请求"
      description={`所属对话：${conversationTitle || '当前对话'}`}
      initialFocusRef={laterRef}
      className="chat-approval-dialog"
      footer={
        <>
          <Button
            type="button"
            ref={laterRef}
            onClick={onClose}
            disabled={busy}
            data-testid="approval-later"
          >
            暂不处理
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!selected || busy}
            onClick={() => {
              if (selected) onRespond(selected.id, 'approve');
            }}
            data-testid="approval-approve"
          >
            批准本次
          </Button>
          <Button
            type="button"
            className="chat-approval-deny"
            disabled={!selected || busy}
            onClick={() => {
              if (selected) onRespond(selected.id, 'deny');
            }}
            data-testid="approval-deny"
          >
            拒绝
          </Button>
        </>
      }
    >
      {pending.length > 1 ? (
        <ul className="chat-approval-list" aria-label="待审批请求">
          {pending.map((approval) => (
            <li key={approval.id}>
              <button
                type="button"
                className={`chat-approval-tab${
                  selected?.id === approval.id ? ' is-active' : ''
                }`}
                aria-current={
                  selected?.id === approval.id ? 'true' : undefined
                }
                onClick={() => setSelectedId(approval.id)}
              >
                <span className="chat-approval-tab-kind">
                  {KIND_LABEL[approval.kind]}
                </span>
                <span className="chat-approval-tab-title">
                  {approval.title}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {selected ? (
        <div className="chat-approval-body">
          <dl className="chat-approval-facts">
            <div>
              <dt>操作类型</dt>
              <dd>{KIND_LABEL[selected.kind]}</dd>
            </div>
            {selected.command ? (
              <div>
                <dt>命令</dt>
                <dd>
                  <pre className="chat-approval-command">
                    {selected.command}
                  </pre>
                </dd>
              </div>
            ) : null}
            {selected.permissions ? (
              <>
                <div>
                  <dt>读取范围</dt>
                  <dd>
                    {selected.permissions.readPaths.length > 0 ? (
                      <ul className="chat-approval-paths">
                        {selected.permissions.readPaths.map((pathValue) => (
                          <li key={`read-${pathValue}`}>{pathValue}</li>
                        ))}
                      </ul>
                    ) : (
                      <span className="chat-approval-none">无</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>写入范围</dt>
                  <dd>
                    {selected.permissions.writePaths.length > 0 ? (
                      <ul className="chat-approval-paths">
                        {selected.permissions.writePaths.map((pathValue) => (
                          <li key={`write-${pathValue}`}>{pathValue}</li>
                        ))}
                      </ul>
                    ) : (
                      <span className="chat-approval-none">无</span>
                    )}
                  </dd>
                </div>
                {selected.permissions.denyPaths.length > 0 ? (
                  <div>
                    <dt>禁止访问</dt>
                    <dd>
                      <ul className="chat-approval-paths">
                        {selected.permissions.denyPaths.map((pathValue) => (
                          <li key={`deny-${pathValue}`}>{pathValue}</li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>网络访问</dt>
                  <dd>
                    {selected.permissions.network
                      ? `允许${
                          selected.permissions.networkTargets.length > 0
                            ? `（${selected.permissions.networkTargets
                                .map((target) =>
                                  target.protocol
                                    ? `${target.host} · ${target.protocol}`
                                    : target.host,
                                )
                                .join('、')}）`
                            : ''
                        }`
                      : '不增加网络权限'}
                  </dd>
                </div>
                <div>
                  <dt>授权范围</dt>
                  <dd>
                    {selected.permissions.scope === 'command'
                      ? '仅本次命令'
                      : '仅本轮对话'}
                  </dd>
                </div>
              </>
            ) : null}
            {selected.paths?.length && !selected.permissions ? (
              <div>
                <dt>路径</dt>
                <dd>
                  <ul className="chat-approval-paths">
                    {selected.paths.map((pathValue) => (
                      <li key={pathValue}>{pathValue}</li>
                    ))}
                  </ul>
                </dd>
              </div>
            ) : null}
            {selected.cwd ? (
              <div>
                <dt>工作目录</dt>
                <dd>{selected.cwd}</dd>
              </div>
            ) : null}
            {selected.reason ? (
              <div>
                <dt>原因</dt>
                <dd>{selected.reason}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : (
        <p className="chat-approval-hint">暂无待审批请求</p>
      )}
      {error ? (
        <p className="chat-inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
