export interface Project {
  id: string;
  name: string;
  path: string;
  port: number;
  url: string;
}

export interface CodeServerInfo {
  port: number;
  url: string;
}
