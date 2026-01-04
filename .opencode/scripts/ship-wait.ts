#!/usr/bin/env node
/**
 * Client-side merge queue for /ship command.
 *
 * Waits for PRs ahead in queue, rebases when it's our turn,
 * waits for CI, and confirms merge completion.
 *
 * Usage: npx tsx .opencode/scripts/ship-wait.ts <pr-number>
 *
 * Exit codes:
 *   0 - MERGED: PR successfully merged
 *   1 - FAILED: PR failed (CI failed, conflicts, closed, etc.)
 *   2 - TIMEOUT: Still processing after 15 minutes
 *
 * Environment:
 *   Requires `gh` CLI to be authenticated.
 */

import { spawn } from "node:child_process";

const POLL_INTERVAL_MS = 30_000; // 30 seconds
const TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const COMMAND_TIMEOUT_MS = 60_000; // 60 seconds per command

interface PR {
  number: number;
  createdAt: string;
  autoMergeRequest: { enabledAt: string } | null;
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefName: string;
}

interface PRState {
  state: "OPEN" | "MERGED" | "CLOSED";
  mergeStateStatus: string;
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

async function getOpenPRsWithAutoMerge(): Promise<PR[]> {
  const json = await exec(
    `gh pr list --state open --json number,createdAt,autoMergeRequest,state,headRefName`
  );
  const prs: PR[] = JSON.parse(json);
  // Filter to PRs with auto-merge enabled
  return prs.filter((pr) => pr.autoMergeRequest !== null);
}

async function getPRState(prNumber: number): Promise<PRState> {
  const json = await exec(`gh pr view ${prNumber} --json state,mergeStateStatus`);
  return JSON.parse(json);
}

function getPRsAhead(ourPR: PR, allPRs: PR[]): PR[] {
  // Filter PRs created before ours (FIFO queue)
  return allPRs
    .filter((pr) => pr.number !== ourPR.number)
    .filter((pr) => new Date(pr.createdAt) < new Date(ourPR.createdAt))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

async function waitForPRsAhead(ourPR: PR, startTime: number): Promise<boolean> {
  while (true) {
    if (Date.now() - startTime > TIMEOUT_MS) {
      return false; // Timeout
    }

    const allPRs = await getOpenPRsWithAutoMerge();
    const prsAhead = getPRsAhead(ourPR, allPRs);

    if (prsAhead.length === 0) {
      log("No PRs ahead in queue - it's our turn!");
      return true;
    }

    const prNumbers = prsAhead.map((pr) => `#${pr.number}`).join(", ");
    log(`Waiting for ${prsAhead.length} PR(s) ahead: ${prNumbers}`);

    await sleep(POLL_INTERVAL_MS);
  }
}

async function rebaseAndPush(): Promise<boolean> {
  log("Fetching latest main...");
  const fetchResult = await execNoThrow("git fetch origin main");
  if (!fetchResult.success) {
    log(`Failed to fetch: ${fetchResult.stderr}`);
    return false;
  }

  log("Rebasing onto origin/main...");
  const rebaseResult = await execNoThrow("git rebase origin/main");
  if (!rebaseResult.success) {
    log(`Rebase failed (conflicts?): ${rebaseResult.stderr}`);
    // Abort the rebase
    await execNoThrow("git rebase --abort");
    return false;
  }

  log("Force-pushing...");
  const pushResult = await execNoThrow("git push --force-with-lease origin HEAD");
  if (!pushResult.success) {
    log(`Push failed: ${pushResult.stderr}`);
    return false;
  }

  return true;
}

async function waitForCI(prNumber: number): Promise<boolean> {
  log("Waiting for CI checks...");

  return new Promise((resolve) => {
    const proc = spawn("gh", ["pr", "checks", String(prNumber), "--watch", "--fail-fast"], {
      stdio: "inherit",
    });

    proc.on("close", (code) => {
      if (code === 0) {
        log("All CI checks passed!");
        resolve(true);
      } else {
        log("CI checks failed");
        resolve(false);
      }
    });

    proc.on("error", (err) => {
      log(`CI check error: ${err.message}`);
      resolve(false);
    });
  });
}

async function waitForMerge(
  prNumber: number,
  startTime: number
): Promise<"merged" | "failed" | "timeout"> {
  log("Waiting for auto-merge to complete...");

  // Auto-merge should happen almost immediately after CI passes
  // Poll for up to 2 minutes (should be much faster)
  const mergeTimeout = 2 * 60 * 1000;
  const mergeStart = Date.now();

  while (true) {
    if (Date.now() - startTime > TIMEOUT_MS) {
      return "timeout";
    }

    if (Date.now() - mergeStart > mergeTimeout) {
      log("Auto-merge taking longer than expected");
      return "timeout";
    }

    const state = await getPRState(prNumber);

    if (state.state === "MERGED") {
      log("PR merged successfully!");
      return "merged";
    }

    if (state.state === "CLOSED") {
      log("PR was closed without merging");
      return "failed";
    }

    if (state.mergeStateStatus === "DIRTY") {
      log("Merge conflict detected");
      return "failed";
    }

    // Still waiting
    log(`PR state: ${state.state}, merge status: ${state.mergeStateStatus}`);
    await sleep(5000); // Check every 5 seconds for merge completion
  }
}

async function findMainWorktree(): Promise<string | null> {
  const output = await exec("git worktree list --porcelain");
  const worktrees = output.split("\n\n").filter(Boolean);

  for (const worktree of worktrees) {
    const lines = worktree.split("\n");
    const pathLine = lines.find((l) => l.startsWith("worktree "));
    const branchLine = lines.find((l) => l.startsWith("branch "));

    if (pathLine && branchLine) {
      const path = pathLine.replace("worktree ", "");
      const branch = branchLine.replace("branch refs/heads/", "");

      if (branch === "main") {
        return path;
      }
    }
  }

  return null;
}

async function updateLocalMain(): Promise<void> {
  const mainWorktree = await findMainWorktree();

  if (!mainWorktree) {
    log("Warning: Could not find main worktree to update");
    return;
  }

  log(`Updating local main branch at ${mainWorktree}...`);

  const fetchResult = await execNoThrow(`git -C "${mainWorktree}" fetch origin main`);
  if (!fetchResult.success) {
    log(`Warning: Failed to fetch in main worktree: ${fetchResult.stderr}`);
    return;
  }

  const pullResult = await execNoThrow(`git -C "${mainWorktree}" pull --ff-only origin main`);
  if (!pullResult.success) {
    log(`Warning: Failed to pull in main worktree (local changes?): ${pullResult.stderr}`);
    return;
  }

  log(`Local main updated at ${mainWorktree}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length !== 1) {
    console.error("Usage: npx tsx ship-wait.ts <pr-number>");
    process.exit(1);
  }

  const prNumber = parseInt(args[0], 10);
  if (isNaN(prNumber)) {
    console.error(`Invalid PR number: ${args[0]}`);
    process.exit(1);
  }

  const startTime = Date.now();

  log(`Starting ship-wait for PR #${prNumber}`);

  // Get current state of our PR
  const state = await getPRState(prNumber);

  if (state.state === "MERGED") {
    log("PR is already merged!");
    await updateLocalMain();
    process.exit(0);
  }

  if (state.state === "CLOSED") {
    log("PR is closed");
    process.exit(1);
  }

  // Get our PR details
  const allPRs = await getOpenPRsWithAutoMerge();
  const ourPR = allPRs.find((pr) => pr.number === prNumber);

  if (!ourPR) {
    log("Warning: Our PR doesn't have auto-merge enabled, proceeding anyway");
    // Create a minimal PR object
    const json = await exec(`gh pr view ${prNumber} --json number,createdAt,state,headRefName`);
    const pr = JSON.parse(json) as PR;
    pr.autoMergeRequest = { enabledAt: new Date().toISOString() };

    // Wait for any PRs ahead
    if (!(await waitForPRsAhead(pr, startTime))) {
      log("Timeout waiting for PRs ahead");
      process.exit(2);
    }
  } else {
    // Wait for PRs ahead
    if (!(await waitForPRsAhead(ourPR, startTime))) {
      log("Timeout waiting for PRs ahead");
      process.exit(2);
    }
  }

  // It's our turn - rebase and push
  if (!(await rebaseAndPush())) {
    log("Failed to rebase and push");
    process.exit(1);
  }

  // Wait for CI
  if (!(await waitForCI(prNumber))) {
    log("CI failed");
    process.exit(1);
  }

  // Wait for merge
  const mergeResult = await waitForMerge(prNumber, startTime);

  if (mergeResult === "merged") {
    await updateLocalMain();
    process.exit(0);
  } else if (mergeResult === "failed") {
    process.exit(1);
  } else {
    // timeout
    process.exit(2);
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
