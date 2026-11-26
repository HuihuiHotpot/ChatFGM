import type {
  ChatApproval,
  ChatCapabilityContext,
  ChatConversationSettings,
  ChatConversationSnapshot,
  ChatConversationSummary,
  ChatConversationUiState,
  ChatMessage,
  ChatPendingSubmission,
  ChatReference,
  ChatRun,
  ChatRunStatus,
  ChatUpdate,
} from '../../services/capabilities';
import type { FileTreeEntry } from '../../services/capabilities';

export type ChatLoadStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error';

export interface ChatConversationState {
  summary: ChatConversationSummary;
  loadStatus: 'summary' | 'loading' | 'ready' | 'error';
  loadError: string;
  /** True once the local conversation fields have been populated. Loading
   * again must not discard user edits. */
  hasLoadedState: boolean;
  /** Version of the user-owned draft/references/settings/ui state. */
  stateRevision: number;
  historyWarning: string;
  messages: ChatMessage[];
  runs: Record<string, ChatRun>;
  draft: string;
  references: ChatReference[];
  settings: ChatConversationSettings;
  ui: ChatConversationUiState;
  attachmentBusy: boolean;
  sendStatus: 'idle' | 'sending' | 'verifying' | 'unknown' | 'error';
  sendError: string;
  pendingSubmission: ChatPendingSubmission | null;
  stopPending: boolean;
  stopError: string;
  /** Approval requests, including decided history. */
  approvals: ChatApproval[];
}

export interface ChatProjectState {
  listStatus: ChatLoadStatus;
  listError: string;
  order: string[];
  conversations: Record<string, ChatConversationState>;
  activeId: string | null;
  creating: boolean;
  createError: string;
}

export interface ChatAppState {
  contextStatus: ChatLoadStatus;
  context: ChatCapabilityContext | null;
  contextError: string;
  projects: Record<string, ChatProjectState>;
}

export type ChatAction =
  | { type: 'context-loading' }
  | { type: 'context-ready'; context: ChatCapabilityContext }
  | { type: 'context-error'; message: string }
  | { type: 'ensure-project'; projectId: string }
  | { type: 'list-loading'; projectId: string }
  | {
      type: 'list-ready';
      projectId: string;
      summaries: readonly ChatConversationSummary[];
    }
  | { type: 'list-error'; projectId: string; message: string }
  | {
      type: 'conversation-loading';
      projectId: string;
      conversationId: string;
    }
  | {
      type: 'conversation-error';
      projectId: string;
      conversationId: string;
      message: string;
    }
  | {
      type: 'conversation-snapshot';
      projectId: string;
      snapshot: ChatConversationSnapshot;
    }
  | {
      type: 'conversation-summary';
      projectId: string;
      summary: ChatConversationSummary;
    }
  | {
      type: 'state-saved';
      projectId: string;
      conversationId: string;
      stateRevision: number;
    }
  | {
      type: 'project-state';
      projectId: string;
      activeConversationId: string | null;
    }
  | {
      type: 'select-conversation';
      projectId: string;
      conversationId: string;
    }
  | { type: 'create-start'; projectId: string }
  | { type: 'create-error'; projectId: string; message: string }
  | {
      type: 'draft';
      projectId: string;
      conversationId: string;
      draft: string;
    }
  | {
      type: 'references';
      projectId: string;
      conversationId: string;
      references: readonly ChatReference[];
    }
  | {
      type: 'settings';
      projectId: string;
      conversationId: string;
      settings: ChatConversationSettings;
    }
  | {
      type: 'ui-state';
      projectId: string;
      conversationId: string;
      patch: Partial<ChatConversationUiState>;
    }
  | {
      type: 'attachment-busy';
      projectId: string;
      conversationId: string;
      busy: boolean;
    }
  | {
      type: 'send-start';
      projectId: string;
      conversationId: string;
    }
  | {
      type: 'send-error';
      projectId: string;
      conversationId: string;
      message: string;
    }
  | {
      type: 'send-unknown';
      projectId: string;
      conversationId: string;
      message: string;
      pending: ChatPendingSubmission;
    }
  | {
      type: 'send-verifying';
      projectId: string;
      conversationId: string;
    }
  | {
      type: 'send-reconcile-error';
      projectId: string;
      conversationId: string;
      message: string;
    }
  | {
      type: 'send-reconciled';
      projectId: string;
      conversationId: string;
      submissionId: string;
    }
  | {
      type: 'send-accepted';
      stateRevision?: number;
      projectId: string;
      conversationId: string;
      submissionId: string;
      userMessage: ChatMessage;
      run: ChatRun;
      submittedDraft: string;
      submittedReferences: readonly ChatReference[];
    }
  | {
      type: 'stop-start';
      projectId: string;
      conversationId: string;
    }
  | {
      type: 'stop-accepted';
      projectId: string;
      conversationId: string;
    }
  | {
      type: 'stop-error';
      projectId: string;
      conversationId: string;
      message: string;
    }
  | {
      type: 'message-update';
      projectId: string;
      conversationId: string;
      message: ChatMessage;
    }
  | {
      type: 'run-update';
      projectId: string;
      conversationId: string;
      run: ChatRun;
    }
  | {
      type: 'approvals-update';
      projectId: string;
      conversationId: string;
      approvals: readonly ChatApproval[];
    }
  | {
      type: 'update';
      projectId: string;
      update: ChatUpdate;
    }
  | {
      type: 'reconcile-references';
      projectId: string;
      entries: readonly FileTreeEntry[];
    };

const EMPTY_SETTINGS: ChatConversationSettings = {
  modelId: '',
  effortId: null,
  permissionId: '',
};

const EMPTY_UI: ChatConversationUiState = {
  scrollTop: 0,
  followLatest: true,
  expandedRunIds: [],
};

export function createChatProjectState(): ChatProjectState {
  return {
    listStatus: 'idle',
    listError: '',
    order: [],
    conversations: {},
    activeId: null,
    creating: false,
    createError: '',
  };
}

export function createInitialChatAppState(): ChatAppState {
  return {
    contextStatus: 'idle',
    context: null,
    contextError: '',
    projects: {},
  };
}

function ensureProject(
  state: ChatAppState,
  projectId: string,
): ChatProjectState {
  return state.projects[projectId] ?? createChatProjectState();
}

function conversationFromSummary(
  summary: ChatConversationSummary,
): ChatConversationState {
  return {
    summary,
    loadStatus: 'summary',
    loadError: '',
    stateRevision: 0,
    historyWarning: '',
    messages: [],
    runs: {},
    draft: '',
    references: [],
    settings: { ...EMPTY_SETTINGS },
    ui: { ...EMPTY_UI, expandedRunIds: [] },
    attachmentBusy: false,
    sendStatus: 'idle',
    sendError: '',
    pendingSubmission: null,
    stopPending: false,
    stopError: '',
    approvals: [],
    hasLoadedState: false,
  };
}

function sortOrder(
  conversations: Record<string, ChatConversationState>,
  ids: readonly string[],
): string[] {
  return [...ids].sort((leftId, rightId) => {
    const left = conversations[leftId];
    const right = conversations[rightId];
    return (
      (right?.summary.updatedAt ?? 0) -
        (left?.summary.updatedAt ?? 0) ||
      leftId.localeCompare(rightId)
    );
  });
}

function upsertMessage(
  messages: readonly ChatMessage[],
  incoming: ChatMessage,
): ChatMessage[] {
  const next = [...messages];
  const index = next.findIndex((message) => message.id === incoming.id);
  if (index === -1) {
    next.push(incoming);
  } else {
    const current = next[index];
    if (incoming.revision < current.revision) return next;
    if (
      incoming.revision === current.revision &&
      incoming.text.length < current.text.length
    ) {
      return next;
    }
    next[index] = incoming;
  }
  return next.sort(
    (left, right) =>
      left.order - right.order ||
      left.createdAt - right.createdAt ||
      left.id.localeCompare(right.id),
  );
}

function mergeMessages(
  current: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
): ChatMessage[] {
  let next = [...current];
  for (const message of incoming) {
    next = upsertMessage(next, message);
  }
  return next;
}

function isTerminal(status: ChatRunStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'stopped'
  );
}

/**
 * Shared acceptance rule for run state from every entrance (live event,
 * receipt, snapshot). Notification bookkeeping uses the same rule.
 */
export function isAcceptedRunUpdate(
  current: Pick<ChatRun, 'status' | 'revision'> | null | undefined,
  incoming: Pick<ChatRun, 'status' | 'revision'>,
): boolean {
  if (!current) return true;
  if (incoming.revision < current.revision) return false;
  if (isTerminal(current.status) && incoming.status === 'running') {
    return false;
  }
  if (
    isTerminal(current.status) &&
    incoming.revision === current.revision &&
    incoming.status !== current.status
  ) {
    return false;
  }
  return true;
}

function upsertRun(
  runs: Record<string, ChatRun>,
  incoming: ChatRun,
): Record<string, ChatRun> {
  const current = runs[incoming.id];
  if (!isAcceptedRunUpdate(current, incoming)) return runs;
  return { ...runs, [incoming.id]: incoming };
}

function sameReferences(
  left: readonly ChatReference[],
  right: readonly ChatReference[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((reference, index) => {
    const other = right[index];
    return (
      reference.id === other.id &&
      reference.invalid === other.invalid &&
      reference.name === other.name &&
      reference.displayPath === other.displayPath
    );
  });
}

function updateSummaryForRun(
  summary: ChatConversationSummary,
  run: ChatRun,
): ChatConversationSummary {
  return {
    ...summary,
    status: run.status,
    activeRunId:
      run.status === 'running'
        ? run.id
        : summary.activeRunId === run.id
          ? null
          : summary.activeRunId,
    updatedAt: Math.max(summary.updatedAt, run.finishedAt ?? run.startedAt ?? 0),
  };
}

function latestKnownRun(
  runs: Record<string, ChatRun>,
  messages: readonly ChatMessage[],
): ChatRun | null {
  return (
    Object.values(runs)
      .sort((left, right) =>
        compareRunRecency(left, right, messages),
      )
      .at(-1) ?? null
  );
}

function runStartTime(run: ChatRun): number {
  return run.startedAt ?? run.finishedAt ?? 0;
}

function runRoundOrder(
  run: ChatRun,
  messages: readonly ChatMessage[],
): number {
  let order = -1;
  for (const message of messages) {
    if (message.runId === run.id) {
      order = Math.max(order, message.order);
    }
  }
  return order;
}

/**
 * Orders runs by when the task started. A run's revision only describes
 * updates to that same run, so it is not used to compare different tasks.
 * When start times tie, the conversation message order (the existing round
 * order) decides; the run id is the final stable tie-breaker.
 */
export function compareRunRecency(
  left: ChatRun,
  right: ChatRun,
  messages: readonly ChatMessage[],
): number {
  const startDifference = runStartTime(left) - runStartTime(right);
  if (startDifference !== 0) return startDifference;
  const orderDifference =
    runRoundOrder(left, messages) - runRoundOrder(right, messages);
  if (orderDifference !== 0) return orderDifference;
  return left.id.localeCompare(right.id);
}

export function latestRunForConversation(
  conversation: ChatConversationState | null,
): ChatRun | null {
  return conversation
    ? latestKnownRun(conversation.runs, conversation.messages)
    : null;
}

function latestKnownMessage(
  messages: readonly ChatMessage[],
): ChatMessage | null {
  return (
    [...messages].sort(
      (left, right) =>
        left.order - right.order ||
        left.createdAt - right.createdAt ||
        left.id.localeCompare(right.id),
    ).at(-1) ?? null
  );
}

function summaryWithLocalState(
  base: ChatConversationSummary,
  runs: Record<string, ChatRun>,
  messages: readonly ChatMessage[],
  draft: string,
  references: readonly ChatReference[],
): ChatConversationSummary {
  const run = latestKnownRun(runs, messages);
  const message = latestKnownMessage(messages);
  return {
    ...base,
    status: run?.status ?? base.status,
    activeRunId: run
      ? run.status === 'running'
        ? run.id
        : null
      : base.activeRunId ?? null,
    updatedAt: Math.max(
      base.updatedAt,
      run?.finishedAt ?? run?.startedAt ?? 0,
      message?.createdAt ?? 0,
    ),
    messagePreview: message
      ? message.text.slice(0, 160)
      : base.messagePreview,
    hasDraft: draft.trim().length > 0 || references.length > 0,
  };
}

function submittedContentAfterAcceptance(
  conversation: ChatConversationState,
  submittedDraft: string,
  submittedReferences: readonly ChatReference[],
): {
  draft: string;
  references: ChatReference[];
  hasDraft: boolean;
} {
  const draftMatches = conversation.draft === submittedDraft;
  const refsMatch = sameReferences(
    conversation.references,
    submittedReferences,
  );
  return {
    draft: draftMatches ? '' : conversation.draft,
    references: refsMatch ? [] : conversation.references,
    hasDraft: draftMatches
      ? refsMatch
        ? false
        : conversation.references.length > 0
      : true,
  };
}

function updateConversation(
  state: ChatProjectState,
  conversationId: string,
  update: (conversation: ChatConversationState) => ChatConversationState,
): ChatProjectState {
  const current = state.conversations[conversationId];
  if (!current) return state;
  const next = update(current);
  if (next === current) return state;
  return {
    ...state,
    conversations: {
      ...state.conversations,
      [conversationId]: next,
    },
  };
}

function withConversation(
  state: ChatAppState,
  projectId: string,
  conversationId: string,
  updater: (conversation: ChatConversationState) => ChatConversationState,
): ChatAppState {
  const project = state.projects[projectId];
  if (!project || !project.conversations[conversationId]) return state;
  const nextProject = updateConversation(project, conversationId, updater);
  if (nextProject === project) return state;
  return {
    ...state,
    projects: {
      ...state.projects,
      [projectId]: nextProject,
    },
  };
}

function mergeApprovals(
  current: readonly ChatApproval[],
  incoming: readonly ChatApproval[] | undefined,
): ChatApproval[] {
  if (!incoming) return current.map((approval) => ({ ...approval }));
  const merged = new Map(
    incoming.map((approval) => [approval.id, { ...approval }]),
  );
  for (const existing of current) {
    const next = merged.get(existing.id);
    // A stale snapshot must never resurrect a decided/expired pending request.
    if (
      next &&
      existing.status !== 'pending' &&
      next.status === 'pending'
    ) {
      merged.set(existing.id, { ...existing });
      continue;
    }
    if (next && existing.status !== 'pending' && next.status !== existing.status) {
      merged.set(existing.id, { ...existing });
    }
  }
  return [...merged.values()].sort(
    (left, right) => left.createdAt - right.createdAt,
  );
}

function mergeSnapshot(
  current: ChatConversationState,
  snapshot: ChatConversationSnapshot,
): ChatConversationState {
  // Merge records first. The snapshot may have been captured before live
  // messages/runs arrived, so it must never replace a newer record set.
  const messages = mergeMessages(current.messages, snapshot.messages);
  const runs = snapshot.runs.reduce(
    (nextRuns, run) => upsertRun(nextRuns, run),
    current.runs,
  );
  const preserveLocalState = current.hasLoadedState;
  const draft = preserveLocalState ? current.draft : snapshot.draft;
  const references = preserveLocalState
    ? current.references
    : snapshot.references.map((reference) => ({ ...reference }));
  const base =
    snapshot.revision >= current.summary.revision
      ? summaryFromSnapshot(snapshot)
      : current.summary;
  const summary = summaryWithLocalState(
    {
      ...base,
      revision: Math.max(
        current.summary.revision,
        snapshot.revision,
      ),
      updatedAt: Math.max(
        current.summary.updatedAt,
        base.updatedAt,
      ),
    },
    runs,
    messages,
    draft,
    references,
  );
  return {
    ...current,
    summary,
    loadStatus: 'ready',
    loadError: '',
    hasLoadedState: true,
    stateRevision: Math.max(
      current.stateRevision,
      snapshot.stateRevision ?? 0,
    ),
    historyWarning: snapshot.historyWarning ?? '',
    messages,
    runs,
    draft,
    references,
    settings: preserveLocalState
      ? current.settings
      : { ...snapshot.settings },
    ui: preserveLocalState
      ? current.ui
      : {
          ...snapshot.ui,
          expandedRunIds: [...snapshot.ui.expandedRunIds],
        },
    attachmentBusy: false,
    pendingSubmission:
      snapshot.pendingSubmission ?? current.pendingSubmission,
    approvals: mergeApprovals(current.approvals, snapshot.approvals),
    sendStatus:
      snapshot.pendingSubmission && current.sendStatus === 'idle'
        ? 'unknown'
        : current.sendStatus,
    sendError:
      snapshot.pendingSubmission && !current.sendError
        ? '上次发送结果待核实'
        : current.sendError,
  };
}

function summaryFromSnapshot(
  snapshot: ChatConversationSnapshot,
): ChatConversationSummary {
  return {
    id: snapshot.id,
    projectId: snapshot.projectId,
    serviceId: snapshot.serviceId,
    serviceName: snapshot.serviceName,
    title: snapshot.title,
    updatedAt: snapshot.updatedAt,
    revision: snapshot.revision,
    status: snapshot.status,
    activeRunId: snapshot.activeRunId,
    messagePreview: snapshot.messagePreview,
    hasDraft: snapshot.hasDraft,
  };
}

function reconcileReference(
  reference: ChatReference,
  files: Map<string, { name: string; path: string }>,
  folders: Map<string, { name: string; path: string }>,
): ChatReference {
  if (reference.kind === 'attachment') return reference;
  const current =
    reference.kind === 'file'
      ? reference.fileIdentity
        ? files.get(reference.fileIdentity)
        : undefined
      : reference.directoryId
        ? folders.get(reference.directoryId)
        : undefined;
  if (!current) {
    if (reference.invalid) return reference;
    return { ...reference, invalid: true };
  }
  if (
    !reference.invalid &&
    reference.name === current.name &&
    reference.displayPath === current.path
  ) {
    return reference;
  }
  return {
    ...reference,
    name: current.name,
    displayPath: current.path,
    invalid: false,
  };
}

function reconcileReferenceList(
  references: readonly ChatReference[],
  files: Map<string, { name: string; path: string }>,
  folders: Map<string, { name: string; path: string }>,
): ChatReference[] {
  let changed = false;
  const next = references.map((reference) => {
    const updated = reconcileReference(reference, files, folders);
    if (updated !== reference) changed = true;
    return updated;
  });
  return changed ? next : (references as ChatReference[]);
}

function collectTreeReferences(
  entries: readonly FileTreeEntry[],
  parentPath = '',
): {
  files: Map<string, { name: string; path: string }>;
  folders: Map<string, { name: string; path: string }>;
} {
  const files = new Map<string, { name: string; path: string }>();
  const folders = new Map<string, { name: string; path: string }>();
  const visit = (
    list: readonly FileTreeEntry[],
    parent: string,
  ) => {
    for (const entry of list) {
      const path = parent ? `${parent}\\${entry.name}` : entry.name;
      if (entry.kind === 'folder') {
        folders.set(entry.id, { name: entry.name, path });
        if (entry.children) visit(entry.children, path);
      } else if (entry.fileIdentity) {
        files.set(entry.fileIdentity, {
          name: entry.name,
          path,
        });
      }
    }
  };
  visit(entries, parentPath);
  return { files, folders };
}

export function chatReducer(
  state: ChatAppState,
  action: ChatAction,
): ChatAppState {
  switch (action.type) {
    case 'context-loading':
      return {
        ...state,
        contextStatus: 'loading',
        contextError: '',
      };
    case 'context-ready':
      return {
        ...state,
        contextStatus: 'ready',
        context: action.context,
        contextError: '',
      };
    case 'context-error':
      return {
        ...state,
        contextStatus: 'error',
        contextError: action.message,
      };

    case 'ensure-project': {
      if (state.projects[action.projectId]) return state;
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.projectId]: createChatProjectState(),
        },
      };
    }

    case 'list-loading': {
      const project = ensureProject(state, action.projectId);
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.projectId]: {
            ...project,
            listStatus: 'loading',
            listError: '',
          },
        },
      };
    }

    case 'list-ready': {
      const project = ensureProject(state, action.projectId);
      const summaries = [...action.summaries].sort(
        (left, right) =>
          right.updatedAt - left.updatedAt ||
          right.id.localeCompare(left.id),
      );
      const conversations = { ...project.conversations };
      for (const summary of summaries) {
        const existing = conversations[summary.id];
        if (!existing) {
          conversations[summary.id] = conversationFromSummary(summary);
        } else if (summary.revision >= existing.summary.revision) {
          conversations[summary.id] = {
            ...existing,
            summary: summaryWithLocalState(
              {
                ...summary,
                revision: Math.max(
                  existing.summary.revision,
                  summary.revision,
                ),
              },
              existing.runs,
              existing.messages,
              existing.draft,
              existing.references,
            ),
          };
        }
      }
      const order = summaries.map((summary) => summary.id);
      const activeId =
        project.activeId && order.includes(project.activeId)
          ? project.activeId
          : order[0] ?? null;
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.projectId]: {
            ...project,
            listStatus: 'ready',
            listError: '',
            conversations,
            order,
            activeId,
          },
        },
      };
    }

    case 'list-error': {
      const project = ensureProject(state, action.projectId);
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.projectId]: {
            ...project,
            listStatus: 'error',
            listError: action.message,
          },
        },
      };
    }

    case 'conversation-loading': {
      const project = state.projects[action.projectId];
      if (!project?.conversations[action.conversationId]) return state;
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.projectId]: updateConversation(
            project,
            action.conversationId,
            (conversation) => ({
              ...conversation,
              loadStatus: 'loading',
              loadError: '',
            }),
          ),
        },
      };
    }

    case 'conversation-error': {
      const project = state.projects[action.projectId];
      if (!project?.conversations[action.conversationId]) return state;
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.projectId]: updateConversation(
            project,
            action.conversationId,
            (conversation) => ({
              ...conversation,
              loadStatus: 'error',
              loadError: action.message,
            }),
          ),
        },
      };
    }

    case 'conversation-snapshot': {
      const project = ensureProject(state, action.projectId);
      const current =
        project.conversations[action.snapshot.id] ??
        conversationFromSummary(summaryFromSnapshot(action.snapshot));
      const merged = mergeSnapshot(current, action.snapshot);
      const conversations = {
        ...project.conversations,
        [merged.summary.id]: merged,
      };
      const order = project.order.includes(merged.summary.id)
        ? project.order
        : sortOrder(conversations, [
            ...project.order,
            merged.summary.id,
          ]);
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.projectId]: {
            ...project,
            conversations,
            order,
            activeId: project.activeId ?? merged.summary.id,
            listStatus:
              project.listStatus === 'idle'
                ? 'ready'
                : project.listStatus,
            creating: false,
            createError: '',
          },
        },
      };
    }

    case 'conversation-summary': {
      const project = ensureProject(state, action.projectId);
      const existing = project.conversations[action.summary.id];
      if (existing && action.summary.revision < existing.summary.revision) {
        return state;
      }
      const mergedSummary = existing
        ? summaryWithLocalState(
            {
              ...existing.summary,
              ...action.summary,
              revision: Math.max(
                existing.summary.revision,
                action.summary.revision,
              ),
            },
            existing.runs,
            existing.messages,
            existing.draft,
            existing.references,
          )
        : action.summary;
      const conversations = {
        ...project.conversations,
        [action.summary.id]: existing
          ? {
              ...existing,
              summary: mergedSummary,
            }
          : conversationFromSummary(action.summary),
      };
      const nextOrder = project.order.includes(action.summary.id)
        ? project.order
        : [...project.order, action.summary.id];
      const order = sortOrder(conversations, nextOrder);
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.projectId]: {
            ...project,
            conversations,
            order,
            activeId: project.activeId ?? action.summary.id,
          },
        },
      };
    }

    case 'state-saved':
      return withConversation(
        state,
        action.projectId,
        action.conversationId,
        (conversation) => ({
          ...conversation,
          stateRevision: Math.max(
            conversation.stateRevision,
            action.stateRevision,
          ),
        }),
      );

    case 'project-state': {
      const project = state.projects[action.projectId];
      if (!project) return state;
      const activeId =
        action.activeConversationId &&
        project.conversations[action.activeConversationId]
          ? action.activeConversationId
          : project.activeId ?? project.order[0] ?? null;
      if (project.activeId === activeId) return state;
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.projectId]: {
            ...project,
            activeId,
          },
        },
      };
    }

    case 'select-conversation': {
      const project = state.projects[action.projectId];
      if (!project?.conversations[action.conversationId]) return state;
      if (project.activeId === action.conversationId) return state;
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.projectId]: {
            ...project,
            activeId: action.conversationId,
            createError: '',
          },
        },
      };
    }

    case 'create-start': {
      const project = ensureProject(state, action.projectId);
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.projectId]: {
            ...project,
            creating: true,
            createError: '',
          },
        },
      };
    }

    case 'create-error': {
      const project = ensureProject(state, action.projectId);
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.projectId]: {
            ...project,
            creating: false,
            createError: action.message,
          },
        },
      };
    }

    case 'draft':
      return withConversation(
        state,
        action.projectId,
        action.conversationId,
        (conversation) => {
          if (conversation.draft === action.draft) return conversation;
          return {
            ...conversation,
            draft: action.draft,
            summary: {
              ...conversation.summary,
              hasDraft:
                action.draft.trim().length > 0 ||
                conversation.references.length > 0,
            },
          };
        },
      );

    case 'references':
      return withConversation(
        state,
        action.projectId,
        action.conversationId,
        (conversation) => ({
          ...conversation,
          references: action.references.map((reference) => ({
            ...reference,
          })),
          summary: {
            ...conversation.summary,
            hasDraft:
              conversation.draft.trim().length > 0 ||
              action.references.length > 0,
          },
        }),
      );

    case 'settings':
      return withConversation(
        state,
        action.projectId,
        action.conversationId,
        (conversation) => ({
          ...conversation,
          settings: { ...action.settings },
        }),
      );

    case 'ui-state':
      return withConversation(
        state,
        action.projectId,
        action.conversationId,
        (conversation) => ({
          ...conversation,
          ui: { ...conversation.ui, ...action.patch },
        }),
      );

    case 'attachment-busy':
      return withConversation(
        state,
        action.projectId,
        action.conversationId,
        (conversation) => ({
          ...conversation,
          attachmentBusy: action.busy,
        }),
      );

    case 'send-start':
      return withConversation(
        state,
        action.projectId,
        action.conversationId,
        (conversation) => ({
          ...conversation,
          sendStatus: 'sending',
          sendError: '',
        }),
      );

    case 'send-error':
      return withConversation(
        state,
        action.projectId,
        action.conversationId,
        (conversation) => ({
          ...conversation,
          sendStatus: 'error',
          sendError: action.message,
        }),
      );

    case 'send-unknown':
      return withConversation(
        state,
        action.projectId,
        action.conversationId,
        (conversation) => ({
          ...conversation,
          sendStatus: 'unknown',
          sendError: action.message,
          pendingSubmission: action.pending,
        }),
      );

    case 'send-verifying':
      return withConversation(
        state,
        action.projectId,
        action.conversationId,
        (conversation) => ({
          ...conversation,
          sendStatus: 'verifying',
          sendError: '',
        }),
      );

    case 'send-reconcile-error':
      return withConversation(
        state,
        action.projectId,
        action.conversationId,
        (conversation) =>
          conversation.pendingSubmission
            ? {
                ...conversation,
                sendStatus: 'unknown',
                sendError: action.message,
              }
            : conversation,
      );

    case 'send-reconciled':
      return withConversation(
        state,
        action.projectId,
        action.conversationId,
        (conversation) => {
          const pending = conversation.pendingSubmission;
          if (!pending || pending.submissionId !== action.submissionId) {
            return conversation;
          }
          const cleared = submittedContentAfterAcceptance(
            conversation,
            pending.submittedDraft,
            pending.submittedReferences,
          );
          return {
            ...conversation,
            draft: cleared.draft,
            references: cleared.references,
            summary: {
              ...conversation.summary,
              hasDraft: cleared.hasDraft,
            },
            hasLoadedState: true,
            sendStatus: 'idle',
            sendError: '',
            pendingSubmission: null,
            stopPending: false,
            stopError: '',
          };
        },
      );

    case 'send-accepted':
      return withConversation(
        state,
        action.projectId,
        action.conversationId,
        (conversation) => {
          const runs = upsertRun(conversation.runs, action.run);
          const run = runs[action.run.id] ?? action.run;
          const cleared =
            (action.stateRevision ?? conversation.stateRevision) < conversation.stateRevision
              ? {
                  draft: conversation.draft,
                  references: conversation.references,
                  hasDraft: conversation.summary.hasDraft,
                }
              : submittedContentAfterAcceptance(
                  conversation,
                  action.submittedDraft,
                  action.submittedReferences,
                );
          return {
            ...conversation,
            messages: upsertMessage(
              conversation.messages,
              action.userMessage,
            ),
            runs,
            draft: cleared.draft,
            references: cleared.references,
            stateRevision: Math.max(conversation.stateRevision, action.stateRevision ?? 0),
            summary: updateSummaryForRun(
              {
                ...conversation.summary,
                hasDraft: cleared.hasDraft,
              },
              run,
            ),
            hasLoadedState: true,
            sendStatus: 'idle',
            sendError: '',
            pendingSubmission: null,
            stopPending: false,
            stopError: '',
          };
        },
      );

    case 'stop-start':
      return withConversation(
        state,
        action.projectId,
        action.conversationId,
        (conversation) => ({
          ...conversation,
          stopPending: true,
          stopError: '',
        }),
      );

    case 'stop-accepted':
      return withConversation(
        state,
        action.projectId,
        action.conversationId,
        (conversation) => ({
          ...conversation,
          stopPending: Object.values(conversation.runs).some(
            (run) => run.status === 'running',
          ),
          stopError: '',
        }),
      );

    case 'stop-error':
      return withConversation(
        state,
        action.projectId,
        action.conversationId,
        (conversation) => ({
          ...conversation,
          stopPending: false,
          stopError: action.message,
        }),
      );

    case 'message-update':
      return withConversation(
        state,
        action.projectId,
        action.conversationId,
        (conversation) => {
          const messages = upsertMessage(
            conversation.messages,
            action.message,
          );
          if (messages === conversation.messages) {
            return conversation;
          }
          const latest = messages[messages.length - 1];
          return {
            ...conversation,
            messages,
            summary: {
              ...conversation.summary,
              updatedAt: Math.max(
                conversation.summary.updatedAt,
                action.message.createdAt,
              ),
              messagePreview: latest?.text.slice(0, 160),
            },
          };
        },
      );

    case 'run-update':
      return withConversation(
        state,
        action.projectId,
        action.conversationId,
        (conversation) => {
          const runs = upsertRun(conversation.runs, action.run);
          if (runs === conversation.runs) return conversation;
          const run = runs[action.run.id] ?? action.run;
          const terminal = isTerminal(run.status);
          return {
            ...conversation,
            runs,
            summary: updateSummaryForRun(
              conversation.summary,
              run,
            ),
            stopPending: terminal ? false : conversation.stopPending,
            stopError: terminal ? '' : conversation.stopError,
          };
        },
      );

    case 'approvals-update':
      return withConversation(
        state,
        action.projectId,
        action.conversationId,
        (conversation) => ({
          ...conversation,
          approvals: action.approvals.map((approval) => ({
            ...approval,
          })),
        }),
      );

    case 'update': {
      const update = action.update;
      if (update.type === 'context') {
        return {
          ...state,
          contextStatus: 'ready',
          context: update.context,
          contextError: '',
        };
      }
      if (update.type === 'snapshot') {
        return chatReducer(state, {
          type: 'conversation-snapshot',
          projectId: update.projectId,
          snapshot: update.snapshot,
        });
      }
      if (update.type === 'conversation') {
        return chatReducer(state, {
          type: 'conversation-summary',
          projectId: update.projectId,
          summary: update.summary,
        });
      }
      if (update.type === 'message') {
        return chatReducer(state, {
          type: 'message-update',
          projectId: update.projectId,
          conversationId: update.conversationId,
          message: update.message,
        });
      }
      if (update.type === 'approvals') {
        return chatReducer(state, {
          type: 'approvals-update',
          projectId: update.projectId,
          conversationId: update.conversationId,
          approvals: update.approvals,
        });
      }
      return chatReducer(state, {
        type: 'run-update',
        projectId: update.projectId,
        conversationId: update.conversationId,
        run: update.run,
      });
    }

    case 'reconcile-references': {
      const project = state.projects[action.projectId];
      if (!project) return state;
      const { files, folders } = collectTreeReferences(action.entries);
      let changed = false;
      const conversations: Record<string, ChatConversationState> = {};
      for (const [id, conversation] of Object.entries(
        project.conversations,
      )) {
        const references = reconcileReferenceList(
          conversation.references,
          files,
          folders,
        );
        let messages = conversation.messages;
        if (conversation.messages.some((message) => message.references?.length)) {
          messages = conversation.messages.map((message) =>
            message.references?.length
              ? {
                  ...message,
                  references: reconcileReferenceList(
                    message.references,
                    files,
                    folders,
                  ),
                }
              : message,
          );
        }
        if (
          references === conversation.references &&
          messages === conversation.messages
        ) {
          conversations[id] = conversation;
          continue;
        }
        changed = true;
        conversations[id] = {
          ...conversation,
          references,
          messages,
        };
      }
      if (!changed) return state;
      return {
        ...state,
        projects: {
          ...state.projects,
          [action.projectId]: {
            ...project,
            conversations,
          },
        },
      };
    }

    default:
      return state;
  }
}

export function activeChatConversation(
  project: ChatProjectState | null | undefined,
): ChatConversationState | null {
  if (!project?.activeId) return null;
  return project.conversations[project.activeId] ?? null;
}

export function activeRunForConversation(
  conversation: ChatConversationState | null,
): ChatRun | null {
  if (!conversation) return null;
  return (
    Object.values(conversation.runs)
      .filter((run) => run.status === 'running')
      .sort((left, right) =>
        compareRunRecency(left, right, conversation.messages),
      )
      .at(-1) ?? null
  );
}

export function unsettledRunForConversation(
  conversation: ChatConversationState | null,
): ChatRun | null {
  if (!conversation) return null;
  return (
    Object.values(conversation.runs)
      .filter(
        (run) =>
          run.status === 'running' || run.status === 'unknown',
      )
      .sort((left, right) =>
        compareRunRecency(left, right, conversation.messages),
      )
      .at(-1) ?? null
  );
}

export function chatReferenceKey(reference: ChatReference): string {
  return reference.id;
}

export function hasTaskExecution(run: ChatRun): boolean {
  if (run.task !== undefined) return run.task;
  return Boolean(run.tools?.length) || Boolean(run.steps?.length);
}

export function isTerminalRun(status: ChatRunStatus): boolean {
  return isTerminal(status);
}

export function chatRunStatusLabel(
  status: ChatRunStatus | 'idle',
): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '已失败';
    case 'stopped':
      return '已停止';
    case 'unknown':
      return '状态待核实';
    default:
      return '草稿';
  }
}
