import { useEffect, useMemo, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import type { GitHubAccount, GitHubRepository } from "./api";
import { shouldIgnoreInspectorDismiss } from "./inspectorDismiss";

type Props = {
  accounts: GitHubAccount[];
  repositories: GitHubRepository[];
  activeAccountId: string;
  setActiveAccountId: (id: string) => void;
  isPending: (key: string) => boolean;
  onOpenAddAccount: () => void;
  onRefresh: (accountId?: string) => Promise<void>;
  onValidateAccount: (accountId: string) => Promise<void>;
  onDeleteAccount: (accountId: string) => Promise<void>;
  onToggleStar: (repo: GitHubRepository) => Promise<void>;
  onTrackRepository: (repo: GitHubRepository) => Promise<void>;
  onUntrackRepository: (repo: GitHubRepository) => Promise<void>;
  onOpenUrl: (url: string, mode?: string) => Promise<void>;
  onCopyUrl: (url: string) => Promise<void>;
  onSaveNote: (repo: GitHubRepository, note: string) => Promise<void>;
  rateLimitHelpText: string;
  t: (key: string) => string;
};

function Button({
  children,
  onClick,
  disabled = false,
  variant = "secondary",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: string;
}) {
  return (
    <button className={`button ${variant}`} disabled={disabled} onClick={onClick} type="button">
      {children}
    </button>
  );
}

function HelpTip({ text, label = "Help" }: { text: string; label?: string }) {
  return (
    <span aria-label={`${label}: ${text}`} className="help-tip" role="img" tabIndex={0} title={text}>
      ?
    </span>
  );
}

function Chip({ children, tone = "" }: { children: ReactNode; tone?: string }) {
  return <span className={`tag ${tone}`.trim()}>{children}</span>;
}

function Detail({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong className={mono ? "mono" : ""}>{value}</strong>
    </div>
  );
}

function accountLabel(account: GitHubAccount) {
  return account.login || account.displayName || "GitHub";
}

function repoKey(repo: GitHubRepository) {
  return `${repo.accountId}:${repo.fullName}`;
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function repoNameMatches(repo: GitHubRepository, query: string) {
  const term = normalize(query);
  if (!term) return true;
  return [repo.fullName]
    .map((value) => normalize(String(value || "")))
    .some((value) => value.includes(term));
}

function repoContentMatches(repo: GitHubRepository, query: string) {
  const term = normalize(query);
  if (!term) return true;
  return [repo.note, repo.readmeSearchText]
    .map((value) => normalize(String(value || "")))
    .some((value) => value.includes(term));
}

function isPersonalRepository(repo: GitHubRepository, account?: GitHubAccount) {
  return Boolean(account?.login) && normalize(repo.owner) === normalize(account.login);
}

function compareNames(left: string, right: string) {
  return String(left || "").localeCompare(String(right || ""), "en", {
    caseFirst: "upper",
    sensitivity: "variant",
  });
}

function sortableDate(value?: string | null) {
  const normalized = String(value || "").trim();
  return normalized && normalized !== "Never" && normalized !== "-" ? normalized : "";
}

type SortState = {
  key: "name" | "starredAt";
  direction: "asc" | "desc";
};

function sortIndicator(active: boolean, direction: SortState["direction"]) {
  if (!active) return "";
  return direction === "asc" ? " ↑" : " ↓";
}

export function GitHubWorkbench({
  accounts,
  repositories,
  activeAccountId,
  setActiveAccountId,
  isPending,
  onOpenAddAccount,
  onRefresh,
  onValidateAccount,
  onDeleteAccount,
  onToggleStar,
  onTrackRepository,
  onUntrackRepository,
  onOpenUrl,
  onCopyUrl,
  onSaveNote,
  rateLimitHelpText,
  t,
}: Props) {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [contentQuery, setContentQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "name", direction: "asc" });
  const activeAccount =
    accounts.find((account) => account.id === activeAccountId) ||
    accounts[0];

  useEffect(() => {
    if (!activeAccount && activeAccountId) {
      setActiveAccountId("");
    } else if (activeAccount && activeAccount.id !== activeAccountId) {
      setActiveAccountId(activeAccount.id);
    }
  }, [activeAccount?.id]);

  const activeRepos = useMemo(() => {
    return repositories.filter((repo) => !activeAccount?.id || repo.accountId === activeAccount.id);
  }, [repositories, activeAccount?.id]);

  const filteredRepos = useMemo(() => {
    const visible = activeRepos.filter((repo) => {
      const personalRepo = isPersonalRepository(repo, activeAccount);
      const filterMatch =
        filter === "all" ||
        (filter === "personal-public" && personalRepo && !repo.private) ||
        (filter === "personal-private" && personalRepo && repo.private) ||
        (filter === "starred" && repo.starred) ||
        (filter === "tracked" && repo.trackedRepoId);
      return filterMatch && repoNameMatches(repo, query) && repoContentMatches(repo, contentQuery);
    });
    return [...visible].sort((left, right) => {
      if (sort.key === "starredAt") {
        const leftDate = sortableDate(left.starredAt);
        const rightDate = sortableDate(right.starredAt);
        if (!leftDate && rightDate) return 1;
        if (leftDate && !rightDate) return -1;
        const compared = leftDate.localeCompare(rightDate);
        if (compared !== 0) return sort.direction === "asc" ? compared : -compared;
      }
      const compared = compareNames(left.fullName, right.fullName);
      return sort.direction === "asc" || sort.key !== "name" ? compared : -compared;
    });
  }, [activeRepos, activeAccount?.login, filter, query, contentQuery, sort]);

  function toggleSort(key: SortState["key"]) {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  }

  const selectedRepo = selectedKey
    ? filteredRepos.find((repo) => repoKey(repo) === selectedKey) || null
    : null;
  const [noteDraft, setNoteDraft] = useState("");

  useEffect(() => {
    if (selectedKey && !filteredRepos.some((repo) => repoKey(repo) === selectedKey)) {
      setSelectedKey("");
    }
  }, [filteredRepos, selectedKey]);

  useEffect(() => {
    setNoteDraft(selectedRepo?.note || "");
  }, [selectedRepo ? repoKey(selectedRepo) : "", selectedRepo?.note]);

  const counts = {
    all: activeRepos.length,
    personalPublic: activeRepos.filter((repo) => isPersonalRepository(repo, activeAccount) && !repo.private)
      .length,
    personalPrivate: activeRepos.filter((repo) => isPersonalRepository(repo, activeAccount) && repo.private)
      .length,
    starred: activeRepos.filter((repo) => repo.starred).length,
    tracked: activeRepos.filter((repo) => repo.trackedRepoId).length,
  };

  const refreshKey = `githubRefresh:${activeAccount?.id || "all"}`;

  function handleWorkbenchMouseDown(event: MouseEvent<HTMLElement>) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (shouldIgnoreInspectorDismiss(target)) return;
    setSelectedKey("");
  }

  return (
    <div
      className={`github-workbench-grid ${selectedRepo ? "has-inspector" : "no-inspector"}`}
      onMouseDown={handleWorkbenchMouseDown}
    >
      <section className="main-pane github-pane">
        <div className="pane-header github-header">
          <div>
            <h1>{t("githubTitle")}</h1>
            <p>{t("githubSubtitle")}</p>
          </div>
          <div className="github-header-actions">
            <Button disabled={isPending("githubSaveToken")} onClick={onOpenAddAccount}>
              {t("addAccount")}
            </Button>
            <span className="control-with-help">
              <Button
                disabled={!activeAccount || isPending(refreshKey)}
                onClick={() => onRefresh(activeAccount?.id)}
                variant="primary"
              >
                {isPending(refreshKey) ? t("refreshing") : t("refreshGithub")}
              </Button>
              <HelpTip label={t("help")} text={rateLimitHelpText} />
            </span>
          </div>
        </div>

        <div className="github-account-strip">
          {accounts.length ? (
            <div className="account-pill-row">
              {accounts.map((account) => (
                <button
                  aria-pressed={activeAccount?.id === account.id}
                  className={`account-pill ${activeAccount?.id === account.id ? "selected" : ""}`}
                  key={account.id}
                  onClick={() => setActiveAccountId(account.id)}
                  type="button"
                >
                  <span>{accountLabel(account)}</span>
                  <Chip tone={account.status === "verified" ? "success" : "unknown"}>
                    {t(account.status === "verified" ? "tokenVerified" : "tokenSavedUnverified")}
                  </Chip>
                </button>
              ))}
            </div>
          ) : (
            <div className="github-empty-inline">
              <strong>{t("githubNoAccountTitle")}</strong>
              <span>{t("githubNoAccountText")}</span>
            </div>
          )}
        </div>

        <div className="github-filter-bar">
          <div className="segmented" role="group" aria-label={t("githubTitle")}>
            {[
              ["all", `${t("githubAll")} ${counts.all}`],
              ["personal-public", `${t("githubPersonalPublic")} ${counts.personalPublic}`],
              ["personal-private", `${t("githubPersonalPrivate")} ${counts.personalPrivate}`],
              ["starred", `${t("githubStarred")} ${counts.starred}`],
              ["tracked", `${t("githubTracked")} ${counts.tracked}`],
            ].map(([id, label]) => (
              <button
                aria-pressed={filter === id}
                className={filter === id ? "selected" : ""}
                key={id}
                onClick={() => setFilter(id)}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
          <div className="github-searches">
            <label className="search-field github-search">
              <span>{t("search")}</span>
              <input
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("searchRepositoryNames")}
                value={query}
              />
            </label>
            <label className="search-field github-search">
              <span>{t("search")}</span>
              <input
                onChange={(event) => setContentQuery(event.target.value)}
                placeholder={t("searchNotesReadme")}
                value={contentQuery}
              />
            </label>
          </div>
        </div>

        <div className="table-frame github-table-frame">
          {filteredRepos.length ? (
            <table className="data-table github-table">
              <thead>
                <tr>
                  <th>
                    <button className="table-sort-button" onClick={() => toggleSort("name")} type="button">
                      {t("repository")}{sortIndicator(sort.key === "name", sort.direction)}
                    </button>
                  </th>
                  <th>{t("source")}</th>
                  <th>
                    <button className="table-sort-button" onClick={() => toggleSort("starredAt")} type="button">
                      {t("starredAt")}{sortIndicator(sort.key === "starredAt", sort.direction)}
                    </button>
                  </th>
                  <th>{t("visibility")}</th>
                  <th>{t("stars")}</th>
                  <th>{t("languageLabel")}</th>
                  <th>{t("status")}</th>
                  <th>{t("actions")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredRepos.map((repo) => {
                  const active = selectedRepo && repoKey(selectedRepo) === repoKey(repo);
                  return (
                    <tr
                      className={active ? "active-row" : ""}
                      key={repoKey(repo)}
                      onClick={() => setSelectedKey(repoKey(repo))}
                    >
                      <td>
                        <strong>{repo.fullName}</strong>
                        <span className="subtext">{repo.description || t("noDescription")}</span>
                        {repo.note && <span className="subtext note-preview">{repo.note}</span>}
                      </td>
                      <td>{repo.accountLogin}</td>
                      <td className="mono">{repo.starredAt || "-"}</td>
                      <td>
                        <Chip tone={repo.private ? "source-chip" : "generic repo"}>
                          {repo.private ? t("githubPrivate") : t("githubPublic")}
                        </Chip>
                      </td>
                      <td className="mono">{repo.stargazersCount}</td>
                      <td>{repo.language || "-"}</td>
                      <td>
                        {repo.trackedRepoId ? (
                          <Chip tone="success">{t("tracked")}</Chip>
                        ) : (
                          <Chip tone="unknown">{t("notTracked")}</Chip>
                        )}
                      </td>
                      <td onClick={(event) => event.stopPropagation()}>
                        <div className="row-actions">
                          <button
                            disabled={isPending(`githubStar:${repoKey(repo)}`)}
                            onClick={() => onToggleStar(repo)}
                            type="button"
                          >
                            {repo.starred ? t("unstar") : t("star")}
                          </button>
                          <button
                            disabled={isPending(`githubTrack:${repoKey(repo)}`)}
                            onClick={() =>
                              repo.trackedRepoId ? onUntrackRepository(repo) : onTrackRepository(repo)
                            }
                            type="button"
                          >
                            {repo.trackedRepoId ? t("untrack") : t("track")}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="empty-state github-empty">
              <div className="empty-state-icon" aria-hidden="true">
                +
              </div>
              <h2>{accounts.length ? t("githubNoReposTitle") : t("githubNoAccountTitle")}</h2>
              <p>{accounts.length ? t("githubNoReposText") : t("githubNoAccountText")}</p>
              {activeAccount && (
                <span className="control-with-help">
                  <Button disabled={isPending(refreshKey)} onClick={() => onRefresh(activeAccount.id)}>
                    {isPending(refreshKey) ? t("refreshing") : t("refreshGithub")}
                  </Button>
                  <HelpTip label={t("help")} text={rateLimitHelpText} />
                </span>
              )}
            </div>
          )}
        </div>
      </section>

      {selectedRepo && (
        <aside className="inspector github-inspector">
          <header className="inspector-title">
            <div>
              <h2>{selectedRepo.repo}</h2>
              <Chip tone={selectedRepo.starred ? "success" : "unknown"}>
                {selectedRepo.starred ? t("githubStarred") : t("notStarred")}
              </Chip>
            </div>
            <button
              className="icon-button"
              onClick={() => setSelectedKey("")}
              type="button"
              aria-label={t("close")}
            >
              x
            </button>
          </header>

          <section className="inspector-section">
            <h3>{t("githubAccount")}</h3>
            {activeAccount && (
              <>
                <Detail label={t("account")} value={accountLabel(activeAccount)} />
                <Detail label={t("tokenStatus")} value={t(activeAccount.status === "verified" ? "tokenVerified" : "tokenSavedUnverified")} />
                <Detail label={t("lastVerified")} value={activeAccount.lastVerified || t("neverVerified")} />
                <Detail label={t("permissions")} value={activeAccount.scopes || t("unknown")} />
                <div className="action-grid">
                  <Button
                    disabled={isPending(`githubValidate:${activeAccount.id}`)}
                    onClick={() => onValidateAccount(activeAccount.id)}
                  >
                    {isPending(`githubValidate:${activeAccount.id}`) ? t("validating") : t("validateToken")}
                  </Button>
                  <Button onClick={() => onDeleteAccount(activeAccount.id)} variant="danger">
                    {t("deleteAccount")}
                  </Button>
                </div>
              </>
            )}
          </section>

          <section className="inspector-section">
            <h3>{t("repository")}</h3>
            <Detail label={t("sourceUrl")} value={selectedRepo.htmlUrl} mono />
            <Detail label={t("defaultBranch")} value={selectedRepo.defaultBranch || "main"} />
            <Detail label={t("visibility")} value={selectedRepo.private ? t("githubPrivate") : t("githubPublic")} />
            <Detail label={t("languageLabel")} value={selectedRepo.language || "-"} />
            <Detail label={t("permissions")} value={selectedRepo.permissions || t("unknown")} />
            <Detail label={t("starredAt")} value={selectedRepo.starredAt || "-"} />
            <Detail label={t("lastChecked")} value={selectedRepo.lastRefreshed || t("neverVerified")} />
          </section>

          <section className="inspector-section">
            <h3>{t("quickActions")}</h3>
            <div className="action-grid">
              <Button onClick={() => onToggleStar(selectedRepo)}>
                {selectedRepo.starred ? t("unstar") : t("star")}
              </Button>
              <Button
                onClick={() =>
                  selectedRepo.trackedRepoId
                    ? onUntrackRepository(selectedRepo)
                    : onTrackRepository(selectedRepo)
                }
              >
                {selectedRepo.trackedRepoId ? t("untrack") : t("track")}
              </Button>
              <Button onClick={() => onOpenUrl(selectedRepo.htmlUrl, "embedded")}>{t("previewInApp")}</Button>
              <Button onClick={() => onOpenUrl(selectedRepo.htmlUrl, "systemDefault")}>
                {t("systemBrowser")}
              </Button>
              <Button onClick={() => onCopyUrl(selectedRepo.htmlUrl)}>{t("copyLink")}</Button>
            </div>
          </section>

          <section className="inspector-section">
            <h3>{t("description")}</h3>
            <p className="detail-copy">{selectedRepo.description || t("noDescription")}</p>
          </section>

          <section className="inspector-section">
            <h3>{t("note")}</h3>
            <div className="note-editor">
              <textarea
                onChange={(event) => setNoteDraft(event.target.value)}
                placeholder={t("notePlaceholder")}
                value={noteDraft}
              />
              <div className="inline-action-row">
                <Button
                  disabled={isPending(`note:githubRepository:${repoKey(selectedRepo)}`)}
                  onClick={() => onSaveNote(selectedRepo, noteDraft)}
                  variant="primary"
                >
                  {isPending(`note:githubRepository:${repoKey(selectedRepo)}`) ? t("saving") : t("saveNote")}
                </Button>
                <Button
                  disabled={!noteDraft || isPending(`note:githubRepository:${repoKey(selectedRepo)}`)}
                  onClick={() => {
                    setNoteDraft("");
                    onSaveNote(selectedRepo, "");
                  }}
                >
                  {t("clearNote")}
                </Button>
              </div>
            </div>
          </section>
        </aside>
      )}
    </div>
  );
}
