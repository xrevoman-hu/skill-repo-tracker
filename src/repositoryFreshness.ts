type CheckedRepository = { lastChecked?: string | null };

export function latestRepositoryCheck(
  repositories: readonly CheckedRepository[],
): string | null {
  const checks = repositories
    .map((repository) => repository.lastChecked?.trim())
    .filter((value): value is string => Boolean(value));
  if (checks.length === 0) return null;

  return checks.reduce((latest, candidate) => {
    const latestTime = Date.parse(latest);
    const candidateTime = Date.parse(candidate);
    if (Number.isNaN(candidateTime)) return latest;
    if (Number.isNaN(latestTime) || candidateTime > latestTime) return candidate;
    return latest;
  });
}
