import { useLayoutEffect, useState } from 'react';
import type { ProjectSession } from '../../state/workspace';
import './viewers.css';

export interface HtmlViewerHostProps {
  sessions: Record<string, ProjectSession>;
  currentProjectId: string | null;
}

interface HtmlFrameEntry {
  key: string;
  projectId: string;
  title: string;
  url: string;
  previewRevision: number;
  active: boolean;
}

interface FrameRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function HtmlViewerHost({
  sessions,
  currentProjectId,
}: HtmlViewerHostProps) {
  const [rect, setRect] = useState<FrameRect | null>(null);
  const frames: HtmlFrameEntry[] = [];

  for (const [projectId, session] of Object.entries(sessions)) {
    for (const document of session.tabs) {
      if (
        document.viewerKind !== 'html' ||
        !document.htmlView.previewUrl
      ) {
        continue;
      }
      frames.push({
        key: `${projectId}:${document.instanceId}`,
        projectId,
        title: document.name,
        url: document.htmlView.previewUrl,
        previewRevision: document.htmlView.previewRevision,
        active:
          projectId === currentProjectId &&
          document.identity === session.activeIdentity,
      });
    }
  }

  const activeFrame = frames.find((frame) => frame.active) ?? null;
  const activeKey = activeFrame?.key ?? null;

  useLayoutEffect(() => {
    if (!activeKey) {
      setRect(null);
      return;
    }
    let frame = 0;
    let observer: ResizeObserver | null = null;
    const measure = () => {
      const marker = document.querySelector<HTMLElement>(
        '.document-pane:not([hidden]) [data-html-view-mount="true"]',
      );
      if (!marker) {
        setRect(null);
        return;
      }
      const bounds = marker.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) {
        setRect(null);
        return;
      }
      setRect({
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      });
    };
    const schedule = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const marker = document.querySelector<HTMLElement>(
        '.document-pane:not([hidden]) [data-html-view-mount="true"]',
      );
      if (marker) {
        observer = new ResizeObserver(schedule);
        observer.observe(marker);
      }
    }
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [activeKey, currentProjectId]);

  return (
    <div
      className="html-frame-layer"
      hidden={!activeFrame || !rect}
      style={
        rect
          ? {
              left: `${rect.left}px`,
              top: `${rect.top}px`,
              width: `${rect.width}px`,
              height: `${rect.height}px`,
            }
          : undefined
      }
      data-viewer-kind="html-frame-layer"
    >
      {frames.map((frame) => (
        <div
          key={`${frame.key}:${frame.previewRevision}`}
          className="html-frame-shell"
          hidden={!frame.active}
          data-project-id={frame.projectId}
        >
          <iframe
            className="html-frame"
            title={frame.title}
            src={frame.url}
            sandbox="allow-scripts allow-forms"
            referrerPolicy="no-referrer"
          />
        </div>
      ))}
    </div>
  );
}
