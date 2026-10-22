import type { ReactNode } from "react";
import { BookOpenText, KeyRound } from "lucide-react";

export const navItems = [
  { id: "github", labelKey: "nav.github" },
  { id: "repositories", labelKey: "nav.repositories" },
  { id: "skills", labelKey: "nav.skills" },
  { id: "prompts", labelKey: "nav.prompts" },
  { id: "plugins", labelKey: "nav.plugins" },
  { id: "credentials", labelKey: "nav.credentials" },
  { id: "tasks", labelKey: "nav.tasks" },
  { id: "settings", labelKey: "nav.settings" },
];
type Props = {
  activeTab: string;
  language: string;
  onNavigate: (tab: string) => void | Promise<void>;
  t: (key: string) => string;
  promptCounts: { prompts: number; tags: number; filtered: number };
  counts: { total: number; skill: number; generic: number; unknown: number; backed: number; excluded: number; updated: number; failed: number };
};
export function AppSidebar({ activeTab, language, onNavigate, t, promptCounts, counts }: Props) {
  return <aside className="sidebar">
    <div className="brand"><strong>Skill Repo Tracker</strong><span>{t("localCare")}</span></div>
    <nav className="nav-list" aria-label="Primary">{navItems.map((item) => <button className={`nav-item ${activeTab === item.id ? "active" : ""}`} key={item.id} type="button" onClick={() => void onNavigate(item.id)}>
      {item.id === "prompts" ? <BookOpenText aria-hidden="true" className="nav-lucide" size={15} strokeWidth={1.8} /> : item.id === "credentials" ? <KeyRound aria-hidden="true" className="nav-lucide" size={15} strokeWidth={1.8} /> : <span className={`nav-mark nav-mark-${item.id}`} />}
      {t(item.labelKey)}
    </button>)}</nav>
    {activeTab === "prompts" ? <>
      <section className="sidebar-section prompt-sidebar-overview"><h3>{t("promptOverview")}</h3><Metric label={t("totalPrompts")} value={promptCounts.prompts} /><Metric label={t("promptTags")} value={promptCounts.tags} /><Metric label={t("filteredPrompts")} value={promptCounts.filtered} /></section>
      <section className="sidebar-note prompt-sidebar-note"><h3>{language === "zh" ? "本地存储" : "Local storage"}</h3><p>{language === "zh" ? "正文保存在本机 SQLite；每篇最多 5 MiB。" : "Bodies stay in local SQLite, up to 5 MiB each."}</p></section>
    </> : activeTab === "credentials" ? <section className="sidebar-note prompt-sidebar-note"><h3>{language === "zh" ? "人机共用凭据库" : "Shared credential vault"}</h3><p>{language === "zh" ? "你只需记住主密码。关闭软件后再次手动解锁。" : "Remember one master password. Unlock manually each time the app opens."}</p></section> : <>
      <section className="sidebar-section"><h3>{t("summary")}</h3><Metric label={t("totalRepositories")} value={counts.total} /><Metric label={t("skillRepositories")} value={counts.skill} /><Metric label={t("genericRepositories")} value={counts.generic} /><Metric label={t("unknownType")} value={counts.unknown} /></section>
      <section className="sidebar-section"><h3>{t("backupStatus")}</h3><Legend tone="green" label={t("backedLatest")} value={counts.backed} /><Legend tone="orange" label={t("updatedNotBacked")} value={counts.updated} /><Legend tone="gray" label={t("backupExcluded")} value={counts.excluded} /><Legend tone="red" label={t("checkFailed")} value={counts.failed} /><Legend tone="gray" label={t("unknown")} value={counts.unknown} /></section>
    </>}
  </aside>;
}
function Metric({ label, value }: { label: ReactNode; value: ReactNode }) {
  return <div className="metric-row"><span>{label}</span><strong>{value}</strong></div>;
}
function Legend({ tone, label, value }: { tone: string; label: ReactNode; value: ReactNode }) {
  return <div className="legend-row"><span className={`legend-dot ${tone}`} /><span>{label}</span><strong>{value}</strong></div>;
}
