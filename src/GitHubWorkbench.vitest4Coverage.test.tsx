import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import { GitHubWorkbench } from "./GitHubWorkbench";
import type { GitHubAccount, GitHubRepository } from "./api";

const verifiedAccount: GitHubAccount = {
  id: "account-1",
  login: "alice",
  displayName: "Alice",
  status: "verified",
  scopes: "repo, read:user",
  lastVerified: "2026-09-01T10:00:00Z",
};

const secondAccount: GitHubAccount = {
  id: "account-2",
  login: "bob",
  displayName: "Bob",
  status: "saved",
  scopes: "",
  lastVerified: null,
};

const privateRepository: GitHubRepository = {
  accountId: verifiedAccount.id,
  accountLogin: verifiedAccount.login,
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
  lastRefreshed: "2026-09-01T11:00:00Z",
  permissions: "admin",
  readmeSearchText: "Prompt tooling manual",
  note: "review quarterly",
};

const publicRepository: GitHubRepository = {
  ...privateRepository,
  repo: "Public-Tool",
  fullName: "alice/Public-Tool",
  htmlUrl: "https://github.com/alice/Public-Tool",
  owner: "ALICE",
  description: "",
  visibility: "public",
  private: false,
  defaultBranch: "",
  language: "",
  stargazersCount: 0,
  starred: false,
  trackedRepoId: null,
  starredAt: "2025-01-01T00:00:00Z",
  lastRefreshed: null,
  permissions: "",
  readmeSearchText: "Release migration guide",
  note: "",
};

const organizationRepository: GitHubRepository = {
  ...privateRepository,
  repo: "Workbench",
  fullName: "org/Workbench",
  htmlUrl: "https://github.com/org/Workbench",
  owner: "org",
  private: false,
  visibility: "public",
  starred: true,
  trackedRepoId: null,
  starredAt: "Never",
  language: "Rust",
  note: "Quarterly review",
};

type WorkbenchProps = ComponentProps<typeof GitHubWorkbench>;

function createProps(overrides: Partial<WorkbenchProps> = {}): WorkbenchProps {
  return {
    accounts: [verifiedAccount],
    repositories: [privateRepository, publicRepository, organizationRepository],
    activeAccountId: verifiedAccount.id,
    setActiveAccountId: vi.fn(),
    isPending: () => false,
    onOpenAddAccount: vi.fn(),
    onRefresh: vi.fn().mockResolvedValue(undefined),
    onValidateAccount: vi.fn().mockResolvedValue(undefined),
    onDeleteAccount: vi.fn().mockResolvedValue(undefined),
    onToggleStar: vi.fn().mockResolvedValue(undefined),
    onTrackRepository: vi.fn().mockResolvedValue(undefined),
    onUntrackRepository: vi.fn().mockResolvedValue(undefined),
    onOpenUrl: vi.fn().mockResolvedValue(undefined),
    onCopyUrl: vi.fn().mockResolvedValue(undefined),
    onSaveNote: vi.fn().mockResolvedValue(undefined),
    rateLimitHelpText: "GitHub rate limit guidance",
    t: (key) => key,
    ...overrides,
  };
}

function renderedRepositoryNames() {
  const table = screen.getByRole("table");
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelector("strong")?.textContent);
}

function repositoryRow(fullName: string) {
  const row = screen.getByText(fullName).closest("tr");
  expect(row).not.toBeNull();
  return row as HTMLTableRowElement;
}

describe("GitHubWorkbench Vitest 4 behavior coverage", () => {
  it("reconciles missing account selection and exposes the account/header controls", async () => {
    const user = userEvent.setup();
    const setActiveAccountId = vi.fn();
    const onOpenAddAccount = vi.fn();
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <GitHubWorkbench
        {...createProps({
          accounts: [],
          repositories: [],
          activeAccountId: "removed-account",
          setActiveAccountId,
          onOpenAddAccount,
          onRefresh,
        })}
      />,
    );

    await waitFor(() => expect(setActiveAccountId).toHaveBeenCalledWith(""));
    expect(screen.getAllByText("githubNoAccountTitle")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "refreshGithub" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "addAccount" }));
    expect(onOpenAddAccount).toHaveBeenCalledOnce();

    const displayOnlyAccount = { ...secondAccount, login: "", displayName: "Fallback name" };
    rerender(
      <GitHubWorkbench
        {...createProps({
          accounts: [displayOnlyAccount, { ...verifiedAccount, id: "nameless", login: "", displayName: "" }],
          repositories: [],
          activeAccountId: "unknown-account",
          setActiveAccountId,
          onRefresh,
        })}
      />,
    );

    await waitFor(() => expect(setActiveAccountId).toHaveBeenCalledWith(displayOnlyAccount.id));
    expect(screen.getByRole("button", { name: /Fallback name\s*tokenSavedUnverified/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: /GitHub\s*tokenVerified/ }));
    expect(setActiveAccountId).toHaveBeenLastCalledWith("nameless");
    expect(screen.getAllByRole("img", { name: "help: GitHub rate limit guidance" })).not.toHaveLength(0);
    await user.click(screen.getAllByRole("button", { name: "refreshGithub" })[0]);
    expect(onRefresh).toHaveBeenCalledWith(displayOnlyAccount.id);
  });

  it("renders pending states with the exact account-scoped keys", () => {
    const pendingKeys: string[] = [];
    const isPending = vi.fn((key: string) => {
      pendingKeys.push(key);
      return key === "githubSaveToken" || key === "githubRefresh:account-1";
    });

    render(<GitHubWorkbench {...createProps({ repositories: [], isPending })} />);

    expect(screen.getByRole("button", { name: "addAccount" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "refreshing" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "refreshing" })[0]).toBeDisabled();
    expect(pendingKeys).toContain("githubSaveToken");
    expect(pendingKeys).toContain("githubRefresh:account-1");
  });

  it("filters by ownership, star/tracking state, name, notes, and README text", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<GitHubWorkbench {...createProps({ onRefresh })} />);

    expect(screen.getByRole("group", { name: "githubTitle" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "githubAll 3" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "githubPersonalPublic 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "githubPersonalPrivate 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "githubStarred 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "githubTracked 1" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "githubPersonalPublic 1" }));
    expect(renderedRepositoryNames()).toEqual([publicRepository.fullName]);
    await user.click(screen.getByRole("button", { name: "githubPersonalPrivate 1" }));
    expect(renderedRepositoryNames()).toEqual([privateRepository.fullName]);
    await user.click(screen.getByRole("button", { name: "githubStarred 2" }));
    expect(renderedRepositoryNames()).toEqual([privateRepository.fullName, organizationRepository.fullName]);
    await user.click(screen.getByRole("button", { name: "githubTracked 1" }));
    expect(renderedRepositoryNames()).toEqual([privateRepository.fullName]);
    await user.click(screen.getByRole("button", { name: "githubAll 3" }));

    const nameSearch = screen.getByPlaceholderText("searchRepositoryNames");
    await user.type(nameSearch, "  WORKBENCH  ");
    expect(renderedRepositoryNames()).toEqual([organizationRepository.fullName]);
    await user.clear(nameSearch);

    const contentSearch = screen.getByPlaceholderText("searchNotesReadme");
    await user.type(contentSearch, "MIGRATION");
    expect(renderedRepositoryNames()).toEqual([publicRepository.fullName]);
    await user.clear(contentSearch);
    await user.type(contentSearch, "quarterly");
    expect(renderedRepositoryNames()).toEqual([
      privateRepository.fullName,
      organizationRepository.fullName,
    ]);
    await user.clear(contentSearch);
    await user.type(contentSearch, "no matching content");

    expect(screen.getByRole("heading", { level: 2, name: "githubNoReposTitle" })).toBeInTheDocument();
    expect(screen.getByText("githubNoReposText")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "refreshGithub" })[1]);
    expect(onRefresh).toHaveBeenCalledWith(verifiedAccount.id);
  });

  it("sorts names and starred dates while keeping missing dates at the end", async () => {
    const user = userEvent.setup();
    render(<GitHubWorkbench {...createProps()} />);

    expect(screen.getByRole("button", { name: "repository ↑" })).toBeInTheDocument();
    expect(renderedRepositoryNames()).toEqual([
      privateRepository.fullName,
      publicRepository.fullName,
      organizationRepository.fullName,
    ]);

    await user.click(screen.getByRole("button", { name: "repository ↑" }));
    expect(screen.getByRole("button", { name: "repository ↓" })).toBeInTheDocument();
    expect(renderedRepositoryNames()).toEqual([
      organizationRepository.fullName,
      publicRepository.fullName,
      privateRepository.fullName,
    ]);

    await user.click(screen.getByRole("button", { name: "starredAt" }));
    expect(screen.getByRole("button", { name: "starredAt ↑" })).toBeInTheDocument();
    expect(renderedRepositoryNames()).toEqual([
      publicRepository.fullName,
      privateRepository.fullName,
      organizationRepository.fullName,
    ]);

    await user.click(screen.getByRole("button", { name: "starredAt ↑" }));
    expect(screen.getByRole("button", { name: "starredAt ↓" })).toBeInTheDocument();
    expect(renderedRepositoryNames()).toEqual([
      privateRepository.fullName,
      publicRepository.fullName,
      organizationRepository.fullName,
    ]);
  });

  it("keeps cached repositories inspectable when their account and optional metadata are gone", async () => {
    const user = userEvent.setup();
    const missingMetadata: GitHubRepository = {
      ...publicRepository,
      accountId: "removed-account",
      accountLogin: "",
      owner: "",
      repo: "untitled-repository",
      fullName: "",
      starredAt: null,
    };
    const sameDateA = {
      ...privateRepository,
      accountId: "removed-account",
      fullName: "cached/a-repository",
      starredAt: "2026-01-01T00:00:00Z",
    };
    const sameDateB = {
      ...privateRepository,
      accountId: "removed-account",
      fullName: "cached/b-repository",
      starredAt: "2026-01-01T00:00:00Z",
    };
    const { container } = render(
      <GitHubWorkbench
        {...createProps({
          accounts: [],
          repositories: [missingMetadata, sameDateB, sameDateA],
          activeAccountId: "",
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "githubAll 3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "githubPersonalPublic 0" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "refreshGithub" })).toBeDisabled();
    const blankNameRow = container.querySelector("tbody tr");
    expect(blankNameRow).not.toBeNull();
    await user.click(blankNameRow as HTMLTableRowElement);
    const inspector = screen.getByRole("heading", { level: 2, name: "untitled-repository" }).closest("aside");
    expect(inspector).not.toBeNull();
    expect(within(inspector as HTMLElement).getAllByText("-").length).toBeGreaterThanOrEqual(2);
    await user.click(within(inspector as HTMLElement).getByRole("button", { name: "close" }));

    await user.click(screen.getByRole("button", { name: "starredAt" }));
    expect(renderedRepositoryNames()).toEqual(["cached/a-repository", "cached/b-repository", ""]);
    await user.type(screen.getByPlaceholderText("searchRepositoryNames"), "cached");
    expect(renderedRepositoryNames()).toEqual(["cached/a-repository", "cached/b-repository"]);
  });

  it("keeps row actions independent from selection and honors their pending state", async () => {
    const user = userEvent.setup();
    const onToggleStar = vi.fn().mockResolvedValue(undefined);
    const onTrackRepository = vi.fn().mockResolvedValue(undefined);
    const onUntrackRepository = vi.fn().mockResolvedValue(undefined);
    render(
      <GitHubWorkbench
        {...createProps({
          isPending: (key) => key === "githubStar:account-1:alice/private-skill",
          onToggleStar,
          onTrackRepository,
          onUntrackRepository,
        })}
      />,
    );

    const privateRow = repositoryRow(privateRepository.fullName);
    expect(within(privateRow).getByRole("button", { name: "unstar" })).toBeDisabled();
    await user.click(within(privateRow).getByRole("button", { name: "untrack" }));
    expect(onUntrackRepository).toHaveBeenCalledWith(privateRepository);

    const publicRow = repositoryRow(publicRepository.fullName);
    await user.click(within(publicRow).getByRole("button", { name: "star" }));
    await user.click(within(publicRow).getByRole("button", { name: "track" }));
    expect(onToggleStar).toHaveBeenCalledWith(publicRepository);
    expect(onTrackRepository).toHaveBeenCalledWith(publicRepository);
    expect(screen.queryByRole("heading", { level: 2, name: publicRepository.repo })).not.toBeInTheDocument();
  });

  it("runs all rich inspector actions and persists edited or cleared notes", async () => {
    const user = userEvent.setup();
    const onValidateAccount = vi.fn().mockResolvedValue(undefined);
    const onDeleteAccount = vi.fn().mockResolvedValue(undefined);
    const onToggleStar = vi.fn().mockResolvedValue(undefined);
    const onUntrackRepository = vi.fn().mockResolvedValue(undefined);
    const onOpenUrl = vi.fn().mockResolvedValue(undefined);
    const onCopyUrl = vi.fn().mockResolvedValue(undefined);
    const onSaveNote = vi.fn().mockResolvedValue(undefined);
    render(
      <GitHubWorkbench
        {...createProps({
          onValidateAccount,
          onDeleteAccount,
          onToggleStar,
          onUntrackRepository,
          onOpenUrl,
          onCopyUrl,
          onSaveNote,
        })}
      />,
    );

    await user.click(screen.getByText(privateRepository.fullName));
    const inspector = screen.getByRole("heading", { level: 2, name: privateRepository.repo }).closest("aside");
    expect(inspector).not.toBeNull();
    const scoped = within(inspector as HTMLElement);
    expect(scoped.getByText("githubStarred")).toBeInTheDocument();
    expect(scoped.getByText(verifiedAccount.lastVerified as string)).toBeInTheDocument();
    expect(scoped.getByText(privateRepository.htmlUrl)).toHaveClass("mono");

    await user.click(scoped.getByRole("button", { name: "validateToken" }));
    await user.click(scoped.getByRole("button", { name: "deleteAccount" }));
    await user.click(scoped.getByRole("button", { name: "unstar" }));
    await user.click(scoped.getByRole("button", { name: "untrack" }));
    await user.click(scoped.getByRole("button", { name: "previewInApp" }));
    await user.click(scoped.getByRole("button", { name: "systemBrowser" }));
    await user.click(scoped.getByRole("button", { name: "copyLink" }));

    expect(onValidateAccount).toHaveBeenCalledWith(verifiedAccount.id);
    expect(onDeleteAccount).toHaveBeenCalledWith(verifiedAccount.id);
    expect(onToggleStar).toHaveBeenCalledWith(privateRepository);
    expect(onUntrackRepository).toHaveBeenCalledWith(privateRepository);
    expect(onOpenUrl).toHaveBeenNthCalledWith(1, privateRepository.htmlUrl, "embedded");
    expect(onOpenUrl).toHaveBeenNthCalledWith(2, privateRepository.htmlUrl, "systemDefault");
    expect(onCopyUrl).toHaveBeenCalledWith(privateRepository.htmlUrl);

    const note = scoped.getByRole("textbox");
    expect(note).toHaveValue(privateRepository.note);
    await user.clear(note);
    await user.type(note, "checked locally");
    await user.click(scoped.getByRole("button", { name: "saveNote" }));
    expect(onSaveNote).toHaveBeenCalledWith(privateRepository, "checked locally");
    await user.click(scoped.getByRole("button", { name: "clearNote" }));
    expect(note).toHaveValue("");
    expect(onSaveNote).toHaveBeenLastCalledWith(privateRepository, "");

    await user.click(scoped.getByRole("button", { name: "close" }));
    expect(screen.queryByRole("heading", { level: 2, name: privateRepository.repo })).not.toBeInTheDocument();
  });

  it("shows inspector fallbacks, pending controls, track actions, and background dismissal", async () => {
    const user = userEvent.setup();
    const savedAccount = { ...secondAccount, id: verifiedAccount.id, login: "alice" };
    const onToggleStar = vi.fn().mockResolvedValue(undefined);
    const onTrackRepository = vi.fn().mockResolvedValue(undefined);
    render(
      <GitHubWorkbench
        {...createProps({
          accounts: [savedAccount],
          repositories: [publicRepository],
          isPending: (key) =>
            key === "githubValidate:account-1" || key === "note:githubRepository:account-1:alice/Public-Tool",
          onToggleStar,
          onTrackRepository,
        })}
      />,
    );

    await user.click(screen.getByText(publicRepository.fullName));
    const inspector = screen.getByRole("heading", { level: 2, name: publicRepository.repo }).closest("aside");
    expect(inspector).not.toBeNull();
    const scoped = within(inspector as HTMLElement);
    expect(scoped.getByText("notStarred")).toBeInTheDocument();
    expect(scoped.getByText("tokenSavedUnverified")).toBeInTheDocument();
    expect(scoped.getAllByText("neverVerified")).toHaveLength(2);
    expect(scoped.getAllByText("unknown").length).toBeGreaterThanOrEqual(2);
    expect(scoped.getByText("noDescription")).toBeInTheDocument();
    expect(scoped.getByRole("button", { name: "validating" })).toBeDisabled();
    expect(scoped.getByRole("button", { name: "saving" })).toBeDisabled();
    expect(scoped.getByRole("button", { name: "clearNote" })).toBeDisabled();

    await user.click(scoped.getByRole("button", { name: "star" }));
    await user.click(scoped.getByRole("button", { name: "track" }));
    expect(onToggleStar).toHaveBeenCalledWith(publicRepository);
    expect(onTrackRepository).toHaveBeenCalledWith(publicRepository);

    fireEvent.mouseDown(screen.getByRole("heading", { level: 1, name: "githubTitle" }));
    expect(screen.queryByRole("heading", { level: 2, name: publicRepository.repo })).not.toBeInTheDocument();
  });

  it("drops an inspector when the selected repository leaves the visible filter", async () => {
    const user = userEvent.setup();
    const { container } = render(<GitHubWorkbench {...createProps()} />);

    await user.click(screen.getByText(organizationRepository.fullName));
    expect(container.firstElementChild).toHaveClass("has-inspector");
    await user.click(screen.getByRole("button", { name: "githubPersonalPrivate 1" }));
    await waitFor(() => expect(container.firstElementChild).toHaveClass("no-inspector"));
    expect(screen.queryByRole("heading", { level: 2, name: organizationRepository.repo })).not.toBeInTheDocument();
  });
});
