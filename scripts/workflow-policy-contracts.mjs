import { isDeepStrictEqual } from "node:util";

import { parse as parseYaml } from "yaml";

export const TRACKED_DEPENDENCY_OVERRIDE_STEP = {
  name: "Reject tracked dependency and Cargo overrides",
  run: `set -euo pipefail
while IFS= read -r -d '' path; do
  case "$path" in
    .npmrc|rust-toolchain|npm-shrinkwrap.json|*/npm-shrinkwrap.json|.cargo|.cargo/*|*/.cargo|*/.cargo/*)
      echo "forbidden tracked dependency/toolchain override: $path" >&2
      exit 1
      ;;
  esac
done < <(git ls-files -z)
`,
};

const EXPECTED_SECURITY_AUDIT_WORKFLOW = {
  name: "Security audit",
  on: {
    workflow_dispatch: null,
    schedule: [{ cron: "17 2 * * 1" }],
  },
  permissions: { contents: "read" },
  concurrency: { group: "security-audit", "cancel-in-progress": true },
  jobs: {
    audit: {
      "runs-on": "macos-15",
      "timeout-minutes": 40,
      steps: [
        {
          name: "Checkout",
          uses: "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
          with: { "persist-credentials": false },
        },
        TRACKED_DEPENDENCY_OVERRIDE_STEP,
        {
          name: "Set up Node.js",
          uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
          with: { "node-version-file": ".node-version", cache: "npm" },
        },
        {
          name: "Audit npm lock through the official registry",
          run: "npm audit --audit-level=high --registry=https://registry.npmjs.org",
        },
        {
          name: "Set up pinned Rust",
          run: "rustup toolchain install 1.95.0 --profile minimal\nrustup default 1.95.0\n",
        },
        {
          name: "Install pinned cargo-audit",
          run: "cargo install cargo-audit --locked --version 0.22.2",
        },
        { name: "Audit Cargo.lock", run: "cargo audit --file src-tauri/Cargo.lock" },
      ],
    },
  },
};

const EXPECTED_WEEKLY_RESILIENCE_WORKFLOW = {
  name: "Weekly resilience",
  on: {
    workflow_dispatch: null,
    schedule: [{ cron: "43 3 * * 0" }],
  },
  permissions: { contents: "read" },
  concurrency: { group: "weekly-resilience", "cancel-in-progress": true },
  jobs: {
    "repeat-and-performance": {
      "runs-on": "macos-15",
      "timeout-minutes": 90,
      steps: [
        {
          name: "Checkout",
          uses: "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
          with: { "persist-credentials": false },
        },
        TRACKED_DEPENDENCY_OVERRIDE_STEP,
        {
          name: "Set up Node.js",
          uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
          with: { "node-version-file": ".node-version", cache: "npm" },
        },
        {
          name: "Set up pinned Rust",
          run: "rustup toolchain install 1.95.0 --profile minimal\nrustup default 1.95.0\n",
        },
        {
          name: "Install npm dependencies",
          run: "npm ci --ignore-scripts --registry=https://registry.npmjs.org",
        },
        {
          name: "Check tracked test waiver freshness",
          run: "node scripts/test-waivers.mjs",
        },
        {
          name: "Repeat race and filesystem suites",
          run: 'for attempt in 1 2 3; do\n  echo "repeat attempt ${attempt}/3"\n  npm test\n  cargo test --locked --all-features --manifest-path src-tauri/Cargo.toml\ndone\n',
        },
        {
          name: "Run the 10,000 prompts / 100 MiB release performance gate",
          run: "cargo test --release --locked --manifest-path src-tauri/Cargo.toml prompt_library_release_performance_gate -- --ignored --nocapture --test-threads=1",
        },
      ],
    },
  },
};

function validateExactWorkflowPolicy(contents, label, expectedWorkflow) {
  let workflow;
  try {
    workflow = parseYaml(contents, { maxAliasCount: 100, uniqueKeys: true });
  } catch (error) {
    return [
      `${label} workflow is invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  return isDeepStrictEqual(workflow, expectedWorkflow)
    ? []
    : [`${label} workflow must match the complete fail-closed template`];
}

export function validateSecurityAuditWorkflowPolicy(contents) {
  return validateExactWorkflowPolicy(contents, "security audit", EXPECTED_SECURITY_AUDIT_WORKFLOW);
}

export function validateWeeklyResilienceWorkflowPolicy(contents) {
  return validateExactWorkflowPolicy(
    contents,
    "weekly resilience",
    EXPECTED_WEEKLY_RESILIENCE_WORKFLOW,
  );
}

export function validateReleaseWorkflowPolicy(contents) {
  const exactVerifierCommand = `set -euo pipefail
manifest_file="$RUNNER_TEMP/srt-release-manifest.token"
trap 'rm -f "$manifest_file"' EXIT
manifest_token="$(
  node -e '
    const { readFileSync } = require("node:fs");
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const token = event.inputs?.releaseManifest;
    if (token != null && typeof token !== "string") process.exit(2);
    process.stdout.write(token ?? "");
  '
)"
if [[ "$RELEASE_PHASE" == "local" ]]; then
  if [[ -n "$manifest_token" ]]; then
    echo "releaseManifest must be empty for local verification" >&2
    exit 1
  fi
elif [[ ! "$manifest_token" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "releaseManifest is required and must be base64url for remote verification" >&2
  exit 1
fi
if [[ -n "$manifest_token" ]]; then
  printf '::add-mask::%s\\n' "$manifest_token"
fi
umask 077
printf '%s\\n' "$manifest_token" > "$manifest_file"
chmod 600 "$manifest_file"
manifest_token="$(<"$manifest_file")"
npm run --silent release:verify -- --lane adhoc --version "$RELEASE_VERSION" --phase "$RELEASE_PHASE" --manifest-token "$manifest_token"
`;
  let workflow;
  try {
    workflow = parseYaml(contents, { maxAliasCount: 100, uniqueKeys: true });
  } catch (error) {
    return [
      `release workflow is invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  const errors = [];
  const expectedWorkflow = {
    name: "Release gate",
    on: {
      workflow_dispatch: {
        inputs: {
          version: {
            description: "Exact stable version (for example 1.2.2)",
            required: true,
            type: "string",
          },
          phase: {
            description: "Verification phase",
            required: true,
            default: "remote",
            type: "choice",
            options: ["local", "remote"],
          },
          releaseManifest: {
            description:
              "Operator-carried artifact field token; required for remote and not proof of local-gate provenance",
            required: false,
            type: "string",
          },
        },
      },
    },
    permissions: { contents: "read" },
    concurrency: {
      group: "release-gate-${{ inputs.version }}-${{ inputs.phase }}",
      "cancel-in-progress": false,
    },
    jobs: {
      "verify-release": {
        "runs-on": "macos-15",
        "timeout-minutes": 120,
        environment: "release",
        env: {
          GH_TOKEN: "${{ github.token }}",
          RELEASE_VERSION: "${{ inputs.version }}",
          RELEASE_PHASE: "${{ inputs.phase }}",
        },
        steps: [
          {
            name: "Checkout full history and tags",
            uses: "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
            with: { "fetch-depth": 0, "persist-credentials": false },
          },
          TRACKED_DEPENDENCY_OVERRIDE_STEP,
          {
            name: "Set up Node.js",
            uses: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
            with: { "node-version-file": ".node-version", cache: "npm" },
          },
          {
            name: "Set up pinned Rust",
            run: "rustup toolchain install 1.95.0 --profile minimal --component clippy,rustfmt\nrustup toolchain install 1.88.0 --profile minimal\nrustup toolchain install nightly-2026-08-01 --profile minimal --component llvm-tools-preview\nrustup default 1.95.0\n",
          },
          {
            name: "Install npm dependencies",
            run: "npm ci --ignore-scripts --registry=https://registry.npmjs.org",
          },
          {
            name: "Install local-phase coverage and browser tools",
            if: "inputs.phase == 'local'",
            run: "cargo install cargo-llvm-cov --locked --version 0.9.0\nnpx playwright install chromium\n",
          },
          {
            name: "Run the explicit release verification lane",
            run: exactVerifierCommand,
          },
        ],
      },
    },
  };
  if (!isDeepStrictEqual(workflow, expectedWorkflow)) {
    errors.push("release workflow must match the complete fail-closed template");
  }
  const triggers = Object.keys(workflow?.on ?? {});
  if (triggers.length !== 1 || triggers[0] !== "workflow_dispatch") {
    errors.push("release workflow must use only workflow_dispatch");
  }
  const permissions = workflow?.permissions;
  if (
    permissions == null ||
    typeof permissions !== "object" ||
    Array.isArray(permissions) ||
    Object.keys(permissions).length !== 1 ||
    permissions.contents !== "read"
  ) {
    errors.push("release workflow permissions must be exactly contents: read");
  }
  const jobs = workflow?.jobs;
  const jobNames = jobs && typeof jobs === "object" && !Array.isArray(jobs) ? Object.keys(jobs) : [];
  if (jobNames.length !== 1 || jobNames[0] !== "verify-release") {
    errors.push("release workflow must contain only the verify-release job");
  }
  const job = jobs?.["verify-release"];
  const runner = job?.["runs-on"];
  if (runner !== "macos-15") {
    errors.push(
      `release workflow verify-release runner is ${runner ?? "missing"}; expected the Apple Silicon macos-15 hosted runner`,
    );
  }
  const environment =
    typeof job?.environment === "string" ? job.environment : job?.environment?.name;
  if (environment !== "release") {
    errors.push("release workflow verify-release job must bind environment: release");
  }
  if (job?.permissions != null) {
    const jobPermissions = job.permissions;
    if (
      typeof jobPermissions !== "object" ||
      Array.isArray(jobPermissions) ||
      Object.keys(jobPermissions).length !== 1 ||
      jobPermissions.contents !== "read"
    ) {
      errors.push("release workflow job permissions may not exceed contents: read");
    }
  }
  const jobCanAlterVerifierFailure =
    Object.hasOwn(job ?? {}, "if") ||
    Object.hasOwn(job ?? {}, "continue-on-error") ||
    Object.hasOwn(job ?? {}, "shell") ||
    job?.defaults?.run?.shell != null ||
    job?.defaults?.run?.["working-directory"] != null;
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const verifierSteps = [];
  for (const step of steps) {
    if (typeof step?.uses === "string") {
      const action = step.uses.trim();
      if (!action.startsWith("actions/checkout@") && !action.startsWith("actions/setup-node@")) {
        errors.push(`release workflow uses an unapproved action: ${action}`);
      }
    }
    if (typeof step?.run === "string") {
      if (/\bnpm\s+run(?:\s+--silent)?\s+release:verify\b/.test(step.run)) {
        verifierSteps.push(step);
      }
      if (
        /\bgit\s+push\b|\bgh\s+release\b|\b(?:npm|cargo)\s+publish\b|\bgh\s+api\b[^\n]*(?:--method|-X)\s+(?:POST|PUT|PATCH|DELETE)\b/i.test(
          step.run,
        )
      ) {
        errors.push("release workflow contains a remote mutation command");
      }
    }
  }
  const verifierStep = verifierSteps[0];
  const verifierStepCanAlterFailure =
    verifierStep != null &&
    ["if", "continue-on-error", "shell", "timeout-minutes", "working-directory", "env"].some(
      (field) => Object.hasOwn(verifierStep, field),
    );
  if (
    verifierSteps.length !== 1 ||
    verifierStep.run.trim() !== exactVerifierCommand.trim() ||
    verifierStepCanAlterFailure ||
    jobCanAlterVerifierFailure
  ) {
    errors.push("release verifier step must be unique, unconditional, fail-closed, and exact");
  }
  return errors;
}
