import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  SkillConflictNotice,
  SkillsView,
  SkillUpdateConflictModal,
  TasksView,
  getCopy,
} from "./App";
import type { SkillUpdateConflict } from "./api";

const copy: Record<string, string> = {
  agentConflictGuidance:
    "Use Agent tools to inspect the local Skill and complete the update in this folder. Installation decisions remain yours.",
  confirmAgentUpdate: "Confirm Agent update",
  conflictHashes: "Conflict fingerprints",
  conflictQualityLimit:
    "Verification only checks file changes and the target SHA. It cannot prove merge quality.",
  conflictReadyCustomized: "Local files changed and are stable. Confirm that you completed the update with Agent.",
  conflictReadyLatest: "Local files match the target version. Confirm completion.",
  conflictStale: "The remote target SHA changed. Re-check against the new target before confirming.",
  conflictUnchanged: "No file change was detected yet. Complete the local update, then re-check.",
  currentLocalHash: "Current local hash",
  handleLater: "Handle later",
  localSkillConflictText: "The app stopped before changing local files.",
  localSkillConflictTitle: "Local changes need attention",
  openLocalFolder: "Open local folder",
  recheckConflict: "Re-check",
  remoteHash: "Target hash",
  remoteSha: "Target SHA",
  localSource: "Skill library path",
  handleConflict: "Handle conflict",
  noActionNeeded: "Up to date",
  retry: "Retry",
  sourceRepository: "Source repository",
  verificationPending: "Waiting for local update",
  verificationResult: "Verification result",
  close: "Close",
  waitingUser: "Waiting for user",
};

const t = (key: string) => copy[key] || key;

function conflict(
  verificationState: SkillUpdateConflict["verificationState"] = "pending",
): SkillUpdateConflict {
  return {
    id: "conflict-1",
    skillId: "skill-1",
    taskId: "task-1",
    status: "pending",
    localHash: "local-before",
    installedHash: "installed-before",
    remoteSha: "abc1234",
    remoteHash: "remote-target",
    verificationState,
    verifiedLocalHash: verificationState === "pending" ? null : "local-after",
    createdAt: "2026-08-28T10:00:00Z",
    updatedAt: "2026-08-28T10:05:00Z",
    verifiedAt: verificationState === "pending" ? null : "2026-08-28T10:05:00Z",
    resolvedAt: null,
  };
}

const skill = {
  id: "skill-1",
  name: "review-skill",
  installPath: "/Users/example/SkillRepoTracker/skills/review-skill",
  repo: "example/review-skills",
};

function ConflictHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">Resolve review-skill</button>
      {open && (
        <SkillUpdateConflictModal
          conflict={conflict()}
          onClose={() => setOpen(false)}
          onConfirm={vi.fn()}
          onOpenFolder={vi.fn()}
          onVerify={vi.fn()}
          pendingAction=""
          skill={skill}
          t={t}
        />
      )}
    </>
  );
}

describe("SkillUpdateConflictModal", () => {
  it("names common Agent tools in both languages", () => {
    expect(getCopy("zh", "agentConflictGuidance")).toContain(
      "Codex、Claude Code 或其他 Agent 工具",
    );
    expect(getCopy("en", "agentConflictGuidance")).toContain(
      "Codex, Claude Code, or other Agent tools",
    );
  });

  it("hands control to the user with three non-destructive actions and accessible focus", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onOpenFolder = vi.fn();
    const onVerify = vi.fn();

    render(
      <SkillUpdateConflictModal
        conflict={conflict()}
        onClose={onClose}
        onConfirm={vi.fn()}
        onOpenFolder={onOpenFolder}
        onVerify={onVerify}
        pendingAction=""
        skill={skill}
        t={t}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Local changes need attention" });
    expect(dialog).toHaveAttribute("aria-labelledby");
    expect(dialog).toHaveAttribute("aria-describedby");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby") || "")).toBeTruthy();
    expect(document.getElementById(dialog.getAttribute("aria-describedby") || "")).toBeTruthy();

    const openFolder = screen.getByRole("button", { name: "Open local folder" });
    expect(openFolder).toHaveFocus();
    expect(screen.getByRole("button", { name: "Re-check" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Handle later" })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(4); // three actions plus the dialog close button
    expect(screen.queryByRole("button", { name: /overwrite|force|delete|copy/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Use Agent tools/)).toBeInTheDocument();
    expect(screen.getByText("review-skill")).toBeInTheDocument();
    expect(screen.getByText("/Users/example/SkillRepoTracker/skills/review-skill")).toBeInTheDocument();
    expect(screen.getByText("example/review-skills")).toBeInTheDocument();
    expect(screen.getByText("abc1234")).toBeInTheDocument();

    await user.click(openFolder);
    expect(onOpenFolder).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Re-check" }));
    expect(onVerify).toHaveBeenCalledOnce();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("requires explicit confirmation after a stable verification and states the quality limit", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();

    render(
      <SkillUpdateConflictModal
        conflict={conflict("customized")}
        onClose={vi.fn()}
        onConfirm={onConfirm}
        onOpenFolder={vi.fn()}
        onVerify={vi.fn()}
        pendingAction=""
        skill={skill}
        t={t}
      />,
    );

    expect(screen.getByText("Local files changed and are stable. Confirm that you completed the update with Agent.")).toBeInTheDocument();
    expect(screen.getByText("Verification only checks file changes and the target SHA. It cannot prove merge quality.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm Agent update" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("uses the approved Chinese title and full stop-before-update explanation", () => {
    render(
      <SkillUpdateConflictModal
        conflict={conflict()}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        onOpenFolder={vi.fn()}
        onVerify={vi.fn()}
        pendingAction=""
        skill={skill}
        t={(key) => getCopy("zh", key)}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Skill 更新冲突" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "未执行更新。这个 Skill 在本地存在修改，与远端新版本不一致。为避免覆盖，本应用已停止更新。请自行使用 Agent 工具处理，完成后回到这里重新检测。",
    );
  });

  it("returns focus to the control that opened the dialog", async () => {
    const user = userEvent.setup();
    render(<ConflictHarness />);

    const trigger = screen.getByRole("button", { name: "Resolve review-skill" });
    await user.click(trigger);
    expect(screen.getByRole("button", { name: "Open local folder" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });

  it.each(["pending", "unchanged", "stale"] as const)(
    "does not allow confirmation while verification is %s",
    (verificationState) => {
      render(
        <SkillUpdateConflictModal
          conflict={conflict(verificationState)}
          onClose={vi.fn()}
          onConfirm={vi.fn()}
          onOpenFolder={vi.fn()}
          onVerify={vi.fn()}
          pendingAction=""
          skill={skill}
          t={t}
        />,
      );

      expect(screen.queryByRole("button", { name: "Confirm Agent update" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Re-check" })).toBeInTheDocument();
    },
  );
});

describe("persistent conflict surfaces", () => {
  it("keeps update-conflict actionable and installed-customized non-updatable in the Skills table", async () => {
    const user = userEvent.setup();
    const openSkillConflict = vi.fn();
    const baseSkill = {
      repoId: "repo-1",
      description: "",
      repo: "example/review-skills",
      path: "skills/review",
      ref: "main",
      localVersion: "local",
      remoteVersion: "remote",
      installed: true,
      updatedAt: "2026-08-28",
    };

    render(
      <SkillsView
        availableSyncTargets={[]}
        handleSkillAction={vi.fn()}
        hasInspector={false}
        hasSkills
        isPending={() => false}
        language="en"
        openSkillConflict={openSkillConflict}
        openSkillDetail={vi.fn()}
        repositories={[]}
        restoreSkill={vi.fn()}
        selectedSkillId=""
        setActiveTab={vi.fn()}
        setInspectorRepoId={vi.fn()}
        setModal={vi.fn()}
        setSelectedRepoId={vi.fn()}
        setSkillFilter={vi.fn()}
        setSkillRepoQuery={vi.fn()}
        setSkillSort={vi.fn()}
        skillFilter="all"
        skillRepoQuery=""
        skills={[
          { ...baseSkill, id: "conflict", name: "conflict-skill", status: "update-conflict" },
          { ...baseSkill, id: "customized", name: "customized-skill", status: "installed-customized" },
        ]}
        skillSort={{ key: "name", direction: "asc" }}
        t={t}
      />,
    );

    expect(screen.getByText("update conflict")).toBeInTheDocument();
    expect(screen.getByText("updated with local customizations")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Handle conflict: conflict-skill" }));
    expect(openSkillConflict).toHaveBeenCalledWith(expect.objectContaining({ id: "conflict" }));
    expect(screen.getByRole("button", { name: "Up to date: customized-skill" })).toBeDisabled();
  });

  it("shows all Inspector handoff entries, including direct re-check", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onOpenFolder = vi.fn();
    const onRecheck = vi.fn();
    render(
      <SkillConflictNotice
        onOpen={onOpen}
        onOpenFolder={onOpenFolder}
        onRecheck={onRecheck}
        skill={{ name: "review-skill" }}
        t={t}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open local folder" }));
    await user.click(screen.getByRole("button", { name: "Re-check" }));
    await user.click(screen.getByRole("button", { name: "Handle conflict" }));
    expect(onOpenFolder).toHaveBeenCalledOnce();
    expect(onRecheck).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("shows waiting-user tasks and keeps Retry disabled", () => {
    render(
      <TasksView
        copyTaskSummary={vi.fn()}
        hasTasks
        isPending={() => false}
        language="en"
        retryTask={vi.fn()}
        setTaskFilter={vi.fn()}
        taskFilter="all"
        tasks={[
          {
            id: "task-1",
            kind: "Update Skill",
            target: "review-skill",
            progress: "0 / 1",
            status: "waiting-user",
            summary: "waiting for user to update local Skill",
            retryable: false,
            retryReason: "User action required",
            log: ["waiting for user-managed update with Agent tools"],
          },
        ]}
        t={t}
      />,
    );

    expect(screen.getAllByText("waiting for user").length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: "Retry: review-skill" }).every(
        (button) => button.hasAttribute("disabled"),
      ),
    ).toBe(true);
  });
});
