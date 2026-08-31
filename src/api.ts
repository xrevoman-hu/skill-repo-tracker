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

const ENGLISH_API_ERRORS: Record<string, string> = {
  filesystem_error: "A filesystem operation failed.",
  sqlite_error: "A SQLite database operation failed.",
  temp_artifact_error: "A temporary file operation failed.",
  zip_error: "The ZIP archive could not be read.",
  prompt_content_required: "Prompt content is required.",
  prompt_content_too_large: "Prompt content must not exceed 5 MiB (5,242,880 UTF-8 bytes).",
  prompt_export_destination_invalid: "The export destination is invalid.",
  prompt_export_dialog_failed: "The export save dialog could not be opened.",
  prompt_export_empty_selection: "Select at least one prompt before exporting.",
  prompt_export_flush_failed: "The exported ZIP could not be fully written.",
  prompt_export_path_failed: "The selected export path could not be resolved.",
  prompt_export_yaml_failed: "The prompt metadata could not be encoded for Markdown export.",
  prompt_fts_integrity_failed: "The prompt search index failed its integrity check.",
  prompt_id_conflict: "A prompt with this ID already exists.",
  prompt_id_invalid: "The prompt ID contains unsupported characters.",
  prompt_not_found: "This prompt no longer exists.",
  prompt_page_invalid: "The page number must start at 1.",
  prompt_page_size_invalid: "Page size must be 30, 50, or 100.",
  prompt_revision_conflict: "This prompt changed in another operation. Reload it and try again.",
  prompt_schema_incompatible: "The existing prompt database schema is incompatible. The migration was rolled back.",
  prompt_schema_integrity_failed: "The prompt database failed its integrity check.",
  prompt_search_cancelled: "This search was replaced by a newer query.",
  prompt_search_failed: "Prompt search failed.",
  prompt_search_timeout: "Search exceeded one second and was cancelled. Narrow the query and try again.",
  prompt_selection_drift: "The prompt library changed during export. Review the selection and try again.",
  prompt_tag_already_exists: "A tag with this name already exists.",
  prompt_tag_merge_required: "A tag with this name already exists. Confirm that you want to merge them.",
  prompt_tag_merge_same: "A tag cannot be merged into itself.",
  prompt_tag_name_required: "Tag name is required.",
  prompt_tag_name_too_long: "Tag name must not exceed 50 characters.",
  prompt_tag_not_found: "The selected tag no longer exists.",
  prompt_title_required: "Prompt title is required.",
  prompt_title_too_long: "Prompt title must not exceed 200 characters.",
  prompt_too_many_tags: "A prompt can have at most 20 tags.",
  prompt_zip_path_unsafe: "An unsafe ZIP entry path was blocked.",
  prompt_zip_bom_forbidden: "Prompt ZIP files must be UTF-8 without a byte-order mark.",
  prompt_zip_database_failed: "The prompt ZIP could not be imported into the local database.",
  prompt_zip_dialog_failed: "The prompt ZIP file picker could not be opened.",
  prompt_zip_duplicate_entry: "The prompt ZIP contains a duplicate archive path.",
  prompt_zip_duplicate_prompt: "The prompt ZIP contains a duplicate prompt ID.",
  prompt_zip_entry_hash_mismatch: "A prompt ZIP entry failed its SHA-256 integrity check.",
  prompt_zip_extra_entry: "The prompt ZIP contains a file that is not listed in its manifest.",
  prompt_zip_file_changed: "The selected prompt ZIP changed after preview. Preview it again.",
  prompt_zip_frontmatter_invalid: "A prompt Markdown file contains invalid or unsupported front matter.",
  prompt_zip_fts_integrity_failed: "The prompt search index failed its integrity check after import.",
  prompt_zip_import_request_invalid: "The prompt ZIP import request is incomplete. Preview the package again.",
  prompt_zip_io_failed: "The prompt ZIP could not be read or written.",
  prompt_zip_legacy_unsupported: "This manifest-less prompt ZIP is from an older export and cannot be imported.",
  prompt_zip_library_changed: "The prompt library changed after preview. Preview the ZIP again.",
  prompt_zip_manifest_invalid: "The prompt ZIP manifest is missing or invalid.",
  prompt_zip_metadata_too_large: "The prompt ZIP contains too much retained metadata.",
  prompt_zip_path_failed: "The selected prompt ZIP path could not be resolved.",
  prompt_zip_schema_unsupported: "This prompt ZIP schema version is not supported.",
  prompt_zip_size_limit_exceeded: "The prompt ZIP exceeds the supported size limits.",
  prompt_zip_total_size_overflow: "The prompt ZIP content total is invalid.",
  prompt_zip_too_many_tags: "The prompt ZIP contains too many unique tags.",
  prompt_zip_utf8_invalid: "A prompt ZIP entry is not valid UTF-8.",
  prompt_reorder_drift: "The prompt library changed while reordering. Refresh and try again.",
  prompt_reorder_invalid_request: "The requested prompt position is invalid. Try moving it again.",
  prompt_reorder_invalid_neighbors: "The selected prompt position is no longer valid. Try dragging again.",
  prompt_reorder_neighbor_not_found: "A neighbouring prompt no longer exists. Refresh and try again.",
  prompt_reorder_pinned_boundary: "Pinned and unpinned prompts cannot be reordered across groups.",
  migration_export_failed: "The migration package could not be exported.",
  migration_import_fingerprint_invalid: "The migration package fingerprint is missing or invalid. Preview the package again.",
  migration_import_path_invalid: "The migration package path is invalid.",
  migration_package_changed_since_preview: "The migration package changed after preview. Preview it again before importing.",
  migration_package_file_too_large: "The migration package file exceeds the supported size limit.",
  migration_package_invalid: "The migration package is invalid.",
  migration_preflight_failed: "The migration package could not be validated before import.",
  migration_schema_unsupported: "This migration package version is not supported.",
  migration_v1_json_invalid: "The legacy v1 migration package contains invalid JSON.",
  migration_v1_schema_unsupported: "This legacy v1 migration package version is not supported.",
  migration_v1_too_large: "The legacy v1 migration package exceeds the supported size limit.",
  prompt_migration_archive_size_overflow: "The migration archive size is invalid.",
  prompt_migration_archive_too_large: "The migration archive exceeds the supported size limit.",
  prompt_migration_atomic_replace_failed: "The migration package could not be finalized atomically.",
  prompt_migration_body_summary_mismatch: "Prompt body totals do not match the migration manifest.",
  prompt_migration_conflict_drift: "Prompt conflicts changed after preview. Preview the package again.",
  prompt_migration_dangling_link: "The migration package contains a tag link to a missing prompt or tag.",
  prompt_migration_duplicate_id_exhausted: "A unique ID could not be generated for an imported copy.",
  prompt_migration_duplicate_link: "The migration package contains a duplicate prompt-tag link.",
  prompt_migration_duplicate_prompt: "The migration package contains a duplicate prompt ID.",
  prompt_migration_duplicate_tag: "The migration package contains a duplicate tag ID.",
  prompt_migration_entry_digest_mismatch: "A migration entry failed its SHA-256 integrity check.",
  prompt_migration_entry_too_large: "A migration entry exceeds the supported size limit.",
  prompt_migration_format_unknown: "The selected file is not a supported migration package.",
  prompt_migration_fts_integrity_failed: "The imported prompt search index failed its integrity check.",
  prompt_migration_id_invalid: "The migration package contains an invalid public ID.",
  prompt_migration_io_failed: "The migration package could not be read or written.",
  prompt_migration_json_invalid: "The migration package contains invalid JSON.",
  prompt_migration_jsonl_invalid: "The migration package contains an invalid JSONL record.",
  prompt_migration_jsonl_record_too_large: "A migration JSONL record exceeds the supported size limit.",
  prompt_migration_manifest_invalid: "The migration manifest is invalid.",
  prompt_migration_meta_missing: "The prompt library metadata row is missing.",
  prompt_migration_order_count_overflow: "The migration package contains too many prompt ordering records.",
  prompt_migration_parent_missing: "The migration package destination folder is missing.",
  prompt_migration_path_invalid: "The migration package contains an unsafe or invalid path.",
  prompt_migration_preflight_drift: "Migration validation changed before import. Preview the package again.",
  prompt_migration_prompt_content_invalid: "The migration package contains invalid prompt content.",
  prompt_migration_prompt_content_too_large: "A prompt in the migration package exceeds 5 MiB.",
  prompt_migration_prompt_excerpt_mismatch: "A prompt excerpt does not match its content.",
  prompt_migration_prompt_hash_mismatch: "A prompt failed its SHA-256 integrity check.",
  prompt_migration_prompt_title_invalid: "The migration package contains an invalid prompt title.",
  prompt_migration_prompt_title_not_normalized: "A prompt title is not Unicode NFC normalized.",
  prompt_migration_record_limit_overflow: "The migration package contains too many records.",
  prompt_migration_reference_drift: "Migration references changed after preview. Preview the package again.",
  prompt_migration_revision_invalid: "The migration package contains an invalid prompt revision.",
  prompt_migration_schema_unsupported: "This prompt migration schema version is not supported.",
  prompt_migration_sensitive_field: "A prohibited sensitive field was found in the migration package.",
  prompt_migration_sensitive_policy_missing: "The migration package is missing its sensitive-data policy.",
  prompt_migration_tag_id_conflict: "An imported tag ID conflicts with a different local tag.",
  prompt_migration_tag_invalid: "The migration package contains an invalid tag.",
  prompt_migration_tag_not_normalized: "A tag name is not Unicode NFC normalized.",
  prompt_migration_timestamp_invalid: "The migration package contains an invalid timestamp.",
  prompt_migration_too_many_links: "The migration package contains too many prompt-tag links.",
  prompt_migration_too_many_prompts: "The migration package contains too many prompts.",
  prompt_migration_too_many_prompt_tags: "A prompt in the migration package has more than 20 tags.",
  prompt_migration_too_many_records: "The migration package contains too many records.",
  prompt_migration_too_many_tags: "The migration package contains too many tags.",
  prompt_migration_total_body_too_large: "The total prompt content in the migration package exceeds the supported limit.",
  prompt_migration_total_size_overflow: "The total prompt content size is invalid.",
  prompt_migration_zip_duplicate_entry: "The migration ZIP contains a duplicate entry.",
  prompt_migration_zip_entry_missing: "A required migration ZIP entry is missing.",
  prompt_migration_zip_invalid: "The migration ZIP is invalid or damaged.",
  prompt_migration_zip_path_invalid: "The migration ZIP contains an unsafe path.",
  prompt_migration_database_failed: "The migration database operation failed.",
};

function errorStringField(error: unknown, field: "code" | "details" | "message") {
  if (!error || typeof error !== "object" || !(field in error)) return "";
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}

export function localizedApiErrorMessage(
  error: unknown,
  language: "zh" | "en",
  fallback: string,
) {
  const code = errorStringField(error, "code");
  const original = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : errorStringField(error, "message");
  const message = language === "en" && code && ENGLISH_API_ERRORS[code]
    ? ENGLISH_API_ERRORS[code]
    : original || fallback;
  const details = errorStringField(error, "details");
  return details && !message.includes(details) ? `${message} (${details})` : message;
}

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
  starredAt?: string | null;
  pushedAt?: string | null;
  updatedAt?: string | null;
  lastRefreshed?: string | null;
  permissions: string;
  readmeSearchText?: string;
  note: string;
};

export type RecognizedSkill = {
  id?: string;
  name: string;
  path?: string;
  version: string;
};

export type RecognizedPlugin = {
  id: string;
  name: string;
  kind: string;
  installCommand: string;
  skillCount: number;
};

export type UiRepository = {
  id: string;
  name: string;
  type: string;
  ref: string;
  skills: number;
  remoteSha: string;
  lastBackupSha: string;
  lastChecked?: string;
  backupStatus: string;
  checkStatus: string;
  url?: string;
  branch?: string;
  backupPath?: string;
  snapshotTime?: string;
  recognizedSkills?: RecognizedSkill[];
  recognizedPlugins?: RecognizedPlugin[];
  sourceType?: string;
  localPath?: string | null;
  addedAt?: string;
  readmeSearchText?: string;
  note?: string;
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
  createdAt: string;
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
  prompts?: number;
  tags?: number;
  totalBytes?: number;
  message: string;
};

export type PromptTagMode = "all" | "any";
export type PromptSort = "manual" | "updatedDesc";
export type PromptPageSize = 30 | 50 | 100;

export type PromptTag = {
  id: string;
  name: string;
  promptCount: number;
  createdAt: string;
  updatedAt: string;
};

export type PromptSummary = {
  id: string;
  title: string;
  excerpt: string;
  tags: PromptTag[];
  pinned: boolean;
  contentBytes: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type PromptDetail = PromptSummary & {
  content: string;
};

export type PromptListFilter = {
  query: string;
  tagIds: string[];
  tagMode: PromptTagMode;
  sort: PromptSort;
};

export type PromptListRequest = PromptListFilter & {
  page: number;
  pageSize: PromptPageSize;
};

export type PromptPage = {
  items: PromptSummary[];
  total: number;
  page: number;
  pageSize: PromptPageSize;
  totalPages: number;
  libraryRevision: number;
};

export type PromptSelection =
  | { mode: "explicit"; ids: string[] }
  | {
      mode: "filter";
      filter: PromptListFilter;
      excludedIds: string[];
      expectedLibraryRevision: number;
    };

export type CreatePromptRequest = {
  title: string;
  content: string;
  tagIds: string[];
  pinned?: boolean;
};

export type UpdatePromptRequest = {
  id: string;
  title: string;
  content: string;
  tagIds: string[];
  pinned?: boolean;
  expectedRevision: number;
};

export type ReorderPromptRequest = {
  id: string;
  previousId: string | null;
  nextId: string | null;
  boundary?: "first" | "last";
  expectedRevision: number;
  expectedLibraryRevision: number;
};

export type ReorderPromptResult = {
  libraryRevision: number;
};

export type PromptExportSummary = {
  path?: string | null;
  cancelled: boolean;
  count: number;
  bytes: number;
  message: string;
};

export type PromptMigrationPreview = {
  path?: string | null;
  cancelled: boolean;
  format: "v1" | "v2";
  packageSha256?: string | null;
  packageSizeBytes: number;
  prompts: number;
  tags: number;
  totalBytes: number;
  conflicts: Array<{
    id: string;
    title: string;
    kind: "same" | "different";
  }>;
  differentConflictCount: number;
  hasDifferentConflicts: boolean;
  valid: boolean;
  message: string;
};

export type PromptMigrationConflictStrategy = "keep-local" | "overwrite" | "duplicate";

export type PromptZipConflictStrategy = PromptMigrationConflictStrategy;

export type PromptZipImportConflict = {
  id: string;
  importedTitle: string;
  localTitle: string;
};

export type PromptZipImportPreview = {
  path?: string | null;
  fileName?: string | null;
  cancelled: boolean;
  sha256?: string | null;
  sizeBytes: number;
  expectedLibraryRevision: number;
  prompts: number;
  totalContentBytes: number;
  newPrompts: number;
  identicalPrompts: number;
  conflictingPrompts: number;
  tagsToCreate: number;
  tagsToReuse: number;
  conflicts: PromptZipImportConflict[];
  valid: boolean;
  message: string;
};

export type PromptZipImportRequest = {
  path: string;
  sha256: string;
  sizeBytes: number;
  expectedLibraryRevision: number;
  conflictStrategy: PromptZipConflictStrategy;
};

export type PromptZipImportResult = {
  inserted: number;
  skippedSame: number;
  keptLocal: number;
  overwritten: number;
  duplicated: number;
  createdTags: number;
  reusedTags: number;
  libraryRevision: number;
  message: string;
};

export type UiTask = {
  id: string;
  kind: string;
  target: string;
  progress: string;
  status: string;
  summary: string;
  retryable: boolean;
  retryReason?: string | null;
  log: string[];
  optimistic?: boolean;
};

export type UiSkill = {
  id: string;
  repoId: string;
  name: string;
  description: string;
  repo: string;
  path: string;
  ref: string;
  localVersion: string;
  remoteVersion: string;
  remoteHash?: string | null;
  handledRemoteSha?: string | null;
  handledRemoteHash?: string | null;
  status: string;
  installed: boolean;
  createdAt?: string;
  updatedAt: string;
  sourceType?: string;
  localPath?: string | null;
  installPath?: string | null;
  deletedPath?: string | null;
  syncTargetsMode?: string;
  syncTargets?: string[];
  resolvedSyncTargets?: string[];
  publishedTargets?: string[];
  canRestore?: boolean;
  canDelete?: boolean;
  searchText?: string;
  note?: string;
  plugins?: SkillPluginReference[];
};

export type SkillDetail = {
  id: string;
  name: string;
  description: string;
  repo: string;
  path: string;
  ref: string;
  localVersion: string;
  remoteVersion: string;
  status: string;
  sourceType?: string;
  localPath?: string | null;
  installPath?: string | null;
  syncTargetsMode?: string;
  syncTargets?: string[];
  resolvedSyncTargets?: string[];
  publishedTargets?: string[];
  plugins: SkillPluginReference[];
  skillMd: string;
  filePath?: string | null;
  note?: string;
};

export type SkillUpdateVerificationState =
  | "pending"
  | "stale"
  | "unchanged"
  | "customized"
  | "latest";

export type SkillUpdateConflict = {
  id: string;
  skillId: string;
  taskId: string;
  status: string;
  localHash: string;
  installedHash?: string | null;
  remoteSha: string;
  remoteHash: string;
  verificationState: SkillUpdateVerificationState;
  verifiedLocalHash?: string | null;
  createdAt: string;
  updatedAt: string;
  verifiedAt?: string | null;
  resolvedAt?: string | null;
};

export type SkillActionOutcome =
  | { kind: "updated"; skills: UiSkill[] }
  | { kind: "conflict"; skills: UiSkill[]; conflict: SkillUpdateConflict };

export type AppMetadata = {
  name: string;
  version: string;
  projectGithubUrl: string;
  openSource: boolean;
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
  listRepositories: () => command<UiRepository[]>("list_repositories"),
  listSkills: () => command<UiSkill[]>("list_skills"),
  listPlugins: () => command<UiPlugin[]>("list_plugins"),
  updateItemNote: (request: {
    target: string;
    id?: string;
    accountId?: string;
    fullName?: string;
    note: string;
  }) => command<any>("update_item_note", { request }),
  getSkillDetail: (skillId: string) =>
    command<SkillDetail>("get_skill_detail", { request: { skillId } }),
  getPluginDetail: (pluginId: string) => command<PluginDetail>("get_plugin_detail", { request: { pluginId } }),
  getRepositoryReadme: (repoId: string) =>
    command<any>("get_repository_readme", { request: { repoId } }),
  getGithubPreview: (url: string) => command<any>("get_github_preview", { request: { url } }),
  listTasks: () => command<UiTask[]>("list_tasks"),
  getAppMetadata: () => command<AppMetadata>("get_app_metadata"),
  getSettings: () => command<any>("get_settings"),
  pickDirectory: (defaultPath?: string) => command<string | null>("pick_directory", { defaultPath }),
  validateDirectory: (kind: string, path: string) =>
    command<any>("validate_directory", { request: { kind, path } }),
  updateSettings: (request: Record<string, unknown>) => command<any>("update_settings", { request }),
  addRepository: (request: { url: string; refName: string; note?: string }) =>
    command<UiRepository[]>("add_repository", { request }),
  addLocalRepository: (path: string) =>
    command<UiRepository[]>("add_local_repository", { request: { path } }),
  checkRepositories: (repoIds?: string[]) =>
    command<UiRepository[]>("check_repositories", { request: { repoIds } }),
  backupRepositories: (mode: string, repoIds?: string[]) =>
    command<UiTask[]>("backup_repositories", { request: { mode, repoIds } }),
  scanLocalSkills: (root?: string) =>
    command<UiSkill[]>("scan_local_skills", { request: { root } }),
  installSkill: (skillId: string) =>
    command<SkillActionOutcome>("install_skill", { request: { skillId } }),
  updateSkill: (skillId: string) =>
    command<SkillActionOutcome>("update_skill", { request: { skillId } }),
  getSkillUpdateConflict: (skillId: string) =>
    command<SkillUpdateConflict>("get_skill_update_conflict", { request: { skillId } }),
  verifySkillUpdateConflict: (conflictId: string) =>
    command<SkillUpdateConflict>("verify_skill_update_conflict", { request: { conflictId } }),
  confirmSkillUpdateConflict: (conflictId: string) =>
    command<SkillActionOutcome>("confirm_skill_update_conflict", { request: { conflictId } }),
  openSkillFolder: (skillId: string) =>
    command<void>("open_skill_folder", { request: { skillId } }),
  deleteSkill: (skillId: string) =>
    command<UiSkill[]>("delete_skill", { request: { skillId, mode: "backup_then_remove" } }),
  restoreSkill: (skillId: string) =>
    command<UiSkill[]>("restore_skill", { request: { skillId } }),
  syncInstalledSkills: () => command<UiSkill[]>("sync_installed_skills"),
  updateSkillSyncTargets: (skillId: string, mode: string, targets: string[]) =>
    command<UiSkill[]>("update_skill_sync_targets", { request: { skillId, mode, targets } }),
  retryTask: (taskId: string) => command<UiTask[]>("retry_task", { request: { taskId } }),
  cancelTask: (taskId: string) => command<any[]>("cancel_task", { request: { taskId } }),
  copyTaskSummary: (taskId: string) => command<string>("copy_task_summary", { request: { taskId } }),
  removeRepository: (id: string) => command<UiRepository[]>("remove_repository", { id }),
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
    command<UiRepository[]>("add_repository_from_github", { request: { accountId, owner, repo, refName } }),
  setGithubToken: (token: string) => command<any>("set_github_token", { request: { token } }),
  clearGithubToken: () => command<any>("clear_github_token"),
  validateGithubToken: () => command<any>("validate_github_token"),
  listBackupHistory: () => command<any[]>("list_backup_history"),
  listPrompts: (request: PromptListRequest) =>
    command<PromptPage>("list_prompts", { request }),
  getPromptDetail: (id: string) =>
    command<PromptDetail>("get_prompt_detail", { request: { id } }),
  createPrompt: (request: CreatePromptRequest) =>
    command<PromptDetail>("create_prompt", { request }),
  updatePrompt: (request: UpdatePromptRequest) =>
    command<PromptDetail>("update_prompt", { request }),
  deletePrompt: (id: string, expectedRevision: number) =>
    command<void>("delete_prompt", {
      request: { id, expectedRevision },
    }),
  setPromptPinned: (id: string, pinned: boolean, expectedRevision: number) =>
    command<PromptSummary>("set_prompt_pinned", {
      request: { id, pinned, expectedRevision },
    }),
  reorderPrompt: (request: ReorderPromptRequest) =>
    command<ReorderPromptResult>("reorder_prompt", { request }),
  listPromptTags: () => command<PromptTag[]>("list_prompt_tags"),
  createPromptTag: (name: string) =>
    command<PromptTag>("create_prompt_tag", { request: { name } }),
  renamePromptTag: (tagId: string, name: string) =>
    command<PromptTag>("rename_prompt_tag", { request: { tagId, name } }),
  mergePromptTags: (sourceTagId: string, targetTagId: string) =>
    command<PromptTag>("merge_prompt_tags", { request: { sourceTagId, targetTagId } }),
  deletePromptTag: (tagId: string) =>
    command<void>("delete_prompt_tag", {
      request: { tagId },
    }),
  exportPromptMarkdown: (id: string) =>
    command<PromptExportSummary>("export_prompt_markdown", { request: { id } }),
  exportPromptsZip: (selection: PromptSelection) =>
    command<PromptExportSummary>("export_prompts_zip", { request: { selection } }),
  previewPromptsZipImport: () =>
    command<PromptZipImportPreview>("preview_prompts_zip_import"),
  importPromptsZip: (request: PromptZipImportRequest) =>
    command<PromptZipImportResult>("import_prompts_zip", { request }),
  previewPromptMigrationPackage: () =>
    command<PromptMigrationPreview>("preview_prompt_migration_package"),
  exportMigrationPackage: (includePrompts = false) =>
    command<MigrationPackageSummary>("export_migration_package", {
      request: { includePrompts },
    }),
  importMigrationPackage: (
    path: string,
    conflictStrategy: PromptMigrationConflictStrategy,
    expectedPackageSha256: string,
    expectedPackageSizeBytes: number,
  ) => command<MigrationPackageSummary>("import_migration_package", {
    request: {
      path,
      conflictStrategy,
      expectedPackageSha256,
      expectedPackageSizeBytes,
    },
  }),
  openBackupFolder: (path?: string) => command<string>("open_backup_folder", { path }),
  openUrl: (url: string, mode = "embedded", browserId?: string) =>
    command<string>("open_url", { request: { url, mode, browserId } }),
  openExternalUrl: (url: string) =>
    command<string>("open_external_url", { request: { url } }),
  listSystemBrowsers: () => command<any[]>("list_system_browsers"),
  configureSchedule: (kind: string, enabled: boolean, intervalMinutes: number) =>
    command<any>("configure_schedule", { request: { kind, enabled, intervalMinutes } }),
};
