import type {
  ChatMessage,
  ChatReference,
  ChatRun,
  ChatStep,
  ChatToolCall,
} from '../../services/capabilities';
import {
  chatRunStatusLabel,
  hasTaskExecution,
  isTerminalRun,
} from './chat-state';
import { ChatMarkdown } from './ChatMarkdown';
import {
  ChevronIcon,
  CopyIcon,
  FileRefIcon,
  FolderRefIcon,
} from './ChatIcons';

function stepStateLabel(status: ChatStep['status']): string {
  switch (status) {
    case 'running':
      return '进行中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'stopped':
      return '已停止';
    default:
      return '待开始';
  }
}

function toolStateLabel(status: ChatToolCall['status']): string {
  switch (status) {
    case 'running':
      return '进行中';
    case 'completed':
      return '成功';
    case 'failed':
      return '失败';
    default:
      return '待核实';
  }
}

function runLabel(run: ChatRun, waitingApproval?: boolean): string {
  if (waitingApproval && run.status === 'running') return '等待审批';
  if (run.summary) return run.summary;
  if (run.status === 'running') {
    const active = run.steps?.find((step) => step.status === 'running');
    return active ? `正在执行 · ${active.title}` : '正在处理…';
  }
  if (run.status === 'completed') {
    if (run.steps?.length) {
      const done = run.steps.filter(
        (step) => step.status === 'completed',
      ).length;
      return `已完成 · ${done} / ${run.steps.length} 个步骤`;
    }
    return '已完成';
  }
  if (run.status === 'failed') return '执行失败';
  if (run.status === 'stopped') return '已停止';
  return '状态待核实';
}

function referenceIcon(reference: ChatReference) {
  if (reference.kind === 'folder') return <FolderRefIcon />;
  return <FileRefIcon />;
}

export function ReferenceChips({
  references,
  removable,
  onRemove,
  className = '',
}: {
  references: readonly ChatReference[];
  removable?: boolean;
  onRemove?: (reference: ChatReference) => void;
  className?: string;
}) {
  if (references.length === 0) return null;
  return (
    <div
      className={`chat-refs ${className}`.trim()}
      aria-label="对话引用"
    >
      {references.map((reference) => {
        const image =
          reference.kind === 'attachment' &&
          reference.preview?.url &&
          reference.mime?.startsWith('image/');
        const invalid = Boolean(reference.invalid);
        return (
          <span
            key={reference.id}
            className={`chat-ref${
              invalid ? ' is-invalid' : ''
            }${image ? ' chat-ref--image' : ''}`}
            title={`${reference.displayPath}${
              invalid ? '（文件已删除）' : ''
            }`}
          >
            {image ? (
              <img
                className="chat-ref-thumb"
                src={reference.preview?.url}
                alt={reference.name}
                loading="lazy"
              />
            ) : (
              <span className="chat-ref-icon" aria-hidden="true">
                {referenceIcon(reference)}
              </span>
            )}
            <span className="chat-ref-name">{reference.name}</span>
            {removable ? (
              <button
                type="button"
                className="chat-ref-remove"
                aria-label={`移除引用 ${reference.name}`}
                title="移除引用"
                onClick={() => onRemove?.(reference)}
              >
                <span aria-hidden="true">×</span>
              </button>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

function ToolList({ tools }: { tools: readonly ChatToolCall[] }) {
  if (tools.length === 0) return null;
  return (
    <div className="chat-trace-section">
      <p className="chat-trace-heading">工具调用</p>
      <ul className="chat-trace-list">
        {tools.map((tool) => (
          <li
            key={tool.id}
            className={`chat-trace-item is-${tool.status}`}
            data-tool-status={tool.status}
          >
            <span className="chat-trace-mark" aria-hidden="true" />
            <div className="chat-trace-main">
              <span className="chat-trace-title">{tool.name}</span>
              {tool.summary ? (
                <span className="chat-trace-summary">
                  {tool.summary}
                </span>
              ) : null}
              <span className="chat-trace-state">
                {toolStateLabel(tool.status)}
                {typeof tool.exitCode === 'number'
                  ? ` · 退出码 ${tool.exitCode}`
                  : ''}
              </span>
            </div>
            {tool.detail ? (
              <details className="chat-trace-detail">
                <summary>查看详情</summary>
                <pre>{tool.detail}</pre>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function StepList({ steps }: { steps: readonly ChatStep[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="chat-trace-section">
      <p className="chat-trace-heading">步骤</p>
      <ol className="chat-trace-list chat-step-list">
        {steps.map((step) => (
          <li
            key={step.id}
            className={`chat-trace-item is-${step.status}`}
            data-step-status={step.status}
          >
            <span className="chat-trace-mark" aria-hidden="true" />
            <div className="chat-trace-main">
              <span className="chat-trace-title">{step.title}</span>
              <span className="chat-trace-state">
                {stepStateLabel(step.status)}
              </span>
            </div>
            {step.detail ? (
              <p className="chat-trace-detail-text">{step.detail}</p>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function hasRunTrace(run: ChatRun): boolean {
  return (
    Boolean(run.tools?.length) ||
    Boolean(run.steps?.length) ||
    run.task === true ||
    Boolean(run.summary)
  );
}

export function RunTrace({
  run,
  expanded,
  onToggle,
  waitingApproval,
}: {
  run: ChatRun;
  expanded: boolean;
  onToggle: () => void;
  waitingApproval?: boolean;
}) {
  if (!hasRunTrace(run)) return null;
  const running = run.status === 'running';
  return (
    <div className={`msg-trace${expanded ? ' is-open' : ''}`}>
      <button
        type="button"
        className="trace-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span
          className="trace-spinner"
          aria-hidden="true"
          hidden={!running}
        />
        <span className="trace-label">
          {runLabel(run, waitingApproval)}
        </span>
        <ChevronIcon />
      </button>
      {expanded ? (
        <div className="trace-body">
          {run.steps?.length ? <StepList steps={run.steps} /> : null}
          {run.tools?.length ? <ToolList tools={run.tools} /> : null}
          <p className="chat-run-settings">
            本轮设置 ·{' '}
            {run.settings.serviceName ?? run.settings.serviceId}
            {' · '}
            {run.settings.modelLabel ?? run.settings.modelId}
            {run.settings.effortLabel
              ? ` · ${run.settings.effortLabel}`
              : ''}
            {` · ${run.settings.permissionLabel ?? run.settings.permissionId}`}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function runStatusText(
  run: ChatRun,
  waitingApproval?: boolean,
): string | null {
  if (waitingApproval && run.status === 'running') return '等待审批';
  if (run.status === 'failed') return '执行失败';
  if (run.status === 'stopped') return '已停止';
  if (run.status === 'unknown') return '执行状态待核实';
  if (run.status === 'running') return '正在生成回复…';
  return null;
}

export interface ChatMessageViewProps {
  message: ChatMessage;
  run: ChatRun | null;
  expanded: boolean;
  waitingApproval?: boolean;
  /** A run owns one trace; only its first rendered message may show it. */
  showRunTrace?: boolean;
  /** Only the last message of a run may show the run's terminal status. */
  showRunStatus?: boolean;
  onToggleRun: () => void;
  onCopy: (text: string) => void;
  onOpenProjectFile: (href: string) => void;
}

export function ChatMessageView({
  message,
  run,
  expanded,
  waitingApproval,
  showRunTrace = true,
  showRunStatus = true,
  onToggleRun,
  onCopy,
  onOpenProjectFile,
}: ChatMessageViewProps) {
  if (message.role === 'user') {
    return (
      <div className="msg-user">
        <div className="msg-bubble">
          {message.references?.length ? (
            <ReferenceChips
              references={message.references}
              className="msg-refs"
            />
          ) : null}
          {message.text ? (
            <span className="msg-text">{message.text}</span>
          ) : null}
        </div>
      </div>
    );
  }

  const statusText = run ? runStatusText(run, waitingApproval) : null;
  const fallbackStatus =
    showRunStatus
      ? statusText ??
        (run?.status === 'completed' ? '已完成' : null)
      : null;
  const showTrailingStatus =
    showRunStatus &&
    !!run &&
    !!message.text &&
    !hasTaskExecution(run) &&
    !!statusText;
  return (
    <article
      className="msg-agent"
      aria-busy={
        run?.status === 'running' && !message.text
          ? 'true'
          : undefined
      }
      data-message-id={message.id}
      data-run-status={run?.status}
    >
      {run && showRunTrace ? (
        <RunTrace
          run={run}
          expanded={expanded}
          onToggle={onToggleRun}
          waitingApproval={waitingApproval}
        />
      ) : null}
      {message.text ? (
        message.format === 'markdown' ? (
          <ChatMarkdown
            source={message.text}
            onOpenProjectFile={onOpenProjectFile}
          />
        ) : (
          <div className="msg-text msg-text--agent">{message.text}</div>
        )
      ) : fallbackStatus ? (
        <p className="msg-pending">
          {run?.status === 'running' ? (
            <span className="trace-spinner" aria-hidden="true" />
          ) : null}
          <span>{fallbackStatus}</span>
        </p>
      ) : null}
      {showTrailingStatus ? (
        <p className="msg-run-state">{statusText}</p>
      ) : null}
      {message.text ? (
        <div className="msg-actions">
          <button
            type="button"
            className="msg-copy"
            title="复制回复"
            aria-label="复制回复"
            onClick={() => onCopy(message.text)}
          >
            <CopyIcon />
            <span>复制</span>
          </button>
        </div>
      ) : null}
    </article>
  );
}

export function PendingAgent({
  run,
  expanded,
  waitingApproval,
  onToggle,
}: {
  run: ChatRun;
  expanded: boolean;
  waitingApproval?: boolean;
  onToggle: () => void;
}) {
  return (
    <article
      className="msg-agent"
      aria-busy={run.status === 'running' ? 'true' : undefined}
      aria-label="正在生成的回复"
      data-run-status={run.status}
    >
      <RunTrace
        run={run}
        expanded={expanded}
        onToggle={onToggle}
        waitingApproval={waitingApproval}
      />
      {run.status === 'running' && hasRunTrace(run) ? null : waitingApproval &&
        run.status === 'running' ? (
        <p className="msg-pending">
          <span className="trace-spinner" aria-hidden="true" />
          <span>等待审批…</span>
        </p>
      ) : run.status === 'running' ? (
        <p className="msg-pending">
          <span className="trace-spinner" aria-hidden="true" />
          <span>正在生成回复…</span>
        </p>
      ) : (
        <p className="msg-run-state">
          {run.status === 'unknown'
            ? chatRunStatusLabel(run.status)
            : run.status === 'completed'
              ? '已完成'
              : isTerminalRun(run.status)
                ? chatRunStatusLabel(run.status)
                : '状态续传中…'}
        </p>
      )}
    </article>
  );
}
