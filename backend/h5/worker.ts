import path from 'node:path';
import { createRequire } from 'node:module';
import { parentPort } from 'node:worker_threads';
import type {
  H5CellValue,
  H5Dataset,
  H5DatasetRange,
} from '../ipc/capabilities';
import {
  H5_MAX_DATASETS,
  H5_MAX_DEPTH,
  H5_MAX_RANGE_CELLS,
  H5_MAX_RANGE_COLS,
  H5_MAX_RANGE_ROWS,
  H5_MAX_RESPONSE_BYTES,
  type H5WorkerRequest,
  type H5WorkerResult,
} from './protocol';

interface H5Metadata {
  type: number;
  size: number;
  signed?: boolean;
  vlen?: boolean;
  cset?: number;
  shape?: number[] | null;
  filters?: { id: number; name?: string }[];
  virtual_sources?: { file_name: string; dset_name: string }[];
  enum_type?: {
    members?: Record<string, number>;
  };
}

interface H5DatasetLike {
  path: string;
  type: string;
  shape: number[] | null;
  dtype: unknown;
  metadata: H5Metadata;
  filters?: { id: number; name?: string }[];
  value: unknown;
  slice(ranges: (number | null)[][]): unknown;
}

interface H5GroupLike {
  path: string;
  file_id: bigint;
  type: string;
  keys(): string[];
  get(name: string): H5EntityLike | null;
  get_external_link(objectPath: string): {
    filename?: string;
    obj_path?: string;
  };
  get_link(objectPath: string): string | null;
}

type H5EntityLike =
  | H5DatasetLike
  | H5GroupLike
  | {
      type: string;
      path?: string;
    };

interface H5ModuleLike {
  File: new (filename: string, mode?: 'r') => H5GroupLike & {
    close(): number;
  };
  ready: Promise<unknown>;
}

const H5T_INTEGER = 0;
const H5T_FLOAT = 1;
const H5T_STRING = 3;
const H5T_COMPOUND = 6;
const H5T_REFERENCE = 7;
const H5T_ENUM = 8;
const KNOWN_FILTER_IDS = new Set([1, 2, 3]);

let allowedFilePath: string | null = null;
let externalAccessAttempted = false;
const openedFileDescriptors = new Set<number>();

type FsPath = string | Buffer | URL;
type FsStats = ReturnType<typeof import('node:fs').statSync>;

interface MutableFs {
  openSync(target: FsPath, flags: string | number, mode?: number): number;
  readSync(
    descriptor: number,
    buffer: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: number | null,
  ): number;
  closeSync(descriptor: number): void;
  readFileSync(target: FsPath): string | Buffer;
  lstatSync(target: FsPath): FsStats;
  statSync(target: FsPath): FsStats;
  accessSync(target: FsPath, mode?: number): void;
  realpathSync(target: FsPath): string;
}

const fsModule = createRequire(import.meta.url)('node:fs') as unknown as MutableFs;

function normalizedPath(value: string): string {
  return path.resolve(value).replace(/\//g, '\\').toLowerCase();
}

function isAllowedAncestor(value: string): boolean {
  if (!allowedFilePath) return false;
  const candidate = normalizedPath(value);
  const allowed = normalizedPath(allowedFilePath);
  if (candidate === allowed) return true;
  const relative = path.relative(candidate, allowed);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function denyExternalAccess(): never {
  externalAccessAttempted = true;
  const error = new Error(
    'HDF5 跨文件访问被拒绝：外部文件读取不属于当前项目资源。',
  ) as NodeJS.ErrnoException;
  error.code = 'EACCES';
  throw error;
}

/**
 * h5wasm's Node build uses NODERAWFS, so HDF5 external links/VDS/external
 * storage can otherwise open arbitrary host files. Patch the shared fs object
 * before the first HDF5 open: only the authorized main file may be opened,
 * and only its already-open descriptors may be read. This is a second layer
 * behind the explicit link/VDS checks below, not a replacement for them.
 */
function installFileAccessGuard(): void {
  const originalOpenSync = fsModule.openSync.bind(fsModule);
  const originalReadFileSync = fsModule.readFileSync.bind(fsModule);
  const originalReadSync = fsModule.readSync.bind(fsModule);
  const originalCloseSync = fsModule.closeSync.bind(fsModule);
  const originalLstatSync = fsModule.lstatSync.bind(fsModule);
  const originalStatSync = fsModule.statSync.bind(fsModule);
  const originalAccessSync = fsModule.accessSync.bind(fsModule);
  const originalRealpathSync = fsModule.realpathSync.bind(fsModule);

  fsModule.openSync = (
    target: FsPath,
    flags: string | number,
    mode?: number,
  ): number => {
    if (
      !allowedFilePath ||
      normalizedPath(String(target)) !== normalizedPath(allowedFilePath)
    ) {
      denyExternalAccess();
    }
    const descriptor = originalOpenSync(target, flags, mode);
    openedFileDescriptors.add(descriptor);
    return descriptor;
  };

  fsModule.readSync = (
    descriptor: number,
    buffer: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: number | null,
  ): number => {
    if (!openedFileDescriptors.has(descriptor)) denyExternalAccess();
    return originalReadSync(
      descriptor,
      buffer,
      offset,
      length,
      position,
    );
  };

  fsModule.closeSync = (descriptor: number): void => {
    originalCloseSync(descriptor);
    openedFileDescriptors.delete(descriptor);
  };

  fsModule.readFileSync = (target: FsPath): string | Buffer => {
    if (
      !allowedFilePath ||
      normalizedPath(String(target)) !== normalizedPath(allowedFilePath)
    ) {
      denyExternalAccess();
    }
    return originalReadFileSync(target);
  };

  const allowStat = (target: FsPath): void => {
    if (!isAllowedAncestor(String(target))) denyExternalAccess();
  };
  fsModule.lstatSync = (target: FsPath): FsStats => {
    allowStat(target);
    return originalLstatSync(target);
  };
  fsModule.statSync = (target: FsPath): FsStats => {
    allowStat(target);
    return originalStatSync(target);
  };
  fsModule.accessSync = (target: FsPath, mode?: number): void => {
    allowStat(target);
    originalAccessSync(target, mode);
  };
  fsModule.realpathSync = (target: FsPath): string => {
    allowStat(target);
    return originalRealpathSync(target);
  };
}

function normalizeH5Path(value: string): string {
  const parts: string[] = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function assertSafeH5Path(
  file: H5GroupLike,
  inputPath: string,
  visited = new Set<string>(),
): void {
  const normalized = normalizeH5Path(inputPath);
  const parts = normalized.split('/').filter(Boolean);
  let current = '';
  for (let index = 0; index < parts.length; index += 1) {
    current += `/${parts[index]}`;
    const external = file.get_external_link(current);
    if (external?.filename) {
      throw new Error(
        'HDF5 ExternalLink 跨文件机制不受支持，已拒绝读取。',
      );
    }
    const softTarget = file.get_link(current);
    if (softTarget) {
      if (visited.has(current)) {
        throw new Error('HDF5 链接循环不受支持，已拒绝读取。');
      }
      const base = softTarget.startsWith('/')
        ? softTarget
        : path.posix.join(path.posix.dirname(current), softTarget);
      const remaining = parts.slice(index + 1).join('/');
      const resolved = normalizeH5Path(
        remaining ? `${base}/${remaining}` : base,
      );
      assertSafeH5Path(
        file,
        resolved,
        new Set([...visited, current]),
      );
      return;
    }
  }
}

function trimMessage(message: string, filePath: string): string {
  return message.split(filePath).join(path.basename(filePath));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function userFacingError(error: unknown): string {
  const raw = errorText(error);
  if (
    /unable to synchronously open|H5Fopen|file signature|not an HDF5|invalid HDF5|name not defined/i.test(
      raw,
    )
  ) {
    return 'HDF5 文件无法打开，可能已损坏、缺少压缩过滤器或格式不受支持。';
  }
  if (/filter/i.test(raw)) {
    return 'HDF5 数据集缺少可用的压缩过滤器。';
  }
  return `HDF5 文件读取失败：${raw}`;
}

async function loadH5(): Promise<H5ModuleLike> {
  const navigatorObject = Object.getOwnPropertyDescriptor(
    globalThis,
    'navigator',
  );
  if (navigatorObject?.configurable) {
    Object.defineProperty(globalThis, 'navigator', {
      value: undefined,
      configurable: true,
    });
  }
  try {
    const module = (await import('h5wasm/node')) as unknown as H5ModuleLike;
    await module.ready;
    return module;
  } finally {
    if (navigatorObject?.configurable) {
      Object.defineProperty(globalThis, 'navigator', navigatorObject);
    }
  }
}

interface BooleanMapping {
  falseValue: number;
  trueValue: number;
}

/**
 * h5py/h5wasm expose enum labels and their actual base-integer values. A
 * boolean enum is only recognizable when FALSE and TRUE are present exactly
 * once, are distinct, and both values can be represented without loss.
 */
function booleanMapping(metadata: H5Metadata): BooleanMapping | null {
  if (metadata.type !== H5T_ENUM) return null;
  const members = metadata.enum_type?.members;
  if (!members) return null;
  const names = Object.keys(members);
  if (
    names.length !== 2 ||
    !names.includes('FALSE') ||
    !names.includes('TRUE') ||
    !Object.prototype.hasOwnProperty.call(members, 'FALSE') ||
    !Object.prototype.hasOwnProperty.call(members, 'TRUE')
  ) {
    return null;
  }
  const falseValue = members.FALSE;
  const trueValue = members.TRUE;
  if (
    !Number.isSafeInteger(falseValue) ||
    !Number.isSafeInteger(trueValue) ||
    falseValue === trueValue
  ) {
    return null;
  }
  return { falseValue, trueValue };
}

function looksLikeBooleanLabels(metadata: H5Metadata): boolean {
  const members = metadata.enum_type?.members;
  return Boolean(
    members &&
      Object.prototype.hasOwnProperty.call(members, 'FALSE') &&
      Object.prototype.hasOwnProperty.call(members, 'TRUE'),
  );
}

function dtypeLabel(metadata: H5Metadata): string {
  switch (metadata.type) {
    case H5T_INTEGER:
      return `${metadata.signed ? 'int' : 'uint'}${metadata.size * 8}`;
    case H5T_FLOAT:
      return `float${metadata.size * 8}`;
    case H5T_STRING:
      return metadata.vlen ? 'string' : `string${metadata.size}`;
    case H5T_COMPOUND:
      return 'compound';
    case H5T_REFERENCE:
      return 'reference';
    case H5T_ENUM:
      return booleanMapping(metadata) ? 'bool' : 'enum';
    default:
      return 'unknown';
  }
}

function unsupportedReason(
  metadata: H5Metadata,
  shape: number[] | null,
): string | null {
  if (shape === null) return 'null dataspace（无数据）';
  if ((metadata.virtual_sources?.length ?? 0) > 0) {
    return '虚拟数据集（VDS）跨文件机制不受支持。';
  }
  if (shape.length > 2) {
    return `该数据集为 ${shape.length} 维数组，本轮仅支持标量、一维和二维数组。`;
  }
  if (metadata.type === H5T_ENUM && looksLikeBooleanLabels(metadata)) {
    if (!booleanMapping(metadata)) {
      return '布尔枚举映射不完整、歧义或无法精确比较，已拒绝读取。';
    }
  } else if (
    metadata.type !== H5T_INTEGER &&
    metadata.type !== H5T_FLOAT &&
    metadata.type !== H5T_STRING &&
    metadata.type !== H5T_ENUM
  ) {
    return `不支持的数据类型：${dtypeLabel(metadata)}。`;
  } else if (metadata.type === H5T_ENUM && !booleanMapping(metadata)) {
    return '不支持的数据类型：enum。';
  }
  const filters = metadata.filters ?? [];
  const unsupported = filters.find(
    (filter) => !KNOWN_FILTER_IDS.has(filter.id),
  );
  if (unsupported) {
    return `缺少压缩过滤器：${unsupported.name ?? unsupported.id}。`;
  }
  return null;
}

function datasetInfo(entity: H5DatasetLike): H5Dataset {
  const metadata = {
    ...entity.metadata,
    filters: entity.filters ?? [],
  };
  const shape = entity.shape ?? null;
  const reason = unsupportedReason(metadata, shape);
  const safeShape = shape ?? [];
  return {
    path: entity.path,
    name: entity.path.split('/').filter(Boolean).pop() ?? entity.path,
    dtype: dtypeLabel(metadata),
    shape: safeShape,
    kind: reason ? 'unsupported' : safeShape.length === 0 ? 'scalar' : 'array',
    supported: reason === null,
    ...(reason ? { reason } : {}),
  };
}

function collectDatasets(
  file: H5GroupLike,
  onDataset: (dataset: H5Dataset) => void,
): void {
  let count = 0;
  const visit = (group: H5GroupLike, depth: number): void => {
    if (depth > H5_MAX_DEPTH) {
      throw new Error(`数据集遍历深度超过 ${H5_MAX_DEPTH} 层限制。`);
    }
    for (const key of group.keys()) {
      count += 1;
      if (count > H5_MAX_DATASETS) {
        throw new Error(
          `数据集数量超过 ${H5_MAX_DATASETS} 个限制。`,
        );
      }
      const currentPath =
        group.path === '/'
          ? `/${key}`
          : `${group.path}/${key}`;
      try {
        assertSafeH5Path(file, currentPath);
      } catch {
        // External/dangling/cyclic links are omitted from the listing. We do
        // not dereference them to see whether their target looks like a group.
        continue;
      }
      const entity = group.get(key);
      if (!entity) continue;
      const entityType = (entity as { type?: string }).type;
      if (entityType === 'Dataset') {
        onDataset(datasetInfo(entity as H5DatasetLike));
      } else if (entityType === 'Group') {
        visit(entity as H5GroupLike, depth + 1);
      }
      // External links, broken soft links, datatypes and references are not
      // followed. In particular no path from another file is opened.
    }
  };
  visit(file, 0);
}

function flattenValues(raw: unknown, expectedCells: number): unknown[] {
  if (raw === null || raw === undefined) {
    if (expectedCells === 0) return [];
    throw new Error('HDF5 返回了空数据。');
  }
  if (ArrayBuffer.isView(raw)) {
    return Array.from(raw as unknown as ArrayLike<unknown>);
  }
  if (Array.isArray(raw)) {
    const result: unknown[] = [];
    const append = (value: unknown) => {
      if (Array.isArray(value)) {
        for (const item of value) append(item);
      } else {
        result.push(value);
      }
    };
    append(raw);
    if (result.length !== expectedCells) {
      throw new Error('HDF5 返回的数据长度与请求窗口不一致。');
    }
    return result;
  }
  if (expectedCells === 1) return [raw];
  throw new Error('HDF5 返回了无法识别的数据形状。');
}

function numberRaw(value: number, float: boolean): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  if (Object.is(value, -0)) return '-0';
  if (!float && Number.isInteger(value)) return BigInt(value).toString();
  return String(value);
}

function cellValue(
  value: unknown,
  metadata: H5Metadata,
): H5CellValue {
  const mapping = booleanMapping(metadata);
  if (mapping) {
    const falseValue = BigInt(mapping.falseValue);
    const trueValue = BigInt(mapping.trueValue);
    let booleanValue: boolean;
    if (typeof value === 'bigint') {
      if (value === falseValue) booleanValue = false;
      else if (value === trueValue) booleanValue = true;
      else {
        throw new Error(
          `布尔枚举值 ${value.toString()} 不属于 FALSE/TRUE 映射。`,
        );
      }
    } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
      if (value === mapping.falseValue) booleanValue = false;
      else if (value === mapping.trueValue) booleanValue = true;
      else {
        throw new Error(
          `布尔枚举值 ${value} 不属于 FALSE/TRUE 映射。`,
        );
      }
    } else {
      throw new Error('布尔枚举值无法精确比较。');
    }
    return {
      raw: booleanValue ? 'true' : 'false',
      display: booleanValue ? 'TRUE' : 'FALSE',
      kind: 'boolean',
    };
  }
  if (metadata.type === H5T_ENUM) {
    throw new Error('HDF5 枚举类型不受支持。');
  }
  if (metadata.type === H5T_STRING) {
    return {
      raw: typeof value === 'string' ? value : String(value ?? ''),
      kind: 'string',
    };
  }
  if (typeof value === 'bigint') {
    return { raw: value.toString(), kind: 'number' };
  }
  if (typeof value === 'number') {
    return {
      raw: numberRaw(value, metadata.type === H5T_FLOAT),
      kind: 'number',
    };
  }
  if (typeof value === 'boolean') {
    return {
      raw: value ? 'true' : 'false',
      kind: 'boolean',
    };
  }
  throw new Error('HDF5 单元格值类型不受支持。');
}

function responseSizeBytes(rows: readonly H5CellValue[][]): number {
  let total = 0;
  for (const row of rows) {
    for (const value of row) {
      total += Buffer.byteLength(value.raw, 'utf8');
      if (value.display) {
        total += Buffer.byteLength(value.display, 'utf8');
      }
    }
  }
  return total;
}

function assertResponseSize(rows: readonly H5CellValue[][]): void {
  if (responseSizeBytes(rows) > H5_MAX_RESPONSE_BYTES) {
    throw new Error(
      `HDF5 返回内容超过 ${H5_MAX_RESPONSE_BYTES / (1024 * 1024)} MiB UTF-8 字节限制（raw+display）。`,
    );
  }
}

function shapeProduct(shape: readonly number[]): number {
  return shape.reduce((product, size) => product * size, 1);
}

function readRange(
  file: H5GroupLike,
  request: Extract<H5WorkerRequest, { operation: 'range' }>,
): H5DatasetRange {
  assertSafeH5Path(file, request.datasetPath);
  const entity = file.get(request.datasetPath);
  if (!entity || (entity as { type?: string }).type !== 'Dataset') {
    throw new Error(`数据集不存在：${request.datasetPath}`);
  }
  const dataset = entity as H5DatasetLike;
  const metadata = {
    ...dataset.metadata,
    filters: dataset.filters ?? [],
  };
  const shape = dataset.shape ?? null;
  const reason = unsupportedReason(metadata, shape);
  if (reason) throw new Error(reason);
  if (shape === null) throw new Error('null dataspace（无数据）');

  if (shape.length === 0) {
    if (request.start.length !== 0 || request.shape.length !== 0) {
      throw new Error('标量数据集只接受空 start 和 shape。');
    }
    const scalar = dataset.value;
    if (externalAccessAttempted) {
      throw new Error(
        'HDF5 标量读取触发了项目外文件访问，已拒绝；跨文件机制不受支持。',
      );
    }
    const rows: H5CellValue[][] = [[cellValue(scalar, metadata)]];
    assertResponseSize(rows);
    return {
      datasetPath: dataset.path,
      start: [],
      shape: [],
      values: rows,
    };
  }
  if (request.start.length !== shape.length) {
    throw new Error('start 维度与数据集维度不匹配。');
  }
  if (request.shape.length !== shape.length) {
    throw new Error('shape 维度与数据集维度不匹配。');
  }
  if (shape.length === 1) {
    if (request.shape[0] > H5_MAX_RANGE_ROWS) {
      throw new Error(`一维窗口不能超过 ${H5_MAX_RANGE_ROWS} 项。`);
    }
  } else if (shape.length === 2) {
    if (request.shape[0] > H5_MAX_RANGE_ROWS) {
      throw new Error(`行窗口不能超过 ${H5_MAX_RANGE_ROWS} 行。`);
    }
    if (request.shape[1] > H5_MAX_RANGE_COLS) {
      throw new Error(`列窗口不能超过 ${H5_MAX_RANGE_COLS} 列。`);
    }
  }
  const cells = shapeProduct(request.shape);
  if (cells > H5_MAX_RANGE_CELLS) {
    throw new Error(`单次读取不能超过 ${H5_MAX_RANGE_CELLS} 个单元格。`);
  }
  for (let index = 0; index < shape.length; index += 1) {
    if (
      !Number.isSafeInteger(request.start[index]) ||
      !Number.isSafeInteger(request.shape[index]) ||
      request.start[index] < 0 ||
      request.shape[index] < 0 ||
      request.start[index] + request.shape[index] > shape[index]
    ) {
      throw new Error('读取范围超出数据集边界。');
    }
  }

  let raw: unknown;
  if (request.shape.some((size) => size === 0)) {
    raw = [];
  } else if (shape.length === 1) {
    raw = dataset.slice([
      [request.start[0], request.start[0] + request.shape[0]],
    ]);
  } else {
    raw = dataset.slice([
      [request.start[0], request.start[0] + request.shape[0]],
      [request.start[1], request.start[1] + request.shape[1]],
    ]);
  }
  if (externalAccessAttempted) {
    throw new Error(
      'HDF5 读取触发了项目外文件访问，已拒绝；跨文件机制不受支持。',
    );
  }
  const cellsRaw = flattenValues(raw, cells);
  const values: H5CellValue[] = cellsRaw.map((value) =>
    cellValue(value, metadata),
  );
  let rows: H5CellValue[][];
  if (shape.length === 1) {
    rows = values.map((value) => [value]);
  } else {
    const columns = request.shape[1];
    rows = [];
    for (let row = 0; row < request.shape[0]; row += 1) {
      rows.push(values.slice(row * columns, (row + 1) * columns));
    }
  }
  assertResponseSize(rows);
  return {
    datasetPath: dataset.path,
    start: [...request.start],
    shape: [...request.shape],
    values: rows,
  };
}

function handleRequest(
  h5: H5ModuleLike,
  request: H5WorkerRequest,
): {
  datasets?: H5Dataset[];
  fileInfo?: string;
  range?: H5DatasetRange;
} {
  externalAccessAttempted = false;
  allowedFilePath = request.filePath;
  openedFileDescriptors.clear();
  const file = new h5.File(request.filePath, 'r');
  try {
    if (request.operation === 'list') {
      const datasets: H5Dataset[] = [];
      collectDatasets(file as unknown as H5GroupLike, (dataset) =>
        datasets.push(dataset),
      );
      return {
        datasets,
        fileInfo: path.basename(request.filePath),
      };
    }
    return {
      range: readRange(
        file as unknown as H5GroupLike,
        request,
      ),
    };
  } catch (error) {
    if (externalAccessAttempted) {
      throw new Error(
        'HDF5 尝试访问项目外的外部文件，已拒绝；跨文件机制不受支持。',
        { cause: error },
      );
    }
    throw error;
  } finally {
    try {
      file.close();
    } catch {
      // Closing is best effort; the file was opened read-only.
    }
    openedFileDescriptors.clear();
  }
}

async function main(): Promise<void> {
  if (!parentPort) throw new Error('H5 worker 缺少 parentPort。');
  const h5 = await loadH5();
  installFileAccessGuard();
  parentPort.on('message', (request: H5WorkerRequest) => {
    let response: H5WorkerResult;
    try {
      const result = handleRequest(h5, request);
      response = {
        id: request.id,
        ok: true,
        value:
          request.operation === 'list'
            ? {
                datasets: result.datasets ?? [],
                ...(result.fileInfo ? { fileInfo: result.fileInfo } : {}),
              }
            : (result.range as H5DatasetRange),
      };
    } catch (error) {
      response = {
        id: request.id,
        ok: false,
        code: 'h5-read-failed',
        message: trimMessage(userFacingError(error), request.filePath),
      };
    }
    parentPort?.postMessage(response);
  });
}

void main().catch((error) => {
  console.error('[chatfgm-h5-worker]', error);
  process.exitCode = 1;
});




