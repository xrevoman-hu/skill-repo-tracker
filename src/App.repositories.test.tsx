import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App, RepositoriesView, RepositorySelectionActions, getCopy } from "./App";
import { DemoAppService } from "./appService";

const copy: Record<string, string> = {
  all: "All",
  selectAllFilteredRepositories: "Select all filtered repositories across all pages",
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
    const selectAllFiltered = vi.fn();
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
        selectAllFiltered={selectAllFiltered}
        selectionState={{ checked: false, mixed: true, selectableCount: 2 }}
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

    const selectPage = screen.getByRole("checkbox", { name: copy.selectAllFilteredRepositories });
    expect(selectPage).toHaveAttribute("aria-checked", "mixed");
    expect((selectPage as HTMLInputElement).indeterminate).toBe(true);
    fireEvent.click(selectPage);
    expect(selectAllFiltered).toHaveBeenCalledWith(true);

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
        selectAllFiltered={vi.fn()}
        selectionState={{ checked: false, mixed: false, selectableCount: 0 }}
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
  it("preserves scoped selections through search, sorting, pagination and clearing", async () => {
    const user = userEvent.setup();
    const service = new DemoAppService();
    const bootstrap = await service.bootstrap();
    const repositories = Array.from({ length: 60 }, (_, index) => ({
      ...repository(`repo-${String(index + 1).padStart(2, "0")}`, "github"),
      note: index < 40 ? "needle" : "outside",
      readmeSearchText: index < 30 ? "readme-match" : "",
      type: index < 20 ? "generic repo" : "skill repo",
    }));
    vi.spyOn(service, "bootstrap").mockResolvedValue({
      ...bootstrap, workspace: { ...bootstrap.workspace, repositories },
    });
    render(<App appService={service} />);
    await screen.findByText("repo-01");
    await user.click(screen.getByRole("button", { name: "清空选择" }));
    const selectAll = () => screen.getByRole("checkbox", { name: "全选当前筛选结果（跨所有页）" });
    const selectedCount = (count: number) => expect(screen.getByRole("button", { name: `备份选中（${count}）` })).toBeInTheDocument();
    const nameSearch = screen.getByPlaceholderText("搜索仓库名称...");
    const contentSearch = screen.getByPlaceholderText("搜索备注 / README...");
    await user.type(nameSearch, "repo-60");
    await user.click(selectAll());
    await user.clear(nameSearch);
    await user.type(contentSearch, "readme-match");
    await user.click(selectAll());
    selectedCount(31);
    await user.click(selectAll());
    selectedCount(1);
    await user.clear(contentSearch);
    await user.type(contentSearch, "needle");
    await user.click(selectAll());
    selectedCount(41);
    await user.click(screen.getByRole("button", { name: "普通仓库" }));
    expect(selectAll()).toBeChecked();
    await user.click(selectAll());
    selectedCount(21);
    await user.click(selectAll());
    selectedCount(41);
    await user.click(screen.getByRole("button", { name: "全部" }));
    await user.clear(contentSearch);
    expect(selectAll()).toHaveAttribute("aria-checked", "mixed");
    await user.click(selectAll());
    selectedCount(60);
    await user.click(screen.getByRole("button", { name: "下一页" }));
    await user.click(screen.getByRole("checkbox", { name: "仓库: repo-16" }));
    selectedCount(59);
    await user.click(screen.getByRole("button", { name: "首页" }));
    expect(selectAll()).toHaveAttribute("aria-checked", "mixed");
    expect((selectAll() as HTMLInputElement).indeterminate).toBe(true);
    await user.selectOptions(screen.getByRole("combobox", { name: "每页行数" }), "30");
    await user.click(screen.getByRole("button", { name: /^仓库.*↑/ }));
    selectedCount(59);
    await user.click(selectAll());
    selectedCount(60);
    await user.type(nameSearch, "no-matching-repository");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    selectedCount(60);
    await user.clear(nameSearch);
    await user.click(screen.getByRole("button", { name: "清空选择" }));
    selectedCount(0);
    expect(selectAll()).not.toBeChecked();
  });

  it("removes deleted or no-longer-selectable IDs without selecting new repositories", async () => {
    const user = userEvent.setup();
    const service = new DemoAppService();
    const bootstrap = await service.bootstrap();
    const repositories = [repository("remote-a", "github"), repository("remote-b", "github"),
      { ...repository("remote-c", "github"), backupStatus: "backed-up-latest" },
      repository("local-a", "local"), repository("unknown-a", "unknown")];
    vi.spyOn(service, "bootstrap").mockResolvedValue({ ...bootstrap, workspace: { ...bootstrap.workspace, repositories } });
    vi.spyOn(service, "checkRepositories").mockResolvedValue({ ...bootstrap.workspace,
      repositories: [repository("remote-b", "local"), repositories[2], repository("new-repo", "github")],
    });
    render(<App appService={service} />);
    const selectAll = await screen.findByRole("checkbox", { name: "全选当前筛选结果（跨所有页）" });
    await user.click(selectAll);
    expect(screen.getByRole("button", { name: "备份选中（3）" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "仓库: local-a" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "检测全部" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "备份选中（1）" })).toBeEnabled());
    expect(screen.getByRole("checkbox", { name: "仓库: new-repo" })).not.toBeChecked();
    expect(selectAll).toHaveAttribute("aria-checked", "mixed");
    await user.type(screen.getByPlaceholderText("搜索仓库名称..."), "remote-b");
    expect(selectAll).toBeDisabled();
    expect(selectAll).not.toBeChecked();
  });

  it("selects all 60 repositories across pages and submits their unique IDs once", async () => {
    const user = userEvent.setup();
    const service = new DemoAppService();
    const bootstrap = await service.bootstrap();
    const repositories = Array.from({ length: 60 }, (_, index) =>
      repository(`repo-${String(index + 1).padStart(2, "0")}`, "github"));
    vi.spyOn(service, "bootstrap").mockResolvedValue({
      ...bootstrap, workspace: { ...bootstrap.workspace, repositories },
    });
    const backup = vi.spyOn(service, "backupRepositories");
    render(<App appService={service} />);
    await screen.findByText("repo-01");
    await user.click(screen.getByRole("button", { name: "清空选择" }));
    await user.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByRole("button", { name: "备份选中（60）" })).toBeEnabled();
    expect(backup).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getAllByRole("checkbox").every((box) => (box as HTMLInputElement).checked)).toBe(true);
    await user.click(screen.getByRole("button", { name: "备份选中（60）" }));
    const dialog = screen.getByRole("dialog", { name: "备份选中仓库" });
    expect(within(dialog).getByText("+ 52", { exact: true })).toBeInTheDocument();
    expect(within(dialog).getAllByText("60", { exact: true })).toHaveLength(2);
    await user.click(within(dialog).getByRole("button", { name: "确认备份" }));
    await waitFor(() => expect(backup).toHaveBeenCalledOnce());
    expect(backup.mock.calls[0][0].repositoryIds).toEqual(repositories.map((repo) => repo.id));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

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
