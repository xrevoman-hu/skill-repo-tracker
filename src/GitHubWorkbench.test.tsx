import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { GitHubWorkbench } from "./GitHubWorkbench";
import type { GitHubAccount, GitHubRepository } from "./api";

const account: GitHubAccount = {
  id: "account-1",
  login: "alice",
  displayName: "Alice",
  status: "verified",
  scopes: "repo",
};

const repository: GitHubRepository = {
  accountId: account.id,
  accountLogin: account.login,
  owner: "alice",
  repo: "private-skill",
  fullName: "alice/private-skill",
  htmlUrl: "https://github.com/alice/private-skill",
  description: "Private prompt tooling",
  visibility: "private",
  private: true,
  fork: false,
  archived: false,
  defaultBranch: "main",
  language: "TypeScript",
  stargazersCount: 4,
  starred: true,
  trackedRepoId: "tracked-1",
  starredAt: "2026-08-31T00:00:00Z",
  permissions: "admin",
  note: "review quarterly",
};

describe("GitHubWorkbench injected behavior", () => {
  it("filters locally and sends stable repository data through inspector actions", async () => {
    const user = userEvent.setup();
    const onOpenUrl = vi.fn().mockResolvedValue(undefined);
    const onSaveNote = vi.fn().mockResolvedValue(undefined);
    const onUntrackRepository = vi.fn().mockResolvedValue(undefined);

    render(
      <GitHubWorkbench
        accounts={[account]}
        repositories={[repository, { ...repository, repo: "public", fullName: "bob/public", owner: "bob", private: false, starred: false, trackedRepoId: null, note: "" }]}
        activeAccountId={account.id}
        setActiveAccountId={vi.fn()}
        isPending={() => false}
        onOpenAddAccount={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onValidateAccount={vi.fn().mockResolvedValue(undefined)}
        onDeleteAccount={vi.fn().mockResolvedValue(undefined)}
        onToggleStar={vi.fn().mockResolvedValue(undefined)}
        onTrackRepository={vi.fn().mockResolvedValue(undefined)}
        onUntrackRepository={onUntrackRepository}
        onOpenUrl={onOpenUrl}
        onCopyUrl={vi.fn().mockResolvedValue(undefined)}
        onSaveNote={onSaveNote}
        rateLimitHelpText="rate limit"
        t={(key) => key}
      />,
    );

    await user.click(screen.getByRole("button", { name: "githubPersonalPrivate 1" }));
    expect(screen.getByText("alice/private-skill")).toBeInTheDocument();
    expect(screen.queryByText("bob/public")).not.toBeInTheDocument();

    await user.click(screen.getByText("alice/private-skill"));
    const inspector = screen.getByRole("heading", { level: 2, name: "private-skill" }).closest("aside");
    expect(inspector).not.toBeNull();
    await user.click(within(inspector as HTMLElement).getByRole("button", { name: "previewInApp" }));
    expect(onOpenUrl).toHaveBeenCalledWith(repository.htmlUrl, "embedded");

    await user.click(within(inspector as HTMLElement).getByRole("button", { name: "untrack" }));
    expect(onUntrackRepository).toHaveBeenCalledWith(repository);

    const note = within(inspector as HTMLElement).getByRole("textbox");
    await user.clear(note);
    await user.type(note, "checked locally");
    await user.click(within(inspector as HTMLElement).getByRole("button", { name: "saveNote" }));
    expect(onSaveNote).toHaveBeenCalledWith(repository, "checked locally");
  });
});
