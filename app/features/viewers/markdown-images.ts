import { marked } from 'marked';

marked.setOptions({
  gfm: true,
  breaks: false,
});

/**
 * Mirrors the renderer's HTML attribute semantics: parse the fragment with the
 * same inert template used by renderMarkdown, decode character references and
 * read only the real `src` attribute (never `data-src` or a later occurrence).
 */
function collectHtmlImageSources(html: string, sources: string[]): void {
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const image of template.content.querySelectorAll('img')) {
    const source = image.getAttribute('src');
    if (source) sources.push(source);
  }
}

/** Applies the same HTML attribute parsing to a marked image token href. */
function renderedImageSource(value: string): string {
  const template = document.createElement('template');
  const escaped = value
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  template.innerHTML = `<img src="${escaped}">`;
  return template.content.querySelector('img')?.getAttribute('src') ?? value;
}

function collectSources(value: unknown, sources: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSources(item, sources);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const token = value as {
    type?: string;
    href?: unknown;
    text?: unknown;
    tokens?: unknown;
    items?: unknown;
    header?: unknown;
    rows?: unknown;
  };
  if (token.type === 'image' && typeof token.href === 'string') {
    sources.push(renderedImageSource(token.href));
  }
  if (token.type === 'html' && typeof token.text === 'string') {
    collectHtmlImageSources(token.text, sources);
  }
  // Inline images can be nested in links, list items, table cells and other
  // container tokens. Walk the token tree rather than matching Markdown text.
  for (const child of [
    token.tokens,
    token.items,
    token.header,
    token.rows,
  ]) {
    if (child !== undefined) collectSources(child, sources);
  }
}

/**
 * Returns local image references using the same marked lexer that renders the
 * Markdown preview. Reference-style images, inline images, HTML img tags and
 * nested container tokens therefore share one dependency source of truth.
 */
export function markdownImageSources(source: string): string[] {
  const sources: string[] = [];
  collectSources(marked.lexer(source), sources);
  return sources;
}
