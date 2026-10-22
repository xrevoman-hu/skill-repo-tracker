import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  compareGovernanceAssetCatalogs,
  validateGovernanceAssetCatalog,
} from "./governance-assets.mjs";
import {
  VERIFY_PLAN,
  VERIFY_PLAN_DOCUMENT,
  VERIFY_PLAN_PATH,
  compareVerifyPlans,
  validateVerifyPlan,
  validateVerifyPlanDocument,
} from "./verify-plan.mjs";
import { checkRepositorySurfaceBudget } from "./surface-budget.mjs";
import { checkRepositoryModuleMap, MODULE_MAP_PATH } from "./module-map.mjs";
import { gitPathExistsAtRef, listRepositoryFiles } from "./git-paths.mjs";
import { checkRepositoryDependencyRisks } from "./dependency-risk.mjs";
import { validatePolicyRemovalPlan } from "./governance-policy-removal.mjs";
import { checkSurfaceBudgetHistory } from "./surface-budget-history.mjs";

export const GOVERNANCE_ASSET_PATH = "docs/engineering/governance-assets.json";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function repositoryFiles(root) {
  return listRepositoryFiles(root);
}

function trackedJsonAtBase(root, baseRef, path) {
  const tracked = gitPathExistsAtRef(root, baseRef, path);
  if (!tracked) return undefined;
  const contents = execFileSync("git", ["show", `${baseRef}:${path}`], {
    cwd: root,
    encoding: "utf8",
  });
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`tracked ${baseRef}:${path} is invalid JSON`, { cause: error });
  }
}

export function checkGovernanceAssets(
  root,
  { baseRef = process.env.VERIFY_BASE_REF } = {},
) {
  const trackedFiles = repositoryFiles(root);
  const catalog = readJson(join(root, GOVERNANCE_ASSET_PATH));
  const packageJson = readJson(join(root, "package.json"));
  const errors = validateGovernanceAssetCatalog({
    catalog,
    trackedFiles,
    packageScripts: packageJson.scripts,
    readFile: (path) => {
      const absolute = join(root, path);
      return existsSync(absolute) ? readFileSync(absolute) : undefined;
    },
    commitExists: (commit) => {
      try {
        execFileSync("git", ["rev-parse", "--verify", `${commit}^{commit}`], {
          cwd: root,
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    },
  });
  const policyErrors = validatePolicyRemovalPlan(catalog, {
    readFile: (path) => existsSync(join(root, path)) ? readFileSync(join(root, path)) : undefined,
    readBootstrapCatalog: (commit) => trackedJsonAtBase(root, commit, GOVERNANCE_ASSET_PATH),
    isBootstrapAncestor: (commit) => {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: root, stdio: "ignore" });
        return true;
      } catch { return false; }
    },
  });
  errors.push(...policyErrors);
  errors.push(...checkRepositoryDependencyRisks(root, { baseRef }));
  errors.push(
    ...validateVerifyPlanDocument(VERIFY_PLAN_DOCUMENT),
    ...validateVerifyPlan(VERIFY_PLAN),
  );

  if (!baseRef) {
    errors.push(...checkRepositoryModuleMap(root));
    errors.push(...checkRepositorySurfaceBudget(root));
    return errors;
  }
  execFileSync("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], {
    cwd: root,
    stdio: "ignore",
  });
  const baseCatalog = trackedJsonAtBase(root, baseRef, GOVERNANCE_ASSET_PATH);
  if (baseCatalog) {
    errors.push(...compareGovernanceAssetCatalogs(catalog, baseCatalog, { trackedPaths: trackedFiles }));
  }
  const baseVerifyPlan = trackedJsonAtBase(root, baseRef, VERIFY_PLAN_PATH);
  if (baseVerifyPlan) {
    errors.push(...compareVerifyPlans(VERIFY_PLAN_DOCUMENT, baseVerifyPlan));
  }
  errors.push(
    ...checkRepositoryModuleMap(root, {
      baseMap: trackedJsonAtBase(root, baseRef, MODULE_MAP_PATH),
    }),
  );
  errors.push(
    ...checkRepositorySurfaceBudget(root),
    ...checkSurfaceBudgetHistory(root, { baseRef }),
  );
  return errors;
}
