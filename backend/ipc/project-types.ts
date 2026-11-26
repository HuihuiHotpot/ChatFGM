export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  pathKey: string;
  toolboxId?: string;
}

export interface RecentProject extends ProjectInfo {
  opened: string;
}
