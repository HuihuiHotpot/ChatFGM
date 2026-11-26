import DOMPurify from 'dompurify';
import katex from 'katex';
import { marked } from 'marked';
import { escapeHtml, highlightCode } from './highlight';

marked.setOptions({
  gfm: true,
  breaks: false,
});

interface MathExpression {
  tex: string;
  display: boolean;
}

interface ProtectedMarkdown {
  text: string;
  expressions: MathExpression[];
}

const MATH_PREFIX = 'CHATFGMMATHPLACEHOLDER';
const MATH_SUFFIX = 'END';
const CODE_PREFIX = 'CHATFGMCODEPLACEHOLDER';
const CODE_SUFFIX = 'END';

interface ProtectedCode {
  text: string;
  spans: string[];
}

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && source[cursor] === '\\';
    cursor -= 1
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/**
 * Replaces CommonMark code spans with inert placeholders before math is
 * extracted. Multi-backtick spans may contain shorter backtick runs.
 */
function protectInlineCode(source: string): ProtectedCode {
  const spans: string[] = [];
  let text = '';
  let index = 0;
  while (index < source.length) {
    if (source[index] !== '`' || isEscaped(source, index)) {
      text += source[index];
      index += 1;
      continue;
    }

    let openingLength = 1;
    while (source[index + openingLength] === '`') {
      openingLength += 1;
    }

    let closingStart = -1;
    let cursor = index + openingLength;
    while (cursor < source.length) {
      if (source[cursor] !== '`') {
        cursor += 1;
        continue;
      }
      let closingLength = 1;
      while (source[cursor + closingLength] === '`') {
        closingLength += 1;
      }
      if (closingLength === openingLength) {
        closingStart = cursor;
        break;
      }
      cursor += closingLength;
    }

    if (closingStart === -1) {
      text += source.slice(index, index + openingLength);
      index += openingLength;
      continue;
    }

    const end = closingStart + openingLength;
    spans.push(source.slice(index, end));
    text += `${CODE_PREFIX}${spans.length - 1}${CODE_SUFFIX}`;
    index = end;
  }
  return { text, spans };
}

function restoreInlineCode(source: string, spans: string[]): string {
  return source.replace(
    new RegExp(`${CODE_PREFIX}(\\d+)${CODE_SUFFIX}`, 'g'),
    (_match, index: string) => spans[Number(index)] ?? '',
  );
}

function nextPlaceholder(
  expressions: MathExpression[],
  tex: string,
  display: boolean,
): string {
  const index = expressions.length;
  expressions.push({ tex, display });
  return `${MATH_PREFIX}${index}${MATH_SUFFIX}`;
}

function protectBlockMath(
  source: string,
  expressions: MathExpression[],
): string {
  let text = source.replace(
    /\$\$([\s\S]+?)\$\$/g,
    (_match, tex: string) =>
      nextPlaceholder(expressions, tex, true),
  );
  text = text.replace(
    /\\\[([\s\S]+?)\\\]/g,
    (_match, tex: string) =>
      nextPlaceholder(expressions, tex, true),
  );
  return text;
}

function protectInlineMath(
  source: string,
  expressions: MathExpression[],
): string {
  const parts = source.split(/(`+[^`\n]*?`+)/g);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part.replace(
        /(^|[^\\$])\$(?!\s)([^\n$]*?[^\s$])\$(?!\d)/g,
        (_match, lead: string, tex: string) =>
          `${lead}${nextPlaceholder(expressions, tex, false)}`,
      );
    })
    .join('');
}

function protectMath(source: string): ProtectedMarkdown {
  const expressions: MathExpression[] = [];
  const lines = source.split('\n');
  const segments: string[] = [];
  let buffer: string[] = [];
  let inFence = false;
  let marker = '';

  function flushText() {
    if (buffer.length === 0) return;
    const joined = buffer.join('\n');
    const code = protectInlineCode(joined);
    const withMath = protectInlineMath(
      protectBlockMath(code.text, expressions),
      expressions,
    );
    segments.push(restoreInlineCode(withMath, code.spans));
    buffer = [];
  }

  for (const line of lines) {
    const fence = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (!inFence) {
      if (fence) {
        flushText();
        segments.push(line);
        inFence = true;
        marker = fence[1];
      } else {
        buffer.push(line);
      }
      continue;
    }

    segments.push(line);
    if (
      fence &&
      fence[1][0] === marker[0] &&
      fence[1].length >= marker.length
    ) {
      inFence = false;
      marker = '';
    }
  }
  flushText();
  return {
    text: segments.join('\n'),
    expressions,
  };
}

function renderMathExpression(expression: MathExpression): string {
  const className = expression.display ? 'md-math-block' : 'md-math-inline';
  try {
    const html = katex.renderToString(expression.tex, {
      displayMode: expression.display,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
      output: 'htmlAndMathml',
    });
    return `<span class="${className}">${html}</span>`;
  } catch {
    const fence = expression.display ? '$$' : '$';
    return `<code>${escapeHtml(`${fence}${expression.tex}${fence}`)}</code>`;
  }
}

function isExternalImageSource(src: string): boolean {
  return /^(?:https?:|data:image\/|blob:)/i.test(src);
}

function isDisallowedImageSource(src: string): boolean {
  return (
    src.length === 0 ||
    src.startsWith('//') ||
    /^file:/i.test(src) ||
    /^[a-zA-Z]:[\\/]/.test(src) ||
    src.startsWith('/') ||
    src.startsWith('\\')
  );
}

function prepareImages(container: HTMLElement) {
  container.querySelectorAll('img').forEach((image) => {
    const src = image.getAttribute('src')?.trim() ?? '';
    image.setAttribute('loading', 'lazy');
    if (isExternalImageSource(src)) {
      image.setAttribute('referrerpolicy', 'no-referrer');
      return;
    }
    image.removeAttribute('src');
    if (isDisallowedImageSource(src)) {
      image.setAttribute('data-image-error', '资源路径无效');
      return;
    }
    image.setAttribute('data-chatfgm-src', src);
    image.classList.add('md-local-image');
    image.setAttribute('data-image-state', 'pending');
  });
}

function prepareCodeBlocks(container: HTMLElement) {
  container.querySelectorAll('pre > code').forEach((code) => {
    const className = code.getAttribute('class') ?? '';
    const language = /language-([a-z0-9_-]+)/i.exec(className)?.[1];
    if (!language) return;
    const source = code.textContent ?? '';
    code.innerHTML = highlightCode(source, language.toLowerCase());
    code.classList.add('hljs');
    code.setAttribute('data-language', language.toLowerCase());
  });
}

export interface RenderMarkdownResult {
  html: string;
  expressions: number;
}

export function renderMarkdown(source: string): RenderMarkdownResult {
  const protectedDoc = protectMath(source);
  const parsed = marked.parse(protectedDoc.text) as string;
  let safeHtml = DOMPurify.sanitize(parsed, {
    USE_PROFILES: { html: true },
  });
  safeHtml = safeHtml.replace(
    new RegExp(`${MATH_PREFIX}(\\d+)${MATH_SUFFIX}`, 'g'),
    (_match, index: string) => {
      const expression = protectedDoc.expressions[Number(index)];
      return expression ? renderMathExpression(expression) : '';
    },
  );

  const template = document.createElement('template');
  template.innerHTML = safeHtml;
  prepareImages(template.content as unknown as HTMLElement);
  prepareCodeBlocks(template.content as unknown as HTMLElement);
  return {
    html: template.innerHTML,
    expressions: protectedDoc.expressions.length,
  };
}

export function decorateMarkdownDocument(container: HTMLElement) {
  container.querySelectorAll('table').forEach((table) => {
    if (table.parentElement?.classList.contains('md-table-scroll')) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'md-table-scroll';
    table.parentNode?.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  });

  container.querySelectorAll('a').forEach((link) => {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noreferrer noopener');
  });
}
