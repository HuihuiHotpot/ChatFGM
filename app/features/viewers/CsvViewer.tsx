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
  CsvViewState,
  OpenDocument,
} from '../../state/workspace';
import { csvColumnCount, parseCsv } from './csv';
import {
  DEFAULT_COLUMN_WIDTH,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  clampGridSelection,
  columnName,
  fitWidthsToColumns,
  gridStep,
  revealGridCell,
} from './grid-utils';
import './viewers.css';

export interface CsvViewerProps {
  document: OpenDocument;
  active: boolean;
  onViewChange: (patch: Partial<CsvViewState>) => void;
  onCopyValue: (value: string) => void;
}

interface ResizeDrag {
  pointerId: number;
  index: number;
  startX: number;
  startWidth: number;
  width: number;
}

export function CsvViewer({
  document,
  active,
  onViewChange,
  onCopyValue,
}: CsvViewerProps) {
  const parsed = useMemo(() => parseCsv(document.content), [
    document.content,
  ]);
  const rows = parsed.ok ? parsed.rows : [];
  const dataRows = rows.length;
  const dataColumns = parsed.ok ? csvColumnCount(rows) : 0;
  const viewRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const scrollFrameRef = useRef(0);
  const restoredRef = useRef(false);
  const lastScrollRef = useRef({
    top: document.csvView.scrollTop,
    left: document.csvView.scrollLeft,
  });
  const resizingRef = useRef<ResizeDrag | null>(null);
  const widthsRef = useRef<number[]>(
    fitWidthsToColumns(document.csvView.columnWidths, dataColumns),
  );
  const [widths, setWidths] = useState(widthsRef.current);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  const selected = parsed.ok && dataRows > 0 && dataColumns > 0
    ? clampGridSelection(
        {
          row: document.csvView.selectedRow,
          col: document.csvView.selectedCol,
        },
        { rows: dataRows, cols: dataColumns },
      )
    : { row: 0, col: 0 };

  useEffect(() => {
    const next = fitWidthsToColumns(
      document.csvView.columnWidths,
      dataColumns,
    );
    if (
      next.length === widthsRef.current.length &&
      next.every((width, index) => width === widthsRef.current[index])
    ) {
      return;
    }
    widthsRef.current = next;
    setWidths(next);
  }, [dataColumns, document.csvView.columnWidths]);

  useEffect(() => {
    if (!parsed.ok) {
      if (document.csvView.parseError !== parsed.message) {
        onViewChange({
          rows: 0,
          columns: 0,
          parseError: parsed.message,
        });
      }
      return;
    }
    if (
      document.csvView.rows !== dataRows ||
      document.csvView.columns !== dataColumns ||
      document.csvView.parseError
    ) {
      onViewChange({
        rows: dataRows,
        columns: dataColumns,
        parseError: '',
      });
    }
  }, [
    dataColumns,
    dataRows,
    document.csvView.columns,
    document.csvView.parseError,
    document.csvView.rows,
    onViewChange,
    parsed,
  ]);

  useEffect(() => {
    if (!parsed.ok || dataRows === 0 || dataColumns === 0) return;
    if (
      document.csvView.selectedRow !== selected.row ||
      document.csvView.selectedCol !== selected.col
    ) {
      onViewChange({
        selectedRow: selected.row,
        selectedCol: selected.col,
      });
    }
  }, [
    dataColumns,
    dataRows,
    document.csvView.selectedCol,
    document.csvView.selectedRow,
    onViewChange,
    parsed.ok,
    selected.col,
    selected.row,
  ]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || typeof ResizeObserver === 'undefined') return;
    const update = () =>
      setViewport({
        width: view.clientWidth,
        height: view.clientHeight,
      });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(view);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (restoredRef.current || !active) return;
    if (viewport.width === 0 || viewport.height === 0) return;
    const view = viewRef.current;
    if (!view || !parsed.ok || dataRows === 0) return;
    restoredRef.current = true;
    view.scrollTop = document.csvView.scrollTop;
    view.scrollLeft = document.csvView.scrollLeft;
    lastScrollRef.current = {
      top: view.scrollTop,
      left: view.scrollLeft,
    };
  }, [
    active,
    dataRows,
    document.csvView.scrollLeft,
    document.csvView.scrollTop,
    parsed.ok,
    viewport.height,
    viewport.width,
  ]);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
      onViewChange({
        scrollTop: lastScrollRef.current.top,
        scrollLeft: lastScrollRef.current.left,
      });
      resizingRef.current = null;
    };
    // Flush the final scroll position to the owning project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fillerColumns = useMemo(() => {
    let renderedWidth =
      48 + widths.reduce((sum, width) => sum + width, 0);
    let count = 0;
    while (
      renderedWidth < viewport.width + DEFAULT_COLUMN_WIDTH &&
      count < 256
    ) {
      renderedWidth += DEFAULT_COLUMN_WIDTH;
      count += 1;
    }
    return count;
  }, [viewport.width, widths]);

  const renderedColumns = dataColumns + fillerColumns;
  const targetRows =
    Math.ceil(Math.max(0, viewport.height - 26) / 26) + 2;
  const fillerRows = Math.max(0, targetRows - dataRows);
  const renderedRows = dataRows + fillerRows;

  const renderedWidths = useMemo(() => {
    const list = widths.slice();
    while (list.length < renderedColumns) {
      list.push(DEFAULT_COLUMN_WIDTH);
    }
    return list;
  }, [renderedColumns, widths]);

  const tableWidth =
    48 + renderedWidths.reduce((sum, width) => sum + width, 0);

  function currentCell(): string {
    if (!parsed.ok || dataRows === 0 || dataColumns === 0) return '';
    return rows[selected.row]?.[selected.col] ?? '';
  }

  function selectCell(row: number, col: number) {
    if (!parsed.ok || dataRows === 0 || dataColumns === 0) return;
    const next = clampGridSelection(
      { row, col },
      { rows: dataRows, cols: dataColumns },
    );
    onViewChange({ selectedRow: next.row, selectedCol: next.col });
    const cell = tableRef.current?.querySelector<HTMLElement>(
      `td.csv-cell[data-row="${next.row}"][data-col="${next.col}"]`,
    );
    if (viewRef.current && cell) {
      viewRef.current.focus({ preventScroll: true });
      revealGridCell(viewRef.current, cell);
    }
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

  function handleGridKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    if (!parsed.ok || dataRows === 0 || dataColumns === 0) return;
    if (event.altKey) return;
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 'c'
    ) {
      event.preventDefault();
      onCopyValue(currentCell());
      return;
    }
    const next = gridStep(
      event.key,
      selected,
      { rows: dataRows, cols: dataColumns },
      event.ctrlKey || event.metaKey,
    );
    if (!next) return;
    event.preventDefault();
    selectCell(next.row, next.col);
  }

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    const view = event.currentTarget;
    lastScrollRef.current = {
      top: view.scrollTop,
      left: view.scrollLeft,
    };
    if (scrollFrameRef.current) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = 0;
      onViewChange({
        scrollTop: view.scrollTop,
        scrollLeft: view.scrollLeft,
      });
    });
  }

  function handleResizePointerDown(
    event: ReactPointerEvent<HTMLSpanElement>,
    index: number,
  ) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const drag: ResizeDrag = {
      pointerId: event.pointerId,
      index,
      startX: event.clientX,
      startWidth: widthsRef.current[index] ?? DEFAULT_COLUMN_WIDTH,
      width: widthsRef.current[index] ?? DEFAULT_COLUMN_WIDTH,
    };
    resizingRef.current = drag;
    handle.setPointerCapture(event.pointerId);

    function onMove(moveEvent: PointerEvent) {
      const active = resizingRef.current;
      if (!active || active.pointerId !== moveEvent.pointerId) return;
      const next = Math.round(
        Math.min(
          MAX_COLUMN_WIDTH,
          Math.max(
            MIN_COLUMN_WIDTH,
            active.startWidth + moveEvent.clientX - active.startX,
          ),
        ),
      );
      if (next === active.width) return;
      active.width = next;
      const nextWidths = widthsRef.current.slice();
      nextWidths[active.index] = next;
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
      const view = viewRef.current;
      onViewChange({
        columnWidths: widthsRef.current,
        scrollTop: view?.scrollTop ?? 0,
        scrollLeft: view?.scrollLeft ?? 0,
      });
    }

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  if (!parsed.ok) {
    return (
      <div className="csv-sheet" data-viewer-kind="csv">
        <p className="grid-notice" role="alert">
          {parsed.message}
        </p>
      </div>
    );
  }

  if (dataRows === 0) {
    return (
      <div className="csv-sheet" data-viewer-kind="csv">
        <p className="grid-notice" role="status">
          CSV 文件为空。
        </p>
      </div>
    );
  }

  return (
    <div className="csv-sheet" data-viewer-kind="csv">
      <div className="csv-bar">
        <span className="csv-bar-address" aria-hidden="true">
          {columnName(selected.col)}
          {selected.row + 1}
        </span>
        <span
          className="csv-bar-value"
          role="status"
          aria-label="当前单元格内容"
          title={currentCell()}
        >
          {currentCell()}
        </span>
      </div>
      <div
        ref={viewRef}
        className="csv-view"
        role="region"
        aria-label="CSV 工作表"
        tabIndex={0}
        onKeyDown={handleGridKeyDown}
        onScroll={handleScroll}
      >
        <table
          ref={tableRef}
          className="csv-table"
          style={{ width: `${tableWidth}px` }}
          aria-rowcount={dataRows}
          aria-colcount={dataColumns}
          onClick={handleGridClick}
        >
          <colgroup>
            <col style={{ width: '48px' }} />
            {renderedWidths.map((width, index) => (
              <col key={index} style={{ width: `${width}px` }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th
                className="csv-corner"
                scope="col"
                aria-label="行号"
              />
              {Array.from({ length: renderedColumns }, (_, col) => {
                const isFiller = col >= dataColumns;
                return (
                  <th
                    key={col}
                    className={
                      isFiller ? 'csv-filler-head' : 'csv-colhead'
                    }
                    scope="col"
                    aria-hidden={isFiller || undefined}
                  >
                    {columnName(col)}
                    {!isFiller ? (
                      <span
                        className="csv-resizer"
                        data-col={col}
                        title={`拖动调整 ${columnName(col)} 列宽度`}
                        onPointerDown={(event) =>
                          handleResizePointerDown(event, col)
                        }
                      />
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: renderedRows }, (_, row) => {
              const isFillerRow = row >= dataRows;
              return (
                <tr key={row} aria-hidden={isFillerRow || undefined}>
                  <th
                    className={
                      isFillerRow ? 'csv-filler-rowhead' : 'csv-rowhead'
                    }
                    scope="row"
                    aria-hidden={isFillerRow || undefined}
                  >
                    {row + 1}
                  </th>
                  {Array.from(
                    { length: renderedColumns },
                    (_, col) => {
                      const isData =
                        !isFillerRow && col < dataColumns;
                      const value = isData
                        ? rows[row]?.[col] ?? ''
                        : '';
                      return (
                        <td
                          key={col}
                          className={
                            isData
                              ? `csv-cell${
                                  selected.row === row &&
                                  selected.col === col
                                    ? ' is-selected'
                                    : ''
                                }`
                              : 'csv-filler'
                          }
                          data-row={isData ? row : undefined}
                          data-col={isData ? col : undefined}
                          title={isData && value ? value : undefined}
                          aria-hidden={!isData || undefined}
                        >
                          {value}
                        </td>
                      );
                    },
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
