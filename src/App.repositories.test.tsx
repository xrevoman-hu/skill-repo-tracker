import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App, RepositoriesView, RepositorySelectionActions, getCopy } from "./App";

const copy: Record<string, string> = {
  all: "All",
  allRepositories: "All repositories",
  backup: "Backup",
  backupSelected: "Backup Selected",
  backupSelectedCount: "Backup Selected ({count})",
  backupStatus: "Backup status",
  checkFailed: "Check failed",
  checkStatusLabel: "Check status",
  firstRepositoryText: "Add one",
  firstRepositoryTitle: "No repositories",
  firstPage: "First page",
  generic: "Generic",
  lastBackup: "Last backup",
  lastPage: "Last page",
  more: "More",
  neverBacked: "Never backed",
  nextPage: "Next page",
  noFilteredRepositoriesText: "No matches",
  noFilteredRepositoriesTitle: "No matches",
  pageSize: "Rows per page",
  paginationFilteredSuffix: " (all {total})",
  paginationPage: "Page {page} / {pages}",
  paginationRange: "{start}–{end} / {filtered}",
  previousPage: "Previous page",
  clearSelection: "Clear selection",
  selectedOnOtherPages: "{count} selected on other pages",
  ref: "Ref",
  remoteSha: "Remote SHA",
  repository: "Repository",
  repositoriesSubtitle: "Tracked repositories",
  repositoriesTitle: "Repositories",
  skills: "Skills",
  skillRepos: "Skill repositories",
  type: "Type",
  updated: "Updated",
  addedAt: "Added",
  actions: "Actions",
};

const t = (key: string) => copy[key] || key;

function repository(id: string, sourceType: string) {
  return {
    id,
    name: id,
    sourceType,
    type: sourceType === "local" ? "generic repo" : "skill repo",
    ref: "main",
    skills: 1,
    remoteSha: "abc",
    lastBackupSha: "none",
    checkStatus: "success",
    backupStatus: sourceType === "local" ? "local-only" : "never-backed-up",
    addedAt: "2026-08-28",
  };
}

describe("RepositoriesView pagination", () => {
  it("spaces the current and total page numbers in both languages", () => {
    expect(getCopy("zh", "paginationPage")).toBe("第 {page} / {pages} 页");
    expect(getCopy("en", "paginationPage")).toBe("Page {page} / {pages}");
  });

  it("keeps page controls outside the table frame and exposes mixed page selection", () => {
    const selectAllVisible = vi.fn();
    const onPageChange = vi.fn();
    const onPageSizeChange = vi.fn();

    const { container } = render(
      <RepositoriesView
        hasRepositories
        allItemsTotal={53}
        language="en"
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
        openAddRepoModal={vi.fn()}
        page={1}
        pageSize={15}
        repoFilter="all"
        repos={[
          repository("github-one", "github"),
          repository("local-one", "local"),
          repository("unknown-one", "unknown"),
          repository("github-two", "github"),
        ]}
        repoSort={{ key: "name", direction: "asc" }}
        selectAllVisible={selectAllVisible}
        selectedRepo={repository("github-one", "github")}
        selectedRows={["other-page", "github-one"]}
        setInspectorRepoId={vi.fn()}
        setModal={vi.fn()}
        setRepoFilter={vi.fn()}
        setRepoSort={vi.fn()}
        setSelectedRepoId={vi.fn()}
        t={t}
        toggleRow={vi.fn()}
        totalItems={49}
        totalPages={4}
      />,
    );

    const selectPage = screen.getByRole("checkbox", { name: "All repositories" });
    expect(selectPage).toHaveAttribute("aria-checked", "mixed");
    expect((selectPage as HTMLInputElement).indeterminate).toBe(true);
    fireEvent.click(selectPage);
    expect(selectAllVisible).toHaveBeenCalledWith(true);

    expect(screen.getByRole("checkbox", { name: "Repository: local-one" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Repository: unknown-one" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Backup: unknown-one" })).toBeDisabled();

    const pagination = screen.getByTestId("repository-pagination");
    const tableFrame = container.querySelector(".table-frame");
    expect(pagination.parentElement).toBe(tableFrame?.parentElement);
    expect(tableFrame?.contains(pagination)).toBe(false);
    expect(screen.getByText("1–15 / 49 (all 53)")).toBeInTheDocument();
    expect(screen.getByText("Page 1 / 4")).toBeInTheDocument();

    const pageSize = screen.getByRole("combobox", { name: "Rows per page" });
    expect(Array.from(pageSize.querySelectorAll("option"), (option) => option.value)).toEqual([
      "15",
      "30",
      "50",
    ]);
    fireEvent.change(pageSize, { target: { value: "30" } });
    expect(onPageSizeChange).toHaveBeenCalledWith(30);

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(onPageChange).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByRole("button", { name: "Last page" }));
    expect(onPageChange).toHaveBeenCalledWith(4);
    expect(screen.getByRole("button", { name: "First page" })).toBeDisabled();
  });

  it("keeps the footer discoverable when a filter has no results", () => {
    render(
      <RepositoriesView
        allItemsTotal={53}
        hasRepositories
        language="en"
        openAddRepoModal={vi.fn()}
        page={1}
        pageSize={15}
        repoFilter="all"
        repos={[]}
        repoSort={{ key: "name", direction: "asc" }}
        selectAllVisible={vi.fn()}
        selectedRepo={null}
        selectedRows={[]}
        setInspectorRepoId={vi.fn()}
        setModal={vi.fn()}
        setRepoFilter={vi.fn()}
        setRepoSort={vi.fn()}
        setSelectedRepoId={vi.fn()}
        t={t}
        toggleRow={vi.fn()}
        totalItems={0}
        totalPages={1}
      />,
    );

    expect(screen.getByTestId("repository-pagination")).toBeInTheDocument();
    expect(screen.getByText("0–0 / 0 (all 53)")).toBeInTheDocument();
  });
});

describe("RepositorySelectionActions", () => {
  it("shows the selected total, cross-page count, and clear action", () => {
    const onBackup = vi.fn();
    const onClear = vi.fn();

    render(
      <RepositorySelectionActions
        onBackup={onBackup}
        onClear={onClear}
        otherPageCount={2}
        selectedCount={3}
        t={t}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Backup Selected (3)" }));
    expect(onBackup).toHaveBeenCalledOnce();
    expect(screen.getByText("2 selected on other pages")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});

describe("App repository pagination integration", () => {
  it("retains the open repository Inspector when paging away from its row", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);

    await user.click((await screen.findAllByRole("button", { name: /^详情:/ }))[0]);
    const inspectorTitle = container.querySelector(".inspector-title h2")?.textContent;
    expect(inspectorTitle).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(container.querySelector(".inspector-title h2")).toHaveTextContent(inspectorTitle || "");
  });
});
