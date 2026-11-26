import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type {
  H5DatasetList,
  H5DatasetRange,
  ReadH5RangeInput,
} from '../ipc/capabilities';
import type { Logger } from '../platform/log';
import type { ProjectService } from '../projects/service';
import {
  H5_MAX_DATASETS,
  H5_MAX_DEPTH,
  H5_MAX_RANGE_CELLS,
  H5_MAX_RANGE_COLS,
  H5_MAX_RANGE_ROWS,
  H5_REQUEST_TIMEOUT_MS,
  type H5WorkerRequest,
  type H5WorkerResult,
} from './protocol';

export const H5_MAX_QUEUE = 8;

export class H5ServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'H5ServiceError';
    this.code = code;
  }
}

interface H5ServiceOptions {
  appPath: string;
  logger: Logger;
  projectService: ProjectService;
}

interface QueuedRequest {
  request: H5WorkerRequest;
  resolve: (value: H5DatasetList | H5DatasetRange) => void;
  reject: (error: Error) => void;
}

function validateRangeArrays(
  start: readonly number[],
  shape: readonly number[],
): void {
  if (!Array.isArray(start) || !Array.isArray(shape)) {
    throw new H5ServiceError(
      'invalid-h5-range',
      'H5 读取范围必须是整数数组。',
    );
  }
  if (start.length > 2 || shape.length > 2 || start.length !== shape.length) {
    throw new H5ServiceError(
      'invalid-h5-range',
      'H5 读取范围维度无效。',
    );
  }
  for (let index = 0; index < shape.length; index += 1) {
    if (
      !Number.isSafeInteger(start[index]) ||
      !Number.isSafeInteger(shape[index]) ||
      start[index] < 0 ||
      shape[index] < 0
    ) {
      throw new H5ServiceError(
        'invalid-h5-range',
        'H5 读取范围必须是安全的非负整数。',
      );
    }
  }
  if (shape.length === 1 && shape[0] > H5_MAX_RANGE_ROWS) {
    throw new H5ServiceError(
      'h5-range-too-large',
      `一维窗口不能超过 ${H5_MAX_RANGE_ROWS} 项。`,
    );
  }
  if (shape.length === 2) {
    if (shape[0] > H5_MAX_RANGE_ROWS) {
      throw new H5ServiceError(
        'h5-range-too-large',
        `H5 窗口不能超过 ${H5_MAX_RANGE_ROWS} 行。`,
      );
    }
    if (shape[1] > H5_MAX_RANGE_COLS) {
      throw new H5ServiceError(
        'h5-range-too-large',
        `H5 窗口不能超过 ${H5_MAX_RANGE_COLS} 列。`,
      );
    }
  }
  if (shape.reduce((product, value) => product * value, 1) > H5_MAX_RANGE_CELLS) {
    throw new H5ServiceError(
      'h5-range-too-large',
      `H5 窗口不能超过 ${H5_MAX_RANGE_CELLS} 个单元格。`,
    );
  }
}

export class H5Service {
  private readonly appPath: string;
  private readonly logger: Logger;
  private readonly projectService: ProjectService;
  private worker: Worker | null = null;
  private active:
    | {
        id: number;
        timer: NodeJS.Timeout;
        task: QueuedRequest;
      }
    | null = null;
  private queue: QueuedRequest[] = [];
  private nextId = 1;
  private disposed = false;

  constructor(options: H5ServiceOptions) {
    this.appPath = options.appPath;
    this.logger = options.logger;
    this.projectService = options.projectService;
  }

  listDatasets(projectId: string, fileIdentity: string): Promise<H5DatasetList> {
    const file = this.resolveH5File(projectId, fileIdentity);
    return this.request<H5DatasetList>({
      id: 0,
      operation: 'list',
      filePath: file,
    });
  }

  readDatasetRange(input: ReadH5RangeInput): Promise<H5DatasetRange> {
    const file = this.resolveH5File(input.projectId, input.fileIdentity);
    if (
      typeof input.datasetPath !== 'string' ||
      !input.datasetPath.startsWith('/') ||
      input.datasetPath.length > 4096 ||
      input.datasetPath.includes('\u0000')
    ) {
      throw new H5ServiceError(
        'invalid-h5-dataset',
        'H5 数据集路径无效。',
      );
    }
    validateRangeArrays(input.start, input.shape);
    return this.request<H5DatasetRange>({
      id: 0,
      operation: 'range',
      filePath: file,
      datasetPath: input.datasetPath,
      start: [...input.start],
      shape: [...input.shape],
    });
  }

  dispose(): void {
    this.disposed = true;
    this.failAll(
      new H5ServiceError('h5-worker-disposed', 'H5 读取服务已关闭。'),
    );
    this.worker?.terminate();
    this.worker = null;
  }

  private resolveH5File(
    projectId: string,
    fileIdentity: string,
  ): string {
    const file = this.projectService.resolveFileEntry(
      projectId,
      fileIdentity,
    );
    const extension = path.extname(file.absolute).toLowerCase();
    if (extension !== '.h5' && extension !== '.hdf5') {
      throw new H5ServiceError(
        'not-an-h5-file',
        '所选文件不是 .h5/.hdf5 文件。',
      );
    }
    return file.absolute;
  }

  private request<T extends H5DatasetList | H5DatasetRange>(
    request: H5WorkerRequest,
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(
        new H5ServiceError('h5-worker-disposed', 'H5 读取服务已关闭。'),
      );
    }
    if (this.queue.length >= H5_MAX_QUEUE) {
      return Promise.reject(
        new H5ServiceError(
          'h5-queue-full',
          'H5 读取请求过多，请稍后重试。',
        ),
      );
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        request: { ...request, id: this.nextId++ },
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.pump();
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const workerPath = path.join(
      this.appPath,
      'dist',
      'main',
      'h5-worker.mjs',
    );
    let worker: Worker;
    try {
      worker = new Worker(workerPath);
    } catch (error) {
      throw new H5ServiceError(
        'h5-worker-unavailable',
        `H5 解析进程无法启动：${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    worker.stdout?.resume();
    worker.stderr?.resume();
    worker.on('message', (message: H5WorkerResult) => {
      if (this.worker !== worker) return;
      if (!this.active || message.id !== this.active.id) return;
      const task = this.active.task;
      clearTimeout(this.active.timer);
      this.active = null;
      if (message.ok) {
        task.resolve(message.value);
      } else {
        task.reject(
          new H5ServiceError(
            'h5-read-failed',
            message.message || 'HDF5 文件读取失败。',
          ),
        );
      }
      this.pump();
    });
    worker.on('error', (error) => {
      this.logger.error('h5-worker-error', {
        message: error.message,
      });
      this.workerFailed(worker, error);
    });
    worker.on('exit', (code) => {
      this.workerFailed(
        worker,
        new Error(`H5 解析进程退出（代码 ${code}）。`),
      );
    });
    this.worker = worker;
    return worker;
  }

  private workerFailed(worker: Worker, error: unknown): void {
    if (this.worker !== worker) return;
    worker.terminate();
    this.worker = null;
    this.failAll(
      new H5ServiceError(
        'h5-worker-failed',
        error instanceof Error ? error.message : String(error),
        { cause: error },
      ),
    );
  }

  private failAll(error: Error): void {
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active.task.reject(error);
      this.active = null;
    }
    for (const task of this.queue) task.reject(error);
    this.queue = [];
  }

  private pump(): void {
    if (this.disposed || this.active) return;
    const task = this.queue.shift();
    if (!task) return;
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      task.reject(error as Error);
      this.failAll(
        error instanceof Error
          ? error
          : new Error('H5 解析进程无法启动。'),
      );
      return;
    }
    const timer = setTimeout(() => {
      if (!this.active || this.active.task !== task) return;
      this.worker?.terminate();
      this.worker = null;
      this.active = null;
      task.reject(
        new H5ServiceError(
          'h5-timeout',
          `H5 读取超过 ${H5_REQUEST_TIMEOUT_MS / 1000} 秒，已终止。`,
        ),
      );
      this.failAll(
        new H5ServiceError(
          'h5-worker-restarted',
          'H5 解析进程在超时后已重启，请重试。',
        ),
      );
    }, H5_REQUEST_TIMEOUT_MS);
    timer.unref();
    this.active = { id: task.request.id, timer, task };
    worker.postMessage(task.request);
  }
}

export { H5_MAX_DATASETS, H5_MAX_DEPTH };

