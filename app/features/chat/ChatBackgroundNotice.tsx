import { Notice } from '../../components/ui/Notice';
import type { NoticeTone } from '../../components/ui/Notice';

export interface ChatBackgroundNoticeState {
  projectId: string;
  conversationId: string;
  title: string;
  message: string;
  tone: NoticeTone;
}

export interface ChatBackgroundNoticeProps {
  notice: ChatBackgroundNoticeState;
  blocked: boolean;
  onView: () => void;
}

export function ChatBackgroundNotice({
  notice,
  blocked,
  onView,
}: ChatBackgroundNoticeProps) {
  return (
    <div
      className="chat-notification-wrap"
      data-conversation-id={notice.conversationId}
      data-project-id={notice.projectId}
    >
      <Notice
        className="chat-background-notice"
        name={notice.title}
        message={notice.message}
        tone={notice.tone}
        actionLabel="查看"
        actionDisabled={blocked}
        onAction={onView}
      />
    </div>
  );
}
