import type { RecentProject } from '../types';
import {
  sessionReducer,
} from './workspace';
import type { ProjectSession, SessionAction } from './workspace';
import {
  chatReducer,
  createChatProjectState,
  createInitialChatAppState,
} from '../features/chat/chat-state';
import type {
  ChatAction,
  ChatAppState,
} from '../features/chat/chat-state';

export interface AppData {
  currentProjectId: string | null;
  sessions: Record<string, ProjectSession>;
  recentProjects: RecentProject[];
  chat: ChatAppState;
}

export type AppDataAction =
  | { type: 'set-recent-projects'; recentProjects: RecentProject[] }
  | {
      type: 'activate-project';
      session: ProjectSession;
      replaceSession?: boolean;
    }
  | { type: 'close-project' }
  | { type: 'retire-project'; projectId: string }
  | {
      type: 'session';
      projectId: string;
      action: SessionAction;
    }
  | { type: 'chat'; action: ChatAction };

export function createInitialAppData(): AppData {
  return {
    currentProjectId: null,
    sessions: {},
    recentProjects: [],
    chat: createInitialChatAppState(),
  };
}

function rememberRecent(
  recentProjects: readonly RecentProject[],
  session: ProjectSession,
): RecentProject[] {
  const project = session.project;
  const recent: RecentProject = {
    ...project,
    opened: '刚刚',
  };
  return [
    recent,
    ...recentProjects.filter(
      (item) =>
        item.id !== project.id && item.pathKey !== project.pathKey,
    ),
  ];
}

export function appDataReducer(
  state: AppData,
  action: AppDataAction,
): AppData {
  switch (action.type) {
    case 'retire-project': {
      const sessions = { ...state.sessions };
      const projects = { ...state.chat.projects };
      delete sessions[action.projectId];
      delete projects[action.projectId];
      return {
        ...state, sessions, chat: { ...state.chat, projects },
        currentProjectId: state.currentProjectId === action.projectId ? null : state.currentProjectId,
        recentProjects: state.recentProjects.filter((project) => project.id !== action.projectId),
      };
    }
    case 'set-recent-projects': {
      const sessionPathKeys = new Set(
        Object.values(state.sessions).map(
          (session) => session.project.pathKey,
        ),
      );
      if (sessionPathKeys.size === 0) {
        return {
          ...state,
          recentProjects: action.recentProjects,
        };
      }
      return {
        ...state,
        recentProjects: [
          ...state.recentProjects.filter((project) =>
            sessionPathKeys.has(project.pathKey),
          ),
          ...action.recentProjects.filter(
            (project) => !sessionPathKeys.has(project.pathKey),
          ),
        ],
      };
    }

    case 'activate-project': {
      const project = action.session.project;
      // App.tsx has already reconciled the cached session (tree, valid tabs,
      // unsaved edits) before dispatching. Do not replace it with the older
      // cached object here.
      const session = action.session;

      return {
        ...state,
        currentProjectId: project.id,
        sessions: {
          ...state.sessions,
          [project.id]: session,
        },
        recentProjects: rememberRecent(state.recentProjects, session),
        chat: state.chat.projects[project.id]
          ? state.chat
          : {
              ...state.chat,
              projects: {
                ...state.chat.projects,
                [project.id]: createChatProjectState(),
              },
            },
      };
    }

    case 'close-project':
      return {
        ...state,
        currentProjectId: null,
      };

    case 'session': {
      const session = state.sessions[action.projectId];
      if (!session) return state;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.projectId]: sessionReducer(session, action.action),
        },
      };
    }

    case 'chat': {
      const chat = chatReducer(state.chat, action.action);
      if (chat === state.chat) return state;
      return { ...state, chat };
    }

    default:
      return state;
  }
}

export function currentSession(state: AppData): ProjectSession | null {
  if (!state.currentProjectId) return null;
  return state.sessions[state.currentProjectId] ?? null;
}
