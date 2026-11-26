import { useEffect, useId, useRef, useState } from 'react';
import type { ChatFgmCapabilities, FileTreeEntry } from '../../services/capabilities';
import {
  readWorkflowProgress,
  WORKFLOW_STAGES,
  type WorkflowProgress,
} from '../../features/projects/workflow-progress';

export interface ProjectProgressSource {
  entry: FileTreeEntry | undefined;
  readFile: ChatFgmCapabilities['readFile'];
  saveRevision: number;
}

const STATUS_TEXT: Partial<Record<WorkflowProgress['stage'], string>> = {
  '0': '尚未开始',
  missing: '未记录阶段',
  unknown: '阶段无法识别',
  unreadable: '阶段无法读取',
};

const UNREADABLE: WorkflowProgress = { stage: 'unreadable', completed: new Set() };

export function ProjectProgress({
  projectId,
  entry,
  readFile,
  saveRevision,
}: ProjectProgressSource & { projectId: string }) {
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [reading, setReading] = useState<{
    identity: string;
    progress: WorkflowProgress;
  }>();

  useEffect(() => {
    const fileIdentity = entry?.fileIdentity;
    if (!fileIdentity) return;
    let current = true;
    async function refresh(identity: string) {
      let progress = UNREADABLE;
      try {
        const result = await readFile({ projectId, fileIdentity: identity });
        if (result.status === 'success') progress = readWorkflowProgress(result.value.content);
      } catch {
        // A failed disk read uses the same state as an unavailable caseDict.
      }
      if (current) setReading({ identity, progress });
    }
    void refresh(fileIdentity);
    return () => {
      current = false;
    };
  }, [entry, projectId, readFile, saveRevision]);

  useEffect(() => {
    if (!expanded) return;
    function dismissOutside(event: MouseEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setExpanded(false);
      }
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setExpanded(false);
      triggerRef.current?.focus();
    }
    document.addEventListener('click', dismissOutside, true);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('click', dismissOutside, true);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [expanded]);

  const progress = !entry?.fileIdentity
    ? UNREADABLE
    : reading?.identity === entry.fileIdentity ? reading.progress : null;
  const stage = progress?.stage;
  const message = stage ? STATUS_TEXT[stage] : undefined;

  return (
    <div className="status-progress" ref={rootRef}>
      <button
        type="button"
        className="status-progress-trigger"
        aria-expanded={expanded}
        aria-controls={panelId}
        ref={triggerRef}
        onClick={() => setExpanded(!expanded)}
      >
        项目进度
        <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <section className="status-progress-panel" id={panelId} aria-label="项目进度" hidden={!expanded}>
        {message ? <p className="status-progress-message">{message}</p> : null}
        <ol className="status-progress-stages" role="list">
          {WORKFLOW_STAGES.map(([id, label]) => {
            const completed = progress?.completed.has(id);
            return (
              <li key={id} aria-current={stage === id ? 'step' : undefined} data-completed={completed || undefined}>
                {label}
                {completed ? <span className="visually-hidden">，已确认完成</span> : null}
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
