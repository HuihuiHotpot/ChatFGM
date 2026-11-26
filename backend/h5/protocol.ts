import type {
  H5Dataset,
  H5DatasetRange,
} from '../ipc/capabilities';

export const H5_MAX_DATASETS = 5000;
export const H5_MAX_DEPTH = 32;
export const H5_MAX_RANGE_ROWS = 80;
export const H5_MAX_RANGE_COLS = 24;
export const H5_MAX_RANGE_CELLS = H5_MAX_RANGE_ROWS * H5_MAX_RANGE_COLS;
export const H5_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const H5_REQUEST_TIMEOUT_MS = 20_000;

export interface H5ListRequest {
  id: number;
  operation: 'list';
  filePath: string;
}

export interface H5RangeRequest {
  id: number;
  operation: 'range';
  filePath: string;
  datasetPath: string;
  start: number[];
  shape: number[];
}

export type H5WorkerRequest = H5ListRequest | H5RangeRequest;

export type H5WorkerResult =
  | {
      id: number;
      ok: true;
      value:
        | { datasets: H5Dataset[]; fileInfo?: string }
        | H5DatasetRange;
    }
  | {
      id: number;
      ok: false;
      code: string;
      message: string;
    };
