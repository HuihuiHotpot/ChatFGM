import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { Logger } from '../platform/log';
import { initializeSkeleton } from '../filesystem/operations';
import { isDirectoryEmpty } from '../filesystem/path-policy';

interface CreationJournal {
  target: string;
  stage: string;
  backup: string;
  projectId: string;
  originalIdentity: string;
  stageIdentity: string;
  /** True when the original target contained files that are fully replaced. */
  replaceExisting?: boolean;
}

export function pendingCreationTargets(journalRoot: string): string[] {
  if (!existsSync(journalRoot)) return [];
  return readdirSync(journalRoot).filter((name) => name.endsWith('.json')).map((name) => {
    const journal = JSON.parse(readFileSync(path.join(journalRoot, name), 'utf8')) as CreationJournal;
    if (typeof journal.target !== 'string' || !path.isAbsolute(journal.target) ||
      name !== `${createHash('sha256').update(journal.target.toLowerCase()).digest('hex')}.json`) {
      throw new Error('项目初始化恢复记录的目标路径无效，已保留所有文件。');
    }
    return journal.target;
  });
}

function identity(directory: string): string | null {
  if (!existsSync(directory)) return null;
  const stat = lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  return `${stat.dev}:${stat.ino}`;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Windows can transiently refuse a directory rename while a just-written file
 * is still being closed or scanned. Retry the sharing violation briefly; a
 * persistent failure still propagates and the journal keeps recovery possible.
 */
function renameDirectoryWithRetry(source: string, target: string): void {
  const delays = [40, 80, 120, 200];
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient =
        code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!transient || attempt >= delays.length) throw error;
      sleepSync(delays[attempt]);
    }
  }
}

function nonEmptyDuringCreationError(): Error & { code: string } {
  const error = new Error(
    '所选文件夹已发生变化，不能初始化，也不会覆盖现有内容。',
  ) as Error & { code: string };
  error.code = 'directory-became-nonempty';
  return error;
}

/** A durable intent coordinates directory publication with the SQLite commit.
 * Recovery replays only a durable filesystem intent, never patches database
 * ownership. Incomplete trees are preserved, not deleted.
 */
export class ProjectCreation {
  private readonly journalPath: string;

  constructor(
    private readonly target: string,
    journalRoot: string,
    private readonly logger: Logger,
  ) {
    this.journalPath = path.join(journalRoot,
      `${createHash('sha256').update(target.toLowerCase()).digest('hex')}.json`);
  }

  recover(isCommitted: (projectId: string) => boolean): string | undefined {
    if (!existsSync(this.journalPath)) return undefined;
    const journal = JSON.parse(readFileSync(this.journalPath, 'utf8')) as CreationJournal;
    const replaceExisting = journal.replaceExisting === true;
    const backupPrefix = replaceExisting
      ? '.chatfgm-replaced-'
      : '.chatfgm-empty-';
    // Journal paths must remain siblings of the selected target. Never follow
    // an edited journal into another directory or through a junction.
    const parent = path.dirname(this.target);
    if (journal.target !== this.target ||
      path.dirname(journal.stage) !== parent ||
      path.dirname(journal.backup) !== parent ||
      path.basename(journal.stage) !== `.chatfgm-create-${journal.projectId}` ||
      path.basename(journal.backup) !== `${backupPrefix}${journal.projectId}`) {
      throw new Error('项目初始化恢复记录无效，已保留所有文件。');
    }
    const current = identity(this.target);
    const backup = identity(journal.backup);
    if (isCommitted(journal.projectId)) {
      if (current !== journal.stageIdentity) {
        throw new Error('新项目文件夹身份已改变，已保留初始化恢复记录。');
      }
      // Only an explicitly authorized overwrite may recursively remove the
      // replaced directory. An empty-directory creation may remove its backup
      // only while the backup is still empty; a late external write is kept
      // and reported with its path.
      const backupWarning = this.removeLeftover(
        journal.backup,
        journal.originalIdentity,
        replaceExisting,
      );
      const stageWarning = this.removeLeftover(
        journal.stage,
        journal.stageIdentity,
        true,
      );
      if (backupWarning || stageWarning) {
        // Keep the durable intent when cleanup could not finish so a later
        // startup/open retries it and keeps reporting the preserved path.
        return backupWarning ?? stageWarning;
      }
      unlinkSync(this.journalPath);
      return undefined;
    }
    if (backup === journal.originalIdentity) {
      if (current === journal.stageIdentity && !existsSync(journal.stage)) {
        renameDirectoryWithRetry(this.target, journal.stage);
      } else if (current !== null || existsSync(this.target)) {
        throw new Error('初始化期间项目文件夹被其他操作替换，已保留所有内容。');
      }
      renameDirectoryWithRetry(journal.backup, this.target);
    } else if (current !== journal.originalIdentity) {
      throw new Error('无法核对原项目文件夹身份，已保留所有内容。');
    }
    // This stage only ever contains a template copy made by this journal.
    this.removeLeftover(journal.stage, journal.stageIdentity, true);
    unlinkSync(this.journalPath);
    return undefined;
  }

  initialize(
    source: string,
    projectId = randomUUID(),
    options: { replaceExisting?: boolean } = {},
  ): string {
    const replaceExisting = options.replaceExisting === true;
    const parent = path.dirname(this.target);
    const stage = path.join(parent, `.chatfgm-create-${projectId}`);
    const backup = path.join(
      parent,
      `${replaceExisting ? '.chatfgm-replaced-' : '.chatfgm-empty-'}${projectId}`,
    );
    mkdirSync(path.dirname(this.journalPath), { recursive: true });
    mkdirSync(stage);
    const journal: CreationJournal = {
      target: this.target, stage, backup, projectId,
      originalIdentity: identity(this.target)!,
      stageIdentity: identity(stage)!,
      replaceExisting,
    };
    const pendingJournal = `${this.journalPath}.${projectId}.pending`;
    const descriptor = openSync(pendingJournal, 'wx');
    try {
      writeFileSync(descriptor, JSON.stringify(journal));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    // A killed write can leave only an unused .pending file, never a partial
    // recovery record for a directory that has already been published.
    renameSync(pendingJournal, this.journalPath);
    initializeSkeleton(source, stage);
    if (identity(this.target) !== journal.originalIdentity) {
      throw new Error('所选文件夹已发生变化，不能初始化，也不会覆盖现有内容。');
    }
    if (!replaceExisting && !isDirectoryEmpty(this.target)) {
      throw nonEmptyDuringCreationError();
    }
    renameDirectoryWithRetry(this.target, backup);
    if (!replaceExisting) {
      // The emptiness check above happened before the rename. A writer that
      // still holds the directory can add a file while rename retries, and
      // that file travels with the directory into the backup. Publishing the
      // template now would later delete it without user confirmation.
      let backupEmpty: boolean;
      try {
        backupEmpty = isDirectoryEmpty(backup);
      } catch {
        backupEmpty = false;
      }
      if (!backupEmpty) {
        // The durable journal still describes the pre-publish state, so the
        // caller's recovery restores the original directory with these files.
        throw nonEmptyDuringCreationError();
      }
    }
    try {
      renameDirectoryWithRetry(stage, this.target);
    } catch (error) {
      // The durable journal also covers this path; restore the original now so
      // the caller sees the untouched directory after a failed creation.
      if (identity(this.target) === null && identity(backup) === journal.originalIdentity) {
        try {
          renameDirectoryWithRetry(backup, this.target);
        } catch {
          // Recovery replays the durable journal on the next access.
        }
      }
      throw error;
    }
    return projectId;
  }

  private removeLeftover(
    directory: string,
    expectedIdentity: string,
    recursive: boolean,
  ): string | undefined {
    if (!existsSync(directory)) return undefined;
    if (identity(directory) !== expectedIdentity) {
      this.logger.warn('project-initialization-files-preserved', {
        directory: path.basename(directory),
      });
      return `初始化备份目录身份已改变，已保留：${directory}`;
    }
    try {
      if (recursive) {
        rmSync(directory, { recursive: true, force: false });
        return undefined;
      }
      if (isDirectoryEmpty(directory)) {
        rmdirSync(directory);
        return undefined;
      }
      this.logger.warn('project-initialization-files-preserved', {
        directory: path.basename(directory),
      });
      return `原目录备份仍包含文件，已保留：${directory}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown';
      this.logger.warn('project-initialization-cleanup-failed', {
        directory: path.basename(directory),
        message,
      });
      return `初始化备份未能清理，已保留：${directory}（${message}）`;
    }
  }
}
