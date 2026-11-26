export const DEFAULT_COLUMN_WIDTH = 96;
export const MIN_COLUMN_WIDTH = 48;
export const MAX_COLUMN_WIDTH = 640;
export const GRID_ROW_HEIGHT = 26;
export const GRID_HEADER_HEIGHT = 26;

export interface GridBounds {
  rows: number;
  cols: number;
}

export interface GridSelection {
  row: number;
  col: number;
}

export function columnName(index: number): string {
  let name = '';
  let value = index;
  do {
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return name;
}

export function clampGridSelection(
  selection: GridSelection,
  bounds: GridBounds,
): GridSelection {
  return {
    row: Math.max(0, Math.min(bounds.rows - 1, selection.row)),
    col: Math.max(0, Math.min(bounds.cols - 1, selection.col)),
  };
}

export interface GridStep {
  row: number;
  col: number;
}

export function gridStep(
  key: string,
  selection: GridStep,
  bounds: GridBounds,
  modKey: boolean,
): GridStep | null {
  if (key === 'ArrowUp') return { row: selection.row - 1, col: selection.col };
  if (key === 'ArrowDown') return { row: selection.row + 1, col: selection.col };
  if (key === 'ArrowLeft') return { row: selection.row, col: selection.col - 1 };
  if (key === 'ArrowRight') return { row: selection.row, col: selection.col + 1 };
  if (key === 'PageDown') return { row: selection.row + 10, col: selection.col };
  if (key === 'PageUp') return { row: selection.row - 10, col: selection.col };
  if (key === 'Home') {
    return modKey
      ? { row: 0, col: 0 }
      : { row: selection.row, col: 0 };
  }
  if (key === 'End') {
    return modKey
      ? { row: bounds.rows - 1, col: bounds.cols - 1 }
      : { row: selection.row, col: bounds.cols - 1 };
  }
  return null;
}

export function revealGridCell(
  view: HTMLElement | null,
  cell: HTMLElement | null,
  headWidth = 48,
  headHeight = GRID_HEADER_HEIGHT,
) {
  if (!view || !cell) return;
  const viewRect = view.getBoundingClientRect();
  const cellRect = cell.getBoundingClientRect();
  const left = cellRect.left - viewRect.left;
  const top = cellRect.top - viewRect.top;
  if (left < headWidth) {
    view.scrollLeft += left - headWidth;
  } else if (left + cellRect.width > view.clientWidth) {
    view.scrollLeft += left + cellRect.width - view.clientWidth;
  }
  if (top < headHeight) {
    view.scrollTop += top - headHeight;
  } else if (top + cellRect.height > view.clientHeight) {
    view.scrollTop += top + cellRect.height - view.clientHeight;
  }
}

export function estimateColumnWidths(
  values: readonly (readonly string[])[],
  columns: number,
): number[] {
  const widths = Array.from(
    { length: Math.max(0, columns) },
    () => DEFAULT_COLUMN_WIDTH,
  );
  const limit = Math.min(values.length, 400);
  for (let row = 0; row < limit; row += 1) {
    const line = values[row] ?? [];
    for (let col = 0; col < columns; col += 1) {
      const text = line[col] ?? '';
      if (!text) continue;
      const estimated =
        Array.from(text).reduce(
          (sum, character) =>
            sum + (character.charCodeAt(0) > 255 ? 13 : 7.5),
          0,
        ) + 18;
      if (estimated > widths[col]) {
        widths[col] = Math.min(
          MAX_COLUMN_WIDTH,
          Math.max(DEFAULT_COLUMN_WIDTH, Math.ceil(estimated)),
        );
      }
    }
  }
  return widths;
}

export function fitWidthsToColumns(
  widths: readonly number[],
  columns: number,
): number[] {
  return Array.from({ length: Math.max(0, columns) }, (_, index) => {
    const value = widths[index];
    return typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= MIN_COLUMN_WIDTH
      ? Math.min(MAX_COLUMN_WIDTH, value)
      : DEFAULT_COLUMN_WIDTH;
  });
}
