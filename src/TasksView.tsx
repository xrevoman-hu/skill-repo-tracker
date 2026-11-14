import { useEffect, useState } from "react";
import type { UiTask } from "./api";
import { EmptyState, Tag } from "./UiPrimitives";
import { canRetryTask, isRetryStatus, retryTaskTitle, taskFailureLines, taskText } from "./taskDiagnostics";
import "./tasks.css";

type TasksViewProps = {
  tasks: UiTask[];
  taskFilter: string;
  setTaskFilter: (filter: string) => void;
  retryTask: (task: UiTask) => void | Promise<void>;
  copyTaskSummary: (task: UiTask) => void | Promise<void>;
  hasTasks: boolean;
  isPending: (key: string) => boolean;
  language: string;
  t: (key: string) => string;
};


function Detail({ label, value }: { label: string; value: string }) {
  return <div className="detail-row"><span>{label}</span><strong>{value}</strong></div>;
}

export function TasksView({
  tasks,
  taskFilter,
  setTaskFilter,
  retryTask,
  copyTaskSummary,
  hasTasks,
  isPending,
  language,
  t,
}: TasksViewProps) {
  const filters = [
    ["all", t("all")],
    ["waiting-user", t("waitingUser")],
    ["success", t("success")],
    ["partial-success", t("partial")],
    ["failed", t("failed")],
    ["interrupted", t("interrupted")],
  ];
  const [expanded, setExpanded] = useState<string | undefined>(tasks[0]?.id);
  const expandedTask = tasks.find((task) => task.id === expanded) || tasks[0];
  const failures = expandedTask ? taskFailureLines(expandedTask) : [];

  function taskActions(task: UiTask) {
    const target = taskText(task.target, language);
    const pending = isPending(`retryTask:${task.id}`);
    const copyLabel = `${t("copy")}: ${target}`;
    return (
      <div className="row-actions">
        <button aria-label={`${t("retry")}: ${target}`}
          disabled={!canRetryTask(task) || pending}
          onClick={() => retryTask(task)} title={retryTaskTitle(task, language, t)} type="button">
          {t(pending ? "retrying" : "retry")}
        </button>
        <button aria-label={copyLabel} onClick={() => copyTaskSummary(task)} title={copyLabel} type="button">
          {t("copy")}
        </button>
      </div>
    );
  }

  useEffect(() => {
    if (!tasks.length) {
      setExpanded(undefined);
    } else if (!tasks.some((task) => task.id === expanded)) {
      setExpanded(tasks[0].id);
    }
  }, [tasks, expanded]);

  return (
    <section className="main-pane single">
      <div className="pane-header">
        <div>
          <h1>{t("tasksTitle")}</h1>
          <p>{t("tasksSubtitle")}</p>
        </div>
        <div className="segmented" role="group" aria-label={t("tasksTitle")}>
          {filters.map(([id, label]) => (
            <button
              aria-pressed={taskFilter === id}
              className={taskFilter === id ? "selected" : ""}
              key={id}
              onClick={() => setTaskFilter(id)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="task-layout">
        <div className="table-frame">
          {tasks.length ? (
            <table className="data-table task-table">
              <thead>
                <tr>
                  {["type", "target", "progress", "status", "taskSummary", "actions"].map((key) => <th key={key}>{t(key)}</th>)}
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr
                    aria-selected={expandedTask?.id === task.id}
                    className={expandedTask?.id === task.id ? "active-row" : ""}
                    key={task.id}
                    onClick={() => setExpanded(task.id)}
                  >
                    <td>{taskText(task.kind, language)}</td>
                    <td title={taskText(task.target, language)}>
                      <button className="task-target-button" type="button"
                        aria-label={`${t("taskDetails")}: ${taskText(task.target, language)}`}
                        aria-pressed={expandedTask?.id === task.id}
                        onClick={() => setExpanded(task.id)}>
                        {taskText(task.target, language)}
                      </button>
                    </td>
                    <td>{task.progress}</td>
                    <td>
                      <Tag value={task.status} language={language} />
                    </td>
                    <td className="task-summary-cell" title={taskText(task.summary, language)}>
                      {taskText(task.summary, language)}
                    </td>
                    <td onClick={(event) => event.stopPropagation()}>
                      {taskActions(task)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState
              title={hasTasks ? t("noFilteredTasksTitle") : t("firstTaskTitle")}
              body={hasTasks ? t("noFilteredTasksText") : t("firstTaskText")}
            />
          )}
        </div>

        {expandedTask ? (
          <aside className="log-panel">
            <div className="task-detail-card">
              <div>
                <span>{t("taskDetails")}</span>
                <strong>{taskText(expandedTask.kind, language)}</strong>
              </div>
              <Tag value={expandedTask.status} language={language} />
              {[
                ["taskId", expandedTask.id], ["target", taskText(expandedTask.target, language)],
                ["progress", expandedTask.progress], ["taskSummary", taskText(expandedTask.summary, language)],
              ].map(([key, value]) => <Detail key={key} label={t(key)} value={value} />)}
              {!canRetryTask(expandedTask) && isRetryStatus(expandedTask.status) && (
                <Detail
                  label={t("retry")}
                  value={taskText(expandedTask.retryReason || t("retryUnavailable"), language)}
                />
              )}
              {failures.length > 0 && (
                <section className="task-failures" aria-label={t("taskFailures")}>
                  <h3>{t("taskFailures")}</h3>
                  <pre>{failures.join("\n")}</pre>
                </section>
              )}
            </div>
            <div className="log-actions">
              <h2>{t("taskLog")}</h2>
              {taskActions(expandedTask)}
            </div>
            <pre tabIndex={0} aria-label={t("taskLog")}>
              {expandedTask.log.length ? expandedTask.log
                .map((line, index) => `${String(index + 1).padStart(2, "0")}  ${taskText(line, language)}`)
                .join("\n") : t("taskLogUnavailable")}
            </pre>
          </aside>
        ) : (
          <aside className="log-panel empty-log">
            <h2>{t("taskLog")}</h2>
            <p>{t("firstTaskText")}</p>
          </aside>
        )}
      </div>
    </section>
  );
}
