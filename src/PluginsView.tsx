import { useEffect, useState } from "react";
import type { ComponentType, KeyboardEvent, ReactNode } from "react";
import type { PluginDetail, PluginSkillSummary, UiPlugin } from "./api";

type TabSetter = (tab: string) => void;
type IdSetter = (id: string) => void;
type Translator = (key: string) => string;
type DisplayValue = (value: unknown, language: string) => ReactNode;
type DisplayRepoName = (value: string, language?: string) => string;
type ManifestPreview = (value?: string | null) => string;
type StatusLabel = (value: string, language?: string) => string;
type SortState = {
  key: string;
  direction: "asc" | "desc";
};

type TagComponent = ComponentType<{
  value: string;
  tone?: string;
  language?: string;
}>;

type EmptyStateComponent = ComponentType<{
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}>;

type ButtonComponent = ComponentType<{
  children: ReactNode;
  variant?: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit" | "reset";
}>;

type SectionComponent = ComponentType<{
  title: ReactNode;
  children: ReactNode;
}>;

type DetailComponent = ComponentType<{
  label: string;
  value: ReactNode;
  mono?: boolean;
  link?: boolean;
}>;

type RepositorySummary = {
  id: string;
  name: string;
};

type SkillSummary = PluginSkillSummary & {
  repoId?: string;
};

type PluginViewProps = {
  plugins: UiPlugin[];
  openPluginDetail: (plugin: UiPlugin) => void;
  setActiveTab: TabSetter;
  setSelectedRepoId: IdSetter;
  setInspectorRepoId: IdSetter;
  hasPlugins: boolean;
  hasInspector: boolean;
  selectedPluginId: string;
  focusPluginRow?: boolean;
  pluginSort: SortState;
  setPluginSort: (sorter: (current: SortState) => SortState) => void;
  language: string;
  t: Translator;
  Tag: TagComponent;
  EmptyState: EmptyStateComponent;
  displayRepoName: DisplayRepoName;
  displayValue: DisplayValue;
  manifestShaPreview: ManifestPreview;
};

type PluginInspectorProps = {
  plugin: UiPlugin;
  detail: PluginDetail | null;
  loading: boolean;
  error: string;
  onClose: () => void;
  setActiveTab: TabSetter;
  setSelectedRepoId: IdSetter;
  setInspectorRepoId: IdSetter;
  openSkillDetail: (skill: SkillSummary) => void;
  copyInstallCommand: (command: string) => void;
  onSaveNote: (plugin: UiPlugin, note: string) => Promise<void>;
  isPending: (key: string) => boolean;
  skills: SkillSummary[];
  repositories: RepositorySummary[];
  language: string;
  t: Translator;
  Tag: TagComponent;
  Button: ButtonComponent;
  Section: SectionComponent;
  Detail: DetailComponent;
  displayRepoName: DisplayRepoName;
  displayValue: DisplayValue;
  statusLabel: StatusLabel;
};

function handleRowKey(
  event: KeyboardEvent<HTMLTableRowElement>,
  plugin: UiPlugin,
  openPluginDetail: (plugin: UiPlugin) => void,
) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  openPluginDetail(plugin);
}

export function PluginsView({
  plugins,
  openPluginDetail,
  setActiveTab,
  setSelectedRepoId,
  setInspectorRepoId,
  hasPlugins,
  hasInspector,
  selectedPluginId,
  focusPluginRow = false,
  pluginSort,
  setPluginSort,
  language,
  t,
  Tag,
  EmptyState,
  displayRepoName,
  displayValue,
  manifestShaPreview,
}: PluginViewProps) {
  function jumpToRepo(plugin: UiPlugin) {
    if (plugin.repoId) {
      setSelectedRepoId(plugin.repoId);
      setInspectorRepoId(plugin.repoId);
    }
    setActiveTab("repositories");
  }

  function toggleSort(key: string) {
    setPluginSort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  }

  function sortIndicator(active: boolean, direction: SortState["direction"]) {
    if (!active) return "";
    return direction === "asc" ? " ↑" : " ↓";
  }

  return (
    <section className={`main-pane ${hasInspector ? "" : "single"}`}>
      <div className="pane-header">
        <div>
          <h1>{t("pluginsTitle")}</h1>
          <p>{t("pluginsSubtitle")}</p>
        </div>
      </div>

      <div className="table-frame">
        {plugins.length ? (
          <table className="data-table plugins-table">
            <thead>
              <tr>
                <th>
                  <button className="table-sort-button" onClick={() => toggleSort("name")} type="button">
                    {t("plugin")}{sortIndicator(pluginSort.key === "name", pluginSort.direction)}
                  </button>
                </th>
                <th>{t("installCommand")}</th>
                <th>{t("sourceRepository")}</th>
                <th>
                  <button className="table-sort-button" onClick={() => toggleSort("createdAt")} type="button">
                    {t("createdAt")}{sortIndicator(pluginSort.key === "createdAt", pluginSort.direction)}
                  </button>
                </th>
                <th>{t("skills")}</th>
                <th>{t("remoteSha")}</th>
                <th>{t("status")}</th>
                <th>{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {plugins.map((plugin, index) => (
                <tr
                  aria-label={`${t("more")}: ${plugin.name}`}
                  className={[
                    plugin.id === selectedPluginId ? "active-row" : "",
                    focusPluginRow && index === 0 ? "keyboard-focus-row" : "",
                  ].filter(Boolean).join(" ")}
                  key={plugin.id}
                  onClick={() => openPluginDetail(plugin)}
                  onKeyDown={(event) => handleRowKey(event, plugin, openPluginDetail)}
                  role="button"
                  tabIndex={0}
                >
                  <td>
                    <strong>{plugin.name}</strong>
                    <span className="subtext">
                      <Tag value={plugin.kind || "unknown"} tone="source-chip" language={language} />
                      <span>{plugin.description || t("pluginInstallEntryHint")}</span>
                    </span>
                    {plugin.note && <span className="subtext note-preview">{plugin.note}</span>}
                  </td>
                  <td>
                    <code className="plugin-command-inline">{plugin.installCommand || t("unknown")}</code>
                  </td>
                  <td className="source-repo-cell" title={displayRepoName(plugin.repoName, language)}>
                    {displayRepoName(plugin.repoName, language)}
                  </td>
                  <td className="mono">{plugin.createdAt || "-"}</td>
                  <td>{plugin.skillCount || 0}</td>
                  <td className="mono" title={String(displayValue(plugin.detectedSha, language))}>
                    {manifestShaPreview(plugin.detectedSha)}
                  </td>
                  <td>
                    <Tag value={plugin.status || "detected"} language={language} />
                  </td>
                  <td onClick={(event) => event.stopPropagation()}>
                    <div className="row-actions">
                      <button
                        aria-label={`${t("more")}: ${plugin.name}`}
                        onClick={() => openPluginDetail(plugin)}
                        title={`${t("more")}: ${plugin.name}`}
                        type="button"
                      >
                        {t("more")}
                      </button>
                      <button
                        aria-label={`${t("source")}: ${plugin.name}`}
                        onClick={() => jumpToRepo(plugin)}
                        title={`${t("source")}: ${plugin.name}`}
                        type="button"
                      >
                        {t("source")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState
            title={hasPlugins ? t("noFilteredPluginsTitle") : t("firstPluginTitle")}
            body={hasPlugins ? t("noFilteredPluginsText") : t("firstPluginText")}
            actionLabel={t("rescanSources")}
            onAction={() => setActiveTab("repositories")}
          />
        )}
      </div>
    </section>
  );
}

function CommandRow({
  label,
  command,
  emptyValue,
  copyInstallCommand,
  t,
}: {
  label: string;
  command?: string | null;
  emptyValue: ReactNode;
  copyInstallCommand: (command: string) => void;
  t: Translator;
}) {
  const hasCommand = Boolean(command);

  return (
    <div className="command-row">
      <span>{label}</span>
      <div className="command-row-value">
        <code>{hasCommand ? command : emptyValue}</code>
        {hasCommand && (
          <button
            aria-label={`${t("copy")}: ${label}`}
            className="command-copy-button"
            onClick={() => copyInstallCommand(command as string)}
            title={`${t("copy")}: ${label}`}
            type="button"
          >
            {t("copy")}
          </button>
        )}
      </div>
    </div>
  );
}

export function PluginInspector({
  plugin,
  detail,
  loading,
  error,
  onClose,
  setActiveTab,
  setSelectedRepoId,
  setInspectorRepoId,
  openSkillDetail,
  copyInstallCommand,
  onSaveNote,
  isPending,
  skills,
  repositories,
  language,
  t,
  Tag,
  Button,
  Section,
  Detail,
  displayRepoName,
  displayValue,
  statusLabel,
}: PluginInspectorProps) {
  const activeDetail = detail || plugin;
  const linkedSkills = activeDetail.linkedSkills || plugin.linkedSkills || [];
  const [noteDraft, setNoteDraft] = useState(activeDetail.note || "");

  useEffect(() => {
    setNoteDraft(activeDetail.note || "");
  }, [activeDetail.id, activeDetail.note]);

  function jumpToRepo() {
    const repo =
      repositories.find((item) => item.id === plugin.repoId) ||
      repositories.find(
        (item) => displayRepoName(item.name, language) === displayRepoName(plugin.repoName, language),
      );
    if (repo) {
      setSelectedRepoId(repo.id);
      setInspectorRepoId(repo.id);
    }
    setActiveTab("repositories");
  }

  function jumpToSkill(summary: PluginSkillSummary) {
    const skill = skills.find((item) => item.id === summary.id);
    if (skill) {
      openSkillDetail(skill);
    }
    setActiveTab("skills");
  }

  return (
    <aside className="inspector plugin-inspector">
      <header className="inspector-title">
        <div>
          <h2>{plugin.name}</h2>
          <Tag value={plugin.kind || "unknown"} language={language} />
        </div>
        <button className="icon-button" onClick={onClose} type="button" aria-label={t("close")}>
          x
        </button>
      </header>

      <Section title={t("pluginOverview")}>
        <Detail label={t("pluginKind")} value={<Tag value={activeDetail.kind || "unknown"} language={language} />} />
        <Detail label={t("sourceRepository")} value={displayRepoName(activeDetail.repoName, language)} />
        <Detail label={t("status")} value={<Tag value={activeDetail.status || "detected"} language={language} />} />
        <Detail label={t("remoteSha")} value={displayValue(activeDetail.detectedSha, language)} mono />
        <Detail label={t("lastChecked")} value={displayValue(activeDetail.updatedAt, language)} />
        <p className="detail-copy muted-copy">{t("pluginInstallEntryHint")}</p>
        <div className="inline-action-row">
          <Button onClick={jumpToRepo}>{t("source")}</Button>
        </div>
      </Section>

      <Section title={t("pluginInstallEntries")}>
        <CommandRow
          label={t("installCommand")}
          command={activeDetail.installCommand}
          emptyValue={t("unknown")}
          copyInstallCommand={copyInstallCommand}
          t={t}
        />
        <CommandRow
          label={t("updateCommand")}
          command={activeDetail.updateCommand}
          emptyValue={displayValue("", language)}
          copyInstallCommand={copyInstallCommand}
          t={t}
        />
      </Section>

      <Section title={t("note")}>
        <div className="note-editor">
          <textarea
            onChange={(event) => setNoteDraft(event.target.value)}
            placeholder={t("notePlaceholder")}
            value={noteDraft}
          />
          <div className="inline-action-row">
            <Button
              disabled={isPending(`note:plugin:${plugin.id}`)}
              onClick={() => onSaveNote(plugin, noteDraft)}
              variant="primary"
            >
              {isPending(`note:plugin:${plugin.id}`) ? t("saving") : t("saveNote")}
            </Button>
            <Button
              disabled={!noteDraft || isPending(`note:plugin:${plugin.id}`)}
              onClick={() => {
                setNoteDraft("");
                onSaveNote(plugin, "");
              }}
            >
              {t("clearNote")}
            </Button>
          </div>
        </div>
      </Section>

      <Section title={`${t("linkedSkills")} (${linkedSkills.length || activeDetail.skillCount || 0})`}>
        {loading && <p className="empty-note">{t("loading")}</p>}
        {error && <p className="empty-note error-note">{error}</p>}
        {!loading && !error && linkedSkills.length ? (
          <div className="skill-list-mini">
            {linkedSkills.map((skill) => (
              <button
                className="mini-skill mini-skill-button"
                key={skill.id || skill.path}
                onClick={() => jumpToSkill(skill)}
                type="button"
              >
                <span className="health-dot" />
                <span>{skill.name}</span>
                <code>{skill.version || skill.path}</code>
              </button>
            ))}
          </div>
        ) : null}
        {!loading && !error && !linkedSkills.length && <p className="empty-note">{t("noSkillsFound")}</p>}
      </Section>

      <Section title={t("pluginSource")}>
        <Detail label={t("path")} value={activeDetail.sourcePath || "README.md"} mono />
        <Detail label={t("pluginKind")} value={statusLabel(activeDetail.kind || "unknown", language)} />
        <div className="markdown-preview-block">
          <pre>{activeDetail.sourceExcerpt || t("readmeUnavailable")}</pre>
        </div>
      </Section>
    </aside>
  );
}
