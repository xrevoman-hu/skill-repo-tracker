type RepositoryBackupState = {
  id: string;
  sourceType?: string;
  backupEnabled: boolean;
  backupStatus: string;
};

/** Selection is independent: watching-only repositories remain selectable. */
export function isRepositoryBackupEligible(repository: RepositoryBackupState): boolean {
  return repository.sourceType === "github" && repository.backupEnabled;
}

export function needsRepositoryBackup(repository: RepositoryBackupState): boolean {
  return isRepositoryBackupEligible(repository)
    && ["updated-not-backed-up", "never-backed-up"].includes(repository.backupStatus);
}

export function repositoryBackupTargets<T extends RepositoryBackupState>(
  repositories: T[],
  mode: string,
  repositoryIds: string[],
): T[] {
  const selectedIds = new Set(repositoryIds);
  return repositories.filter((repository) => isRepositoryBackupEligible(repository)
    && (mode === "selected"
      ? selectedIds.has(repository.id)
      : mode === "all" || ["updated-not-backed-up", "never-backed-up", "check-failed"].includes(repository.backupStatus)));
}
