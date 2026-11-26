import {
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from '../../components/ui/Menu';
import type {
  ChatAttachmentKind,
  ChatCapabilityContext,
  ChatConversationSettings,
  ChatModel,
  ChatReference,
} from '../../services/capabilities';
import type {
  ChatConversationState,
} from './chat-state';
import {
  activeRunForConversation,
  unsettledRunForConversation,
} from './chat-state';
import { ReferenceChips } from './ChatMessage';
import {
  CaretIcon,
  CheckIcon,
  PlusIcon,
  SendIcon,
  StopIcon,
} from './ChatIcons';

export interface ChatComposerProps {
  conversation: ChatConversationState | null;
  context: ChatCapabilityContext | null;
  contextStatus: 'idle' | 'loading' | 'ready' | 'error';
  contextError: string;
  /** A service switch/new conversation is pending; block edit and send. */
  creating: boolean;
  onDraftChange: (draft: string) => void;
  onReferencesChange: (references: readonly ChatReference[]) => void;
  onSettingsChange: (settings: ChatConversationSettings) => void;
  onSwitchService: (serviceId: string, modelId: string) => void;
  onAddAttachment: (kind: ChatAttachmentKind) => void;
  onSend: () => void;
  onStop: () => void;
}

type ServiceGroup = NonNullable<ChatCapabilityContext['services']>[number];

function serviceGroups(
  context: ChatCapabilityContext | null,
): readonly ServiceGroup[] {
  if (!context) return [];
  if (context.services && context.services.length > 0) {
    return context.services;
  }
  return [
    {
      serviceId: context.serviceId,
      serviceName: context.serviceName,
      connection: context.connection,
      ...(context.connectionMessage
        ? { connectionMessage: context.connectionMessage }
        : {}),
      models: context.models,
      defaultModelId: context.defaultModelId ?? null,
    },
  ];
}

function serviceForConversation(
  context: ChatCapabilityContext | null,
  conversation: ChatConversationState | null,
): ServiceGroup | null {
  if (!context || !conversation) return null;
  return (
    serviceGroups(context).find(
      (service) =>
        service.serviceId === conversation.summary.serviceId,
    ) ?? null
  );
}

function currentModel(
  context: ChatCapabilityContext | null,
  conversation: ChatConversationState | null,
): ChatModel | null {
  if (!context || !conversation) return null;
  const service = serviceForConversation(context, conversation);
  if (!service) return null;
  return (
    service.models.find(
      (model) =>
        model.modelId === conversation.settings.modelId &&
        model.serviceId === service.serviceId,
    ) ?? null
  );
}

function referenceTypeSupported(
  model: ChatModel,
  reference: ChatReference,
): boolean {
  if (reference.kind === 'attachment') {
    return reference.mime?.startsWith('image/')
      ? model.input.image
      : model.input.file;
  }
  return model.input.projectReference;
}

function modelDefaultEffort(
  model: ChatModel,
  requested?: string | null,
): { id: string | null; label?: string } {
  if (!model.efforts?.length) return { id: null };
  const preferred =
    model.efforts.find((option) => option.id === requested) ??
    model.efforts.find(
      (option) => option.id === model.defaultEffortId,
    ) ??
    model.efforts[0];
  return preferred
    ? { id: preferred.id, label: preferred.label }
    : { id: null };
}

function ComposerGate({
  conversation,
  context,
  contextStatus,
  contextError,
}: {
  conversation: ChatConversationState | null;
  context: ChatCapabilityContext | null;
  contextStatus: 'idle' | 'loading' | 'ready' | 'error';
  contextError: string;
}): string {
  if (!conversation) return '请先新建对话。';
  if (conversation.loadStatus === 'loading') {
    return '正在加载对话…';
  }
  if (conversation.loadStatus === 'error') {
    return '对话内容加载失败，请重试。';
  }
  if (conversation.loadStatus !== 'ready') {
    return '准备对话…';
  }
  if (contextStatus === 'loading' || contextStatus === 'idle') {
    return '准备中…';
  }
  if (contextStatus === 'error') {
    return contextError || '暂时无法发送消息。';
  }
  if (!context) return '暂时无法发送消息。';
  const service = serviceForConversation(context, conversation);
  if (!service) {
    return `服务「${
      conversation.summary.serviceName ??
      conversation.summary.serviceId
    }」未配置。选择其他服务将新建对话。`;
  }
  if (service.connection !== 'connected') {
    return (
      service.connectionMessage ??
      `服务「${service.serviceName}」未连接。`
    );
  }
  if (!conversation.settings.modelId) {
    return '请选择模型。';
  }
  const model = currentModel(context, conversation);
  if (!model) {
    return '模型不可用，请重新选择。';
  }
  if (!model.available) {
    return model.reason ?? '模型不可用，请重新选择。';
  }
  const permission = context.permissions.find(
    (item) => item.id === conversation.settings.permissionId,
  );
  if (!permission?.available) {
    return (
      permission?.reason ?? '权限模式不可用，请重新选择。'
    );
  }
  const text = conversation.draft.trim();
  if (text && !model.input.text) {
    return '当前模型不支持文本输入。';
  }
  const unsupported = conversation.references.find(
    (reference) => !referenceTypeSupported(model, reference),
  );
  if (unsupported) {
    return `模型不支持「${unsupported.name}」，请移除或更换引用。`;
  }
  if (unsettledRunForConversation(conversation)?.status === 'unknown') {
    return '上一轮状态待核实，暂不能发送。';
  }
  return '';
}

export function ChatComposer({
  conversation,
  context,
  contextStatus,
  contextError,
  creating,
  onDraftChange,
  onReferencesChange,
  onSettingsChange,
  onSwitchService,
  onAddAttachment,
  onSend,
  onStop,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const activeRun = activeRunForConversation(conversation);
  const model = currentModel(context, conversation);
  const gate = ComposerGate({
    conversation,
    context,
    contextStatus,
    contextError,
  });
  const boundService = serviceForConversation(context, conversation);
  const canEdit =
    !!conversation &&
    conversation.loadStatus === 'ready' &&
    !conversation.attachmentBusy &&
    !creating;
  const hasContent =
    Boolean(conversation?.draft.trim()) ||
    Boolean(conversation?.references.length);
  const running = Boolean(activeRun);
  const sending = conversation?.sendStatus === 'sending';
  const verifying = conversation?.sendStatus === 'verifying';
  const pendingSubmission = conversation?.pendingSubmission ?? null;
  const stopPending = conversation?.stopPending ?? false;
  const sendError = conversation?.sendError ?? '';
  const stopError = conversation?.stopError ?? '';
  const busyStatus = creating
    ? '准备对话…'
    : verifying
      ? '正在核实上次发送…'
      : sending
        ? '正在发送…'
        : stopPending
          ? '正在停止…'
          : conversation?.loadStatus === 'ready' &&
              (contextStatus === 'loading' || contextStatus === 'idle')
            ? '准备中…'
            : '';
  // Loading and empty states already have a home in the message panel.
  // Keep the gate itself unchanged: this only controls duplicate presentation.
  const notice = busyStatus
    ? ''
    : pendingSubmission
      ? sendError || '上次发送结果待核实'
      : sendError ||
        stopError ||
        (conversation?.loadStatus === 'ready' ? gate : '');

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const needed = textarea.scrollHeight;
    textarea.style.height = `${Math.min(needed, 168)}px`;
    textarea.style.overflowY = needed > 168 ? 'auto' : 'hidden';
  }, [conversation?.draft, conversation?.summary.id]);

  function chooseModel(nextModel: ChatModel) {
    if (!conversation) return;
    const effort = modelDefaultEffort(nextModel);
    onSettingsChange({
      modelId: nextModel.modelId,
      modelLabel: nextModel.label,
      effortId: effort.id,
      effortLabel: effort.label,
      permissionId: conversation.settings.permissionId,
      permissionLabel: conversation.settings.permissionLabel,
    });
  }

  function chooseEffort(effortId: string) {
    if (!conversation || !model?.efforts) return;
    const effort = model.efforts.find((item) => item.id === effortId);
    if (!effort) return;
    onSettingsChange({
      ...conversation.settings,
      effortId: effort.id,
      effortLabel: effort.label,
    });
  }

  function choosePermission(permissionId: string) {
    if (!conversation || !context) return;
    const permission = context.permissions.find(
      (item) => item.id === permissionId,
    );
    if (!permission?.available) return;
    onSettingsChange({
      ...conversation.settings,
      permissionId: permission.id,
      permissionLabel: permission.label,
    });
  }

  function removeReference(reference: ChatReference) {
    if (!conversation) return;
    onReferencesChange(
      conversation.references.filter(
        (item) => item.id !== reference.id,
      ),
    );
  }

  function handleKeyDown(
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ) {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (
      composingRef.current ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    ) {
      return;
    }
    event.preventDefault();
    if (creating || running || stopPending || sending || verifying) return;
    if (pendingSubmission) {
      if (
        boundService?.connection === 'connected' &&
        contextStatus === 'ready'
      ) {
        onSend();
      }
      return;
    }
    if (gate || !hasContent) return;
    onSend();
  }

  const modelGroups = serviceGroups(context);
  const selectedModelMissing =
    !!conversation?.settings.modelId &&
    !!boundService &&
    !boundService.models.some(
      (option) => option.modelId === conversation.settings.modelId,
    );
  const selectedModelValue =
    boundService && conversation?.settings.modelId
      ? `${boundService.serviceId}\u0000${conversation.settings.modelId}`
      : '';
  const effortOptions = model?.efforts ?? null;
  const selectedEffortMissing =
    !!conversation?.settings.effortId &&
    !!effortOptions &&
    !effortOptions.some(
      (option) => option.id === conversation.settings.effortId,
    );
  const permissionOptions = context?.permissions ?? [];
  const selectedPermissionMissing =
    !!conversation?.settings.permissionId &&
    !permissionOptions.some(
      (option) =>
        option.id === conversation.settings.permissionId,
    );

  const permissionLabel =
    conversation?.settings.permissionLabel ??
    (context?.permissions.find(
      (option) =>
        option.id === conversation?.settings.permissionId,
    )?.label ||
      conversation?.settings.permissionId ||
      '权限');
  const modelLabel =
    model?.label ||
    conversation?.settings.modelLabel ||
    conversation?.settings.modelId ||
    '选择模型';
  const effortLabel = !model?.efforts?.length
    ? '不支持'
    : model.efforts.find(
        (option) => option.id === conversation?.settings.effortId,
      )?.label ||
      conversation?.settings.effortLabel ||
      '强度';

  const canRetryPending =
    !!pendingSubmission &&
    boundService?.connection === 'connected' &&
    contextStatus === 'ready' &&
    !creating &&
    !running &&
    !sending &&
    !verifying &&
    !stopPending;
  const canSend = pendingSubmission
    ? canRetryPending
    : !gate &&
      hasContent &&
      !creating &&
      !running &&
      !sending &&
      !verifying &&
      !stopPending;
  const buttonBusy = Boolean(busyStatus) && (!running || stopPending);
  const sendMode = running
    ? 'stop'
    : pendingSubmission
      ? 'retry'
      : 'send';

  return (
    <div className="composer">
      <div className="composer-box">
        {conversation?.references.length ? (
          <ReferenceChips
            references={conversation.references}
            removable
            onRemove={removeReference}
            className="composer-refs"
          />
        ) : null}
        <label className="visually-hidden" htmlFor="composer-input">
          输入消息
        </label>
        <textarea
          ref={textareaRef}
          id="composer-input"
          className="composer-input"
          rows={1}
          placeholder="输入消息…"
          spellCheck={false}
          value={conversation?.draft ?? ''}
          disabled={
            !conversation ||
            conversation.loadStatus !== 'ready' ||
            creating
          }
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
        />
        <span className="visually-hidden" role="status">
          {busyStatus}
        </span>
        {notice ? (
          <p className="composer-notice" role="status">
            {notice}
          </p>
        ) : null}
        <div className="composer-toolbar">
          <div className="composer-group">
            <Menu
              modal={false}
              open={menuOpen === 'add'}
              onOpenChange={(open) =>
                setMenuOpen(open ? 'add' : null)
              }
            >
              <MenuTrigger asChild>
                <button
                  type="button"
                  className="composer-icon"
                  aria-label="添加"
                  title="添加文件、图片或截图"
                  aria-haspopup="menu"
                  disabled={!canEdit || !conversation}
                >
                  <PlusIcon />
                </button>
              </MenuTrigger>
              <MenuContent
                side="top"
                align="start"
                className="chat-composer-menu"
              >
                {(
                  [
                    ['file', '添加文件'],
                    ['image', '添加图片'],
                    ['screenshot', '添加截图'],
                  ] as const
                ).map(([kind, label]) => (
                  <MenuItem
                    key={kind}
                    className="composer-menu-item"
                    onSelect={() => onAddAttachment(kind)}
                  >
                    {label}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>

            <Menu
              modal={false}
              open={menuOpen === 'permission'}
              onOpenChange={(open) =>
                setMenuOpen(open ? 'permission' : null)
              }
            >
              <MenuTrigger asChild>
                <button
                  type="button"
                  className="composer-chip"
                  aria-label={`权限模式，当前${permissionLabel}`}
                  title={`权限模式：${permissionLabel}`}
                  aria-haspopup="menu"
                  disabled={!canEdit || permissionOptions.length === 0}
                >
                  <span className="composer-chip-label">
                    {permissionLabel}
                  </span>
                </button>
              </MenuTrigger>
              <MenuContent
                side="top"
                align="start"
                className="chat-composer-menu"
              >
                <MenuRadioGroup
                  value={conversation?.settings.permissionId ?? ''}
                  onValueChange={choosePermission}
                >
                  {permissionOptions.map((permission) => (
                    <MenuRadioItem
                      key={permission.id}
                      value={permission.id}
                      className="composer-menu-item"
                      disabled={!permission.available}
                      title={
                        permission.available
                          ? undefined
                          : permission.reason
                      }
                    >
                      <span className="composer-menu-body">
                        <span className="composer-menu-label">
                          {permission.label}
                        </span>
                        {permission.description ? (
                          <span className="composer-menu-desc">
                            {permission.description}
                          </span>
                        ) : null}
                      </span>
                      <span className="composer-menu-check">
                        <CheckIcon />
                      </span>
                    </MenuRadioItem>
                  ))}
                  {selectedPermissionMissing ? (
                    <MenuRadioItem
                      value={conversation?.settings.permissionId ?? ''}
                      className="composer-menu-item"
                      disabled
                    >
                      <span className="composer-menu-body">
                        <span className="composer-menu-label">
                          {conversation?.settings.permissionLabel ??
                            conversation?.settings.permissionId}
                        </span>
                        <span className="composer-menu-desc">
                          当前权限不再提供
                        </span>
                      </span>
                      <span className="composer-menu-check">
                        <CheckIcon />
                      </span>
                    </MenuRadioItem>
                  ) : null}
                </MenuRadioGroup>
              </MenuContent>
            </Menu>
          </div>

          <div className="composer-group composer-group--end">
            <Menu
              modal={false}
              open={menuOpen === 'model'}
              onOpenChange={(open) =>
                setMenuOpen(open ? 'model' : null)
              }
            >
              <MenuTrigger asChild>
                <button
                  type="button"
                  className="composer-chip"
                  aria-label={`选择模型，当前${modelLabel}`}
                  title={`模型：${modelLabel}`}
                  aria-haspopup="menu"
                  disabled={
                    !conversation ||
                    conversation.loadStatus !== 'ready' ||
                    modelGroups.length === 0 ||
                    creating
                  }
                >
                  <span className="composer-chip-label">
                    {modelLabel}
                  </span>
                  <CaretIcon />
                </button>
              </MenuTrigger>
              <MenuContent
                side="top"
                align="end"
                className="chat-composer-menu"
              >
                <MenuRadioGroup
                  value={selectedModelValue}
                  onValueChange={(value) => {
                    const separator = value.indexOf('\u0000');
                    if (separator < 0) return;
                    const serviceId = value.slice(0, separator);
                    const modelId = value.slice(separator + 1);
                    const service = modelGroups.find(
                      (group) => group.serviceId === serviceId,
                    );
                    const next = service?.models.find(
                      (option) => option.modelId === modelId,
                    );
                    if (!next) return;
                    if (
                      conversation?.summary.serviceId === serviceId
                    ) {
                      chooseModel(next);
                    } else {
                      onSwitchService(serviceId, modelId);
                    }
                  }}
                >
                  {modelGroups.map((group) => {
                    const isCurrent =
                      conversation?.summary.serviceId ===
                      group.serviceId;
                    return (
                      <div
                        key={group.serviceId}
                        className="composer-menu-group"
                        role="group"
                        aria-label={group.serviceName}
                      >
                        <p className="composer-menu-heading">
                          {group.serviceName}
                          {isCurrent
                            ? ' · 当前'
                            : ' · 新建对话'}
                        </p>
                        {group.models.length === 0 ? (
                          <p className="composer-menu-empty">
                            {group.connection === 'connected'
                              ? '暂无可用模型'
                              : group.connectionMessage ??
                                '服务未连接'}
                          </p>
                        ) : (
                          group.models.map((option) => {
                            const value = `${group.serviceId}\u0000${option.modelId}`;
                            return (
                              <MenuRadioItem
                                key={value}
                                value={value}
                                className="composer-menu-item"
                                disabled={!option.available}
                                title={
                                  option.available
                                    ? undefined
                                    : option.reason
                                }
                              >
                                <span className="composer-menu-body">
                                  <span className="composer-menu-label">
                                    {option.label}
                                  </span>
                                  {!option.available ? (
                                    <span className="composer-menu-desc">
                                      {option.reason ?? '不可用'}
                                    </span>
                                  ) : null}
                                </span>
                                <span className="composer-menu-check">
                                  <CheckIcon />
                                </span>
                              </MenuRadioItem>
                            );
                          })
                        )}
                      </div>
                    );
                  })}
                  {selectedModelMissing && boundService ? (
                    <MenuRadioItem
                      value={`${boundService.serviceId}\u0000${conversation?.settings.modelId ?? ''}`}
                      className="composer-menu-item"
                      disabled
                    >
                      <span className="composer-menu-body">
                        <span className="composer-menu-label">
                          {conversation?.settings.modelLabel ??
                            conversation?.settings.modelId}
                        </span>
                        <span className="composer-menu-desc">
                          模型已不可用
                        </span>
                      </span>
                      <span className="composer-menu-check">
                        <CheckIcon />
                      </span>
                    </MenuRadioItem>
                  ) : null}
                </MenuRadioGroup>
              </MenuContent>
            </Menu>

            <Menu
              modal={false}
              open={menuOpen === 'effort'}
              onOpenChange={(open) =>
                setMenuOpen(open ? 'effort' : null)
              }
            >
              <MenuTrigger asChild>
                <button
                  type="button"
                  className="composer-chip"
                  aria-label={`选择推理强度，当前${effortLabel}`}
                  title={
                    model?.efforts?.length
                      ? `推理强度：${effortLabel}`
                      : '当前模型不支持推理强度'
                  }
                  aria-haspopup="menu"
                  disabled={
                    !canEdit || !effortOptions || effortOptions.length === 0
                  }
                >
                  <span className="composer-chip-label">
                    {effortLabel}
                  </span>
                  <CaretIcon />
                </button>
              </MenuTrigger>
              <MenuContent
                side="top"
                align="end"
                className="chat-composer-menu"
              >
                <MenuRadioGroup
                  value={conversation?.settings.effortId ?? ''}
                  onValueChange={chooseEffort}
                >
                  {effortOptions?.map((option) => (
                    <MenuRadioItem
                      key={option.id}
                      value={option.id}
                      className="composer-menu-item"
                    >
                      <span className="composer-menu-body">
                        <span className="composer-menu-label">
                          {option.label}
                        </span>
                      </span>
                      <span className="composer-menu-check">
                        <CheckIcon />
                      </span>
                    </MenuRadioItem>
                  ))}
                  {selectedEffortMissing ? (
                    <MenuRadioItem
                      value={conversation?.settings.effortId ?? ''}
                      className="composer-menu-item"
                      disabled
                    >
                      <span className="composer-menu-body">
                        <span className="composer-menu-label">
                          {conversation?.settings.effortLabel ??
                            conversation?.settings.effortId}
                        </span>
                        <span className="composer-menu-desc">
                          当前强度不再提供
                        </span>
                      </span>
                      <span className="composer-menu-check">
                        <CheckIcon />
                      </span>
                    </MenuRadioItem>
                  ) : null}
                </MenuRadioGroup>
              </MenuContent>
            </Menu>

            <button
              type="button"
              className="composer-send"
              data-mode={sendMode}
              aria-busy={buttonBusy ? 'true' : undefined}
              aria-label={
                running
                  ? stopPending
                    ? '正在停止当前执行'
                    : '停止当前执行'
                  : pendingSubmission
                    ? verifying
                      ? '正在核实上次发送'
                      : '核实上次发送'
                    : '发送消息'
              }
              title={
                running
                  ? stopPending
                    ? '正在停止当前执行'
                    : '停止当前执行'
                  : pendingSubmission
                    ? verifying
                      ? '正在核实上次发送'
                      : '核实上次发送'
                    : '发送 (Enter)'
              }
              disabled={running ? stopPending : !canSend}
              onClick={() => {
                if (running) {
                  if (!stopPending) onStop();
                } else if (canSend) {
                  onSend();
                }
              }}
            >
              {buttonBusy ? (
                <span className="trace-spinner" aria-hidden="true" />
              ) : (
                <>
                  <SendIcon />
                  <StopIcon />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
