import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  UIEvent,
} from 'react';
import type {
  H5CellValue,
  H5Dataset,
  H5DatasetRange,
  ListH5DatasetsInput,
  ReadH5RangeInput,
  ServiceResult,
} from '../../services/capabilities';
import type {
  H5Selection,
  H5ViewState,
  OpenDocument,
} from '../../state/workspace';
import {
  DEFAULT_COLUMN_WIDTH,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  clampGridSelection,
  fitWidthsToColumns,
  gridStep,
} from './grid-utils';
import './viewers.css';

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 26;
const ROWHEAD_WIDTH = 48;
const REQUEST_ROWS = 80;
const REQUEST_COLS = 24;
const ROW_BLOCK = 40;
const COL_BLOCK = 8;
const ROW_PREFETCH = 8;
const COL_PREFETCH = 2;
const MAX_RENDER_ROWS = 80;
const MAX_RENDER_COLS = 24;

interface DatasetEntry {
  status: 'ready' | 'loading' | 'error';
  datasets: H5Dataset[];
  fileInfo: string;
  error: string;
}

interface WindowRequest {
  start: number[];
  shape: number[];
  key: string;
}

interface WindowEntry {
  status: 'loading' | 'ready' | 'error';
  range: H5DatasetRange | null;
  error: string;
  requestKey: string | null;
}

interface ViewportState {
  scrollTop: number;
  scrollLeft: number;
  width: number;
  height: number;
}

interface SelectedCache {
  key: string;
  value: H5CellValue | null;
}

interface H5ViewerProps {
  projectId: string;
  document: OpenDocument;
  active: boolean;
  /** Bumped when the same file changed on disk; re-lists datasets. */
  sourceRevision?: number;
  listH5Datasets?: (
    input: ListH5DatasetsInput,
  ) => Promise<ServiceResult<{
    datasets: readonly H5Dataset[];
    fileInfo?: string;
  }>>;
  readH5DatasetRange?: (
    input: ReadH5RangeInput,
  ) => Promise<ServiceResult<H5DatasetRange>>;
  onViewChange: (patch: Partial<H5ViewState>) => void;
  onCopyValue: (value: string) => void;
}

function datasetDimensions(
  dataset: H5Dataset | null,
): { rows: number; cols: number } | null {
  if (!dataset || !dataset.supported) return null;
  if (dataset.kind === 'scalar') return { rows: 1, cols: 1 };
  if (dataset.kind !== 'array') return null;
  if (dataset.shape.length === 1) {
    return { rows: dataset.shape[0], cols: 1 };
  }
  if (dataset.shape.length === 2) {
    return { rows: dataset.shape[0], cols: dataset.shape[1] };
  }
  return null;
}

function datasetMeta(dataset: H5Dataset): string {
  if (dataset.kind === 'scalar') return `${dataset.dtype} · 标量`;
  if (dataset.shape.length === 0) {
    return `${dataset.dtype} · ${
      dataset.kind === 'unsupported' ? '不支持类型' : '标量'
    }`;
  }
  return `${dataset.dtype} · 尺寸 ${dataset.shape.join(' × ')}`;
}

function formatAddress(
  dataset: H5Dataset,
  selected: H5Selection,
): string {
  if (dataset.kind === 'scalar') return '[0]';
  if (dataset.shape.length === 1) return `[${selected.row}]`;
  return `[${selected.row}, ${selected.col}]`;
}

function requestKey(
  dataset: H5Dataset,
  start: readonly number[],
  shape: readonly number[],
  sourceVersion: number,
): string {
  return `${sourceVersion}\u0000${dataset.path}\u0000${start.join(',')}\u0000${shape.join(',')}`;
}

function chooseWindow(
  firstVisible: number,
  visibleCount: number,
  total: number,
  limit: number,
  block: number,
  prefetch: number,
): { start: number; count: number } {
  if (total <= limit) {
    return { start: 0, count: total };
  }
  const wantedEnd = Math.min(
    total,
    firstVisible +
      Math.min(
        Math.max(0, visibleCount),
        limit,
        Math.max(0, total - firstVisible),
      ),
  );
  let start = Math.max(
    0,
    Math.floor(Math.max(0, firstVisible - prefetch) / block) * block,
  );
  let count = Math.min(limit, total - start);
  if (start + count >= wantedEnd) {
    return { start, count };
  }

  // The prefetched block does not cover the viewport. Move the start
  // toward the visible area, preferring a block boundary that still
  // starts at or before it. If no boundary fits, use the minimum start
  // that can cover the viewport; never jump to an unrelated edge.
  const requiredStart = Math.max(0, wantedEnd - limit);
  const alignedStart = Math.floor(firstVisible / block) * block;
  start =
    alignedStart >= requiredStart ? alignedStart : requiredStart;
  start = Math.max(0, Math.min(start, firstVisible));
  count = Math.min(limit, total - start);
  if (start + count < wantedEnd) {
    start = requiredStart;
    count = Math.min(limit, total - start);
  }
  return { start, count };
}

function computeWindowRequest(
  dataset: H5Dataset,
  dimensions: { rows: number; cols: number },
  firstRow: number,
  firstCol: number,
  visibleRows: number,
  visibleCols: number,
  sourceVersion: number,
): WindowRequest {
  if (dataset.kind === 'scalar') {
    return {
      start: [],
      shape: [],
      key: requestKey(dataset, [], [], sourceVersion),
    };
  }

  const { rows, cols } = dimensions;
  const rowWindow = chooseWindow(
    firstRow,
    Math.min(visibleRows, MAX_RENDER_ROWS),
    rows,
    REQUEST_ROWS,
    ROW_BLOCK,
    ROW_PREFETCH,
  );
  const startRow = rowWindow.start;
  const rowCount = rowWindow.count;

  if (dataset.shape.length === 1) {
    return {
      start: [startRow],
      shape: [rowCount],
      key: requestKey(dataset, [startRow], [rowCount], sourceVersion),
    };
  }

  const colWindow = chooseWindow(
    firstCol,
    Math.min(visibleCols, MAX_RENDER_COLS),
    cols,
    REQUEST_COLS,
    COL_BLOCK,
    COL_PREFETCH,
  );
  const startCol = colWindow.start;
  const colCount = colWindow.count;
  return {
    start: [startRow, startCol],
    shape: [rowCount, colCount],
    key: requestKey(
      dataset,
      [startRow, startCol],
      [rowCount, colCount],
      sourceVersion,
    ),
  };
}

function valueInRange(
  dataset: H5Dataset,
  range: H5DatasetRange | null,
  row: number,
  col: number,
): H5CellValue | null | undefined {
  if (!range) return undefined;
  if (dataset.kind === 'scalar') {
    if (row !== 0 || col !== 0) return undefined;
    return range.values[0]?.[0] ?? null;
  }
  const rowStart = range.start[0] ?? 0;
  const rowIndex = row - rowStart;
  if (rowIndex < 0 || rowIndex >= range.values.length) {
    return undefined;
  }
  if (dataset.shape.length === 1) {
    if (col !== 0) return undefined;
    return range.values[rowIndex]?.[0] ?? null;
  }
  const colStart = range.start[1] ?? 0;
  const colIndex = col - colStart;
  const line = range.values[rowIndex];
  if (!line || colIndex < 0 || colIndex >= line.length) {
    return undefined;
  }
  return line[colIndex] ?? null;
}

function rangeCoversVisible(
  dataset: H5Dataset,
  dimensions: { rows: number; cols: number },
  range: H5DatasetRange,
  firstRow: number,
  firstCol: number,
  visibleRows: number,
  visibleCols: number,
): boolean {
  if (dataset.kind === 'scalar') return true;
  const rowStart = range.start[0] ?? 0;
  const valueRows = range.values.length;
  if (
    rowStart > firstRow ||
    rowStart + valueRows <
      Math.min(dimensions.rows, firstRow + visibleRows)
  ) {
    return false;
  }
  if (dataset.shape.length === 1) return true;
  const colStart = range.start[1] ?? 0;
  const valueCols = range.values[0]?.length ?? 0;
  return (
    colStart <= firstCol &&
    colStart + valueCols >=
      Math.min(dimensions.cols, firstCol + visibleCols)
  );
}

function rangeContainsRequest(
  dataset: H5Dataset,
  dimensions: { rows: number; cols: number },
  range: H5DatasetRange,
  request: WindowRequest,
): boolean {
  if (range.datasetPath !== dataset.path) return false;
  const shapeLength = dataset.kind === 'scalar' ? 0 : dataset.shape.length;
  if (
    range.start.length !== shapeLength ||
    range.shape.length !== shapeLength
  ) {
    return false;
  }
  for (let index = 0; index < shapeLength; index += 1) {
    if (
      !Number.isInteger(range.start[index]) ||
      !Number.isInteger(range.shape[index]) ||
      range.start[index] < 0 ||
      range.shape[index] < 0
    ) {
      return false;
    }
    if (
      range.start[index] > request.start[index] ||
      range.start[index] + range.shape[index] <
        request.start[index] + request.shape[index]
    ) {
      return false;
    }
  }
  if (dataset.kind === 'scalar') {
    return (
      range.values.length === 1 &&
      Array.isArray(range.values[0]) &&
      range.values[0].length === 1
    );
  }
  const rows = range.shape[0];
  const cols = dataset.shape.length === 2 ? range.shape[1] : 1;
  if (
    dimensions.rows < range.start[0] + rows ||
    dimensions.cols <
      (dataset.shape.length === 2
        ? (range.start[1] ?? 0) + cols
        : 1)
  ) {
    return false;
  }
  if (range.values.length !== rows) return false;
  return range.values.every(
    (line) => Array.isArray(line) && line.length === cols,
  );
}

function sameCell(
  left: H5CellValue | null | undefined,
  right: H5CellValue | null | undefined,
): boolean {
  return (
    left === right ||
    (left !== null &&
      left !== undefined &&
      right !== null &&
      right !== undefined &&
      left.raw === right.raw &&
      left.display === right.display &&
      left.kind === right.kind)
  );
}

export function H5Viewer({
  projectId,
  document,
  active,
  sourceRevision,
  listH5Datasets,
  readH5DatasetRange,
  onViewChange,
  onCopyValue,
}: H5ViewerProps) {
  const [datasetEntry, setDatasetEntry] = useState<DatasetEntry>({
    status: 'loading',
    datasets: [],
    fileInfo: '',
    error: '',
  });
  const [selectedPath, setSelectedPath] = useState<string | null>(
    document.h5View.currentDatasetPath,
  );
  const [windowEntries, setWindowEntries] = useState<
    Record<string, WindowEntry>
  >({});
  const [sourceVersion, setSourceVersion] = useState(0);
  const [viewport, setViewport] = useState<ViewportState>({
    scrollTop: 0,
    scrollLeft: 0,
    width: 0,
    height: 0,
  });
  const [widths, setWidths] = useState<number[]>([]);
  const [widthsPath, setWidthsPath] = useState<string | null>(null);
  const [selectedCache, setSelectedCache] =
    useState<SelectedCache | null>(null);
  const mountedRef = useRef(true);
  const listRequestRef = useRef<{ token: number; version: number } | null>(
    null,
  );
  const listPendingRef = useRef(false);
  const datasetTokenRef = useRef(0);
  const sourceVersionRef = useRef(0);
  const sourceKeyRef = useRef(
    `${document.identity}\u0000${sourceRevision ?? 0}`,
  );
  const identityRef = useRef(document.identity);
  identityRef.current = document.identity;
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  const windowInFlightRef = useRef(new Map<string, string>());
  const viewRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef(0);
  const restoredPathRef = useRef<string | null>(null);
  const latestViewRef = useRef({ document, selectedPath });
  const lastScrollRef = useRef({
    path: selectedPath,
    top: 0,
    left: 0,
  });
  const resizingRef = useRef<{
    pointerId: number;
    index: number;
    startX: number;
    startWidth: number;
    width: number;
  } | null>(null);
  const widthsRef = useRef<number[]>([]);
  const desiredRequestRef = useRef<WindowRequest | null>(null);
  latestViewRef.current = { document, selectedPath };

  const selectedDataset =
    datasetEntry.datasets.find(
      (dataset) => dataset.path === selectedPath,
    ) ??
    (selectedPath === null ? null : datasetEntry.datasets[0] ?? null);
  const dimensions = datasetDimensions(selectedDataset);
  const rows = dimensions?.rows ?? 0;
  const cols = dimensions?.cols ?? 0;
  const dimensionsPath = selectedDataset?.path ?? null;
  const unsupported =
    !!selectedDataset &&
    (!selectedDataset.supported || !dimensions);
  const emptyDataset =
    !!selectedDataset &&
    selectedDataset.kind === 'array' &&
    selectedDataset.shape.some((dimension) => dimension === 0);
  const supportedWithData =
    !!selectedDataset &&
    !!dimensions &&
    dimensions.rows > 0 &&
    dimensions.cols > 0 &&
    !unsupported &&
    !emptyDataset;
  const widthsReady =
    widthsPath === dimensionsPath &&
    dimensions !== null &&
    widths.length === dimensions.cols;
  const windowEntry = selectedPath
    ? windowEntries[selectedPath] ?? null
    : null;
  const range = windowEntry?.range ?? null;

  const selected: H5Selection = useMemo(() => {
    if (!selectedPath || !dimensions) return { row: 0, col: 0 };
    const stored = document.h5View.selections[selectedPath] ?? {
      row: 0,
      col: 0,
    };
    return clampGridSelection(stored, dimensions);
  }, [
    dimensions,
    document.h5View.selections,
    selectedPath,
  ]);
  const selectionKey = `${selectedPath ?? ''}\u0000${selected.row}\u0000${
    selected.col
  }`;

  const gridWidths = useMemo(
    () => (widthsReady ? widths : []),
    [widths, widthsReady],
  );
  const columnPrefix = useMemo(() => {
    const prefix = new Array<number>(gridWidths.length + 1);
    prefix[0] = 0;
    for (let index = 0; index < gridWidths.length; index += 1) {
      prefix[index + 1] =
        prefix[index] + gridWidths[index];
    }
    return prefix;
  }, [gridWidths]);

  const firstRow =
    rows > 0
      ? Math.min(
          rows - 1,
          Math.max(0, Math.floor(viewport.scrollTop / ROW_HEIGHT)),
        )
      : 0;
  const visibleRows =
    rows > 0
      ? Math.min(
          rows - firstRow,
          MAX_RENDER_ROWS,
          Math.max(
            1,
            Math.ceil(viewport.height / ROW_HEIGHT) + 1,
          ),
        )
      : 0;
  let firstCol = 0;
  if (gridWidths.length > 0) {
    while (
      firstCol < cols - 1 &&
      columnPrefix[firstCol] + gridWidths[firstCol] <=
        viewport.scrollLeft
    ) {
      firstCol += 1;
    }
  }
  let visibleCols = 0;
  let usedWidth = 0;
  const availableWidth = Math.max(0, viewport.width - ROWHEAD_WIDTH);
  while (
    firstCol + visibleCols < cols &&
    visibleCols < MAX_RENDER_COLS &&
    (visibleCols === 0 || usedWidth < availableWidth)
  ) {
    usedWidth += gridWidths[firstCol + visibleCols] ?? 0;
    visibleCols += 1;
  }
  if (visibleCols === 0 && cols > 0) visibleCols = 1;

  const desiredWindow =
    supportedWithData &&
    widthsReady &&
    dimensions &&
    viewport.width > 0 &&
    viewport.height > 0
      ? computeWindowRequest(
          selectedDataset,
          dimensions,
          firstRow,
          firstCol,
          visibleRows,
          visibleCols,
          sourceVersion,
        )
      : null;
  desiredRequestRef.current = desiredWindow;
  const windowCoversView =
    !!range &&
    !!selectedDataset &&
    !!dimensions &&
    rangeCoversVisible(
      selectedDataset,
      dimensions,
      range,
      firstRow,
      firstCol,
      visibleRows,
      visibleCols,
    );
  const windowLoading =
    supportedWithData &&
    (windowEntry?.status === 'loading' ||
      (!windowCoversView && windowEntry?.status !== 'error'));
  const windowError =
    windowEntry?.status === 'error' ? windowEntry.error : '';

  useLayoutEffect(() => {
    if (!selectedDataset || !dimensions) return;
    const saved = document.h5View.widths[selectedDataset.path];
    const next = fitWidthsToColumns(
      saved ?? [],
      dimensions.cols,
    );
    if (
      widthsPath === selectedDataset.path &&
      widthsRef.current.length === dimensions.cols &&
      next.every(
        (width, index) => width === widthsRef.current[index],
      )
    ) {
      return;
    }
    widthsRef.current = next;
    setWidths(next);
    setWidthsPath(selectedDataset.path);
  }, [
    dimensions,
    document.h5View.widths,
    selectedDataset,
    widthsPath,
  ]);

  function syncViewport() {
    const view = viewRef.current;
    if (!view) return;
    const next = {
      scrollTop: view.scrollTop,
      scrollLeft: view.scrollLeft,
      width: view.clientWidth,
      height: view.clientHeight,
    };
    setViewport((previous) =>
      previous.scrollTop === next.scrollTop &&
      previous.scrollLeft === next.scrollLeft &&
      previous.width === next.width &&
      previous.height === next.height
        ? previous
        : next,
    );
    if (selectedPath) {
      lastScrollRef.current = {
        path: selectedPath,
        top: next.scrollTop,
        left: next.scrollLeft,
      };
    }
  }

  useLayoutEffect(() => {
    if (!widthsReady || !selectedPath) return;
    syncViewport();
    const view = viewRef.current;
    if (!view || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(syncViewport);
    observer.observe(view);
    return () => observer.disconnect();
    // Re-measure when the virtual grid mounts for a dataset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widthsReady, selectedPath]);

  useLayoutEffect(() => {
    if (!active || !widthsReady || !selectedPath) return;
    if (restoredPathRef.current === selectedPath) return;
    const view = viewRef.current;
    if (!view) return;
    const saved = document.h5View.scroll[selectedPath];
    view.scrollTop = saved?.top ?? 0;
    view.scrollLeft = saved?.left ?? 0;
    restoredPathRef.current = selectedPath;
    lastScrollRef.current = {
      path: selectedPath,
      top: view.scrollTop,
      left: view.scrollLeft,
    };
    syncViewport();
    // Restore only the first time this dataset becomes active.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    active,
    datasetEntry.status,
    document.h5View.scroll,
    selectedPath,
    sourceVersion,
    widthsReady,
  ]);

  useEffect(() => {
    if (!selectedPath || !dimensions) return;
    const value = valueInRange(
      selectedDataset!,
      range,
      selected.row,
      selected.col,
    );
    setSelectedCache((previous) => {
      if (value !== undefined) {
        if (
          previous?.key === selectionKey &&
          sameCell(previous.value, value)
        ) {
          return previous;
        }
        return { key: selectionKey, value };
      }
      if (previous?.key === selectionKey) return previous;
      return { key: selectionKey, value: null };
    });
  }, [
    dimensions,
    range,
    selected.col,
    selected.row,
    selectedDataset,
    selectedPath,
    selectionKey,
  ]);

  async function loadWindow(
    dataset: H5Dataset,
    request: WindowRequest,
  ) {
    if (!readH5DatasetRange) {
      setWindowEntries((entries) => ({
        ...entries,
        [dataset.path]: {
          status: 'error',
          range: null,
          error: '当前环境不支持读取 H5 数据。',
          requestKey: request.key,
        },
      }));
      return;
    }
    if (windowInFlightRef.current.has(dataset.path)) return;
    windowInFlightRef.current.set(dataset.path, request.key);
    setWindowEntries((entries) => ({
      ...entries,
      [dataset.path]: {
        status: 'loading',
        range: entries[dataset.path]?.range ?? null,
        error: '',
        requestKey: request.key,
      },
    }));
    try {
      let result: ServiceResult<H5DatasetRange>;
      try {
        result = await readH5DatasetRange({
          projectId,
          fileIdentity: document.identity,
          datasetPath: dataset.path,
          start: [...request.start],
          shape: [...request.shape],
        });
      } catch {
        result = {
          status: 'error',
          message: '无法读取 H5 数据范围。',
        };
      }
      if (!mountedRef.current) return;
      const dims = datasetDimensions(dataset);
      let entry: WindowEntry;
      if (!dims) {
        entry = {
          status: 'error',
          range: null,
          error: 'H5 数据集信息不完整。',
          requestKey: request.key,
        };
      } else if (result.status !== 'success') {
        entry = {
          status: 'error',
          range: null,
          error:
            result.status === 'error'
              ? result.message
              : 'H5 数据读取已取消。',
          requestKey: request.key,
        };
      } else if (
        !rangeContainsRequest(
          dataset,
          dims,
          result.value,
          request,
        )
      ) {
        entry = {
          status: 'error',
          range: null,
          error: 'H5 数据范围与请求范围不一致。',
          requestKey: request.key,
        };
      } else {
        entry = {
          status: 'ready',
          range: result.value,
          error: '',
          requestKey: request.key,
        };
      }
      setWindowEntries((entries) => {
        if (
          entries[dataset.path]?.requestKey !== request.key
        ) {
          return entries;
        }
        return { ...entries, [dataset.path]: entry };
      });
    } finally {
      if (
        windowInFlightRef.current.get(dataset.path) === request.key
      ) {
        windowInFlightRef.current.delete(dataset.path);
      }
    }
  }

  useEffect(() => {
    if (
      !supportedWithData ||
      !widthsReady ||
      !selectedDataset ||
      !dimensions ||
      !desiredWindow ||
      !selectedPath
    ) {
      return;
    }
    if (windowEntry?.status === 'loading') return;
    if (
      windowEntry?.status === 'ready' &&
      windowEntry.range &&
      windowCoversView
    ) {
      return;
    }
    if (windowEntry?.requestKey === desiredWindow.key) return;
    void loadWindow(selectedDataset, desiredWindow);
    // The desired window is derived from viewport, dataset and widths.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    desiredWindow?.key,
    dimensions,
    selectedDataset,
    selectedPath,
    supportedWithData,
    viewport.height,
    viewport.scrollLeft,
    viewport.scrollTop,
    viewport.width,
    widthsReady,
    windowCoversView,
    windowEntry?.requestKey,
    windowEntry?.status,
  ]);

  useEffect(() => {
    if (selectedPath === document.h5View.currentDatasetPath) return;
    onViewChange({ currentDatasetPath: selectedPath });
  }, [
    document.h5View.currentDatasetPath,
    onViewChange,
    selectedPath,
  ]);

  useEffect(() => {
    const dimensionsValue = dimensions;
    if (!dimensionsValue || !selectedPath) return;
    const stored =
      document.h5View.selections[selectedPath] ?? {
        row: 0,
        col: 0,
      };
    if (
      stored.row !== selected.row ||
      stored.col !== selected.col
    ) {
      onViewChange({
        selections: {
          ...document.h5View.selections,
          [selectedPath]: selected,
        },
      });
    }
    // Clamp restored selection after dataset shape changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    dimensions,
    selected.col,
    selected.row,
    selectedPath,
  ]);

  async function loadDatasets(): Promise<void> {
    if (listRequestRef.current) {
      // A file update arrived while the current list is in flight. Record the
      // request so the latest file version is read as soon as it completes;
      // the stale result is discarded instead of being displayed. A repeated
      // request for the same version (for example a StrictMode remount) is
      // coalesced and does not schedule extra work.
      if (listRequestRef.current.version !== sourceVersionRef.current) {
        listPendingRef.current = true;
      }
      return;
    }
    const version = sourceVersionRef.current;
    const token = ++datasetTokenRef.current;
    listRequestRef.current = { token, version };
    setDatasetEntry((entry) => ({
      ...entry,
      status: 'loading',
      error: '',
    }));
    if (!listH5Datasets) {
      listRequestRef.current = null;
      setDatasetEntry({
        status: 'error',
        datasets: [],
        fileInfo: '',
        error: '当前环境不支持读取 H5 数据集。',
      });
      return;
    }
    let result: ServiceResult<{
      datasets: readonly H5Dataset[];
      fileInfo?: string;
    }>;
    try {
      result = await listH5Datasets({
        projectId,
        // Read the identity at request time: a queued reload after a file
        // switch must read the current file, not the one captured earlier.
        fileIdentity: identityRef.current,
      });
    } catch {
      result = { status: 'error', message: '无法读取 H5 数据集。' };
    }
    listRequestRef.current = null;
    if (!mountedRef.current) return;
    if (token !== datasetTokenRef.current) return;
    if (version !== sourceVersionRef.current) {
      // The file changed on disk while this list was in flight. The response
      // describes the previous version, so it must not replace the newer file
      // state; read again once the in-flight request has settled.
      listPendingRef.current = true;
    } else if (result.status !== 'success') {
      setDatasetEntry({
        status: 'error',
        datasets: [],
        fileInfo: '',
        error:
          result.status === 'error'
            ? result.message
            : 'H5 数据集读取已取消。',
      });
    } else {
      const datasets = [...result.value.datasets];
      const savedPath =
        latestViewRef.current.document.h5View.currentDatasetPath;
      const nextPath =
        datasets.find((dataset) => dataset.path === savedPath)
          ?.path ??
        datasets[0]?.path ??
        null;
      setDatasetEntry({
        status: 'ready',
        datasets,
        fileInfo: result.value.fileInfo ?? '',
        error: '',
      });
      setSelectedPath(nextPath);
      if (nextPath !== savedPath) {
        onViewChangeRef.current({ currentDatasetPath: nextPath });
      }
    }
    if (listPendingRef.current) {
      listPendingRef.current = false;
      void loadDatasets();
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    void loadDatasets();
    return () => {
      mountedRef.current = false;
      if (scrollFrameRef.current) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
      const latest = latestViewRef.current;
      const path = latest.selectedPath;
      if (path && restoredPathRef.current === path) {
        onViewChange({
          scroll: {
            ...latest.document.h5View.scroll,
            [path]: {
              top: lastScrollRef.current.top,
              left: lastScrollRef.current.left,
            },
          },
        });
      }
      resizingRef.current = null;
    };
    // Dataset listing runs once per mounted document instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const sourceKey = `${document.identity}\u0000${sourceRevision ?? 0}`;
    if (sourceKeyRef.current === sourceKey) return;
    sourceKeyRef.current = sourceKey;
    // A newer file version invalidates both the dataset listing and every
    // in-flight range read. Keeping the selected dataset, widths and scroll
    // state still refers to the same paths, so they are intentionally kept.
    sourceVersionRef.current += 1;
    setSourceVersion(sourceVersionRef.current);
    windowInFlightRef.current.clear();
    // The grid is unmounted while the new listing loads; re-apply the saved
    // scroll position once it remounts instead of losing it.
    restoredPathRef.current = null;
    setWindowEntries({});
    void loadDatasets();
    // The listing is reloaded by the explicit file-version effect only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.identity, sourceRevision]);

  if (datasetEntry.status === 'loading') {
    return (
      <div className="csv-sheet h5-sheet" data-viewer-kind="h5">
        <div className="h5-toolbar">
          <span className="h5-group h5-group--dataset">
            <span className="h5-label">数据集</span>
            <select
              className="h5-select"
              aria-label="选择数据集"
              disabled
            />
          </span>
        </div>
        <p className="grid-notice" role="status">
          正在读取数据集…
        </p>
      </div>
    );
  }

  if (datasetEntry.status === 'error') {
    return (
      <div className="csv-sheet h5-sheet" data-viewer-kind="h5">
        <p className="grid-notice" role="alert">
          {datasetEntry.error}
        </p>
        <button
          type="button"
          className="grid-retry"
          onClick={() => void loadDatasets()}
        >
          重试
        </button>
      </div>
    );
  }

  const noDatasets = datasetEntry.datasets.length === 0;
  const selectedUnsupported = unsupported;
  const selectedEmpty = emptyDataset;
  const notice = noDatasets
    ? '未发现可预览的数据集。'
    : selectedDataset && selectedUnsupported
      ? selectedDataset.reason ??
        (selectedDataset.shape.length > 2
          ? `暂不支持 ${selectedDataset.shape.length} 维数据预览`
          : '该数据集类型暂不支持预览。')
      : selectedEmpty
        ? '数据集为空'
        : windowError;
  const selectedValue =
    selectedCache?.key === selectionKey
      ? selectedCache.value
      : null;
  const address = selectedDataset
    ? formatAddress(selectedDataset, selected)
    : '';

  function updateSelections(next: H5Selection) {
    if (!selectedPath) return;
    onViewChange({
      selections: {
        ...document.h5View.selections,
        [selectedPath]: next,
      },
    });
  }

  function scrollToCell(row: number, col: number) {
    const view = viewRef.current;
    if (!view || !gridWidths.length) return;
    const colLeft = ROWHEAD_WIDTH + columnPrefix[col];
    const colRight = colLeft + gridWidths[col];
    const rowTop = HEADER_HEIGHT + row * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    const visibleLeft = view.scrollLeft + ROWHEAD_WIDTH;
    const visibleRight = view.scrollLeft + view.clientWidth;
    const visibleTop = view.scrollTop + HEADER_HEIGHT;
    const visibleBottom = view.scrollTop + view.clientHeight;
    if (colLeft < visibleLeft) {
      view.scrollLeft = Math.max(0, colLeft - ROWHEAD_WIDTH);
    } else if (colRight > visibleRight) {
      view.scrollLeft = colRight - view.clientWidth;
    }
    if (rowTop < visibleTop) {
      view.scrollTop = Math.max(0, rowTop - HEADER_HEIGHT);
    } else if (rowBottom > visibleBottom) {
      view.scrollTop = rowBottom - view.clientHeight;
    }
    syncViewport();
  }

  function selectCell(row: number, col: number) {
    if (!dimensions) return;
    const next = clampGridSelection(
      { row, col },
      { rows: dimensions.rows, cols: dimensions.cols },
    );
    updateSelections(next);
    scrollToCell(next.row, next.col);
    viewRef.current?.focus({ preventScroll: true });
  }

  function handleDatasetChange(path: string) {
    const view = viewRef.current;
    const oldPath = selectedPath;
    if (oldPath && view) {
      lastScrollRef.current = {
        path: oldPath,
        top: view.scrollTop,
        left: view.scrollLeft,
      };
      onViewChange({
        scroll: {
          ...document.h5View.scroll,
          [oldPath]: {
            top: view.scrollTop,
            left: view.scrollLeft,
          },
        },
      });
    }
    restoredPathRef.current = null;
    lastScrollRef.current = { path, top: 0, left: 0 };
    setSelectedPath(path);
    onViewChange({ currentDatasetPath: path });
  }

  function handleGridClick(event: ReactMouseEvent<HTMLTableElement>) {
    const target = event.target as HTMLElement;
    const cell = target.closest<HTMLElement>('td.csv-cell[data-row]');
    if (!cell || !event.currentTarget.contains(cell)) return;
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    if (!Number.isInteger(row) || !Number.isInteger(col)) return;
    viewRef.current?.focus({ preventScroll: true });
    selectCell(row, col);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!dimensions) return;
    if (event.altKey) return;
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 'c'
    ) {
      event.preventDefault();
      onCopyValue(selectedValue?.raw ?? '');
      return;
    }
    const next = gridStep(
      event.key,
      selected,
      dimensions,
      event.ctrlKey || event.metaKey,
    );
    if (!next) return;
    event.preventDefault();
    selectCell(next.row, next.col);
  }

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    const view = event.currentTarget;
    if (selectedPath) {
      lastScrollRef.current = {
        path: selectedPath,
        top: view.scrollTop,
        left: view.scrollLeft,
      };
    }
    if (scrollFrameRef.current) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = 0;
      syncViewport();
      if (!selectedPath) return;
      const currentView = viewRef.current;
      if (!currentView) return;
      onViewChange({
        scroll: {
          ...document.h5View.scroll,
          [selectedPath]: {
            top: currentView.scrollTop,
            left: currentView.scrollLeft,
          },
        },
      });
    });
  }

  function handleResizePointerDown(
    event: ReactPointerEvent<HTMLSpanElement>,
    index: number,
  ) {
    if (!selectedDataset || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const drag = {
      pointerId: event.pointerId,
      index,
      startX: event.clientX,
      startWidth: widthsRef.current[index] ?? DEFAULT_COLUMN_WIDTH,
      width: widthsRef.current[index] ?? DEFAULT_COLUMN_WIDTH,
    };
    resizingRef.current = drag;
    handle.setPointerCapture(event.pointerId);

    function onMove(moveEvent: PointerEvent) {
      const activeDrag = resizingRef.current;
      if (!activeDrag || activeDrag.pointerId !== moveEvent.pointerId) {
        return;
      }
      const next = Math.round(
        Math.min(
          MAX_COLUMN_WIDTH,
          Math.max(
            MIN_COLUMN_WIDTH,
            activeDrag.startWidth +
              moveEvent.clientX -
              activeDrag.startX,
          ),
        ),
      );
      if (next === activeDrag.width) return;
      activeDrag.width = next;
      const nextWidths = widthsRef.current.slice();
      nextWidths[activeDrag.index] = next;
      widthsRef.current = nextWidths;
      setWidths(nextWidths);
    }

    function finish() {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
      resizingRef.current = null;
      if (selectedDataset) {
        onViewChange({
          widths: {
            ...document.h5View.widths,
            [selectedDataset.path]: widthsRef.current,
          },
        });
      }
    }

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  function retryWindow() {
    if (!selectedDataset || !desiredRequestRef.current) return;
    void loadWindow(selectedDataset, desiredRequestRef.current);
  }

  const gridReady =
    supportedWithData &&
    widthsReady &&
    gridWidths.length === cols;
  const gridCanvasWidth =
    ROWHEAD_WIDTH +
    (columnPrefix.length > 0
      ? columnPrefix[columnPrefix.length - 1]
      : 0);
  const gridCanvasHeight =
    HEADER_HEIGHT + Math.max(0, rows) * ROW_HEIGHT;
  const tableWidth =
    ROWHEAD_WIDTH +
    gridWidths
      .slice(firstCol, firstCol + visibleCols)
      .reduce((sum, width) => sum + width, 0);
  const tableRows = Math.min(
    visibleRows,
    MAX_RENDER_ROWS,
    Math.max(0, rows - firstRow),
  );
  const tableCols = Math.min(
    visibleCols,
    MAX_RENDER_COLS,
    Math.max(0, cols - firstCol),
  );
  const dataReady = windowEntry?.status === 'ready' && !!range;

  return (
    <div className="csv-sheet h5-sheet" data-viewer-kind="h5">
      <div className="h5-toolbar">
        <span className="h5-group h5-group--dataset">
          <span className="h5-label">数据集</span>
          <select
            className="h5-select"
            aria-label="选择数据集"
            value={selectedPath ?? ''}
            disabled={noDatasets}
            onChange={(event) => handleDatasetChange(event.target.value)}
          >
            {datasetEntry.datasets.map((dataset) => (
              <option key={dataset.path} value={dataset.path}>
                {dataset.path}
              </option>
            ))}
          </select>
        </span>
        <span className="h5-group h5-group--meta">
          <span className="h5-meta">
            {selectedDataset ? datasetMeta(selectedDataset) : ''}
          </span>
        </span>
      </div>
      {notice ? (
        <>
          <p
            className="h5-notice"
            role={windowError ? 'alert' : 'status'}
          >
            {notice}
          </p>
          {windowError ? (
            <button
              type="button"
              className="grid-retry"
              onClick={retryWindow}
            >
              重试
            </button>
          ) : null}
        </>
      ) : null}
      {gridReady ? (
        <>
          <div className="csv-bar">
            <span className="csv-bar-address" aria-hidden="true">
              {address}
            </span>
            <span
              className="csv-bar-value"
              role="status"
              aria-label="当前单元格原始内容"
              title={selectedValue?.raw ?? ''}
            >
              {selectedValue?.raw ?? ''}
            </span>
          </div>
          <div className="h5-grid-wrap">
            <div
              ref={viewRef}
              key={selectedDataset?.path}
              className="csv-view h5-grid-view"
              role="region"
              aria-label="H5 原始数据"
              aria-busy={windowLoading ? 'true' : undefined}
              tabIndex={0}
              onKeyDown={handleKeyDown}
              onScroll={handleScroll}
            >
              <div
                className="h5-grid-canvas"
                style={{
                  width: `${gridCanvasWidth}px`,
                  height: `${gridCanvasHeight}px`,
                }}
              >
                <div className="h5-grid-sticky">
                  <table
                    className="csv-table h5-grid-table"
                    style={{ width: `${tableWidth}px` }}
                    aria-rowcount={rows}
                    aria-colcount={cols}
                    onClick={handleGridClick}
                  >
                    <colgroup>
                      <col style={{ width: `${ROWHEAD_WIDTH}px` }} />
                      {Array.from({ length: tableCols }, (_, index) => (
                        <col
                          key={index}
                          style={{
                            width: `${
                              gridWidths[firstCol + index] ??
                              DEFAULT_COLUMN_WIDTH
                            }px`,
                          }}
                        />
                      ))}
                    </colgroup>
                    <thead>
                      <tr>
                        <th
                          className="csv-corner"
                          scope="col"
                          aria-label="索引"
                        />
                        {Array.from(
                          { length: tableCols },
                          (_, index) => {
                            const col = firstCol + index;
                            return (
                              <th
                                key={col}
                                className="csv-colhead"
                                scope="col"
                              >
                                {col}
                                <span
                                  className="csv-resizer"
                                  data-col={col}
                                  title={`拖动调整第 ${col} 列宽度`}
                                  onPointerDown={(event) =>
                                    handleResizePointerDown(event, col)
                                  }
                                />
                              </th>
                            );
                          },
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from(
                        { length: tableRows },
                        (_, index) => {
                          const row = firstRow + index;
                          return (
                            <tr key={row}>
                              <th className="csv-rowhead" scope="row">
                                {row}
                              </th>
                              {Array.from(
                                { length: tableCols },
                                (_, columnIndex) => {
                                  const col = firstCol + columnIndex;
                                  const value =
                                    selectedDataset && dataReady
                                      ? valueInRange(
                                          selectedDataset,
                                          range,
                                          row,
                                          col,
                                        )
                                      : undefined;
                                  const text =
                                    value?.display ??
                                    value?.raw ??
                                    '';
                                  return (
                                    <td
                                      key={col}
                                      className={`csv-cell${
                                        selected.row === row &&
                                        selected.col === col
                                          ? ' is-selected'
                                          : ''
                                      }${
                                        value === undefined
                                          ? ' is-unloaded'
                                          : ''
                                      }`}
                                      data-row={row}
                                      data-col={col}
                                      title={
                                        value?.raw || undefined
                                      }
                                    >
                                      {text}
                                    </td>
                                  );
                                },
                              )}
                            </tr>
                          );
                        },
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            {windowLoading ? (
              <div
                className="h5-grid-loading"
                role="status"
              >
                加载中…
              </div>
            ) : null}
          </div>
        </>
      ) : (
        notice === '' && !selectedUnsupported && !selectedEmpty ? (
          <p className="grid-notice" role="status">
            加载中…
          </p>
        ) : null
      )}
    </div>
  );
}
