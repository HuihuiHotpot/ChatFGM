import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { ApplicationDatabase } from '../storage/database';
import { assertNoLinks } from '../filesystem/path-policy';

interface CleanupFile {
  project_id: string;
  conversation_id: string;
  storage_name: string;
  sha256: string;
  byte_size: number;
}

/** Exact attachment rows survive the project cascade until their file cleanup
 * succeeds. Never scan a project/cache directory to guess what can be deleted.
 */
export class ProjectResourceCleanup {
  constructor(
    private readonly database: ApplicationDatabase,
    private readonly attachmentRoot?: string,
  ) {}

  plan(projectIds: readonly string[], replacementId: string): void {
    for (const id of projectIds) {
      // Carry forward an already-authorized pending cleanup if its replacement
      // project is itself replaced. File ownership always remains the old ID.
      this.database.prepare(`UPDATE project_resource_cleanup
        SET replacement_project_id=? WHERE replacement_project_id=?`).run(replacementId, id);
      const files = this.database.prepare(`
        SELECT a.*, c.project_id AS owner FROM chat_attachments a
        JOIN chat_conversations c ON c.id = a.conversation_id
        WHERE c.project_id = ?
      `).all(id) as unknown as Array<CleanupFile & { owner: string }>;
      for (const file of files) {
        if (file.owner !== file.project_id) throw new Error('附件归属不一致，未清除旧项目。');
        this.database.prepare(`
          INSERT INTO project_resource_cleanup
            (replacement_project_id,project_id,conversation_id,storage_name,sha256,byte_size)
          VALUES (?,?,?,?,?,?)
        `).run(replacementId, id, file.conversation_id, file.storage_name, file.sha256, file.byte_size);
      }
    }
  }

  flush(replacementId: string): string | undefined {
    const files = this.database.prepare(
      'SELECT * FROM project_resource_cleanup WHERE replacement_project_id = ?',
    ).all(replacementId) as unknown as CleanupFile[];
    for (const file of files) {
      try {
        this.remove(file);
        this.database.prepare(`DELETE FROM project_resource_cleanup
          WHERE project_id=? AND conversation_id=? AND storage_name=?
        `).run(file.project_id, file.conversation_id, file.storage_name);
      } catch (error) {
        this.database.prepare(`UPDATE project_resource_cleanup SET last_error=?
          WHERE project_id=? AND conversation_id=? AND storage_name=?
        `).run(error instanceof Error ? error.message : '资源清理失败',
          file.project_id, file.conversation_id, file.storage_name);
      }
    }
    const remaining = this.database.prepare(
      'SELECT COUNT(*) AS count FROM project_resource_cleanup WHERE replacement_project_id=?',
    ).get(replacementId) as { count: number };
    return remaining.count > 0
      ? `新项目已创建，旧项目记录已清除；仍有 ${remaining.count} 个旧附件未能安全清理。请重试清理，原路径不会再次初始化。`
      : undefined;
  }

  private remove(file: CleanupFile): void {
    if (!this.attachmentRoot || !path.isAbsolute(this.attachmentRoot)) throw new Error('附件存储根目录未配置。');
    for (const segment of [file.project_id, file.conversation_id]) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(segment)) throw new Error('附件归属标识无效。');
    }
    if (!/^[A-Za-z0-9-]+\.[A-Za-z0-9]{1,12}$/.test(file.storage_name) ||
      !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('附件清理记录无效。');
    if (this.database.prepare('SELECT id FROM projects WHERE id=?').get(file.project_id)) {
      throw new Error('附件所属旧项目尚未清除。');
    }
    try {
      if (lstatSync(this.attachmentRoot).isSymbolicLink()) throw new Error('附件根目录是链接，已保留。');
      const absolute = path.join(this.attachmentRoot, file.project_id, file.conversation_id, file.storage_name);
      assertNoLinks(this.attachmentRoot, absolute);
      const before = lstatSync(absolute);
      if (!before.isFile() || before.size !== file.byte_size ||
        createHash('sha256').update(readFileSync(absolute)).digest('hex') !== file.sha256) {
        throw new Error('附件内容或身份已改变，已保留。');
      }
      const after = lstatSync(absolute);
      if (after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs) {
        throw new Error('附件在清理期间发生变化，已保留。');
      }
      unlinkSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
