import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRequiredInvariantIds,
  runCli,
  selectRequiredGovernanceIds,
  selectRequiredInvariantIds,
  validatePullRequestEvidence,
} from "../pr-evidence.mjs";

function completeBody(overrides = {}) {
  const values = {
    changeKind: "- [ ] Bug 修复\n- [x] 非 Bug 变更",
    userProblem: "定时任务的 generation 竞态会让旧结果覆盖新结果。",
    nonGoals: "不增加后台 daemon，不改变任务间隔。",
    acceptanceLayers: "static、Rust integration；未执行真实 GitHub 账号人工验收。",
    regression: "- [x] 新增了能让旧实现失败的回归测试，位置/测试名：taskCoordinator.test.ts",
    automationReason: "- 若不能先写自动化失败测试，原因与替代证据：",
    rootCause: "- 根因（不要只复述症状）：旧 generation 完成时没有再次确认所有权。",
    scanPaths: "- 已扫描的同类入口、adapter、竞态或数据路径：手工运行、timer、取消路径。",
    scanConclusion: "- 扫描结论/一并修复项：统一由 coordinator 判定 generation。",
    settings: "- [x] 不新增设置项；如新增，说明为什么合理默认值不能解决：",
    permissions: "- [x] 不新增/扩大 Tauri command、capability、entitlement、目录或网络 host；如有变化：",
    background: "- [x] 不新增后台状态、timer、daemon 或常驻开销；如有变化：",
    compatibility: "- [x] 数据库/导出/迁移兼容性已说明并测试：",
    rules: "- 已阅读/更新的 owning Rule/ADR asset ID：rule-tasks, adr-foreground-scheduling",
    invariants: "- 已复审资产/高风险不变量 ID：TASK-GEN-001, PATH-PERM-001",
    noBoundary: "- [ ] 本变更未产生新的长期边界，因此无需更新 Rule/ADR。",
    noDebt: "- [x] 没有引用独立 lane test waiver。",
    debt: "- 如确需临时隔离到独立 lane（主测试内仍不得 skip），填写 active ledger ID：",
    verify: "- [x] `npm run verify`",
    laneRan: "- [ ] 与本变更相关的独立 lane（coverage/E2E/MSRV/性能/Release）已运行，结果/链接：",
    laneNotApplicable: "- [x] 独立 lane 不适用，原因：仅修改文档和确定性治理测试。",
    sensitive:
      "- [x] 没有秘密、真实用户数据、`AGENTS.md`、`docs/internal/` 或宣传草稿进入 diff。",
    ...overrides,
  };

  return `## 变更类型

${values.changeKind}

## 变更目的

- 用户问题/产品价值：${values.userProblem}
- 非目标：${values.nonGoals}
- 验收层：${values.acceptanceLayers}

## 可复现证据

${values.regression}
${values.automationReason}

## 根因与同类扫描

${values.rootCause}
${values.scanPaths}
${values.scanConclusion}

## 状态与权限预算

${values.settings}
${values.permissions}
${values.background}
${values.compatibility}

## Rule / ADR / Invariant

${values.rules}
${values.invariants}
${values.noBoundary}

## Skip / flaky 债务

${values.noDebt}
${values.debt}

## 验证

${values.verify}
${values.laneRan}
${values.laneNotApplicable}
${values.sensitive}
`;
}

test("a complete non-bug PR satisfies every required evidence field", () => {
  assert.deepEqual(
    validatePullRequestEvidence({
      title: "feat: add repository filters",
      body: completeBody(),
      requiredInvariantIds: ["TASK-GEN-001", "PATH-PERM-001"],
    }),
    [],
  );
});

test("all PRs require a lightweight change brief, four state budgets, verify, and an explicit no-boundary choice", () => {
  const errors = validatePullRequestEvidence({
    title: "docs: clarify contributor flow",
    body: completeBody({
      userProblem: "<!-- 用户问题/产品价值；如无必要勿增实体。 -->",
      nonGoals: "",
      acceptanceLayers: "",
      settings: "- [ ] 不新增设置项；如新增，说明为什么合理默认值不能解决：",
      permissions: "- [ ] 不新增/扩大 Tauri command、capability、entitlement、目录或网络 host；如有变化：",
      background: "- [ ] 不新增后台状态、timer、daemon 或常驻开销；如有变化：",
      compatibility: "- [ ] 数据库/导出/迁移兼容性已说明并测试：",
      invariants: "- 已复审资产/高风险不变量 ID：",
      noBoundary: "- [ ] 本变更未产生新的长期边界，因此无需更新 Rule/ADR。",
      verify: "- [ ] `npm run verify`",
    }),
    requiredInvariantIds: [],
  });

  assert.deepEqual(errors, [
    "变更目的必须填写用户问题/产品价值",
    "变更目的必须填写非目标",
    "变更目的必须填写验收层",
    "状态与权限预算未确认或解释：设置项",
    "状态与权限预算未确认或解释：Tauri command/capability/entitlement/目录/网络 host",
    "状态与权限预算未确认或解释：后台状态/timer/daemon/常驻开销",
    "状态与权限预算未确认或解释：数据库/导出/迁移兼容性",
    "没有匹配到高风险不变量时，必须确认本变更未产生新的长期边界",
    "必须勾选 npm run verify",
  ]);
});

test("an unchecked state budget is accepted only with text after its colon", () => {
  const errors = validatePullRequestEvidence({
    title: "feat: add an opt-in setting",
    body: completeBody({
      settings:
        "- [ ] 不新增设置项；如新增，说明为什么合理默认值不能解决：用户需要在两个互斥仓库间明确选择。",
      permissions:
        "- [ ] 不新增/扩大 Tauri command、capability、entitlement、目录或网络 host；如有变化：新增只读 example.com，并已更新权限预算。",
      background:
        "- [ ] 不新增后台状态、timer、daemon 或常驻开销；如有变化：新增前台 timer，离开页面即销毁。",
      compatibility:
        "- [ ] 数据库/导出/迁移兼容性已说明并测试：新增字段保持旧数据库可读。",
      invariants: "- 已复审资产/高风险不变量 ID：",
      noBoundary: "- [x] 本变更未产生新的长期边界，因此无需更新 Rule/ADR。",
    }),
    requiredInvariantIds: [],
  });

  assert.deepEqual(errors, []);
});

test("every PR selects exactly one explicit change kind", () => {
  for (const changeKind of [
    "- [ ] Bug 修复\n- [ ] 非 Bug 变更",
    "- [x] Bug 修复\n- [x] 非 Bug 变更",
    "- [x] 其他",
  ]) {
    const errors = validatePullRequestEvidence({
      title: "refactor: make ownership explicit",
      body: completeBody({ changeKind }),
      requiredInvariantIds: ["TASK-GEN-001"],
    });
    assert.ok(
      errors.includes("必须且只能选择一种变更类型：Bug 修复或非 Bug 变更"),
    );
  }
});

test("a fix title cannot be classified as non-Bug", () => {
  assert.deepEqual(
    validatePullRequestEvidence({
      title: "fix: stale task result",
      body: completeBody(),
      requiredInvariantIds: ["TASK-GEN-001"],
    }),
    ["标题表明是 Bug 修复，变更类型不能选择非 Bug 变更"],
  );
});

test("every invariant selected from the changed paths must be named in the invariant section", () => {
  const errors = validatePullRequestEvidence({
    title: "refactor: coordinator",
    body: completeBody({
      invariants: "- 已复审资产/高风险不变量 ID：TASK-GEN-001",
      noBoundary: "- [x] 本变更未产生新的长期边界，因此无需更新 Rule/ADR。",
    }),
    requiredInvariantIds: ["TASK-GEN-001", "PATH-PERM-001"],
  });

  assert.deepEqual(errors, ["缺少必须复审的高风险不变量 ID：PATH-PERM-001"]);
});

test("every owning Rule and ADR asset selected from changed paths must be named by stable ID", () => {
  const errors = validatePullRequestEvidence({
    title: "refactor: coordinator",
    body: completeBody({
      rules: "- 已阅读/更新的 owning Rule/ADR asset ID：rule-tasks",
    }),
    requiredAssetIds: ["rule-tasks", "adr-foreground-scheduling"],
    requiredInvariantIds: ["TASK-GEN-001", "PATH-PERM-001"],
  });

  assert.deepEqual(errors, [
    "缺少必须复审的 owning Rule/ADR asset ID：adr-foreground-scheduling",
  ]);
});

test("independent lane evidence is mutually exclusive and sensitive material confirmation is required", () => {
  const missing = validatePullRequestEvidence({
    title: "docs: clarify evidence",
    body: completeBody({
      laneNotApplicable: "- [ ] 独立 lane 不适用，原因：",
      sensitive:
        "- [ ] 没有秘密、真实用户数据、`AGENTS.md`、`docs/internal/` 或宣传草稿进入 diff。",
    }),
    requiredInvariantIds: ["TASK-GEN-001", "PATH-PERM-001"],
  });
  assert.deepEqual(missing, [
    "独立 lane 必须且只能选择：已运行并填写结果/链接，或不适用并填写原因",
    "必须确认 diff 不包含秘密、真实用户数据或本机/内部资料",
  ]);

  const both = validatePullRequestEvidence({
    title: "test: run dedicated lanes",
    body: completeBody({
      laneRan:
        "- [x] 与本变更相关的独立 lane（coverage/E2E/MSRV/性能/Release）已运行，结果/链接：https://github.com/example/repo/actions/runs/1",
    }),
    requiredInvariantIds: ["TASK-GEN-001", "PATH-PERM-001"],
  });
  assert.deepEqual(both, [
    "独立 lane 必须且只能选择：已运行并填写结果/链接，或不适用并填写原因",
  ]);
});

test("skip or flaky debt accepts only one active tracked waiver ID", () => {
  const legacyFreeText = validatePullRequestEvidence({
    title: "test: quarantine unstable browser case",
    body: completeBody({
      noDebt: "- [ ] 没有引用独立 lane test waiver。",
      debt:
        "- 如确需临时隔离到独立 lane（主测试内仍不得 skip），填写 active ledger ID：issue #42，owner @alice，删除日期 2026-09-30。",
    }),
    requiredInvariantIds: ["TASK-GEN-001"],
  });
  assert.deepEqual(legacyFreeText, [
    "skip/flaky 债务必须且只能填写一个 active WAIVER ID",
  ]);

  const complete = validatePullRequestEvidence({
    title: "test: quarantine unstable browser case",
    body: completeBody({
      noDebt: "- [ ] 没有引用独立 lane test waiver。",
      debt: "- 如确需临时隔离到独立 lane（主测试内仍不得 skip），填写 active ledger ID：WAIVER-2026-001",
    }),
    requiredInvariantIds: ["TASK-GEN-001"],
    activeWaiverIds: ["WAIVER-2026-001"],
  });
  assert.deepEqual(complete, []);
});

test("unknown or contradictory waiver declarations fail closed", () => {
  const body = completeBody({
    noDebt: "- [ ] 没有引用独立 lane test waiver。",
    debt: "- 如确需临时隔离到独立 lane（主测试内仍不得 skip），填写 active ledger ID：WAIVER-2026-099",
  });
  assert.deepEqual(
    validatePullRequestEvidence({
      title: "test: quarantine browser case",
      body,
      requiredInvariantIds: ["TASK-GEN-001"],
      activeWaiverIds: ["WAIVER-2026-001"],
    }),
    ["test waiver WAIVER-2026-099 不在 tracked ledger 的 active 清单中"],
  );

  assert.deepEqual(
    validatePullRequestEvidence({
      title: "test: contradictory waiver declaration",
      body: completeBody({
        debt:
          "- 如确需临时隔离到独立 lane（主测试内仍不得 skip），填写 active ledger ID：WAIVER-2026-001",
      }),
      requiredInvariantIds: ["TASK-GEN-001"],
      activeWaiverIds: ["WAIVER-2026-001"],
    }),
    ["test waiver 声明必须且只能选择：无 waiver，或填写一个 active WAIVER ID"],
  );
});

test("Bug classification requires regression, root cause, scan paths, and conclusion", () => {
  const errors = validatePullRequestEvidence({
    title: "correct stale task result",
    body: completeBody({
      changeKind: "- [x] Bug 修复\n- [ ] 非 Bug 变更",
      regression: "- [ ] 新增了能让旧实现失败的回归测试，位置/测试名：",
      automationReason: "- 若不能先写自动化失败测试，原因与替代证据：",
      rootCause: "- 根因（不要只复述症状）：",
      scanPaths: "- 已扫描的同类入口、adapter、竞态或数据路径：",
      scanConclusion: "- 扫描结论/一并修复项：",
    }),
    requiredInvariantIds: ["TASK-GEN-001"],
  });

  assert.deepEqual(errors, [
    "Bug 修复必须勾选回归测试，或填写不能自动化的原因与替代证据",
    "Bug 修复必须填写根因",
    "Bug 修复必须填写同类扫描路径",
    "Bug 修复必须填写同类扫描结论",
  ]);
});

test("a checked Bug regression still needs a concrete test location or test name", () => {
  const errors = validatePullRequestEvidence({
    title: "fix: prevent a late task result from winning",
    body: completeBody({
      changeKind: "- [x] Bug 修复\n- [ ] 非 Bug 变更",
      regression: "- [x] 新增了能让旧实现失败的回归测试，位置/测试名：",
      automationReason: "- 若不能先写自动化失败测试，原因与替代证据：",
    }),
    requiredInvariantIds: ["TASK-GEN-001"],
  });

  assert.ok(
    errors.includes("Bug 修复必须勾选回归测试，或填写不能自动化的原因与替代证据"),
  );
});

test("Bug and Chinese fix titles accept a documented automation exception", () => {
  for (const title of ["Bug: Keychain prompt is hidden", "修复备份目录无法打开"]) {
    assert.deepEqual(
      validatePullRequestEvidence({
        title,
        body: completeBody({
          changeKind: "- [x] Bug 修复\n- [ ] 非 Bug 变更",
          regression: "- [ ] 新增了能让旧实现失败的回归测试，位置/测试名：",
          automationReason:
            "- 若不能先写自动化失败测试，原因与替代证据：系统 Keychain 授权框只能人工验收，附录屏记录。",
        }),
        requiredInvariantIds: ["PATH-PERM-001"],
      }),
      [],
    );
  }
});

test("missing or malformed input fails closed without throwing", () => {
  const errors = validatePullRequestEvidence({
    title: undefined,
    body: undefined,
    requiredInvariantIds: undefined,
  });
  assert.ok(errors.includes("PR 标题缺失"));
  assert.ok(errors.includes("PR 正文缺失"));
  assert.ok(errors.includes("必须且只能选择一种变更类型：Bug 修复或非 Bug 变更"));
  assert.ok(errors.includes("变更目的必须填写用户问题/产品价值"));
});

test("the CLI invariant environment contract accepts commas, spaces, and newlines", () => {
  assert.deepEqual(
    parseRequiredInvariantIds("TASK-GEN-001, PATH-PERM-001\nVERIFY-PLAN-001 TASK-GEN-001"),
    ["TASK-GEN-001", "PATH-PERM-001", "VERIFY-PLAN-001"],
  );
  assert.deepEqual(parseRequiredInvariantIds(""), []);
});

test("changed paths select only active or retiring protected invariants", () => {
  const catalog = {
    assets: [],
    invariants: [
      { id: "TASK-GEN-001", status: "active", protectedPaths: ["src/tasks/"] },
      { id: "PATH-PERM-001", status: "retiring", protectedPaths: ["src/open.ts"] },
      { id: "OLD-001", status: "retired", protectedPaths: ["src/tasks/"] },
      { id: "OTHER-001", status: "active", protectedPaths: ["src/settings.ts"] },
    ],
  };

  assert.deepEqual(
    selectRequiredInvariantIds({
      catalog,
      paths: ["src/tasks/coordinator.ts", "src/open.ts"],
    }),
    ["PATH-PERM-001", "TASK-GEN-001"],
  );
});

test("required governance IDs include module owning Rule and ADR assets", () => {
  const catalog = {
    assets: [
      { id: "global", path: "CONTEXT.md", status: "active", alwaysLoad: true, kind: "glossary" },
      { id: "rule-tasks", path: "docs/rules/tasks.md", status: "active", kind: "rule" },
      {
        id: "adr-foreground-scheduling",
        path: "docs/adr/0004-foreground-scheduling.md",
        status: "active",
        kind: "decision",
      },
    ],
    invariants: [
      { id: "TASK-GEN-001", status: "active", protectedPaths: ["src/taskCoordinator.ts"] },
    ],
  };
  const moduleMap = {
    modules: [
      {
        id: "frontend-tasks",
        ownerRule: "docs/rules/tasks.md",
        decisions: ["docs/adr/0004-foreground-scheduling.md"],
        paths: ["src/taskCoordinator.ts"],
      },
    ],
  };

  assert.deepEqual(
    selectRequiredGovernanceIds({ catalog, moduleMap, paths: ["src/taskCoordinator.ts"] }),
    {
      assets: ["adr-foreground-scheduling", "rule-tasks"],
      invariants: ["TASK-GEN-001"],
    },
  );
});

test("the CLI accepts required invariant IDs only through an injected test seam", () => {
  const successOutput = [];
  assert.equal(
    runCli({
      env: {
        PR_TITLE: "refactor: keep task ownership explicit",
        PR_BODY: completeBody(),
      },
      requiredInvariantIds: "TASK-GEN-001,PATH-PERM-001",
      stdout: (line) => successOutput.push(line),
      stderr: (line) => successOutput.push(line),
    }),
    0,
  );
  assert.deepEqual(successOutput, ["PASS pull request evidence completeness"]);

  const failureOutput = [];
  assert.equal(
    runCli({
      env: { PR_TITLE: "docs: incomplete", PR_BODY: "" },
      requiredInvariantIds: [],
      stdout: (line) => failureOutput.push(line),
      stderr: (line) => failureOutput.push(line),
    }),
    1,
  );
  assert.equal(failureOutput[0], "PR evidence validation failed:");
  assert.ok(failureOutput.includes("- PR 正文缺失"));
});

test("the CLI derives required invariants from VERIFY_BASE_REF when no explicit list exists", () => {
  const calls = [];
  const output = [];
  assert.equal(
    runCli({
      env: {
        PR_TITLE: "refactor: keep task ownership explicit",
        PR_BODY: completeBody(),
        VERIFY_BASE_REF: "origin/main",
      },
      deriveInvariantIds: ({ baseRef }) => {
        calls.push(baseRef);
        return ["TASK-GEN-001", "PATH-PERM-001"];
      },
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
    }),
    0,
  );
  assert.deepEqual(calls, ["origin/main"]);
  assert.deepEqual(output, ["PASS pull request evidence completeness"]);
});

test("the CLI derives and enforces owning Rule and ADR asset IDs", () => {
  const output = [];
  assert.equal(
    runCli({
      env: {
        PR_TITLE: "refactor: keep task ownership explicit",
        PR_BODY: completeBody({
          rules: "- 已阅读/更新的 owning Rule/ADR asset ID：rule-tasks",
        }),
        VERIFY_BASE_REF: "origin/main",
      },
      deriveRequirements: ({ baseRef }) => {
        assert.equal(baseRef, "origin/main");
        return {
          assets: ["rule-tasks", "adr-foreground-scheduling"],
          invariants: ["TASK-GEN-001", "PATH-PERM-001"],
        };
      },
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
    }),
    1,
  );
  assert.deepEqual(output, [
    "PR evidence validation failed:",
    "- 缺少必须复审的 owning Rule/ADR asset ID：adr-foreground-scheduling",
  ]);
});

test("automatic invariant discovery fails closed without a base or after a selector error", () => {
  for (const scenario of [
    {
      env: { PR_TITLE: "docs: update", PR_BODY: completeBody() },
      expected: "VERIFY_BASE_REF is required for governance evidence discovery",
    },
    {
      env: {
        PR_TITLE: "docs: update",
        PR_BODY: completeBody(),
        VERIFY_BASE_REF: "origin/main",
      },
      deriveInvariantIds: () => {
        throw new Error("cannot diff origin/main...HEAD");
      },
      expected: "cannot diff origin/main...HEAD",
    },
  ]) {
    const output = [];
    assert.equal(
      runCli({
        ...scenario,
        stdout: (line) => output.push(line),
        stderr: (line) => output.push(line),
      }),
      1,
    );
    assert.deepEqual(output, [
      "PR evidence governance discovery failed:",
      `- ${scenario.expected}`,
    ]);
  }
});

test("an injected invariant list bypasses automatic discovery for unit tests", () => {
  let derived = false;
  assert.equal(
    runCli({
      env: {
        PR_TITLE: "docs: no long-term boundary",
        PR_BODY: completeBody({
          invariants: "- 已复审资产/高风险不变量 ID：",
          noBoundary: "- [x] 本变更未产生新的长期边界，因此无需更新 Rule/ADR。",
        }),
      },
      requiredInvariantIds: [],
      deriveInvariantIds: () => {
        derived = true;
        return ["SHOULD-NOT-RUN"];
      },
      stdout: () => {},
      stderr: () => {},
    }),
    0,
  );
  assert.equal(derived, false);
});

test("an empty invariant environment cannot disable production discovery", () => {
  const output = [];
  assert.equal(
    runCli({
      env: {
        PR_TITLE: "docs: update",
        PR_BODY: completeBody(),
        REQUIRED_INVARIANT_IDS: "",
      },
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
    }),
    1,
  );
  assert.deepEqual(output, [
    "PR evidence governance discovery failed:",
    "- VERIFY_BASE_REF is required for governance evidence discovery",
  ]);
});

test("the CLI accepts a waiver only through the tracked active-ID seam", () => {
  const output = [];
  assert.equal(
    runCli({
      env: {
        PR_TITLE: "test: quarantine browser case",
        PR_BODY: completeBody({
          noDebt: "- [ ] 没有引用独立 lane test waiver。",
          debt:
            "- 如确需临时隔离到独立 lane（主测试内仍不得 skip），填写 active ledger ID：WAIVER-2026-001",
        }),
      },
      requiredInvariantIds: ["TASK-GEN-001"],
      activeWaiverIds: ["WAIVER-2026-001"],
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
    }),
    0,
  );
  assert.deepEqual(output, ["PASS pull request evidence completeness"]);
});
