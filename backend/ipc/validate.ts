import { DESKTOP_IPC_CHANNELS } from './contracts';
import {
  isValidToolboxFolderName,
  MAX_TOOLBOX_NAME,
  toolboxNameError,
} from '../toolboxes/name';

export class IpcArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpcArgumentError';
  }
}

function fail(message: string): never {
  throw new IpcArgumentError(message);
}

function toolboxName(
  object: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const bounded = boundedText(object, key, label, MAX_TOOLBOX_NAME);
  if (!isValidToolboxFolderName(bounded)) fail(toolboxNameError(label));
  return bounded;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label}必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function text(
  object: Record<string, unknown>,
  key: string,
  label: string,
  options: { allowEmpty?: boolean; nullAsUndefined?: boolean } = {},
): string | null | undefined {
  const value = object[key];
  if (value === undefined) {
    if (options.nullAsUndefined) return undefined;
    fail(`${label}缺失。`);
  }
  if (value === null) {
    if (options.nullAsUndefined) return null;
    fail(`${label}不能为 null。`);
  }
  if (typeof value !== 'string') fail(`${label}必须是字符串。`);
  if (!options.allowEmpty && value.length === 0) fail(`${label}不能为空。`);
  return value;
}

function boolean(
  object: Record<string, unknown>,
  key: string,
  label: string,
  optional = false,
): boolean | undefined {
  const value = object[key];
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'boolean') fail(`${label}必须是布尔值。`);
  return value;
}

function oneOf(
  object: Record<string, unknown>,
  key: string,
  label: string,
  values: readonly string[],
): string {
  const value = object[key];
  if (typeof value !== 'string' || !values.includes(value)) {
    fail(`${label}必须是 ${values.join(' / ')} 之一。`);
  }
  return value;
}

function folderSelection(value: unknown): void {
  const folder = record(value, 'folder');
  text(folder, 'path', 'folder.path');
  text(folder, 'pathKey', 'folder.pathKey');
  text(folder, 'name', 'folder.name');
}

function projectIdentity(value: unknown): Record<string, unknown> {
  const input = record(value, '请求');
  text(input, 'projectId', 'projectId');
  return input;
}

function integerArray(
  value: unknown,
  label: string,
): number[] {
  if (!Array.isArray(value) || value.length > 2) {
    fail(`${label}必须是长度不超过 2 的整数数组。`);
  }
  for (const item of value) {
    if (!Number.isSafeInteger(item) || item < 0) {
      fail(`${label}必须只包含安全的非负整数。`);
    }
  }
  return value as number[];
}

function nonnegativeInteger(
  object: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = object[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label}必须是安全的非负整数。`);
  }
  return value as number;
}

function workspaceObject(
  input: Record<string, unknown>,
  key: string,
  label: string,
): void {
  record(input[key], label);
}

function boundedText(
  object: Record<string, unknown>,
  key: string,
  label: string,
  max: number,
  allowEmpty = false,
): string {
  const value = text(object, key, label, { allowEmpty });
  if (value === undefined || value === null) fail(`${label} 无效。`);
  if (value.length > max) fail(`${label} 超过长度限制。`);
  if (
    value.includes('\u0000') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    fail(`${label} 包含非法控制字符。`);
  }
  return value;
}

function settingsServiceDraft(value: unknown): void {
  const service = record(value, 'settings service');
  boundedText(service, 'id', 'service.id', 128);
  boundedText(service, 'name', 'service.name', 120);
  boundedText(service, 'baseUrl', 'service.baseUrl', 4096);
  if (service.key !== undefined) {
    boundedText(service, 'key', 'service.key', 4096, true);
  }
}

function chatReferences(value: unknown): void {
  if (!Array.isArray(value) || value.length > 32) {
    fail('对话引用数量超过限制。');
  }
  for (const item of value) {
    const reference = record(item, 'chat reference');
    boundedText(reference, 'id', 'reference.id', 300);
    oneOf(reference, 'kind', 'reference.kind', [
      'file',
      'folder',
      'attachment',
    ]);
    boundedText(reference, 'name', 'reference.name', 300);
    boundedText(
      reference,
      'displayPath',
      'reference.displayPath',
      2000,
      true,
    );
    if (reference.fileIdentity !== undefined) {
      boundedText(
        reference,
        'fileIdentity',
        'reference.fileIdentity',
        128,
      );
    }
    if (reference.directoryId !== undefined) {
      boundedText(
        reference,
        'directoryId',
        'reference.directoryId',
        128,
      );
    }
    if (reference.attachmentId !== undefined) {
      boundedText(
        reference,
        'attachmentId',
        'reference.attachmentId',
        128,
      );
    }
    if (reference.mime !== undefined) {
      boundedText(reference, 'mime', 'reference.mime', 200, true);
    }
    if (reference.invalid !== undefined) {
      boolean(reference, 'invalid', 'reference.invalid');
    }
  }
}

function chatSettings(value: unknown): void {
  const settings = record(value, 'chat settings');
  boundedText(settings, 'modelId', 'settings.modelId', 200, true);
  if (settings.effortId !== null && settings.effortId !== undefined) {
    boundedText(settings, 'effortId', 'settings.effortId', 100);
  }
  boundedText(settings, 'permissionId', 'settings.permissionId', 64);
  for (const key of [
    'modelLabel',
    'effortLabel',
    'permissionLabel',
  ] as const) {
    if (settings[key] !== undefined) {
      boundedText(settings, key, `settings.${key}`, 200, true);
    }
  }
}

function chatUiState(value: unknown): void {
  const ui = record(value, 'chat ui');
  if (
    typeof ui.scrollTop !== 'number' ||
    !Number.isFinite(ui.scrollTop) ||
    ui.scrollTop < 0
  ) {
    fail('ui.scrollTop 必须是非负有限数值。');
  }
  boolean(ui, 'followLatest', 'ui.followLatest');
  if (!Array.isArray(ui.expandedRunIds) || ui.expandedRunIds.length > 100) {
    fail('ui.expandedRunIds 必须是有限的数组。');
  }
  for (const id of ui.expandedRunIds) {
    if (typeof id !== 'string' || id.length > 128) {
      fail('ui.expandedRunIds 包含无效标识。');
    }
  }
}

export function validateDesktopRequest(
  channel: string,
  args: readonly unknown[],
): void {
  switch (channel) {
    case DESKTOP_IPC_CHANNELS.getStartupInfo:
    case DESKTOP_IPC_CHANNELS.loadRecentProjects:
    case DESKTOP_IPC_CHANNELS.listToolboxes:
      if (args.length !== 0) fail('该请求不接受参数。');
      return;

    case DESKTOP_IPC_CHANNELS.pickProjectFolder: {
      if (args.length !== 1) fail('选择文件夹请求参数数量无效。');
      if (typeof args[0] !== 'string') fail('purpose 必须是字符串。');
      oneOf({ purpose: args[0] }, 'purpose', 'purpose', ['create', 'open']);
      return;
    }

    case DESKTOP_IPC_CHANNELS.createProject: {
      const input = record(args[0], 'createProject');
      if (input.replaceProjectId !== undefined) boundedText(input, 'replaceProjectId', 'replaceProjectId', 200);
      if (input.replaceProjectIds !== undefined) {
        if (!Array.isArray(input.replaceProjectIds) || input.replaceProjectIds.length > 1000 ||
          input.replaceProjectIds.some((id) => typeof id !== 'string' || !id || id.length > 200) ||
          new Set(input.replaceProjectIds).size !== input.replaceProjectIds.length) {
          fail('确认清除的项目标识集合无效。');
        }
      }
      if (input.confirmOverwrite !== undefined) {
        boolean(input, 'confirmOverwrite', 'confirmOverwrite');
      }
      folderSelection(input.folder);
      toolboxName(input, 'toolboxId', 'toolboxId');
      return;
    }

    case DESKTOP_IPC_CHANNELS.openProject: {
      const input = record(args[0], 'openProject');
      text(input, 'path', 'path');
      text(input, 'pathKey', 'pathKey');
      return;
    }

    case DESKTOP_IPC_CHANNELS.getProjectAvailability: {
      projectIdentity(args[0]);
      return;
    }

    case DESKTOP_IPC_CHANNELS.readFile: {
      const input = projectIdentity(args[0]);
      text(input, 'fileIdentity', 'fileIdentity');
      return;
    }

    case DESKTOP_IPC_CHANNELS.resolveProjectFileLink: {
      const input = projectIdentity(args[0]);
      text(input, 'href', '文件链接');
      return;
    }

    case DESKTOP_IPC_CHANNELS.readBinaryResource: {
      const input = projectIdentity(args[0]);
      text(input, 'fileIdentity', 'fileIdentity');
      if (input.relativePath !== undefined) {
        text(input, 'relativePath', 'relativePath');
      }
      return;
    }

    case DESKTOP_IPC_CHANNELS.getHtmlPreviewUrl: {
      const input = projectIdentity(args[0]);
      text(input, 'fileIdentity', 'fileIdentity');
      return;
    }

    case DESKTOP_IPC_CHANNELS.releaseHtmlPreview: {
      const input = projectIdentity(args[0]);
      text(input, 'fileIdentity', 'fileIdentity');
      text(input, 'handle', 'handle');
      return;
    }

    case DESKTOP_IPC_CHANNELS.listH5Datasets: {
      const input = projectIdentity(args[0]);
      text(input, 'fileIdentity', 'fileIdentity');
      return;
    }

    case DESKTOP_IPC_CHANNELS.readH5DatasetRange: {
      const input = projectIdentity(args[0]);
      text(input, 'fileIdentity', 'fileIdentity');
      text(input, 'datasetPath', 'datasetPath');
      if (!Array.isArray(input.start)) {
        fail('start 必须是整数数组。');
      }
      if (!Array.isArray(input.shape)) {
        fail('shape 必须是整数数组。');
      }
      const start = integerArray(input.start, 'start');
      const shape = integerArray(input.shape, 'shape');
      if (start.length !== shape.length) {
        fail('start 与 shape 的维度必须一致。');
      }
      return;
    }

    case DESKTOP_IPC_CHANNELS.createEntry: {
      const input = projectIdentity(args[0]);
      const parent = input.parentId;
      if (parent !== null && typeof parent !== 'string') {
        fail('parentId 必须是字符串或 null。');
      }
      if (parent === '') fail('parentId 不能为空字符串。');
      text(input, 'name', 'name');
      oneOf(input, 'kind', 'kind', ['file', 'folder']);
      return;
    }

    case DESKTOP_IPC_CHANNELS.renameEntry: {
      const input = projectIdentity(args[0]);
      text(input, 'entryId', 'entryId');
      text(input, 'name', 'name');
      return;
    }

    case DESKTOP_IPC_CHANNELS.deleteEntry: {
      const input = projectIdentity(args[0]);
      text(input, 'entryId', 'entryId');
      return;
    }

    case DESKTOP_IPC_CHANNELS.pasteEntry: {
      const input = projectIdentity(args[0]);
      const target = input.targetFolderId;
      if (target !== null && typeof target !== 'string') {
        fail('targetFolderId 必须是字符串或 null。');
      }
      if (target === '') fail('targetFolderId 不能为空字符串。');
      text(input, 'sourceEntryId', 'sourceEntryId');
      oneOf(input, 'mode', 'mode', ['cut', 'copy']);
      return;
    }

    case DESKTOP_IPC_CHANNELS.copyText: {
      if (args.length !== 1) fail('复制请求参数数量无效。');
      if (typeof args[0] !== 'string') fail('复制内容必须是字符串。');
      return;
    }

    case DESKTOP_IPC_CHANNELS.revealPath: {
      const input = projectIdentity(args[0]);
      text(input, 'path', 'path');
      boolean(input, 'isDirectory', 'isDirectory');
      return;
    }

    case DESKTOP_IPC_CHANNELS.saveFile: {
      const input = projectIdentity(args[0]);
      text(input, 'fileIdentity', 'fileIdentity');
      text(input, 'path', 'path');
      text(input, 'content', 'content', { allowEmpty: true });
      if (input.expectedVersion !== undefined) {
        text(input, 'expectedVersion', 'expectedVersion');
      }
      if (input.bom !== undefined) {
        boolean(input, 'bom', 'bom');
      }
      if (input.newline !== undefined) {
        oneOf(input, 'newline', 'newline', ['\n', '\r\n', '\r']);
      }
      if (input.force !== undefined) {
        boolean(input, 'force', 'force');
      }
      return;
    }

    case DESKTOP_IPC_CHANNELS.saveFileAs: {
      const input = projectIdentity(args[0]);
      if (input.fileIdentity !== undefined) {
        text(input, 'fileIdentity', 'fileIdentity');
      }
      boundedText(input, 'name', 'name', 255);
      text(input, 'content', 'content', { allowEmpty: true });
      return;
    }

    case DESKTOP_IPC_CHANNELS.bindProjectToolbox: {
      const input = projectIdentity(args[0]);
      toolboxName(input, 'toolboxId', 'toolboxId');
      return;
    }

    case DESKTOP_IPC_CHANNELS.flushProjectSync: {
      projectIdentity(args[0]);
      return;
    }

    case DESKTOP_IPC_CHANNELS.listRunningTasks: {
      if (args.length !== 1) fail('任务查询参数数量无效。');
      if (typeof args[0] !== 'string' || args[0].length === 0) {
        fail('projectId 必须是非空字符串。');
      }
      return;
    }

    case DESKTOP_IPC_CHANNELS.stopTask: {
      const input = projectIdentity(args[0]);
      text(input, 'taskId', 'taskId');
      if (input.conversationId !== undefined) {
        text(input, 'conversationId', 'conversationId');
      }
      if (input.runId !== undefined) {
        text(input, 'runId', 'runId');
      }
      return;
    }

    case DESKTOP_IPC_CHANNELS.loadWorkspaceLayout: {
      if (args.length !== 0) fail('布局读取不接受参数。');
      return;
    }

    case DESKTOP_IPC_CHANNELS.saveWorkspaceLayout: {
      const input = record(args[0], 'saveWorkspaceLayout');
      workspaceObject(input, 'snapshot', 'snapshot');
      nonnegativeInteger(input, 'expectedRevision', 'expectedRevision');
      return;
    }

    case DESKTOP_IPC_CHANNELS.loadProjectWorkspace: {
      projectIdentity(args[0]);
      return;
    }

    case DESKTOP_IPC_CHANNELS.saveProjectWorkspace: {
      const input = projectIdentity(args[0]);
      workspaceObject(input, 'snapshot', 'snapshot');
      nonnegativeInteger(input, 'expectedRevision', 'expectedRevision');
      return;
    }

    case DESKTOP_IPC_CHANNELS.respondQuit: {
      const input = record(args[0], 'respondQuit');
      boolean(input, 'allow', 'allow');
      return;
    }

    case DESKTOP_IPC_CHANNELS.quitReady: {
      if (args.length !== 0) fail('退出就绪通知不接受参数。');
      return;
    }

    case DESKTOP_IPC_CHANNELS.getSettingsSnapshot:
    case DESKTOP_IPC_CHANNELS.pickCliExecutable:
    case DESKTOP_IPC_CHANNELS.startChatGptLogin:
    case DESKTOP_IPC_CHANNELS.cancelChatGptLogin:
    case DESKTOP_IPC_CHANNELS.logoutChatGpt:
    case DESKTOP_IPC_CHANNELS.scanSettingsToolboxes:
    case DESKTOP_IPC_CHANNELS.cancelSettingsPendingOperations: {
      if (args.length !== 0) fail('该设置操作不接受参数。');
      return;
    }

    case DESKTOP_IPC_CHANNELS.saveSettings: {
      const input = record(args[0], 'settings');
      const cli = record(input.cli, 'settings.cli');
      boundedText(cli, 'path', 'settings.cli.path', 4096, true);
      const models = record(input.models, 'settings.models');
      oneOf(models, 'mode', 'settings.models.mode', ['chatgpt', 'api']);
      const active = models.activeServiceId;
      if (active !== null && typeof active !== 'string') {
        fail('activeServiceId 必须是字符串或 null。');
      }
      if (typeof active === 'string' && active.length > 128) {
        fail('activeServiceId 超过长度限制。');
      }
      if (!Array.isArray(models.services) || models.services.length > 16) {
        fail('服务数量超过限制。');
      }
      for (const service of models.services) settingsServiceDraft(service);
      const toolboxes = record(input.toolboxes, 'settings.toolboxes');
      if (
        !Array.isArray(toolboxes.environments) ||
        toolboxes.environments.length > 64
      ) {
        fail('工具箱环境数量超过限制。');
      }
      for (const entry of toolboxes.environments) {
        const environment = record(entry, 'toolbox environment');
        toolboxName(environment, 'toolboxId', 'toolboxId');
        boundedText(
          environment,
          'environmentPath',
          'environmentPath',
          4096,
          true,
        );
      }
      return;
    }

    case DESKTOP_IPC_CHANNELS.detectCli: {
      const input = record(args[0], 'detectCli');
      boundedText(input, 'path', 'path', 4096);
      return;
    }

    case DESKTOP_IPC_CHANNELS.pickToolboxEnvironment: {
      const input = record(args[0], 'pickToolboxEnvironment');
      toolboxName(input, 'toolboxId', 'toolboxId');
      return;
    }

    case DESKTOP_IPC_CHANNELS.detectToolboxEnvironment: {
      const input = record(args[0], 'detectToolboxEnvironment');
      toolboxName(input, 'toolboxId', 'toolboxId');
      boundedText(input, 'path', 'path', 4096);
      return;
    }

    case DESKTOP_IPC_CHANNELS.testSettingsService: {
      const input = record(args[0], 'testSettingsService');
      settingsServiceDraft(input.service);
      boolean(input, 'keepSavedKey', 'keepSavedKey');
      return;
    }

    case DESKTOP_IPC_CHANNELS.getChatContext: {
      const input = record(args[0], 'getChatContext');
      if (input.projectId !== undefined) {
        boundedText(input, 'projectId', 'projectId', 64);
      }
      return;
    }

    case DESKTOP_IPC_CHANNELS.listChatConversations:
    case DESKTOP_IPC_CHANNELS.createChatConversation: {
      const input = projectIdentity(args[0]);
      void input;
      return;
    }

    case DESKTOP_IPC_CHANNELS.loadChatConversation: {
      const input = projectIdentity(args[0]);
      boundedText(input, 'conversationId', 'conversationId', 128);
      return;
    }

    case DESKTOP_IPC_CHANNELS.getChatProjectState: {
      projectIdentity(args[0]);
      return;
    }

    case DESKTOP_IPC_CHANNELS.setActiveChatConversation: {
      const input = projectIdentity(args[0]);
      boundedText(input, 'conversationId', 'conversationId', 128);
      nonnegativeInteger(input, 'expectedRevision', 'expectedRevision');
      return;
    }

    case DESKTOP_IPC_CHANNELS.selectChatAttachment: {
      const input = projectIdentity(args[0]);
      boundedText(input, 'conversationId', 'conversationId', 128);
      oneOf(input, 'kind', 'kind', ['file', 'image', 'screenshot']);
      return;
    }

    case DESKTOP_IPC_CHANNELS.releaseChatAttachmentPreview: {
      const input = projectIdentity(args[0]);
      const token = boundedText(input, 'token', 'token', 64);
      if (!/^[a-f0-9]{48}$/.test(token)) {
        fail('token 格式无效。');
      }
      return;
    }

    case DESKTOP_IPC_CHANNELS.stopChatRun: {
      const input = projectIdentity(args[0]);
      boundedText(input, 'conversationId', 'conversationId', 128);
      boundedText(input, 'runId', 'runId', 128);
      return;
    }

    case DESKTOP_IPC_CHANNELS.respondChatApproval: {
      const input = projectIdentity(args[0]);
      boundedText(input, 'conversationId', 'conversationId', 128);
      boundedText(input, 'approvalId', 'approvalId', 128);
      oneOf(input, 'decision', 'decision', ['approve', 'deny']);
      return;
    }

    case DESKTOP_IPC_CHANNELS.saveChatConversationState: {
      const input = projectIdentity(args[0]);
      boundedText(input, 'conversationId', 'conversationId', 128);
      text(input, 'draft', 'draft', { allowEmpty: true });
      chatReferences(input.references);
      chatSettings(input.settings);
      chatUiState(input.ui);
      if (input.expectedStateRevision !== undefined) {
        nonnegativeInteger(
          input,
          'expectedStateRevision',
          'expectedStateRevision',
        );
      }
      return;
    }

    case DESKTOP_IPC_CHANNELS.sendChatMessage: {
      const input = projectIdentity(args[0]);
      boundedText(input, 'conversationId', 'conversationId', 128);
      boundedText(input, 'submissionId', 'submissionId', 200);
      text(input, 'text', 'text', { allowEmpty: true });
      chatReferences(input.references);
      chatSettings(input.settings);
      boundedText(input, 'serviceId', 'serviceId', 128);
      if (input.serviceName !== undefined) {
        text(input, 'serviceName', 'serviceName', { allowEmpty: true });
      }
      return;
    }

    default:
      fail('未知的桌面操作。');
  }
}

