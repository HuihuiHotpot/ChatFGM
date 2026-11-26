import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { IconButton } from '../../components/ui/IconButton';
import {
  HistoryIcon,
  NewChatIcon,
} from '../../components/ui/icons';
import type {
  ChatCapabilityContext,
  ChatConversationSettings,
  ChatConversationUiState,
  ChatReference,
} from '../../services/capabilities';
import type {
  ChatConversationState,
  ChatLoadStatus,
  ChatProjectState,
} from './chat-state';
import {
  activeChatConversation,
  activeRunForConversation,
  latestRunForConversation,
} from './chat-state';
import { ChatComposer } from './ChatComposer';
import {
  ChatMessageView,
  PendingAgent,
} from './ChatMessage';
import './chat.css';

export interface ChatPanelProps {
  available: boolean;
  projectId: string;
  /** null means the folder is open but not yet bound to a toolbox. */
  toolboxName: string | null;
  chat: ChatProjectState;
  context: ChatCapabilityContext | null;
  contextStatus: ChatLoadStatus;
  contextError: string;
  pendingApprovals: readonly import('../../services/capabilities').ChatApproval[];
  onNewConversation: () => void;
  onSelectConversation: (conversationId: string) => void;
  onRetryList: () => void;
  onRetryConversation: (conversationId: string) => void;
  onDraftChange: (draft: string) => void;
  onReferencesChange: (references: readonly ChatReference[]) => void;
  onSettingsChange: (settings: ChatConversationSettings) => void;
  onSwitchService: (serviceId: string, modelId: string) => void;
  onUiChange: (patch: Partial<ChatConversationUiState>) => void;
  onAddAttachment: (
    kind: 'file' | 'image' | 'screenshot',
  ) => void;
  onSend: () => void;
  onStop: () => void;
  onChooseToolbox: () => void;
  onOpenApprovals: () => void;
  onCopyText: (text: string) => void;
  onOpenProjectFile: (projectId: string, href: string) => void;
}

function formatConversationTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(
      date.getMinutes(),
    ).padStart(2, '0')}`;
  }
  const yesterday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1,
  );
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function historyStatus(
  conversation: ChatConversationState,
): { label: string; key: string } | null {
  const status = conversation.summary.status;
  if (status === 'running') return { label: '运行中', key: 'running' };
  if (status === 'failed') return { label: '已失败', key: 'failed' };
  if (status === 'stopped') return { label: '已停止', key: 'stopped' };
  if (status === 'unknown') {
    return { label: '待核实', key: 'stopped' };
  }
  return null;
}

function historySnippet(conversation: ChatConversationState): string {
  const draft = conversation.draft.trim();
  if (draft) return draft;
  if (conversation.references.length) {
    return conversation.references
      .map((reference) => reference.name)
      .join('、');
  }
  return (
    conversation.summary.messagePreview
      ?.replace(/[#>*_`~[\]()|]/g, '')
      .replace(/\s+/g, ' ')
      .trim() ?? ''
  );
}

function LegacyChatPanel() {
  return (
    <>
      <div className="panel-label chat-label">
        <h2 className="panel-title chat-title" id="chat-title">
          <span className="chat-title-label">对话</span>
          <span className="chat-title-sep" aria-hidden="true">
            ·
          </span>
          <span className="chat-title-name">新对话</span>
        </h2>
        <div className="chat-label-actions">
          <IconButton compact label="新建对话" disabled>
            <NewChatIcon />
          </IconButton>
          <IconButton compact label="历史对话" disabled>
            <HistoryIcon />
          </IconButton>
        </div>
      </div>
      <div className="chat-scroll">
        <div className="chat-log" role="log" aria-label="消息区">
          <p className="chat-unavailable">
            当前环境无法发送消息。
          </p>
        </div>
      </div>
    </>
  );
}

export function ChatPanel({
  available,
  projectId,
  toolboxName,
  chat,
  context,
  contextStatus,
  contextError,
  pendingApprovals,
  onNewConversation,
  onSelectConversation,
  onRetryList,
  onRetryConversation,
  onDraftChange,
  onReferencesChange,
  onSettingsChange,
  onSwitchService,
  onUiChange,
  onAddAttachment,
  onSend,
  onStop,
  onChooseToolbox,
  onOpenApprovals,
  onCopyText,
  onOpenProjectFile,
}: ChatPanelProps) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const historyRef = useRef<HTMLDivElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef(0);
  const followLatestRef = useRef(true);
  const conversationKeyRef = useRef('');
  const uiChangeRef = useRef(onUiChange);
  uiChangeRef.current = onUiChange;
  const conversation = activeChatConversation(chat);
  const activeRun = activeRunForConversation(conversation);
  const latestRun = latestRunForConversation(conversation);
  const pendingRun = activeRun ?? latestRun;
  const hasPendingRun =
    !!conversation &&
    !!pendingRun &&
    !conversation.messages.some(
      (message) =>
        message.role === 'assistant' &&
        message.runId === pendingRun.id,
    );
  const conversationKey = conversation
    ? `${projectId}:${conversation.summary.id}`
    : '';
  const title = conversation?.summary.title ?? '新对话';
  const pendingRunApprovals = pendingApprovals.filter(
    (approval) => approval.status === 'pending',
  );
  const pendingApprovalRunIds = new Set(
    pendingRunApprovals.map((approval) => approval.runId),
  );
  const canCreate =
    available &&
    contextStatus === 'ready' &&
    (context?.services?.some(
      (service) => service.connection === 'connected',
    ) ||
      (!!context?.serviceId && context.connection === 'connected')) &&
    !chat.creating;
  const historyDisabled =
    !available || chat.listStatus === 'loading' || chat.creating;

  useEffect(() => {
    if (!historyOpen) return;
    function close(event: PointerEvent) {
      const target = event.target as Node;
      if (historyRef.current?.contains(target)) return;
      if (historyButtonRef.current?.contains(target)) return;
      setHistoryOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setHistoryOpen(false);
      historyButtonRef.current?.focus();
    }
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', escape);
    };
  }, [historyOpen]);

  useEffect(() => {
    setHistoryOpen(false);
  }, [conversation?.summary.id]);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  function scrollToLatest(behavior: ScrollBehavior = 'auto') {
    const log = scrollRef.current;
    if (!log) return;
    log.scrollTo({ top: log.scrollHeight, behavior });
    followLatestRef.current = true;
    setAtBottom(true);
    uiChangeRef.current({ followLatest: true });
  }

  useLayoutEffect(() => {
    const log = scrollRef.current;
    if (!log || !conversation || conversation.loadStatus !== 'ready') {
      return;
    }
    if (conversationKeyRef.current === conversationKey) return;
    conversationKeyRef.current = conversationKey;
    followLatestRef.current = conversation.ui.followLatest;
    setAtBottom(conversation.ui.followLatest);
    log.scrollTop = conversation.ui.followLatest
      ? log.scrollHeight
      : conversation.ui.scrollTop;
    if (!conversation.ui.followLatest) {
      const bottom =
        log.scrollHeight - log.scrollTop - log.clientHeight <= 24;
      setAtBottom(bottom);
    }
    // Restoring is tied to the active conversation only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationKey, conversation?.loadStatus]);

  const messageSignature =
    conversation?.messages
      .map(
        (message) =>
          `${message.id}:${message.revision}:${message.text.length}`,
      )
      .join('|') ?? '';
  const runSignature =
    conversation
      ? Object.values(conversation.runs)
          .map(
            (run) =>
              `${run.id}:${run.revision}:${run.status}:${
                run.steps?.map((step) => step.status).join(',') ?? ''
              }`,
          )
          .join('|')
      : '';
  const expandedSignature =
    conversation?.ui.expandedRunIds.join('|') ?? '';

  const runOwnerMessageId = new Map<string, string>();
  const runLastMessageId = new Map<string, string>();
  for (const message of conversation?.messages ?? []) {
    if (message.role !== 'assistant' || !message.runId) continue;
    if (!runOwnerMessageId.has(message.runId)) {
      runOwnerMessageId.set(message.runId, message.id);
    }
    runLastMessageId.set(message.runId, message.id);
  }

  useLayoutEffect(() => {
    const log = scrollRef.current;
    if (!log || !conversation || conversation.loadStatus !== 'ready') {
      return;
    }
    if (followLatestRef.current) {
      log.scrollTop = log.scrollHeight;
      setAtBottom(true);
    } else {
      setAtBottom(
        log.scrollHeight - log.scrollTop - log.clientHeight <= 24,
      );
    }
    // Keep the reading position unless the user is following new content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    messageSignature,
    runSignature,
    expandedSignature,
    conversationKey,
    conversation?.loadStatus,
  ]);

  function handleScroll() {
    const log = scrollRef.current;
    if (!log || !conversation) return;
    const bottom =
      log.scrollHeight - log.scrollTop - log.clientHeight <= 24;
    if (bottom !== atBottom) setAtBottom(bottom);
    followLatestRef.current = bottom;
    if (scrollFrameRef.current) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = 0;
      uiChangeRef.current({
        scrollTop: log.scrollTop,
        followLatest: bottom,
      });
    });
  }

  function handleSend() {
    if (chat.creating) return;
    scrollToLatest('auto');
    onSend();
  }

  if (!available) {
    return (
      <section
        className="panel panel--chat"
        id="chat-panel"
        aria-labelledby="chat-title"
      >
        <LegacyChatPanel />
      </section>
    );
  }

  return (
    <section
      className="panel panel--chat"
      id="chat-panel"
      aria-labelledby="chat-title"
    >
      <div className="panel-label chat-label">
        <h2 className="panel-title chat-title" id="chat-title">
          <span className="chat-title-label">对话</span>
          <span className="chat-title-sep" aria-hidden="true">
            ·
          </span>
          <span className="chat-title-name" title={title}>
            {title}
          </span>
        </h2>
        <div className="chat-label-actions">
          <IconButton
            compact
            label={chat.creating ? '正在新建对话' : '新建对话'}
            disabled={!canCreate}
            onClick={onNewConversation}
          >
            <NewChatIcon />
          </IconButton>
          <div className="chat-history-anchor">
            <IconButton
              ref={historyButtonRef}
              compact
              label="历史对话"
              aria-haspopup="dialog"
              aria-expanded={historyOpen}
              disabled={historyDisabled}
              onClick={() => setHistoryOpen((open) => !open)}
            >
              <HistoryIcon />
            </IconButton>
          </div>
        </div>
      </div>

      {historyOpen ? (
        <div
          ref={historyRef}
          className="chat-history"
          role="dialog"
          aria-label="历史对话"
        >
          <p className="chat-history-heading">历史对话</p>
          {chat.listStatus === 'loading' ? (
            <p className="chat-history-hint" role="status">
              正在加载历史对话…
            </p>
          ) : null}
          {chat.listStatus === 'error' ? (
            <div className="chat-history-hint">
              <p className="chat-inline-error" role="alert">
                {chat.listError || '历史对话加载失败。'}
              </p>
              <button
                type="button"
                className="chat-text-action"
                onClick={onRetryList}
              >
                重试
              </button>
            </div>
          ) : null}
          {chat.listStatus === 'ready' && chat.order.length === 0 ? (
            <p className="chat-history-hint">暂无历史对话</p>
          ) : null}
          {chat.order.length > 0 ? (
            <ul className="chat-history-list">
              {chat.order.map((id) => {
                const item = chat.conversations[id];
                if (!item) return null;
                const status = historyStatus(item);
                const active = chat.activeId === id;
                const snippet = historySnippet(item);
                return (
                  <li key={id}>
                    <button
                      type="button"
                      className={`chat-history-item${
                        active ? ' is-active' : ''
                      }`}
                      aria-current={active ? 'true' : undefined}
                      title={item.summary.title}
                      onClick={() => {
                        setHistoryOpen(false);
                        onSelectConversation(id);
                      }}
                    >
                      <span className="chat-history-main">
                        <span className="chat-history-title">
                          {item.summary.title}
                        </span>
                        {snippet ? (
                          <span className="chat-history-snippet">
                            {snippet}
                          </span>
                        ) : null}
                      </span>
                      <span className="chat-history-side">
                        <span className="chat-history-time">
                          {formatConversationTime(
                            item.summary.updatedAt,
                          )}
                        </span>
                        {status ? (
                          <span
                            className={`chat-history-status is-${status.key}`}
                          >
                            {status.label}
                          </span>
                        ) : null}
                        {item.summary.hasDraft ||
                        item.draft.trim().length > 0 ||
                        item.references.length > 0 ? (
                          <span className="chat-history-status is-draft">
                            草稿
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}

      {chat.createError ? (
        <p className="chat-inline-error chat-create-error" role="alert">
          {chat.createError}
        </p>
      ) : null}

      <div className="chat-scroll">
        <div
          ref={scrollRef}
          className="chat-log"
          role="log"
          aria-label="消息区"
          aria-busy={
            conversation?.sendStatus === 'sending' ||
            Boolean(activeRun)
              ? 'true'
              : undefined
          }
          onScroll={handleScroll}
        >
          {!conversation ? (
            <div className="chat-empty">
              <p className="chat-empty-title">开始一段新对话</p>
              {contextStatus === 'ready' &&
              !context?.services?.some(
                (service) => service.connection === 'connected',
              ) &&
              context?.connection !== 'connected' ? (
                <p className="chat-inline-error" role="status">
                  {context?.connectionMessage ??
                    context?.services?.find(
                      (service) => service.connectionMessage,
                    )?.connectionMessage ??
                    '暂无可用模型服务，请检查依赖设置。'}
                </p>
              ) : null}
              <button
                type="button"
                className="chat-primary-action"
                disabled={!canCreate}
                onClick={onNewConversation}
              >
                {chat.creating ? '正在新建…' : '新建对话'}
              </button>
            </div>
          ) : conversation.loadStatus === 'loading' ? (
            <div className="chat-loading" role="status">
              <span className="chat-loading-spinner" aria-hidden="true" />
              正在加载对话…
            </div>
          ) : conversation.loadStatus === 'error' ? (
            <div className="chat-empty">
              <p className="chat-inline-error" role="alert">
                {conversation.loadError || '对话加载失败。'}
              </p>
              <button
                type="button"
                className="chat-text-action"
                onClick={() =>
                  onRetryConversation(conversation.summary.id)
                }
              >
                重试
              </button>
            </div>
          ) : (
            <>
              {conversation.historyWarning ? (
                <p className="chat-inline-error" role="status">
                  {conversation.historyWarning}
                </p>
              ) : null}
              {conversation.messages.map((message) => {
                const run = message.runId
                  ? conversation.runs[message.runId] ?? null
                  : null;
                return (
                  <ChatMessageView
                    key={message.id}
                    message={message}
                    run={run}
                    onOpenProjectFile={(href) =>
                      onOpenProjectFile(conversation.summary.projectId, href)
                    }
                    expanded={
                      !!run &&
                      conversation.ui.expandedRunIds.includes(
                        run.id,
                      )
                    }
                    waitingApproval={
                      !!run && pendingApprovalRunIds.has(run.id)
                    }
                    showRunTrace={
                      !message.runId ||
                      runOwnerMessageId.get(message.runId) ===
                        message.id
                    }
                    showRunStatus={
                      !message.runId ||
                      runLastMessageId.get(message.runId) ===
                        message.id
                    }
                    onToggleRun={() => {
                      if (!run) return;
                      const expanded =
                        conversation.ui.expandedRunIds.includes(
                          run.id,
                        );
                      onUiChange({
                        expandedRunIds: expanded
                          ? conversation.ui.expandedRunIds.filter(
                              (id) => id !== run.id,
                            )
                          : [
                              ...conversation.ui.expandedRunIds,
                              run.id,
                            ],
                      });
                    }}
                    onCopy={(text) => onCopyText(text)}
                  />
                );
              })}
              {latestRun?.summary &&
              !conversation.messages.some(
                (message) => message.runId === latestRun.id,
              ) ? (
                <p className="chat-inline-error" role="alert">
                  {latestRun.summary}
                </p>
              ) : null}
              {hasPendingRun && pendingRun ? (
                <PendingAgent
                  run={pendingRun}
                  expanded={conversation.ui.expandedRunIds.includes(
                    pendingRun.id,
                  )}
                  waitingApproval={pendingApprovalRunIds.has(
                    pendingRun.id,
                  )}
                  onToggle={() => {
                    const expanded =
                      conversation.ui.expandedRunIds.includes(
                        pendingRun.id,
                      );
                    onUiChange({
                      expandedRunIds: expanded
                        ? conversation.ui.expandedRunIds.filter(
                            (id) => id !== pendingRun.id,
                          )
                        : [
                            ...conversation.ui.expandedRunIds,
                            pendingRun.id,
                          ],
                    });
                  }}
                />
              ) : null}
            </>
          )}
        </div>
        {!atBottom && conversation?.loadStatus === 'ready' ? (
          <button
            type="button"
            className="chat-jump"
            onClick={() => scrollToLatest('smooth')}
          >
            回到最新
          </button>
        ) : null}
      </div>

      {toolboxName === null ? (
        <div className="chat-unbound" role="status">
          <span className="chat-unbound-text">
            未绑定工具箱
          </span>
          <button
            type="button"
            className="chat-text-action"
            onClick={onChooseToolbox}
            data-testid="choose-toolbox"
          >
            选择工具箱
          </button>
        </div>
      ) : null}

      {pendingRunApprovals.length > 0 ? (
        <div className="chat-approval-bar" role="status">
          <span className="chat-approval-bar-text">
            等待审批 · {pendingRunApprovals.length} 个请求
          </span>
          <button
            type="button"
            className="chat-text-action"
            onClick={onOpenApprovals}
            data-testid="open-approvals"
          >
            查看审批
          </button>
        </div>
      ) : null}

      <ChatComposer
        conversation={conversation}
        context={context}
        contextStatus={contextStatus}
        contextError={contextError}
        creating={chat.creating}
        onDraftChange={onDraftChange}
        onReferencesChange={onReferencesChange}
        onSettingsChange={onSettingsChange}
        onSwitchService={onSwitchService}
        onAddAttachment={onAddAttachment}
        onSend={handleSend}
        onStop={onStop}
      />
    </section>
  );
}
