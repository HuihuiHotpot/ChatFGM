import type { ProjectInfo } from '../../types';
import type { ChatConnectionState } from '../../services/capabilities';
import { StatusConnectionIcon } from '../ui/icons';
import { ProjectProgress, type ProjectProgressSource } from './ProjectProgress';
import './StatusBar.css';

export interface StatusBarProps {
  project: ProjectInfo | null;
  connection?: ChatConnectionState;
  connectionMessage?: string;
  onCopyProjectPath?: () => void;
  progress?: ProjectProgressSource;
}

const CONNECTION_LABELS: Record<ChatConnectionState, string> = {
  connected: '已连接',
  connecting: '连接中',
  disconnected: '未连接',
  error: '连接异常',
};

const CONNECTION_DATA: Record<ChatConnectionState, string> = {
  connected: 'connected',
  connecting: 'connecting',
  disconnected: 'not-connected',
  error: 'error',
};

export function StatusBar({
  project,
  connection = 'disconnected',
  connectionMessage,
  onCopyProjectPath,
  progress,
}: StatusBarProps) {
  const label = CONNECTION_LABELS[connection];
  return (
    <footer className="app-status" aria-label="应用状态栏">
      <div className="status-left">
        <button
          type="button"
          className="status-project"
          data-empty={project ? 'false' : 'true'}
          title={project?.path}
          aria-label={
            project ? `复制项目路径 ${project.name}` : '未打开项目'
          }
          disabled={!project || !onCopyProjectPath}
          onClick={onCopyProjectPath}
        >
          <span className="status-project-name">
            {project ? project.name : '未打开项目'}
          </span>
        </button>
        {project && progress ? (
          <ProjectProgress key={project.id} projectId={project.id} {...progress} />
        ) : null}
      </div>
      <div className="status-right">
        <span className="status-cli">Codex CLI</span>
        <span
          className="status-connection"
          data-state={CONNECTION_DATA[connection]}
          title={connectionMessage || `Codex CLI：${label}`}
        >
          <StatusConnectionIcon />
          <span className="status-connection-text">{label}</span>
        </span>
      </div>
    </footer>
  );
}
