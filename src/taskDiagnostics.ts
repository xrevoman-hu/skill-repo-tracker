import type { UiTask } from "./api";
import { localizedApiErrorMessage } from "./api";

const TASK_TEXT_ZH = {
  "Backup repositories": "备份仓库",
  "Check remote state": "检测远端状态",
  "Update Skill": "更新 Skill",
  "Scan repository": "扫描仓库",
  "Scan local Skills": "扫描本地 Skills",
  "Scan local repository": "扫描本地仓库",
  "Delete Skill": "删除 Skill",
  "Restore Skill": "恢复 Skill",
  "Retry task": "重试任务",
  "Install Skill": "安装 Skill",
  "Updated repositories": "有更新仓库",
  "All repositories": "全部仓库",
  "Selected repositories": "选中仓库",
  "Previous session": "上次会话",
  "7 success, 1 failed, 4 queued": "7 个成功、1 个失败、4 个排队",
  "15 success, 2 failed": "15 个成功、2 个失败",
  "blocked by local modifications": "被本地修改阻止",
  "app closed during ZIP download": "ZIP 下载时应用关闭",
  "retry completed": "重试已完成",
  "remote check started": "已开始检测远端状态",
  "local Skills scan started": "已开始扫描本地 Skills",
  "local repository scan started": "已开始扫描本地仓库",
  "repository scan started": "已开始扫描仓库",
  "backup started": "已开始备份",
  "Skill update started": "已开始更新 Skill",
  "Skill install started": "已开始安装 Skill",
  "delete Skill started": "已开始删除 Skill",
  "restore Skill started": "已开始恢复 Skill",
  "retry task started": "已开始重试任务",
  "local Skill updated": "本地 Skill 已更新",
  "1 Skill recognized": "识别到 1 个 Skill",
  "generic repo, 0 Skills": "普通仓库，0 个 Skill",
  "refresh remote state for 17 repositories": "刷新 17 个仓库的远端状态",
  "skip example-org/missing-skill because check failed": "跳过 example-org/missing-skill，因为检测失败",
  "download example-org__content-skill-kit__main__a1b2c3d.zip": "下载 example-org__content-skill-kit__main__a1b2c3d.zip",
  "compute sha256: 19a6...4de1": "计算 sha256：19a6...4de1",
  "write manifest.json": "写入 manifest.json",
  "update last_backup_sha for successful items": "更新成功项的 last_backup_sha",
  "resolve default refs": "解析默认 ref",
  "record remote_head_sha for public repositories": "记录公开仓库的 remote_head_sha",
  "keep previous SHA for failed repositories": "检测失败仓库保留上次 SHA",
  "calculate installed_skill_hash": "计算 installed_skill_hash",
  "local content differs from installation record": "本地内容不同于安装记录",
  "task interrupted before manifest write": "manifest 写入前任务中断",
  "last_backup_sha not updated": "last_backup_sha 未更新",
  "refresh all remote refs": "刷新全部远端 ref",
  "preserve failed repository SHA": "保留失败仓库 SHA",
  "recalculate backup states": "重新计算备份状态",
  "fetch remote HEAD SHA": "获取远端 HEAD SHA",
  "found SKILL.md": "发现 SKILL.md",
  "no SKILL.md found; keep as generic repo": "未发现 SKILL.md，保留为普通仓库",
  "refresh remote state before backup": "备份前刷新远端状态",
  "download ZIP files to .partial paths": "将 ZIP 下载到 .partial 路径",
  "compute sha256 for successful ZIP files": "为成功 ZIP 计算 sha256",
  "update last_backup_sha for successful repositories": "更新成功仓库的 last_backup_sha",
  "download remote Skill directory": "下载远端 Skill 目录",
  "replace local files": "替换本地文件",
  "record installed_skill_hash": "记录 installed_skill_hash",
  "local hash differs from installed_skill_hash": "本地 hash 不同于 installed_skill_hash",
  "record new installed_skill_hash": "记录新的 installed_skill_hash",
  "retry failed item": "重试失败项",
  "complete without changing unrelated state": "完成且不改变无关状态",
};

export function taskText(text: string, language: string): string {
  if (language !== "zh" || !text) return text;
  const successSkipped = text.match(/^(\d+) success, (\d+) skipped$/);
  if (successSkipped) return `${successSkipped[1]} 个成功、${successSkipped[2]} 个跳过`;
  const successFailed = text.match(/^(\d+) success, (\d+) failed$/);
  if (successFailed) return `${successFailed[1]} 个成功、${successFailed[2]} 个失败`;
  if (text.endsWith(" retry")) return `${taskText(text.slice(0, -6), language)}重试`;
  if (text.startsWith("create ")) return text.replace(/^create /, "创建 ");
  if (text.startsWith("normalize ")) return text.replace(/^normalize /, "规范化 ");
  return (TASK_TEXT_ZH as Record<string, string>)[text] || text;
}

export function isRetryStatus(status: string) {
  return ["failed", "interrupted", "partial-success"].includes(status);
}

export function canRetryTask(task: UiTask) {
  return Boolean(task?.retryable) && isRetryStatus(task.status);
}

export function retryTaskTitle(task: UiTask, language: string, t: (key: string) => string) {
  if (!isRetryStatus(task.status)) {
    return t("retryOnlyFailed");
  }
  if (!task.retryable) {
    return taskText(task.retryReason || t("retryUnavailable"), language);
  }
  return `${t("retry")}: ${taskText(task.target, language)}`;
}


export function visibleTaskDiagnostics(tasks: UiTask[], failures: UiTask[]): UiTask[] {
  if (!failures.length) return tasks;
  const localIds = new Set(failures.map((task) => task.id));
  return [...failures, ...tasks.filter((task) => !localIds.has(task.id))];
}

export function failedTaskDiagnostic(
  pending: UiTask,
  error: unknown,
  fallback: string,
  retryReason: string,
): UiTask {
  const message = localizedApiErrorMessage(error, "zh", fallback);
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : "";
  return {
    ...pending,
    status: "failed", progress: "—", summary: message, retryable: false,
    retryReason, log: [...pending.log, code ? `${message} [${code}]` : message],
  };
}

export function formatTaskDiagnostic(task: UiTask): string {
  return [
    `Task ID: ${task.id}`, `Type: ${task.kind}`, `Target: ${task.target}`,
    `Status: ${task.status}`, `Progress: ${task.progress}`, `Summary: ${task.summary}`,
    `Retryable: ${task.retryable}`,
    ...(task.retryReason ? [`Retry reason: ${task.retryReason}`] : []),
    "", "Log:", ...(task.log.length
      ? task.log.map((line, index) => `${String(index + 1).padStart(2, "0")}  ${line}`)
      : ["No detailed log was saved for this task."]),
  ].join("\n");
}

export function taskFailureLines(task: UiTask): string[] {
  if (!isRetryStatus(task.status)) return [];
  return task.log.filter((line) => /\bfailed(?::|$)|\berror\b|失败|错误/i.test(line));
}
