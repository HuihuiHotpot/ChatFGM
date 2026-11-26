/**
 * Shared bounds for the Step 6 chat input and history paths. These are also
 * documented in docs/backend-development.md.
 */
export const CHAT_LIMITS = {
  messageChars: 64 * 1024,
  referencesPerMessage: 32,
  attachmentsPerMessage: 8,
  textAttachmentBytes: 1024 * 1024,
  imageAttachmentBytes: 10 * 1024 * 1024,
  imageDimension: 8192,
  screenshotImageBytes: 24 * 1024 * 1024,
  composedTextBytes: 6 * 1024 * 1024,
  directoryEntries: 200,
  directoryListBytes: 64 * 1024,
  draftChars: 256 * 1024,
  titleChars: 80,
  historyTurns: 500,
  historyItems: 20_000,
  historyJsonBytes: 64 * 1024 * 1024,
  previewTokens: 256,
  previewTokenTtlMs: 60 * 60 * 1000,
  runtimeNameChars: 120,
} as const;

export class ChatLimitError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ChatLimitError';
    this.code = code;
  }
}

export function enforceTextLimit(
  value: string,
  limit: number,
  label: string,
): string {
  if (typeof value !== 'string') {
    throw new ChatLimitError('chat-invalid-input', `${label}必须是文本。`);
  }
  if (value.length > limit) {
    throw new ChatLimitError(
      'chat-input-limit',
      `${label}超过 ${limit} 字符上限，未发送且未截断。`,
    );
  }
  if (value.includes('\u0000')) {
    throw new ChatLimitError(
      'chat-invalid-input',
      `${label}包含不允许的控制字符。`,
    );
  }
  return value;
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
