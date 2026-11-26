import type { RecentProject } from '../../types';
import { Button } from '../../components/ui/Button';
import './WelcomeView.css';

export interface WelcomeViewProps {
  recentProjects: readonly RecentProject[];
  actionsAvailable: boolean;
  busy: boolean;
  error: string;
  onNewProject: () => void;
  onOpenProject: () => void;
  onOpenRecentProject: (project: RecentProject) => void;
}

export function WelcomeView({
  recentProjects,
  actionsAvailable,
  busy,
  error,
  onNewProject,
  onOpenProject,
  onOpenRecentProject,
}: WelcomeViewProps) {
  return (
    <section className="welcome" aria-labelledby="welcome-title">
      <div className="welcome-inner">
        <h1 className="welcome-title" id="welcome-title">
          ChatFGM
        </h1>
        <p className="welcome-subtitle">
          自然语言驱动的 Flamelet Generated Manifold 全流程工作台
        </p>
        <div className="welcome-actions">
          <Button
            variant="primary"
            disabled={!actionsAvailable || busy}
            onClick={onNewProject}
          >
            新建项目
          </Button>
          <Button
            disabled={!actionsAvailable || busy}
            onClick={onOpenProject}
          >
            打开项目
          </Button>
        </div>

        {error ? (
          <p className="welcome-error" role="alert">
            {error}
          </p>
        ) : null}

        {recentProjects.length > 0 ? (
          <section className="recent" aria-labelledby="recent-title">
            <div className="recent-bar">
              <h2 className="recent-title" id="recent-title">
                最近项目
              </h2>
            </div>
            <ul className="recent-list">
              {recentProjects.map((project) => (
                <li className="recent-item" key={project.id}>
                  <button
                    className="recent-button"
                    type="button"
                    disabled={!actionsAvailable || busy}
                    aria-label={`打开项目 ${project.name}`}
                    onClick={() => onOpenRecentProject(project)}
                  >
                    <span className="recent-head">
                      <span className="recent-name">{project.name}</span>
                      <span className="recent-time">{project.opened}</span>
                    </span>
                    <span className="recent-path">{project.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </section>
  );
}
