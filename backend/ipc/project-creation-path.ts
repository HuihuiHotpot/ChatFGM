import type { FolderSelection } from './capabilities';

export const PROJECT_PATH_HAN_ERROR = {
  code: 'project-path-contains-han',
  message: '路径不能包含汉字',
} as const;

export function projectPathContainsHan(path: string): boolean {
  return /\p{Script=Han}/u.test(path);
}

export function invalidProjectCreationFolder(folder: FolderSelection | null): boolean {
  return folder !== null && (
    folder.pathContainsHan === true || projectPathContainsHan(folder.path)
  );
}
