export type CsvParseResult =
  | { ok: true; rows: string[][] }
  | { ok: false; message: string };

type FieldState = 'start' | 'unquoted' | 'quoted' | 'afterQuote';

/**
 * Parses RFC 4180-style CSV without converting field values. The first row is
 * ordinary data. A trailing newline does not create an extra row; an empty
 * source file produces zero rows. Quotes are only legal at the start of a
 * field, and only delimiters may follow a closing quote.
 */
export function parseCsv(source: string): CsvParseResult {
  let text = source;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n?/g, '\n');

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let state: FieldState = 'start';
  let line = 1;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (state === 'quoted') {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          state = 'afterQuote';
        }
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }

    if (state === 'afterQuote') {
      if (char === ',') {
        row.push(field);
        field = '';
        state = 'start';
        continue;
      }
      if (char === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        state = 'start';
        line += 1;
        continue;
      }
      return {
        ok: false,
        message: `第 ${line} 行：引号字段后存在非法字符“${char}”`,
      };
    }

    if (char === '"') {
      if (state !== 'start') {
        return {
          ok: false,
          message: `第 ${line} 行：引号格式错误`,
        };
      }
      state = 'quoted';
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = '';
      state = 'start';
      continue;
    }

    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      state = 'start';
      line += 1;
      continue;
    }

    field += char;
    state = 'unquoted';
  }

  if (state === 'quoted') {
    return {
      ok: false,
      message: `第 ${line} 行：引号未闭合`,
    };
  }

  if (state !== 'start' || row.length > 0 || field !== '') {
    row.push(field);
    rows.push(row);
  }

  return { ok: true, rows };
}

export function csvColumnCount(rows: readonly string[][]): number {
  return rows.reduce((max, cells) => Math.max(max, cells.length), 0);
}
