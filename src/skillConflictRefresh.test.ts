import { describe, expect, it, vi } from "vitest";

import { refreshStaleSkillConflict } from "./skillConflictRefresh";
import type { SkillUpdateConflict, UiRepository, UiSkill, UiTask } from "./api";

const previousConflict: SkillUpdateConflict = {
  id: "conflict-old",
  skillId: "skill-1",
  taskId: "task-old",
  status: "pending",
  localHash: "local-old",
  installedHash: "installed-old",
  remoteSha: "remote-old",
  remoteHash: "remote-hash-old",
  verificationState: "stale",
  verifiedLocalHash: "local-verified-old",
  createdAt: "2026-08-28T10:00:00Z",
  updatedAt: "2026-08-28T10:05:00Z",
  verifiedAt: "2026-08-28T10:05:00Z",
  resolvedAt: null,
};

const refreshedConflict: SkillUpdateConflict = {
  ...previousConflict,
  id: "conflict-new",
  taskId: "task-new",
  remoteSha: "remote-new",
  remoteHash: "remote-hash-new",
  verificationState: "pending",
  verifiedLocalHash: null,
  updatedAt: "2026-08-28T10:10:00Z",
  verifiedAt: null,
};

const repositories: UiRepository[] = [{
  id: "repo-1",
  name: "example/review-skills",
  type: "skill repo",
  ref: "main",
  skills: 1,
  remoteSha: "remote-new",
  lastBackupSha: "none",
  backupStatus: "never-backed-up",
  checkStatus: "success",
  sourceType: "github",
}];

const skills: UiSkill[] = [{
  id: "skill-1",
  repoId: "repo-1",
  name: "review-skill",
  description: "",
  repo: "example/review-skills",
  path: "skills/review-skill",
  ref: "main",
  localVersion: "local-old",
  remoteVersion: "remote-new",
  remoteHash: "remote-hash-new",
  status: "update-conflict",
  installed: true,
  updatedAt: "2026-08-28T10:10:00Z",
}];

const tasks: UiTask[] = [{
  id: "task-new",
  kind: "Update Skill",
  target: "review-skill",
  progress: "0 / 1",
  status: "waiting-user",
  summary: "waiting for user",
  retryable: false,
  log: ["new conflict target created"],
}];

describe("refreshStaleSkillConflict", () => {
  it("reads the new pending target without checking an already-refreshed source", async () => {
    const calls: string[] = [];
    const checkRepositories = vi.fn(async () => {
      calls.push("checkRepositories");
      return repositories;
    });

    const result = await refreshStaleSkillConflict({
      previousConflict,
      skillId: "skill-1",
      repoId: "repo-1",
      dependencies: {
        getConflict: async () => {
          calls.push("getConflict");
          return refreshedConflict;
        },
        checkRepositories,
        listRepositories: async () => {
          calls.push("listRepositories");
          return repositories;
        },
        listSkills: async () => {
          calls.push("listSkills");
          return skills;
        },
        listTasks: async () => {
          calls.push("listTasks");
          return tasks;
        },
      },
    });

    expect(result).toEqual({
      kind: "refreshed",
      conflict: refreshedConflict,
      repositories,
      skills,
      tasks,
      checkedSource: false,
    });
    expect(checkRepositories).not.toHaveBeenCalled();
    expect(calls).toEqual(["getConflict", "listRepositories", "listSkills", "listTasks"]);
  });

  it("checks the repository and gets the new target when the backend requires a source refresh", async () => {
    const calls: string[] = [];
    let getCount = 0;

    const result = await refreshStaleSkillConflict({
      previousConflict,
      skillId: "skill-1",
      repoId: "repo-1",
      dependencies: {
        getConflict: async () => {
          calls.push("getConflict");
          getCount += 1;
          if (getCount === 1) {
            throw Object.assign(new Error("refresh required"), {
              code: "skill_conflict_source_refresh_required",
            });
          }
          return refreshedConflict;
        },
        checkRepositories: async (repoIds) => {
          calls.push(`checkRepositories:${repoIds.join(",")}`);
          return repositories;
        },
        listRepositories: async () => {
          calls.push("listRepositories");
          return repositories;
        },
        listSkills: async () => {
          calls.push("listSkills");
          return skills;
        },
        listTasks: async () => {
          calls.push("listTasks");
          return tasks;
        },
      },
    });

    expect(result.kind).toBe("refreshed");
    if (result.kind !== "refreshed") throw new Error("expected refreshed result");
    expect(result.checkedSource).toBe(true);
    expect(result.conflict).toBe(refreshedConflict);
    expect(calls).toEqual([
      "getConflict",
      "checkRepositories:repo-1",
      "getConflict",
      "listRepositories",
      "listSkills",
      "listTasks",
    ]);
  });

  it("preserves the stale conflict when checking the repository fails", async () => {
    const calls: string[] = [];
    const checkError = new Error("network unavailable");

    const result = await refreshStaleSkillConflict({
      previousConflict,
      skillId: "skill-1",
      repoId: "repo-1",
      dependencies: {
        getConflict: async () => {
          calls.push("getConflict");
          throw Object.assign(new Error("refresh required"), {
            code: "skill_conflict_source_refresh_required",
          });
        },
        checkRepositories: async () => {
          calls.push("checkRepositories");
          throw checkError;
        },
        listRepositories: async () => {
          calls.push("listRepositories");
          return repositories;
        },
        listSkills: async () => {
          calls.push("listSkills");
          return skills;
        },
        listTasks: async () => {
          calls.push("listTasks");
          return tasks;
        },
      },
    });

    expect(result).toEqual({
      kind: "failed",
      conflict: previousConflict,
      error: checkError,
    });
    expect(result.conflict).toBe(previousConflict);
    expect(calls).toEqual(["getConflict", "checkRepositories"]);
  });
});
