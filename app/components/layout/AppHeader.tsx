import logoUrl from '../../assets/chatfgm-logo-color.png';
import type { PanelSide } from '../../state/layout';
import { IconButton } from '../ui/IconButton';
import {
  LeftPanelIcon,
  RightPanelIcon,
  SettingsIcon,
} from '../ui/icons';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from '../ui/Menu';
import './AppHeader.css';

export interface AppHeaderProps {
  showPanelToggles: boolean;
  leftVisible: boolean;
  rightVisible: boolean;
  canCreateProject: boolean;
  canOpenProject: boolean;
  canCloseProject: boolean;
  projectActionsDisabled: boolean;
  settingsAvailable: boolean;
  settingsDisabled: boolean;
  settingsExpanded: boolean;
  onTogglePanel: (side: PanelSide) => void;
  onNewProject: () => void;
  onOpenProject: () => void;
  onCloseProject: () => void;
  onOpenSettings: () => void;
}

export function AppHeader({
  showPanelToggles,
  leftVisible,
  rightVisible,
  canCreateProject,
  canOpenProject,
  canCloseProject,
  projectActionsDisabled,
  settingsAvailable,
  settingsDisabled,
  settingsExpanded,
  onTogglePanel,
  onNewProject,
  onOpenProject,
  onCloseProject,
  onOpenSettings,
}: AppHeaderProps) {
  return (
    <header className="app-header">
      <div className="app-menu">
        <h1 className="app-name">
          <Menu>
            <MenuTrigger asChild>
              <button className="app-menu-button" type="button">
                <img
                  className="app-logo"
                  src={logoUrl}
                  alt=""
                  width="20"
                  height="20"
                  aria-hidden="true"
                />
                <span>ChatFGM</span>
              </button>
            </MenuTrigger>
            <MenuContent
              className="app-menu-list"
              sideOffset={15}
              alignOffset={-1}
              collisionPadding={4}
            >
              <MenuItem
                disabled={
                  !canCreateProject || projectActionsDisabled
                }
                onSelect={onNewProject}
              >
                新建项目
              </MenuItem>
              <MenuItem
                disabled={!canOpenProject || projectActionsDisabled}
                onSelect={onOpenProject}
              >
                打开项目
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                disabled={!canCloseProject || projectActionsDisabled}
                onSelect={onCloseProject}
              >
                关闭项目
              </MenuItem>
            </MenuContent>
          </Menu>
        </h1>
      </div>

      <div className="header-actions">
        {showPanelToggles ? (
          <>
            <IconButton
              label={leftVisible ? '隐藏左侧栏' : '显示左侧栏'}
              aria-controls="projects-panel"
              aria-expanded={leftVisible}
              onClick={() => onTogglePanel('left')}
            >
              <LeftPanelIcon />
            </IconButton>
            <IconButton
              label={rightVisible ? '隐藏右侧栏' : '显示右侧栏'}
              aria-controls="chat-panel"
              aria-expanded={rightVisible}
              onClick={() => onTogglePanel('right')}
            >
              <RightPanelIcon />
            </IconButton>
          </>
        ) : null}
        <IconButton
          label="依赖设置"
          disabled={!settingsAvailable || settingsDisabled}
          aria-haspopup="dialog"
          aria-controls="settings-dialog"
          aria-expanded={settingsExpanded}
          onClick={onOpenSettings}
        >
          <SettingsIcon />
        </IconButton>
      </div>
    </header>
  );
}
