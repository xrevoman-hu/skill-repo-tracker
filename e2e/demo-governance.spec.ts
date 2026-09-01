import { expect, test } from "@playwright/test";

test("DemoAppService 支撑设置与仓库只读关键流且不访问外部服务", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") externalRequests.push(request.url());
  });

  await page.goto("/?lang=zh&tab=settings");

  await expect(page.getByRole("heading", { level: 1, name: "设置" })).toBeVisible();
  await expect(page.getByText("自动检测间隔")).toBeVisible();
  await expect(page.getByText("元数据并发")).toHaveCount(0);
  await expect(page.getByText("失败重试次数")).toHaveCount(0);
  await expect(page.getByText("备份历史保留数量")).toHaveCount(0);
  await page.getByRole("button", { name: "检查更新" }).click();
  await expect(page.getByText("当前已是最新版本。").first()).toBeVisible();
  expect(externalRequests).toEqual([]);

  await page.getByRole("button", { name: "仓库", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "仓库" })).toBeVisible();

  const repositoryRow = page.locator("tbody tr").filter({
    hasText: "example-org/content-skill-kit",
  });
  await repositoryRow.click();
  await expect(page.getByRole("heading", {
    level: 2,
    name: "example-org/content-skill-kit",
  })).toBeVisible();
  await expect(page.getByText("已识别技能 (3)")).toBeVisible();

  await page.getByRole("button", { name: "打开备份目录" }).click();
  await expect(page.getByRole("heading", {
    level: 2,
    name: "example-org/content-skill-kit",
  })).toBeVisible();
  expect(externalRequests).toEqual([]);
});
