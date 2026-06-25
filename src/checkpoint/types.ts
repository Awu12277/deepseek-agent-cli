export interface Checkpoint {
  stashSha: string;
  timestamp: number;
  cwd: string;
  isGitRepo: boolean;
}
