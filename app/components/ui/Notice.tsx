import './Notice.css';

export type NoticeTone = 'neutral' | 'success' | 'error' | 'stopped';

export interface NoticeProps {
  message: string;
  tone?: NoticeTone;
  name?: string;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  className?: string;
}

export function Notice({
  message,
  tone = 'neutral',
  name,
  actionLabel,
  onAction,
  actionDisabled,
  className,
}: NoticeProps) {
  const classes = ['app-notice', className].filter(Boolean).join(' ');
  const hasAction = Boolean(actionLabel && onAction);
  return (
    <div
      className={classes}
      data-tone={tone}
      role="status"
      aria-live="polite"
    >
      <span className="app-notice-dot" aria-hidden="true" />
      {name ? (
        <>
          <span className="app-notice-name" title={name}>
            {name}
          </span>
          <span className="app-notice-sep" aria-hidden="true">
            ·
          </span>
        </>
      ) : null}
      <span className="app-notice-text">{message}</span>
      {hasAction ? (
        <button
          type="button"
          className="app-notice-action"
          disabled={actionDisabled}
          title={actionDisabled ? '请先关闭当前弹窗' : actionLabel}
          onClick={onAction}
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
