export const REPOSITORY_PAGE_SIZES = [15, 30, 50] as const;
export type RepositoryPageSize = (typeof REPOSITORY_PAGE_SIZES)[number];

export function normalizeRepositoryPageSize(value: number): RepositoryPageSize {
  return REPOSITORY_PAGE_SIZES.includes(value as RepositoryPageSize)
    ? (value as RepositoryPageSize)
    : REPOSITORY_PAGE_SIZES[0];
}

export type RepositoryPaginationState = {
  page: number;
  pageSize: RepositoryPageSize;
};

export type RepositoryPaginationAction =
  | { type: "criteria-changed" }
  | { type: "go-to-page"; page: number }
  | { type: "items-changed"; totalItems: number }
  | { type: "page-size-changed"; pageSize: number };

export function repositoryPaginationReducer(
  state: RepositoryPaginationState,
  action: RepositoryPaginationAction,
): RepositoryPaginationState {
  if (action.type === "criteria-changed") {
    return state.page === 1 ? state : { ...state, page: 1 };
  }
  if (action.type === "page-size-changed") {
    return { page: 1, pageSize: normalizeRepositoryPageSize(action.pageSize) };
  }
  if (action.type === "go-to-page") {
    const page = Math.max(1, Math.floor(action.page));
    return page === state.page ? state : { ...state, page };
  }

  const totalPages = Math.max(1, Math.ceil(action.totalItems / state.pageSize));
  const page = Math.min(state.page, totalPages);
  return page === state.page ? state : { ...state, page };
}

export type RepositoryPageOptions<T> = {
  page: number;
  pageSize: number;
  filter: (item: T) => boolean;
  compare: (left: T, right: T) => number;
};

export type RepositoryPage<T> = {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};

type SelectableRepository = {
  id: string;
  sourceType?: string;
};

export function isRepositorySelectable(repository: SelectableRepository) {
  return repository.sourceType === "github";
}

export function pageSelectionState(
  repositories: SelectableRepository[],
  selectedIds: string[],
) {
  const selectableIds = repositories.filter(isRepositorySelectable).map((repo) => repo.id);
  const selectedCount = selectableIds.filter((id) => selectedIds.includes(id)).length;

  return {
    checked: selectableIds.length > 0 && selectedCount === selectableIds.length,
    mixed: selectedCount > 0 && selectedCount < selectableIds.length,
    selectableCount: selectableIds.length,
  };
}

export function togglePageSelection(
  repositories: SelectableRepository[],
  selectedIds: string[],
  checked: boolean,
) {
  const pageIds = repositories.filter(isRepositorySelectable).map((repo) => repo.id);
  const pageIdSet = new Set(pageIds);
  const selectedOutsidePage = selectedIds.filter((id) => !pageIdSet.has(id));
  if (!checked) return selectedOutsidePage;

  return [...selectedOutsidePage, ...pageIds];
}

export function buildRepositoryPage<T extends { id: string }>(
  repositories: T[],
  options: RepositoryPageOptions<T>,
): RepositoryPage<T> {
  const pageSize = normalizeRepositoryPageSize(options.pageSize);
  const sorted = repositories
    .filter(options.filter)
    .sort((left, right) => options.compare(left, right) || left.id.localeCompare(right.id));
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(Math.max(1, Math.floor(options.page)), totalPages);
  const start = (page - 1) * pageSize;

  return {
    items: sorted.slice(start, start + pageSize),
    page,
    pageSize,
    totalItems: sorted.length,
    totalPages,
  };
}
