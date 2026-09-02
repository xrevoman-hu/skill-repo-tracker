import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

export const VERIFY_PLAN_PATH = "docs/engineering/verify-plan.json";

const DOCUMENT_FIELDS = ["schemaVersion", "steps"];
const STEP_FIELDS = ["args", "capabilities", "command", "id", "label", "retirement", "status"];
const EXECUTION_FIELDS = ["args", "command", "id", "label"];
const RETIREMENT_FIELDS = ["reason", "replacement"];
const STEP_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const STATUSES = new Set(["active", "retiring", "retired"]);
const CONSTITUTION_CAPABILITY_CONTRACTS = new Map([
  ["governance-script-regressions", { command: "npm", args: ["run", "test:scripts"] }],
  ["repository-governance", { command: "node", args: ["scripts/governance.mjs", "all"] }],
  ["typescript-type-safety", { command: "npm", args: ["run", "typecheck"] }],
  ["typescript-strict-safety", { command: "npm", args: ["run", "typecheck:strict-islands"] }],
  ["frontend-unit-regressions", { command: "npm", args: ["test"] }],
  ["frontend-production-build", { command: "npm", args: ["run", "build"] }],
  ["frontend-bundle-budget", { command: "node", args: ["scripts/governance.mjs", "bundle"] }],
  ["rust-format", { command: "cargo", args: ["fmt", "--check", "--manifest-path", "src-tauri/Cargo.toml"] }],
  [
    "rust-lint",
    {
      command: "cargo",
      args: [
        "clippy",
        "--locked",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--all-targets",
        "--all-features",
        "--",
        "-D",
        "warnings",
      ],
    },
  ],
  [
    "rust-regressions",
    {
      command: "cargo",
      args: [
        "test",
        "--locked",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--all-features",
      ],
    },
  ],
  ["whitespace-integrity", { command: "node", args: ["scripts/check-diff.mjs"] }],
]);

function unsupportedFields(value, supported) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const allowed = new Set(supported);
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort();
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function missingCapabilities(source, replacement) {
  const replacementCapabilities = new Set(replacement?.capabilities ?? []);
  return (source?.capabilities ?? []).filter(
    (capability) => !replacementCapabilities.has(capability),
  );
}

function resolveActiveReplacement(step, stepsById) {
  const visited = new Set([step.id]);
  let current = step;
  while (current.status !== "active") {
    const replacementId = current.retirement?.replacement;
    if (!isNonEmptyString(replacementId)) return { error: "is missing" };
    if (visited.has(replacementId)) return { error: "contains a cycle" };
    visited.add(replacementId);
    current = stepsById.get(replacementId);
    if (!current) return { error: `references missing step ${replacementId}` };
  }
  return { replacement: current };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function validateRetirement(step, errors) {
  if (step.status === "active") {
    if (Object.hasOwn(step, "retirement")) {
      errors.push(`verify plan active step ${step.id} cannot declare retirement`);
    }
    return;
  }

  const retirement = step.retirement;
  if (
    retirement === null ||
    typeof retirement !== "object" ||
    Array.isArray(retirement)
  ) {
    errors.push(`verify plan ${step.status} step ${step.id} must declare retirement`);
    return;
  }
  const unsupported = unsupportedFields(retirement, RETIREMENT_FIELDS);
  if (unsupported.length > 0) {
    errors.push(
      `verify plan step ${step.id} retirement contains unsupported fields: ${unsupported.join(", ")}`,
    );
  }
  if (!isNonEmptyString(retirement.reason)) {
    errors.push(`verify plan step ${step.id} retirement must explain its reason`);
  }
  if (!isNonEmptyString(retirement.replacement)) {
    errors.push(`verify plan step ${step.id} retirement must name a replacement`);
  } else if (retirement.replacement === step.id) {
    errors.push(`verify plan step ${step.id} cannot replace itself`);
  }
}

export function validateVerifyPlanDocument(document) {
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document)
  ) {
    return ["verify plan document must be an object"];
  }

  const errors = [];
  const unsupported = unsupportedFields(document, DOCUMENT_FIELDS);
  if (unsupported.length > 0) {
    errors.push(
      `verify plan document contains unsupported fields: ${unsupported.join(", ")}`,
    );
  }
  if (document.schemaVersion !== 1) {
    errors.push("verify plan document schemaVersion must be 1");
  }
  if (!Array.isArray(document.steps) || document.steps.length === 0) {
    errors.push("verify plan document steps must be a non-empty array");
    return errors;
  }

  const ids = new Set();
  for (const [index, step] of document.steps.entries()) {
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      errors.push(`verify plan step at index ${index} must be an object`);
      continue;
    }

    const stepName = isNonEmptyString(step.id) ? step.id : `at index ${index}`;
    const unsupportedStepFields = unsupportedFields(step, STEP_FIELDS);
    if (unsupportedStepFields.length > 0) {
      errors.push(
        `verify plan step ${stepName} contains unsupported fields: ${unsupportedStepFields.join(", ")}`,
      );
    }
    if (!isNonEmptyString(step.id) || !STEP_ID.test(step.id)) {
      errors.push(`verify plan step ${stepName} has an invalid id`);
    } else if (ids.has(step.id)) {
      errors.push(`verify plan step id ${step.id} is duplicated`);
    } else {
      ids.add(step.id);
    }
    if (!isNonEmptyString(step.label)) {
      errors.push(`verify plan step ${stepName} must have a label`);
    }
    if (!isNonEmptyString(step.command)) {
      errors.push(`verify plan step ${stepName} must have a command`);
    }
    if (!Array.isArray(step.args) || step.args.some((arg) => typeof arg !== "string")) {
      errors.push(`verify plan step ${stepName} args must be an array of strings`);
    }
    if (
      !Array.isArray(step.capabilities) ||
      step.capabilities.length === 0 ||
      step.capabilities.some((capability) => !isNonEmptyString(capability)) ||
      new Set(step.capabilities).size !== step.capabilities.length
    ) {
      errors.push(`verify plan step ${stepName} capabilities must be unique non-empty strings`);
    } else {
      for (const capability of step.capabilities) {
        const contract = CONSTITUTION_CAPABILITY_CONTRACTS.get(capability);
        if (
          contract &&
          (step.command !== contract.command || !isDeepStrictEqual(step.args, contract.args))
        ) {
          errors.push(
            `verify plan constitution capability ${capability} requires its exact audited command and arguments`,
          );
        }
      }
    }
    if (!STATUSES.has(step.status)) {
      errors.push(`verify plan step ${stepName} has invalid status ${String(step.status)}`);
    } else {
      validateRetirement(step, errors);
    }
  }

  const stepsById = new Map(
    document.steps
      .filter((step) => step && isNonEmptyString(step.id))
      .map((step) => [step.id, step]),
  );
  for (const step of document.steps.filter((candidate) => candidate?.status !== "active")) {
    const resolved = resolveActiveReplacement(step, stepsById);
    if (resolved.error) {
      errors.push(`verify plan step ${step.id} replacement chain ${resolved.error}`);
      continue;
    }
    const missing = missingCapabilities(step, resolved.replacement);
    if (missing.length > 0) {
      errors.push(
        `verify plan step ${step.id} replacement ${resolved.replacement.id} does not cover capabilities: ${missing.join(", ")}`,
      );
    }
  }

  return errors;
}

function executionPlanFor(document) {
  return document.steps
    .filter((step) => step.status !== "retired")
    .map(({ id, label, command, args }) => ({ id, label, command, args }));
}

const loadedDocument = JSON.parse(
  readFileSync(new URL(`../${VERIFY_PLAN_PATH}`, import.meta.url), "utf8"),
);
const documentErrors = validateVerifyPlanDocument(loadedDocument);
if (documentErrors.length > 0) {
  throw new Error(`Invalid tracked verify plan:\n${documentErrors.join("\n")}`);
}

export const VERIFY_PLAN_DOCUMENT = deepFreeze(structuredClone(loadedDocument));
export const VERIFY_PLAN = deepFreeze(executionPlanFor(VERIFY_PLAN_DOCUMENT));

export function validateVerifyPlan(plan) {
  const expectedPlan = executionPlanFor(VERIFY_PLAN_DOCUMENT);
  const expectedIds = expectedPlan.map((step) => step.id);
  const actualIds = Array.isArray(plan) ? plan.map((step) => step?.id) : [];
  if (!isDeepStrictEqual(actualIds, expectedIds)) {
    return [`verify plan step order changed; expected ${expectedIds.join(", ")}`];
  }

  const errors = [];
  for (const [index, expected] of expectedPlan.entries()) {
    const actual = plan[index];
    const unsupported = unsupportedFields(actual, EXECUTION_FIELDS);
    if (unsupported.length > 0) {
      errors.push(
        `verify plan step ${expected.id} contains unsupported fields: ${unsupported.join(", ")}`,
      );
      continue;
    }
    if (!isNonEmptyString(actual.label)) {
      errors.push(`verify plan step ${expected.id} must have a label`);
    }
    if (
      actual.command !== expected.command ||
      !isDeepStrictEqual(actual.args, expected.args)
    ) {
      errors.push(`verify plan step ${expected.id} command or arguments changed`);
    }
  }
  return errors;
}

export function compareVerifyPlans(current, base) {
  const currentErrors = validateVerifyPlanDocument(current);
  if (currentErrors.length > 0) {
    return currentErrors;
  }
  const baseErrors = validateVerifyPlanDocument(base);
  if (baseErrors.length > 0) {
    return baseErrors.map((error) => `base ${error}`);
  }

  const errors = [];
  const currentById = new Map(current.steps.map((step) => [step.id, step]));
  const baseById = new Map(base.steps.map((step) => [step.id, step]));
  const missingIds = [];

  for (const baseStep of base.steps) {
    const currentStep = currentById.get(baseStep.id);
    if (!currentStep) {
      errors.push(`verify plan base step ${baseStep.id} was deleted`);
      missingIds.push(baseStep.id);
      continue;
    }
    if (
      currentStep.command !== baseStep.command ||
      !isDeepStrictEqual(currentStep.args, baseStep.args)
    ) {
      errors.push(
        `verify plan base step ${baseStep.id} command or arguments changed`,
      );
    }
    if (!isDeepStrictEqual(currentStep.capabilities, baseStep.capabilities)) {
      errors.push(`verify plan base step ${baseStep.id} capabilities changed`);
    }
    if (
      baseStep.status !== "active" &&
      !isDeepStrictEqual(currentStep.retirement, baseStep.retirement)
    ) {
      errors.push(
        `verify plan base step ${baseStep.id} retirement metadata changed`,
      );
    }

    if (baseStep.status === "active" && currentStep.status === "retired") {
      errors.push(
        `verify plan base step ${baseStep.id} must enter retiring before retired`,
      );
    } else if (
      baseStep.status === "retiring" &&
      !["retiring", "retired"].includes(currentStep.status)
    ) {
      errors.push(
        `verify plan base step ${baseStep.id} cannot return from retiring to ${currentStep.status}`,
      );
    } else if (
      baseStep.status === "retired" &&
      currentStep.status !== "retired"
    ) {
      errors.push(
        `verify plan base step ${baseStep.id} cannot return from retired to ${currentStep.status}`,
      );
    }
  }

  if (missingIds.length === 0) {
    const baseIds = base.steps
      .filter((step) => currentById.has(step.id))
      .map((step) => step.id);
    const retainedCurrentIds = current.steps
      .filter((step) => baseById.has(step.id))
      .map((step) => step.id);
    if (!isDeepStrictEqual(retainedCurrentIds, baseIds)) {
      errors.push(
        `verify plan base step order changed; expected ${baseIds.join(", ")}`,
      );
    }
  }

  for (const currentStep of current.steps) {
    if (!baseById.has(currentStep.id) && currentStep.status !== "active") {
      errors.push(
        `verify plan new step ${currentStep.id} must start with active status`,
      );
    }
  }

  return errors;
}
