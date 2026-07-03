import { invoke } from "@tauri-apps/api/core";

type ApiError = {
  code: string;
  message: string;
  details?: string;
};

type ApiResponse<T> = {
  ok: boolean;
  data?: T;
  error?: ApiError;
};

export type GitHubAccount = {
  id: string;
  login: string;
  displayName: string;
  avatarUrl?: string | null;
  status: string;
  scopes: string;
  lastVerified?: string | null;
};

export type GitHubRepository = {
  accountId: string;
  accountLogin: string;
  owner: string;
  repo: string;
  fullName: string;
  htmlUrl: string;
  description: string;
  visibility: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  defaultBranch: string;
  language: string;
  stargazersCount: number;
  starred: boolean;
  trackedRepoId?: string | null;
  pushedAt?: string | null;
  updatedAt?: string | null;
  lastRefreshed?: string | null;
  permissions: string;
  note: string;
};

export type PluginSkillSummary = {
  id: string;
  name: string;
  path: string;
  version: string;
  status: string;
};

export type SkillPluginReference = {
  id: string;
  name: string;
  kind: string;
  installCommand: string;
};

export type UiPlugin = {
  id: string;
  repoId: string;
  repoName: string;
  name: string;
  description: string;
  kind: string;
  installCommand: string;
  updateCommand?: string | null;
  sourcePath: string;
  sourceExcerpt: string;
  status: string;
  skillCount: number;
  detectedSha: string;
  updatedAt: string;
  linkedSkills?: PluginSkillSummary[];
  note: string;
};

export type PluginDetail = UiPlugin & {
  linkedSkills: PluginSkillSummary[];
};

export type MigrationPackageSummary = {
  path?: string | null;
  cancelled: boolean;
  githubAccounts: number;
  githubRepositories: number;
  repositories: number;
  skills: number;
  plugins: number;
  userNotes: number;
  message: string;
};

const runningInTauri = () => typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

async function command<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!runningInTauri()) {
    throw new Error("Tauri backend is not available in browser preview.");
  }
  const response = await invoke<ApiResponse<T>>(name, args);
  if (!response.ok) {
    const error = new Error(response.error?.message || "Command failed");
    Object.assign(error, { code: response.error?.code, details: response.error?.details });
    throw error;
  }
  return response.data as T;
}

export const isDesktopRuntime = runningInTauri;

export const api = {
  listRepositories: () => command<any[]>("list_repositories"),
  listSkills: () => command<any[]>("list_skills"),
  listPlugins: () => command<UiPlugin[]>("list_plugins"),
  updateItemNote: (request: {
    target: string;
    id?: string;
    accountId?: string;
    fullName?: string;
    note: string;
  }) => command<any>("update_item_note", { request }),
  getSkillDetail: (skillId: string) => command<any>("get_skill_detail", { request: { skillId } }),
  getPluginDetail: (pluginId: string) => command<PluginDetail>("get_plugin_detail", { request: { pluginId } }),
  getRepositoryReadme: (repoId: string) =>
    command<any>("get_repository_readme", { request: { repoId } }),
  getGithubPreview: (url: string) => command<any>("get_github_preview", { request: { url } }),
  listTasks: () => command<any[]>("list_tasks"),
  getSettings: () => command<any>("get_settings"),
  pickDirectory: (defaultPath?: string) => command<string | null>("pick_directory", { defaultPath }),
  validateDirectory: (kind: string, path: string) =>
    command<any>("validate_directory", { request: { kind, path } }),
  updateSettings: (request: Record<string, unknown>) => command<any>("update_settings", { request }),
  addRepository: (request: { url: string; refName: string; note?: string }) =>
    command<any[]>("add_repository", { request }),
  addLocalRepository: (path: string) => command<any[]>("add_local_repository", { request: { path } }),
  checkRepositories: (repoIds?: string[]) =>
    command<any[]>("check_repositories", { request: { repoIds } }),
  backupRepositories: (mode: string, repoIds?: string[]) =>
    command<any[]>("backup_repositories", { request: { mode, repoIds } }),
  scanLocalSkills: (root?: string) => command<any[]>("scan_local_skills", { request: { root } }),
  installSkill: (skillId: string) => command<any[]>("install_skill", { request: { skillId } }),
  updateSkill: (skillId: string) => command<any[]>("update_skill", { request: { skillId } }),
  deleteSkill: (skillId: string) =>
    command<any[]>("delete_skill", { request: { skillId, mode: "backup_then_remove" } }),
  restoreSkill: (skillId: string) => command<any[]>("restore_skill", { request: { skillId } }),
  syncInstalledSkills: () => command<any[]>("sync_installed_skills"),
  updateSkillSyncTargets: (skillId: string, mode: string, targets: string[]) =>
    command<any[]>("update_skill_sync_targets", { request: { skillId, mode, targets } }),
  resolveSkillLocalConflict: (skillId: string, choice: string) =>
    command<any[]>("resolve_skill_local_conflict", { request: { skillId, choice } }),
  retryTask: (taskId: string) => command<any[]>("retry_task", { request: { taskId } }),
  cancelTask: (taskId: string) => command<any[]>("cancel_task", { request: { taskId } }),
  copyTaskSummary: (taskId: string) => command<string>("copy_task_summary", { request: { taskId } }),
  removeRepository: (id: string) => command<any[]>("remove_repository", { id }),
  listGithubAccounts: () => command<GitHubAccount[]>("list_github_accounts"),
  saveGithubAccountToken: (token: string) =>
    command<GitHubAccount[]>("save_github_account_token", { request: { token } }),
  deleteGithubAccount: (accountId: string) =>
    command<GitHubAccount[]>("delete_github_account", { request: { accountId } }),
  validateGithubAccount: (accountId: string) =>
    command<GitHubAccount[]>("validate_github_account", { request: { accountId } }),
  refreshGithubRepositories: (accountId?: string) =>
    command<GitHubRepository[]>("refresh_github_repositories", { request: { accountId } }),
  listGithubRepositoryCatalog: (accountId?: string) =>
    command<GitHubRepository[]>("list_github_repository_catalog", { request: { accountId } }),
  setGithubStar: (accountId: string, owner: string, repo: string, starred: boolean) =>
    command<GitHubRepository[]>("set_github_star", { request: { accountId, owner, repo, starred } }),
  addRepositoryFromGithub: (accountId: string, owner: string, repo: string, refName?: string) =>
    command<any[]>("add_repository_from_github", { request: { accountId, owner, repo, refName } }),
  setGithubToken: (token: string) => command<any>("set_github_token", { request: { token } }),
  clearGithubToken: () => command<any>("clear_github_token"),
  validateGithubToken: () => command<any>("validate_github_token"),
  listBackupHistory: () => command<any[]>("list_backup_history"),
  exportMigrationPackage: () => command<MigrationPackageSummary>("export_migration_package"),
  importMigrationPackage: () => command<MigrationPackageSummary>("import_migration_package"),
  openBackupFolder: (path?: string) => command<string>("open_backup_folder", { path }),
  openUrl: (url: string, mode = "embedded", browserId?: string) =>
    command<string>("open_url", { request: { url, mode, browserId } }),
  listSystemBrowsers: () => command<any[]>("list_system_browsers"),
  configureSchedule: (kind: string, enabled: boolean, intervalMinutes: number) =>
    command<any>("configure_schedule", { request: { kind, enabled, intervalMinutes } }),
};
