import { expect, test, type Page } from "@playwright/test";

async function blockExternalRequests(page: Page) {
  const externalRequests: string[] = [];
  const context = page.context();

  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    const url = new URL(requestUrl);
    if (url.origin === "http://127.0.0.1:4173") {
      await route.continue();
      return;
    }

    externalRequests.push(requestUrl);
    await route.abort("blockedbyclient");
  });

  await context.routeWebSocket("**/*", async (webSocket) => {
    const socketUrl = webSocket.url();
    const url = new URL(socketUrl);
    if (url.origin === "ws://127.0.0.1:4173") {
      webSocket.connectToServer();
      return;
    }
    externalRequests.push(socketUrl);
    await webSocket.close({ code: 1008, reason: "external network disabled in Demo E2E" });
  });

  return () => expect(externalRequests).toEqual([]);
}

test("检测全部仓库会生成可审计任务，且不访问外部服务", async ({ page }) => {
  const expectNoExternalRequests = await blockExternalRequests(page);
  await page.goto("/?lang=zh&tab=tasks");

  const checkRows = page.getByRole("row", { name: /检测远端状态.*全部仓库/ });
  const previousCount = await checkRows.count();
  await page.getByRole("button", { name: "仓库", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "仓库" })).toBeVisible();

  await page.getByRole("button", { name: "检测全部" }).click();
  await page.getByRole("button", { name: "任务", exact: true }).click();

  await expect(page.getByRole("heading", { level: 1, name: "任务" })).toBeVisible();
  await expect(checkRows).toHaveCount(previousCount + 1);
  const completedCheck = checkRows.first();
  await expect(completedCheck).toContainText("成功");
  await completedCheck.click();
  const taskLog = page.getByRole("heading", { level: 2, name: "任务日志" });
  await expect(taskLog).toBeVisible();
  await expect(taskLog.locator("..").locator("..")).toContainText("重新计算备份状态");

  expectNoExternalRequests();
});

test("选择仓库并确认备份后可查看成功状态和日志，且不访问外部服务", async ({ page }) => {
  const expectNoExternalRequests = await blockExternalRequests(page);
  await page.goto("/?lang=zh&tab=repositories");

  await page.getByRole("button", { name: "清空选择" }).click();
  await page.getByRole("checkbox", { name: "仓库: example-org/content-skill-kit" }).check();
  await page.getByRole("button", { name: "备份选中（1）" }).click();

  const backupDialog = page.getByRole("dialog", { name: "备份选中仓库" });
  await expect(backupDialog).toBeVisible();
  await expect(backupDialog.getByText("example-org/content-skill-kit", { exact: true })).toBeVisible();
  await backupDialog.getByRole("button", { name: "确认备份" }).click();
  await expect(backupDialog).toHaveCount(0);

  const repositoryRow = page.getByRole("row", { name: /example-org\/content-skill-kit/ });
  await expect(repositoryRow).toContainText("已备份");
  await repositoryRow.click();
  await page.getByRole("button", { name: "打开备份目录" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "example-org/content-skill-kit" })).toBeVisible();

  await page.getByRole("button", { name: "任务", exact: true }).click();
  const backupTask = page.getByRole("row", { name: /备份仓库.*选中仓库.*1 \/ 1.*成功/ }).first();
  await expect(backupTask).toBeVisible();
  await backupTask.click();
  const taskLog = page.getByRole("heading", { level: 2, name: "任务日志" });
  await expect(taskLog).toBeVisible();
  await expect(taskLog.locator("..").locator("..")).toContainText("写入 manifest.json");

  expectNoExternalRequests();
});

test("新增远端仓库使用稳定 ID 并自动聚焦详情，且不访问外部服务", async ({ page }) => {
  const expectNoExternalRequests = await blockExternalRequests(page);
  await page.goto("/?lang=zh&tab=repositories");

  await page.getByRole("button", { name: "添加仓库" }).click();
  const addDialog = page.getByRole("dialog", { name: "添加仓库" });
  await addDialog.getByRole("textbox", { name: "仓库 URL 或 owner/repo" }).fill("a11y/demo-skill");
  await addDialog.getByRole("textbox", { name: "Ref" }).fill("release");
  await addDialog.getByRole("textbox", { name: "备注" }).fill("E2E stable identity");
  await addDialog.getByRole("button", { name: "添加并扫描" }).click();
  await expect(addDialog).toHaveCount(0);

  const repositoryRow = page.getByRole("row", { name: /a11y\/demo-skill/ });
  await expect(repositoryRow).toBeVisible();
  await expect(repositoryRow).toHaveAttribute("data-repository-id", "demo:a11y/demo-skill@release");
  await expect(repositoryRow).toHaveAttribute("aria-selected", "true");
  await expect(repositoryRow).toContainText("E2E stable identity");
  await expect(page.getByRole("heading", { level: 2, name: "a11y/demo-skill" })).toBeVisible();
  await expect(page.getByRole("textbox", {
    name: "记录用途、场景、安装注意事项或迁移说明。",
  })).toHaveValue("E2E stable identity");

  expectNoExternalRequests();
});

test("Demo 中取消或不可用的本地目录选择不会生成任务，且不访问外部服务", async ({ page }) => {
  const expectNoExternalRequests = await blockExternalRequests(page);
  await page.goto("/?lang=zh&tab=tasks");

  const taskRows = page.getByRole("table").getByRole("row");
  const previousCount = await taskRows.count();
  await page.getByRole("button", { name: "技能", exact: true }).click();
  await page.getByRole("button", { name: "添加本地仓库" }).click();
  await page.getByRole("button", { name: "任务", exact: true }).click();

  await expect(taskRows).toHaveCount(previousCount);
  await expect(page.getByRole("row", { name: /扫描本地仓库/ })).toHaveCount(0);

  expectNoExternalRequests();
});

test("失败任务重试被较新的仓库变更 supersede，并清理 optimistic 状态", async ({ page }) => {
  const expectNoExternalRequests = await blockExternalRequests(page);
  await page.goto("/?lang=zh&tab=tasks&demo=retry-race");

  const failedTask = page.getByRole("row", { name: /备份仓库.*example-org\/content-skill-kit.*失败/ });
  await expect(failedTask).toBeVisible();
  await failedTask.getByRole("button", { name: "重试: example-org/content-skill-kit" }).click();
  await expect(failedTask.getByRole("button", { name: "重试: example-org/content-skill-kit" })).toHaveText("重试中…");

  await page.getByRole("button", { name: "仓库", exact: true }).click();
  await page.getByRole("button", { name: "添加仓库" }).click();
  const addDialog = page.getByRole("dialog", { name: "添加仓库" });
  await addDialog.getByRole("textbox", { name: "仓库 URL 或 owner/repo" }).fill("quality/newer-repository");
  await addDialog.getByRole("button", { name: "添加并扫描" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "quality/newer-repository" })).toBeVisible();

  await page.getByRole("button", { name: "任务", exact: true }).click();
  await expect(page.getByRole("row", { name: /扫描仓库.*quality\/newer-repository.*成功/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /备份仓库.*example-org\/content-skill-kit.*失败/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "重试中…" })).toHaveCount(0);
  await expect(page.getByRole("row", { name: /重试任务.*example-org\/content-skill-kit/ })).toHaveCount(0);

  expectNoExternalRequests();
});

test("设置从默认值保存并由服务回灌，切换页面后仍保持，且不访问外部服务", async ({ page }) => {
  const expectNoExternalRequests = await blockExternalRequests(page);
  await page.goto("/?lang=zh&tab=settings");

  const interval = page.getByRole("slider", { name: "自动检测间隔" });
  const backupRoot = page.getByRole("textbox", { name: "本地目录" });
  await expect(page.getByRole("button", { name: "浅色主题" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "舒适" })).toHaveAttribute("aria-pressed", "true");
  await expect(interval).toHaveValue("60");
  await expect(backupRoot).toHaveValue("~/SkillRepoBackups");
  await expect(page.getByText("元数据并发")).toHaveCount(0);
  await expect(page.getByText("失败重试次数")).toHaveCount(0);
  await expect(page.getByText("备份历史保留数量")).toHaveCount(0);
  await page.getByRole("button", { name: "检查更新" }).click();
  await expect(page.getByText("当前已是最新版本。").first()).toBeVisible();

  await page.getByRole("button", { name: "黑色主题" }).click();
  await page.getByRole("button", { name: "紧凑" }).click();
  await interval.fill("75");
  await backupRoot.fill("/tmp/demo-backups/");
  await page.getByRole("button", { name: "保存设置" }).click();

  await expect(page.getByRole("status")).toHaveText("设置已保存。");
  await expect(backupRoot).toHaveValue("/tmp/demo-backups");
  await page.getByRole("button", { name: "仓库", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("button", { name: "黑色主题" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "紧凑" })).toHaveAttribute("aria-pressed", "true");
  await expect(interval).toHaveValue("75");
  await expect(backupRoot).toHaveValue("/tmp/demo-backups");

  expectNoExternalRequests();
});

test("GitHub 429 显示 reset_at 后可确定性恢复，且不访问外部服务", async ({ page }) => {
  const expectNoExternalRequests = await blockExternalRequests(page);
  await page.goto("/?lang=zh&tab=github&demo=github-rate-limit");

  await expect(page.getByRole("heading", { level: 1, name: "GitHub" })).toBeVisible();
  await page.getByRole("button", { name: "刷新 GitHub" }).click();
  await expect(page.getByRole("status")).toContainText("429");
  await expect(page.getByRole("status")).toContainText("reset_at=2026-09-03T12:00:00Z");

  await page.getByRole("button", { name: "刷新 GitHub" }).click();
  await expect(page.getByRole("status")).toContainText("远端状态已刷新");
  await expect(page.getByText("example-org/private-skill-kit", { exact: true })).toBeVisible();

  expectNoExternalRequests();
});

test("Prompt 可创建标签、搜索并完成 ZIP 批量导出导入，且不访问外部服务", async ({ page }) => {
  const expectNoExternalRequests = await blockExternalRequests(page);
  await page.goto("/?lang=zh&tab=prompts");

  await expect(page.getByRole("heading", { level: 1, name: "提示词库" })).toBeVisible();
  await page.getByRole("button", { name: "新建提示词" }).click();
  const editor = page.getByRole("dialog", { name: "创建提示词" });
  await editor.getByRole("textbox", { name: "标题" }).fill("发布安全复验");
  await editor.getByRole("textbox", { name: "正文" }).fill("验证 tag、search 与 ZIP export/import 的离线闭环。");
  await editor.getByRole("textbox", { name: "新标签名称" }).fill("发布治理");
  await editor.getByRole("button", { name: "新增标签" }).click();
  await expect(editor.getByRole("checkbox", { name: "发布治理" })).toBeChecked();
  await editor.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("提示词已保存", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "关闭" }).click();
  const search = page.getByRole("searchbox", { name: "搜索提示词" });
  await search.fill("发布安全复验");
  const promptCard = page.getByRole("article", { name: "发布安全复验" });
  await expect(promptCard).toBeVisible();
  await promptCard.getByRole("checkbox", { name: "选择：发布安全复验" }).check();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "批量导出" }).click();
  await expect(page.getByText("导出任务已完成", { exact: true })).toBeVisible();

  await promptCard.click();
  const promptDrawer = page.getByRole("dialog", { name: "发布安全复验" });
  await expect(promptDrawer).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await promptDrawer.getByRole("button", { name: "删除提示词" }).click();
  await expect(page.getByText("提示词已删除", { exact: true })).toBeVisible();
  await expect(promptCard).toHaveCount(0);

  await page.getByRole("button", { name: "批量导入" }).click();
  const importDialog = page.getByRole("dialog", { name: "导入提示词 ZIP" });
  await expect(importDialog).toBeVisible();
  await expect(importDialog.getByRole("combobox", { name: "冲突处理" })).toHaveValue("duplicate");
  await importDialog.getByRole("button", { name: "导入提示词" }).click();
  await expect(importDialog.getByRole("heading", { level: 2, name: "导入完成" })).toBeVisible();
  await importDialog.locator("footer").getByRole("button", { name: "关闭" }).click();
  await search.fill("发布安全复验");
  await expect(page.getByRole("article", { name: "发布安全复验" })).toBeVisible();

  expectNoExternalRequests();
});
