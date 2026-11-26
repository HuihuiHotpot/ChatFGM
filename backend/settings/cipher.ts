import { safeStorage } from 'electron';
import { SettingsStoreError } from './store';
import type { SecretCipher } from './store';

const PREFIX = 'safeStorage:v1:';

/**
 * Production secret protection. There is deliberately no plaintext fallback:
 * when Windows/Electron encryption is unavailable, the caller must surface an
 * error and leave any previously saved ciphertext untouched.
 */
export class SafeStorageCipher implements SecretCipher {
  isAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  encrypt(value: string): string {
    if (!this.isAvailable()) {
      throw new SettingsStoreError(
        'settings-encryption-unavailable',
        'Windows 系统加密不可用，无法保存 API Key；不会降级为明文保存。',
      );
    }
    try {
      return `${PREFIX}${safeStorage.encryptString(value).toString('base64')}`;
    } catch (error) {
      throw new SettingsStoreError(
        'settings-encryption-failed',
        'API Key 加密失败，配置和旧密钥均未修改。',
        { cause: error },
      );
    }
  }

  decrypt(value: string): string {
    if (!value.startsWith(PREFIX)) {
      throw new SettingsStoreError(
        'settings-key-unreadable',
        '已保存的 API Key 格式无效，无法解密；请重新输入密钥。',
      );
    }
    if (!this.isAvailable()) {
      throw new SettingsStoreError(
        'settings-encryption-unavailable',
        'Windows 系统加密不可用，无法读取已保存的 API Key。',
      );
    }
    try {
      const encrypted = Buffer.from(value.slice(PREFIX.length), 'base64');
      return safeStorage.decryptString(encrypted);
    } catch (error) {
      throw new SettingsStoreError(
        'settings-key-unreadable',
        '已保存的 API Key 无法解密；请重新输入密钥，旧密钥未被覆盖。',
        { cause: error },
      );
    }
  }
}
