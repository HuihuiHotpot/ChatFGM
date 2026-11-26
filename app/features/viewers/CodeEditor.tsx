import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import type { KeyboardEvent, UIEvent } from 'react';
import type {
  OpenDocument,
  TextViewState,
} from '../../state/workspace';
import { languageForFileName } from './viewer-types';
import { highlightCode } from './highlight';
import './viewers.css';

export interface CodeEditorProps {
  document: OpenDocument;
  active: boolean;
  ariaLabel?: string;
  onChange: (content: string) => void;
  onTextViewChange: (patch: Partial<TextViewState>) => void;
}

export function CodeEditor({
  document,
  active,
  ariaLabel,
  onChange,
  onTextViewChange,
}: CodeEditorProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef(0);
  const selectionFrameRef = useRef(0);
  const restoredRef = useRef(false);
  const suppressSelectionRef = useRef(false);
  const lastScrollRef = useRef({
    top: document.textView.scrollTop,
    left: document.textView.scrollLeft,
  });
  const lastSelectionRef = useRef({
    start: document.textView.selectionStart,
    end: document.textView.selectionEnd,
  });
  const previousContentRef = useRef(document.content);
  const followOutputRef = useRef(true);

  const language = languageForFileName(document.name);
  const highlighted = useMemo(
    () => highlightCode(document.content, language),
    [document.content, language],
  );
  const lineNumbers = useMemo(() => {
    const count = Math.max(1, document.content.split('\n').length);
    return Array.from({ length: count }, (_, index) =>
      String(index + 1),
    ).join('\n');
  }, [document.content]);

  function syncScroll() {
    const input = inputRef.current;
    if (!input) return;
    if (highlightRef.current) {
      highlightRef.current.scrollLeft = input.scrollLeft;
      highlightRef.current.scrollTop = input.scrollTop;
    }
    if (gutterRef.current) {
      gutterRef.current.style.transform = `translateY(${-input.scrollTop}px)`;
    }
  }

  function flushScroll() {
    const input = inputRef.current;
    if (!input) return;
    lastScrollRef.current = {
      top: input.scrollTop,
      left: input.scrollLeft,
    };
    onTextViewChange({
      scrollTop: input.scrollTop,
      scrollLeft: input.scrollLeft,
    });
  }

  function scheduleScrollSave() {
    if (scrollFrameRef.current) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = 0;
      flushScroll();
    });
  }

  function flushSelection() {
    const input = inputRef.current;
    if (!input || suppressSelectionRef.current) return;
    lastSelectionRef.current = {
      start: input.selectionStart ?? 0,
      end: input.selectionEnd ?? 0,
    };
    onTextViewChange({
      selectionStart: input.selectionStart ?? 0,
      selectionEnd: input.selectionEnd ?? 0,
    });
  }

  function scheduleSelectionSave() {
    if (selectionFrameRef.current) return;
    selectionFrameRef.current = window.requestAnimationFrame(() => {
      selectionFrameRef.current = 0;
      flushSelection();
    });
  }

  function handleSelectionEvent() {
    const input = inputRef.current;
    if (input && !suppressSelectionRef.current) {
      lastSelectionRef.current = {
        start: input.selectionStart ?? 0,
        end: input.selectionEnd ?? 0,
      };
    }
    scheduleSelectionSave();
  }

  function isAtBottom(input: HTMLTextAreaElement): boolean {
    return (
      input.scrollHeight - input.scrollTop - input.clientHeight <= 24
    );
  }

  useLayoutEffect(() => {
    if (!active || restoredRef.current) return;
    const input = inputRef.current;
    if (!input) return;
    restoredRef.current = true;
    suppressSelectionRef.current = true;
    input.scrollTop = document.textView.scrollTop;
    input.scrollLeft = document.textView.scrollLeft;
    lastScrollRef.current = {
      top: input.scrollTop,
      left: input.scrollLeft,
    };
    followOutputRef.current = isAtBottom(input);
    const max = input.value.length;
    const start = Math.min(document.textView.selectionStart, max);
    const end = Math.min(document.textView.selectionEnd, max);
    try {
      input.setSelectionRange(start, end);
    } catch {
      // Disabled or not focusable elements can reject selection changes.
    }
    lastSelectionRef.current = { start, end };
    syncScroll();
    window.requestAnimationFrame(() => {
      suppressSelectionRef.current = false;
    });
    // The stored state is the restore snapshot for the first activation.
    // Subsequent prop updates must not force the caret back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useLayoutEffect(() => {
    if (active) syncScroll();
  }, [active, highlighted]);

  // Solver logs and other live outputs grow while open. When the reader is at
  // the bottom, follow the newest output; when they scrolled up, restore the
  // reading position instead of jumping to the end.
  useLayoutEffect(() => {
    const input = inputRef.current;
    const previous = previousContentRef.current;
    if (!input || previous === document.content) return;
    previousContentRef.current = document.content;
    if (!active) return;
    const appended = document.content.startsWith(previous);
    if (appended && followOutputRef.current) {
      input.scrollTop = input.scrollHeight;
      lastScrollRef.current = {
        top: input.scrollTop,
        left: input.scrollLeft,
      };
      onTextViewChange({ scrollTop: input.scrollTop });
    } else {
      input.scrollTop = lastScrollRef.current.top;
    }
    syncScroll();
    // Only a disk content change may move the viewport; selection and scroll
    // saves run from their own event handlers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.content]);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
      if (selectionFrameRef.current) {
        window.cancelAnimationFrame(selectionFrameRef.current);
      }
      onTextViewChange({
        scrollTop: lastScrollRef.current.top,
        scrollLeft: lastScrollRef.current.left,
        selectionStart: lastSelectionRef.current.start,
        selectionEnd: lastSelectionRef.current.end,
      });
    };
    // The cleanup deliberately flushes the final view state to the project
    // that mounted this editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleScroll(event: UIEvent<HTMLTextAreaElement>) {
    const input = event.currentTarget;
    lastScrollRef.current = {
      top: input.scrollTop,
      left: input.scrollLeft,
    };
    followOutputRef.current = isAtBottom(input);
    if (highlightRef.current) {
      highlightRef.current.scrollLeft = input.scrollLeft;
      highlightRef.current.scrollTop = input.scrollTop;
    }
    if (gutterRef.current) {
      gutterRef.current.style.transform = `translateY(${-input.scrollTop}px)`;
    }
    scheduleScrollSave();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      // App owns the save action; prevent the browser save dialog here.
      event.preventDefault();
    }
  }

  return (
    <div className="editor-shell" data-viewer-kind="editor">
      <div className="editor-gutter" aria-hidden="true">
        <div ref={gutterRef} className="editor-gutter-inner">
          {lineNumbers}
        </div>
      </div>
      <div className="editor-pane">
        <pre
          ref={highlightRef}
          className="editor-highlight"
          aria-hidden="true"
        >
          <code
            className="hljs"
            data-language={language}
            dangerouslySetInnerHTML={{
              __html: `${highlighted}\n`,
            }}
          />
        </pre>
        <textarea
          ref={inputRef}
          className="editor-input"
          aria-label={ariaLabel ?? `文件内容 ${document.name}`}
          // textarea normalizes CRLF/CR to LF. Keep React's tracked value in
          // the same form so a native change on blur cannot invent an edit
          // after an external read restored the original disk newlines.
          value={document.content.replace(/\r\n?/g, '\n')}
          wrap="off"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          data-document-identity={document.identity}
          data-viewer-kind="editor"
          onChange={(event) => onChange(event.target.value)}
          onScroll={handleScroll}
          onSelect={handleSelectionEvent}
          onKeyUp={handleSelectionEvent}
          onMouseUp={handleSelectionEvent}
          onFocus={handleSelectionEvent}
          onKeyDown={handleKeyDown}
        />
      </div>
    </div>
  );
}
