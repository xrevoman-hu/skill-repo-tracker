import { expect, test, type Page } from "@playwright/test";

async function blockExternalRequests(page: Page) {
  const externalRequests: string[] = [];
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:4173") { await route.continue(); return; }
    externalRequests.push(url.href);
    await route.abort("blockedbyclient");
  });
  await page.context().routeWebSocket("**/*", async (socket) => {
    const url = new URL(socket.url());
    if (url.origin === "ws://127.0.0.1:4173") { socket.connectToServer(); return; }
    externalRequests.push(url.href);
    await socket.close({ code: 1008, reason: "external network disabled in Demo E2E" });
  });
  return () => expect(externalRequests).toEqual([]);
}

test("Demo 凭据可保存查找并重新验证，使用指令不含秘密，设置共享状态跨页生效", async ({ page }) => {
  const expectNoExternalRequests = await blockExternalRequests(page);
  const clipboardWrites: string[] = [];
  // Observe the user-facing locator without changing the machine's clipboard.
  await page.exposeFunction("captureCredentialLocator", (text: string) => { clipboardWrites.push(text); });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: (text: string) => (window as unknown as {
        captureCredentialLocator: (value: string) => Promise<void>;
      }).captureCredentialLocator(text),
    } });
  });
  const master = "e2e-synthetic-master-123";
  const secret = "e2e-synthetic-website-secret";
  const name = "E2E 演示网站";
  await page.goto("/?lang=zh&tab=credentials");
  await page.getByLabel("主密码", { exact: true }).fill(master);
  await page.getByLabel("再次输入主密码", { exact: true }).fill(master);
  await page.getByRole("button", { name: "创建并解锁", exact: true }).click();
  await page.getByRole("button", { name: "新增凭据", exact: true }).first().click();
  const editor = page.getByRole("dialog", { name: "编辑凭据" });
  await editor.getByLabel("名称 *", { exact: true }).fill(name);
  await editor.getByLabel("网址 *", { exact: true }).fill("https://credential.example.test");
  await editor.getByLabel("账号 / 用户名 *", { exact: true }).fill("synthetic-user");
  await editor.getByLabel("密码", { exact: true }).fill(secret);
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "凭据详情" });
  await expect(detail.getByLabel("内容已隐藏")).toBeVisible();
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
  await detail.getByRole("button", { name: "关闭详情" }).click();

  const search = page.getByRole("searchbox", { name: "搜索凭据" });
  await search.fill("no-such-credential");
  await expect(page.getByRole("heading", { name: "没有匹配的凭据" })).toBeVisible();
  await search.fill("synthetic-user");
  const card = page.getByRole("article").filter({ has: page.getByRole("button", { name, exact: true }) });
  await expect(card).toHaveCount(1);
  await card.getByRole("button", { name: "使用", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已复制使用指令");
  expect(clipboardWrites).toHaveLength(1);
  const copied = clipboardWrites[0];
  const locator = JSON.parse(copied.split("\n")[1]) as { vaultId: string; recordId: string; name: string };
  expect(locator.name).toBe(name);
  expect(locator.vaultId).toBeTruthy();
  expect(locator.recordId).toBeTruthy();
  expect(copied).not.toContain(master);
  expect(copied).not.toContain(secret);

  await card.getByRole("button", { name, exact: true }).click();
  await detail.getByRole("button", { name: "显示密码", exact: true }).click();
  const verification = page.getByRole("dialog", { name: "验证主密码" });
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
  await verification.getByLabel("主密码", { exact: true }).fill("incorrect-synthetic-password");
  await verification.getByRole("button", { name: "验证并继续" }).click();
  await expect(verification.getByRole("alert")).toContainText("主密码不正确");
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
  await verification.getByLabel("主密码", { exact: true }).fill(master);
  await verification.getByRole("button", { name: "验证并继续" }).click();
  await expect(detail.getByText(secret, { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "关闭详情" }).click();
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
  await card.getByRole("button", { name, exact: true }).click();
  await detail.getByRole("button", { name: "显示密码", exact: true }).click();
  await expect(verification).toBeVisible();
  await verification.getByLabel("主密码", { exact: true }).fill(master);
  await verification.getByRole("button", { name: "验证并继续" }).click();
  await expect(detail.getByText(secret, { exact: true })).toBeVisible();

  const navigation = page.getByRole("navigation", { name: "Primary" });
  await navigation.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
  const settings = page.getByRole("region", { name: "凭据库设置" });
  await settings.getByRole("button", { name: "开启访问", exact: true }).click();
  await page.getByRole("dialog", { name: "开启 Agent 访问" }).getByRole("button", { name: "确认", exact: true }).click();
  await expect(settings.getByRole("button", { name: "关闭访问", exact: true })).toBeVisible();
  await navigation.getByRole("button", { name: "凭据", exact: true }).click();
  await expect(page.getByText("Agent 访问已开启", { exact: true })).toBeVisible();
  await page.getByRole("button", { name, exact: true }).click();
  await expect(detail.getByLabel("内容已隐藏")).toBeVisible();
  await detail.getByRole("button", { name: "显示密码", exact: true }).click();
  await expect(verification).toBeVisible();
  await verification.getByRole("button", { name: "取消", exact: true }).click();
  await detail.getByRole("button", { name: "关闭详情" }).click();
  await navigation.getByRole("button", { name: "设置", exact: true }).click();
  await settings.getByRole("button", { name: "关闭访问", exact: true }).click();
  await page.getByRole("dialog", { name: "关闭 Agent 访问" }).getByRole("button", { name: "确认", exact: true }).click();
  await expect(settings.getByRole("button", { name: "开启访问", exact: true })).toBeVisible();

  await settings.getByRole("button", { name: "恢复备份", exact: true }).click();
  const recovery = page.getByRole("dialog", { name: "从加密备份恢复" });
  await expect(recovery.getByRole("button", { name: "选择备份文件" })).toBeDisabled();
  await expect(recovery).toContainText("浏览器演示不读取或恢复真实备份");
  await recovery.getByRole("button", { name: "取消", exact: true }).click();
  await navigation.getByRole("button", { name: "凭据", exact: true }).click();
  await expect(page.getByText("Agent 访问已关闭", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "新增凭据", exact: true }).click();
  await editor.getByRole("combobox", { name: "类型", exact: true }).selectOption("generic");
  await editor.getByLabel("名称 *", { exact: true }).fill("E2E 合成附件");
  await editor.getByLabel("秘密文件", { exact: true }).setInputFiles({
    name: "synthetic-attachment.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0xff, 0x00, 0x01]),
  });
  await expect(editor.getByText("synthetic-attachment.bin", { exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await detail.getByRole("button", { name: "导出原文件 synthetic-attachment.bin", exact: true }).click();
  await expect(detail.getByRole("alert")).toContainText("此操作需要桌面版");
  await expect(detail.getByRole("alert")).toContainText("不会创建、导出或恢复真实文件");
  await expect(page.getByRole("dialog", { name: "验证主密码" })).toHaveCount(0);
  expect(clipboardWrites).toHaveLength(1);
  expectNoExternalRequests();
});
