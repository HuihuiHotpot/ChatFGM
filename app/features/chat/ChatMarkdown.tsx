import { useLayoutEffect, useMemo, useRef } from 'react';
import type { MouseEvent } from 'react';
import {
  decorateMarkdownDocument,
  renderMarkdown,
} from '../viewers/markdown';

export interface ChatMarkdownProps {
  source: string;
  onOpenProjectFile: (href: string) => void;
}

/**
 * Chat messages use the same sanitized Markdown pipeline as the Markdown
 * viewer. The extra wrapping keeps wide tables and code inside the chat log.
 */
export function ChatMarkdown({ source, onOpenProjectFile }: ChatMarkdownProps) {
  const ref = useRef<HTMLDivElement>(null);
  const rendered = useMemo(() => renderMarkdown(source), [source]);

  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    container.querySelectorAll('table').forEach((table) => {
      if (table.parentElement?.classList.contains('md-table-scroll')) {
        return;
      }
      const wrapper = document.createElement('div');
      wrapper.className = 'md-table-scroll chat-md-scroll';
      table.parentNode?.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    });
    decorateMarkdownDocument(container);
  }, [rendered.html]);

  function handleLinkClick(event: MouseEvent<HTMLDivElement>) {
    if (event.button !== 0 && event.button !== 1) return;
    const link = event.target instanceof Element
      ? event.target.closest('a[href]')
      : null;
    const href = link?.getAttribute('href')?.trim();
    if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/|[#?])/i.test(href)) return;

    event.preventDefault();
    onOpenProjectFile(href);
  }

  if (!source) return null;

  return (
    <div
      ref={ref}
      className="msg-md chat-markdown"
      onClick={handleLinkClick}
      onAuxClick={handleLinkClick}
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  );
}
