import { describe, expect, it } from "vitest";

import {
  REPOSITORY_PAGE_SIZES,
  buildRepositoryPage,
  normalizeRepositoryPageSize,
  pageSelectionState,
  repositoryPaginationReducer,
  togglePageSelection,
} from "./repositoryPagination";

describe("buildRepositoryPage", () => {
  it("filters and sorts with an id tie-break before pagination", () => {
    const repositories = [
      { id: "repo-c", name: "Same", visible: true },
      { id: "repo-z", name: "Hidden", visible: false },
      { id: "repo-a", name: "Same", visible: true },
      { id: "repo-b", name: "Alpha", visible: true },
    ];

    const result = buildRepositoryPage(repositories, {
      page: 1,
      pageSize: 15,
      filter: (repo) => repo.visible,
      compare: (left, right) => left.name.localeCompare(right.name),
    });

    expect(result.totalItems).toBe(3);
    expect(result.totalPages).toBe(1);
    expect(result.page).toBe(1);
    expect(result.items.map((repo) => repo.id)).toEqual(["repo-b", "repo-a", "repo-c"]);
  });
});

describe("repository pagination state", () => {
  it("resets criteria and page-size changes, while clamping data shrink", () => {
    expect(
      repositoryPaginationReducer(
        { page: 4, pageSize: 15 },
        { type: "criteria-changed" },
      ),
    ).toEqual({ page: 1, pageSize: 15 });

    expect(
      repositoryPaginationReducer(
        { page: 4, pageSize: 15 },
        { type: "page-size-changed", pageSize: 30 },
      ),
    ).toEqual({ page: 1, pageSize: 30 });

    expect(
      repositoryPaginationReducer(
        { page: 4, pageSize: 15 },
        { type: "items-changed", totalItems: 31 },
      ),
    ).toEqual({ page: 3, pageSize: 15 });
  });

  it("preserves object identity when navigation already targets the current page", () => {
    const state = { page: 3, pageSize: 15 } as const;

    expect(repositoryPaginationReducer(state, { type: "go-to-page", page: 3 })).toBe(state);
  });
});

describe("repository page bounds", () => {
  it("offers 15/30/50 rows and clamps a stale page to the last available page", () => {
    const repositories = Array.from({ length: 31 }, (_, index) => ({
      id: `repo-${String(index + 1).padStart(2, "0")}`,
    }));

    expect(REPOSITORY_PAGE_SIZES).toEqual([15, 30, 50]);
    expect(normalizeRepositoryPageSize(999)).toBe(15);

    const result = buildRepositoryPage(repositories, {
      page: 4,
      pageSize: 15,
      filter: () => true,
      compare: (left, right) => left.id.localeCompare(right.id),
    });

    expect(result.page).toBe(3);
    expect(result.items.map((repo) => repo.id)).toEqual(["repo-31"]);
  });

  it("splits 53 repositories into 15, 15, 15, and 8 rows", () => {
    const repositories = Array.from({ length: 53 }, (_, index) => ({ id: `repo-${index}` }));
    const pageLengths = [1, 2, 3, 4].map(
      (page) =>
        buildRepositoryPage(repositories, {
          page,
          pageSize: 15,
          filter: () => true,
          compare: (left, right) => Number(left.id.slice(5)) - Number(right.id.slice(5)),
        }).items.length,
    );

    expect(pageLengths).toEqual([15, 15, 15, 8]);
  });
});

describe("repository page selection", () => {
  it("keeps selections from other pages, reports mixed state, and excludes local repositories", () => {
    const page = [
      { id: "remote-a", sourceType: "github" },
      { id: "local-b", sourceType: "local" },
      { id: "unknown-b", sourceType: "unknown" },
      { id: "remote-c", sourceType: "github" },
    ];
    const selected = ["remote-from-page-one", "remote-a"];

    expect(pageSelectionState(page, selected)).toEqual({
      checked: false,
      mixed: true,
      selectableCount: 2,
    });
    expect(togglePageSelection(page, selected, true)).toEqual([
      "remote-from-page-one",
      "remote-a",
      "remote-c",
    ]);
    expect(togglePageSelection(page, selected, false)).toEqual(["remote-from-page-one"]);
  });
});
