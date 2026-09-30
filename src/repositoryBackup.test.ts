import { describe, expect, it } from "vitest";
import { isRepositoryBackupEligible, needsRepositoryBackup, repositoryBackupTargets } from "./repositoryBackup";
import { repositorySelectionState, toggleRepositorySelection } from "./repositoryPagination";

const allowed = { id: "allowed", sourceType: "github", backupEnabled: true, backupStatus: "updated-not-backed-up" };
const watching = { ...allowed, id: "watching", backupEnabled: false };
const local = { ...allowed, id: "local", sourceType: "local" };
const backed = { ...allowed, id: "backed", backupStatus: "backed-up-latest" };
const never = { ...allowed, id: "never", backupStatus: "never-backed-up" };
const failed = { ...allowed, id: "failed", backupStatus: "check-failed" };

describe("repository backup policy", () => {
  it("keeps selection independent of backup permission across pages", () => {
    expect(isRepositoryBackupEligible(watching)).toBe(false);
    expect(isRepositoryBackupEligible(local)).toBe(false);
    expect(isRepositoryBackupEligible(allowed)).toBe(true);
    expect(toggleRepositorySelection([allowed, watching, local], ["another-page"], true))
      .toEqual(["another-page", "allowed", "watching"]);
    expect(repositorySelectionState([allowed, watching], ["allowed", "watching"]).checked).toBe(true);
    expect(toggleRepositorySelection([watching], ["allowed", "watching", "another-page"], false))
      .toEqual(["allowed", "another-page"]);
  });

  it("excludes watch-only rows from both manual and scheduled targets without hiding their update state", () => {
    const repositories = [allowed, watching, local, backed, never, failed];
    expect(repositoryBackupTargets(repositories, "selected", repositories.map((repository) => repository.id)))
      .toEqual([allowed, backed, never, failed]);
    expect(repositoryBackupTargets(repositories, "updated", [])).toEqual([allowed, never, failed]);
    expect(repositoryBackupTargets(repositories, "all", [])).toEqual([allowed, backed, never, failed]);
    expect(repositories.filter(needsRepositoryBackup)).toEqual([allowed, never]);
    expect(watching.backupStatus).toBe("updated-not-backed-up");
    expect(repositoryBackupTargets([watching], "selected", [watching.id])).toEqual([]);
  });
});
