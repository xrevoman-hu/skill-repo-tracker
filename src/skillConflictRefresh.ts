import type { SkillUpdateConflict, UiRepository, UiSkill, UiTask } from "./api";

const SOURCE_REFRESH_REQUIRED = "skill_conflict_source_refresh_required";

export type SkillConflictRefreshDependencies = {
  getConflict: (skillId: string) => Promise<SkillUpdateConflict>;
  checkRepositories: (repoIds: string[]) => Promise<UiRepository[]>;
  listRepositories: () => Promise<UiRepository[]>;
  listSkills: () => Promise<UiSkill[]>;
  listTasks: () => Promise<UiTask[]>;
};

type SkillConflictRefreshInput = {
  previousConflict: SkillUpdateConflict;
  skillId: string;
  repoId: string;
  dependencies: SkillConflictRefreshDependencies;
};

export type SkillConflictRefreshResult =
  | {
      kind: "refreshed";
      conflict: SkillUpdateConflict;
      repositories: UiRepository[];
      skills: UiSkill[];
      tasks: UiTask[];
      checkedSource: boolean;
    }
  | {
      kind: "failed";
      conflict: SkillUpdateConflict;
      error: unknown;
    };

function commandErrorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  return typeof error.code === "string" ? error.code : "";
}

export async function refreshStaleSkillConflict({
  previousConflict,
  skillId,
  repoId,
  dependencies,
}: SkillConflictRefreshInput): Promise<SkillConflictRefreshResult> {
  let checkedSource = false;

  try {
    let conflict: SkillUpdateConflict;
    try {
      conflict = await dependencies.getConflict(skillId);
    } catch (error: unknown) {
      if (commandErrorCode(error) !== SOURCE_REFRESH_REQUIRED) throw error;
      await dependencies.checkRepositories([repoId]);
      checkedSource = true;
      conflict = await dependencies.getConflict(skillId);
    }

    const [repositories, skills, tasks] = await Promise.all([
      dependencies.listRepositories(),
      dependencies.listSkills(),
      dependencies.listTasks(),
    ]);

    return {
      kind: "refreshed",
      conflict,
      repositories,
      skills,
      tasks,
      checkedSource,
    };
  } catch (error: unknown) {
    return {
      kind: "failed",
      conflict: previousConflict,
      error,
    };
  }
}
