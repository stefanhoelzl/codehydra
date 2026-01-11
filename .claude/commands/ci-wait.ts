#!/usr/bin/env node
/**
 * Blocking CI runner for /ci command.
 *
 * Pushes the branch, triggers CI workflow, and waits for completion.
 *
 * Usage: npx tsx .claude/commands/ci-wait.ts
 *
 * Exit codes:
 *   0 - SUCCESS: CI passed
 *   1 - FAILED: CI failed (logs printed)
 *   2 - TIMEOUT: Still running after 15 minutes
 *
 * Environment:
 *   Requires `gh` CLI to be authenticated.
 */

import { spawn } from "node:child_process";

const POLL_INTERVAL_MS = 10_000; // 10 seconds
const TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const COMMAND_TIMEOUT_MS = 60_000; // 60 seconds per command
const MAX_RETRIES = 3;
const UPSTREAM_REPO = "stefanhoelzl/codehydra";

interface JobInfo {
  name: string;
  status: string;
  conclusion: string | null;
}

interface RunStatus {
  status: string;
  conclusion: string | null;
  jobs: JobInfo[];
}

function log(message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exec(command: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, [], { stdio: ["pipe", "pipe", "pipe"], shell: true });

    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Command failed: ${command}\n${stderr || stdout}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Command error: ${command}\n${err.message}`));
    });
  });
}

async function execNoThrow(
  command: string,
  timeoutMs = COMMAND_TIMEOUT_MS
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  try {
    const stdout = await exec(command, timeoutMs);
    return { success: true, stdout, stderr: "" };
  } catch (error) {
    const err = error as Error;
    return { success: false, stdout: "", stderr: err.message };
  }
}

function isNetworkError(error: string): boolean {
  return (
    error.includes("TLS handshake timeout") ||
    error.includes("connection reset") ||
    error.includes("ETIMEDOUT") ||
    error.includes("ECONNRESET") ||
    error.includes("network") ||
    error.includes("socket hang up")
  );
}

async function execWithRetry(
  command: string,
  timeoutMs = COMMAND_TIMEOUT_MS
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await execNoThrow(command, timeoutMs);
    if (result.success) {
      return result;
    }
    if (!isNetworkError(result.stderr) || attempt === MAX_RETRIES) {
      return result;
    }
    log(`Network error, retrying (${attempt}/${MAX_RETRIES})...`);
    await sleep(2000);
  }
  return { success: false, stdout: "", stderr: "Max retries exceeded" };
}

async function getCurrentBranch(): Promise<string> {
  return exec("git branch --show-current");
}

async function pushBranch(): Promise<boolean> {
  log("Pushing branch...");
  const result = await execNoThrow("git push --force-with-lease origin HEAD");
  if (!result.success) {
    log(`Push failed: ${result.stderr}`);
    return false;
  }
  log("Branch pushed");
  return true;
}

async function triggerWorkflow(branch: string): Promise<boolean> {
  log(`Triggering CI workflow on branch: ${branch}`);
  const result = await execNoThrow(
    `gh workflow run ci.yaml --repo ${UPSTREAM_REPO} --ref ${branch}`
  );
  if (!result.success) {
    log(`Failed to trigger workflow: ${result.stderr}`);
    return false;
  }
  log("Workflow triggered");
  return true;
}

async function findRunId(branch: string, startTime: number): Promise<number | null> {
  log("Waiting for run to appear...");

  // Poll for up to 30 seconds for the run to appear
  const maxWait = 30_000;
  const pollStart = Date.now();

  while (Date.now() - pollStart < maxWait) {
    const result = await execNoThrow(
      `gh run list --repo ${UPSTREAM_REPO} --workflow=ci.yaml --branch=${branch} --limit=1 --json databaseId,createdAt`
    );

    if (result.success && result.stdout) {
      try {
        const runs = JSON.parse(result.stdout) as Array<{ databaseId: number; createdAt: string }>;
        if (runs.length > 0) {
          const run = runs[0];
          const runCreatedAt = new Date(run.createdAt).getTime();
          // Only accept runs created after we started
          if (runCreatedAt >= startTime - 5000) {
            log(`Found run ID: ${run.databaseId}`);
            return run.databaseId;
          }
        }
      } catch {
        // JSON parse failed, retry
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }

  log("Could not find workflow run");
  return null;
}

async function getRunStatus(runId: number): Promise<RunStatus | null> {
  const result = await execWithRetry(
    `gh run view --repo ${UPSTREAM_REPO} ${runId} --json status,conclusion,jobs`
  );
  if (!result.success) {
    return null;
  }
  try {
    return JSON.parse(result.stdout) as RunStatus;
  } catch {
    return null;
  }
}

async function pollRun(runId: number, startTime: number): Promise<RunStatus | "timeout"> {
  log(`Watching run ${runId}...`);

  let lastStatus = "";

  while (Date.now() - startTime < TIMEOUT_MS) {
    const status = await getRunStatus(runId);

    if (!status) {
      log("Failed to get run status, retrying...");
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Log status changes
    const inProgress = status.jobs.filter((j) => j.status === "in_progress").map((j) => j.name);
    const statusStr = inProgress.length > 0 ? `Running: ${inProgress.join(", ")}` : status.status;
    if (statusStr !== lastStatus) {
      log(statusStr);
      lastStatus = statusStr;
    }

    if (status.status === "completed") {
      return status;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return "timeout";
}

async function getFailedLogs(runId: number): Promise<string> {
  const result = await execWithRetry(
    `gh run view --repo ${UPSTREAM_REPO} ${runId} --log-failed`,
    120_000 // 2 minute timeout for logs
  );
  if (result.success) {
    return result.stdout;
  }
  return result.stderr;
}

async function main(): Promise<void> {
  const startTime = Date.now();

  log("Starting CI...");

  // Get current branch
  const branch = await getCurrentBranch();
  if (!branch) {
    log("Could not determine current branch");
    process.exit(1);
  }
  log(`Branch: ${branch}`);

  // Push branch
  if (!(await pushBranch())) {
    process.exit(1);
  }

  // Trigger workflow
  if (!(await triggerWorkflow(branch))) {
    process.exit(1);
  }

  // Wait a moment for GitHub to register the run
  await sleep(3000);

  // Find the run ID
  const runId = await findRunId(branch, startTime);
  if (!runId) {
    process.exit(1);
  }

  // Poll the run until completion
  const result = await pollRun(runId, startTime);

  if (result === "timeout") {
    log("CI timed out");
    process.exit(2);
  }

  // Print final summary
  console.log("\n--- CI Summary ---");
  for (const job of result.jobs) {
    const icon = job.conclusion === "success" ? "✓" : job.conclusion === "failure" ? "✗" : "○";
    console.log(`${icon} ${job.name}`);
  }
  console.log("");

  if (result.conclusion === "success") {
    log("CI passed!");
    process.exit(0);
  } else {
    log("CI failed!");

    const failedJobs = result.jobs.filter((j) => j.conclusion === "failure").map((j) => j.name);
    if (failedJobs.length > 0) {
      log(`Failed jobs: ${failedJobs.join(", ")}`);
    }

    log("\n--- Failed job logs ---\n");
    const logs = await getFailedLogs(runId);
    console.log(logs);

    process.exit(1);
  }
}

// Graceful shutdown handlers
process.on("SIGINT", () => {
  log("Interrupted by user");
  process.exit(1);
});

process.on("SIGTERM", () => {
  log("Terminated");
  process.exit(1);
});

main().catch((err) => {
  log(`Unexpected error: ${err.message}`);
  process.exit(1);
});
