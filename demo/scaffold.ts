/**
 * What the demo works on: two small repositories "on GitHub", a stand-in `gh`,
 * and the plugin whose automation turns pull requests into workspaces.
 *
 * Everything outside CodeHydra is staged so the recording is the same on every
 * run and needs no network or account. The repositories are local bare clones
 * that git reaches through an `insteadOf` rewrite of `https://github.com/acme/`
 * (`gitHubEnv`), so the app clones `acme/nimbus` exactly as it would from
 * GitHub; the `gh` on the app's PATH answers from canned data, and the recorder
 * decides when GitHub "changes" by touching files in the state directory
 * (`openPullRequests`, `passCi`).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The GitHub owner both repositories belong to. */
export const OWNER = "acme";

/** The web page, cloned on camera; a repository's name is its project's name. */
export const SITE = "nimbus";
/** The service behind it, open before the recording starts. */
export const API = "nimbus-api";

/** The pull requests on the API the reviews automation finds once they are "opened". */
export const PULL_REQUESTS = [
  { number: 12, title: "Add an hourly forecast endpoint", branch: "hourly-endpoint" },
  { number: 15, title: "Cache weather lookups", branch: "lookup-cache" },
] as const;

/** The pull request the flaky-test agent opens on the API, and waits on CI for. */
export const OWN_PR = 42;

/**
 * The page. A variant restyles it by writing `theme.css`, which the repository
 * does not have: a new file shows as a short summary in the agent's
 * transcript, where rewriting the page would fill it with a diff.
 */
function nimbusPage(): string {
  return page(`<style>${PLAIN}
  </style>
  <link rel="stylesheet" href="theme.css" />`);
}

/** The page with one look applied inline, for the side-by-side comparison. */
export function styledPage(workspace: string): string {
  return page(`<style>${STYLES[workspace]!.css}
  </style>`);
}

function page(head: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Nimbus</title>
  ${head}
</head>
<body>
  <header>
    <span class="brand"><span class="dot"></span>Nimbus</span>
    <h1>Good afternoon.</h1>
    <p class="lede">A tiny weather board for wherever you are.</p>
  </header>
  <main>
    <div class="card"><h2>Temperature</h2><p class="value">21&deg;</p><p>Partly cloudy</p></div>
    <div class="card"><h2>Wind</h2><p class="value">8 km/h</p><p>Gentle breeze</p></div>
    <div class="card"><h2>Humidity</h2><p class="value">64%</p><p>Comfortable</p></div>
    <div class="card"><h2>Sunset</h2><p class="value">19:42</p><p>In 4 hours</p></div>
  </main>
</body>
</html>
`;
}

const LAYOUT = `
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; }
    header { padding: 3rem 3rem 1.5rem; }
    .brand { display: inline-flex; align-items: center; gap: 0.6rem; }
    .brand .dot { width: 0.8rem; height: 0.8rem; border-radius: 50%; }
    h1 { margin: 1.2rem 0 0; }
    p.lede { margin: 0.75rem 0 0; max-width: 34rem; }
    main { padding: 1rem 3rem 3rem; display: grid; gap: 1rem;
           grid-template-columns: repeat(2, minmax(0, 16rem)); }
    .card h2 { margin: 0 0 0.4rem; }
    .card p { margin: 0; }
    .value { margin: 0.2rem 0 0; }`;

/** The page as the repository holds it: plain, before any variant. */
const PLAIN = `${LAYOUT}
    body { font-family: system-ui, sans-serif; background: #f6f7f9; color: #1d2433; }
    .brand { font-weight: 650; color: #3b6fe0; }
    .brand .dot { background: #3b6fe0; }
    h1 { font-size: 2.4rem; }
    p.lede { color: #5b6472; font-size: 1.15rem; }
    .card { background: #fff; border: 1px solid #e3e6eb; border-radius: 10px; padding: 1.2rem 1.4rem; }
    .card h2 { font-size: 1rem; }
    .card p { color: #5b6472; }
    .value { font-size: 1.8rem; font-weight: 650; color: #1d2433 !important; }`;

/**
 * The three themes the restyle variants write, keyed by workspace name. Each
 * restates every property the plain page sets, so nothing of it shows through.
 */
export const STYLES: Record<string, { title: string; css: string }> = {
  "style-minimal": {
    title: "Minimal black & white",
    css: `${LAYOUT}
    body { font-family: "Helvetica Neue", Arial, sans-serif; background: #fff; color: #000; }
    .brand { font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; font-size: 0.85rem; }
    .brand .dot { background: #000; border-radius: 0; }
    h1 { font-size: 3.2rem; font-weight: 300; letter-spacing: -0.03em; }
    p.lede { color: #555; font-size: 1.1rem; }
    .card { background: none; border: 0; border-top: 2px solid #000; border-radius: 0; padding: 1rem 0 0; }
    .card h2 { font-size: 0.75rem; letter-spacing: 0.2em; text-transform: uppercase; }
    .card p { color: #666; }
    .value { font-size: 2.4rem; font-weight: 300; color: #000 !important; }`,
  },
  "style-gradient": {
    title: "Bold gradient",
    css: `${LAYOUT}
    body { font-family: system-ui, sans-serif; color: #fff;
           background: linear-gradient(135deg, #5b21b6 0%, #db2777 55%, #f59e0b 100%); }
    .brand { font-weight: 800; font-size: 1.2rem; }
    .brand .dot { background: #fde68a; box-shadow: 0 0 12px #fde68a; }
    h1 { font-size: 3.4rem; font-weight: 800; letter-spacing: -0.03em; }
    p.lede { color: rgba(255, 255, 255, 0.85); font-size: 1.2rem; }
    .card { background: rgba(255, 255, 255, 0.16); border: 1px solid rgba(255, 255, 255, 0.35);
            border-radius: 18px; padding: 1.3rem 1.5rem; backdrop-filter: blur(8px); }
    .card h2 { font-size: 1rem; }
    .card p { color: rgba(255, 255, 255, 0.8); }
    .value { font-size: 2.4rem; font-weight: 800; color: #fff !important; }`,
  },
  "style-retro": {
    title: "Warm retro",
    css: `${LAYOUT}
    body { font-family: Georgia, "Times New Roman", serif; background: #f3e6cf; color: #4a2c17; }
    .brand { font-weight: 700; font-style: italic; color: #c2410c; font-size: 1.2rem; }
    .brand .dot { background: #c2410c; }
    h1 { font-size: 3rem; color: #7c2d12; }
    p.lede { color: #7a5a3a; font-size: 1.15rem; }
    .card { background: #fbf3e4; border: 3px solid #4a2c17; border-radius: 4px;
            padding: 1.1rem 1.3rem; box-shadow: 6px 6px 0 #c2410c; }
    .card h2 { font-size: 1.05rem; color: #7c2d12; }
    .card p { color: #7a5a3a; }
    .value { font-size: 2.2rem; font-weight: 700; color: #4a2c17 !important; }`,
  },
};

/** The test the flaky-test agent fixes: it fails before noon. */
export const FLAKY_TEST = `import assert from "node:assert";
import { greeting } from "./greeting.mjs";

// Flaky: depends on the hour the suite happens to run.
assert.equal(greeting(new Date()), "Good afternoon.");
console.log("forecast tests passed");
`;

export const FLAKY_TEST_FIXED_LINE =
  'assert.equal(greeting(new Date("2026-06-01T15:00:00")), "Good afternoon.");';

/** `owner/repo`, as typed into the clone dialog. */
export function slug(repo: string): string {
  return `${OWNER}/${repo}`;
}

/**
 * Put both repositories "on GitHub": bare repositories under `root`, each
 * committed on `main`.
 */
export function scaffoldGitHub(root: string): void {
  rmSync(root, { recursive: true, force: true });
  publish(root, SITE, {
    "index.html": nimbusPage(),
    "README.md": "# Nimbus\n\nA tiny weather board.\n",
  });
  publish(root, API, {
    "greeting.mjs": `export function greeting(date) {
  const hour = date.getHours();
  if (hour < 12) return "Good morning.";
  if (hour < 18) return "Good afternoon.";
  return "Good evening.";
}
`,
    "forecast.test.mjs": FLAKY_TEST,
    "README.md": "# Nimbus API\n\nThe forecasts behind Nimbus.\n",
  });
}

function publish(root: string, repo: string, files: Record<string, string>): void {
  const work = join(root, "work", repo);
  mkdirSync(work, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(work, name), content);
  const git = (cwd: string, ...args: string[]): void =>
    void execFileSync("git", args, { cwd, stdio: "ignore" });
  git(work, "init", "-b", "main");
  git(work, "-c", "user.email=demo@example.com", "-c", "user.name=Demo", "add", ".");
  git(work, "-c", "user.email=demo@example.com", "-c", "user.name=Demo", "commit", "-m", "Initial");
  git(root, "clone", "--bare", "-q", work, join(root, OWNER, `${repo}.git`));
}

/**
 * Environment that sends git's `https://github.com/acme/…` to the bare
 * repositories under `root` — the app's clone and the agents' pushes alike.
 * Also the identity the agents commit with.
 */
export function gitHubEnv(root: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${join(root, OWNER)}/.insteadOf`,
    GIT_CONFIG_VALUE_0: `https://github.com/${OWNER}/`,
    GIT_AUTHOR_NAME: "Demo",
    GIT_AUTHOR_EMAIL: "demo@example.com",
    GIT_COMMITTER_NAME: "Demo",
    GIT_COMMITTER_EMAIL: "demo@example.com",
  };
}

/** Files under `stateDir` that stand for GitHub's state. */
export function githubState(stateDir: string): {
  openPullRequests(): void;
  passCi(): void;
} {
  mkdirSync(stateDir, { recursive: true });
  rmSync(join(stateDir, "prs-open"), { force: true });
  rmSync(join(stateDir, "ci-passed"), { force: true });
  return {
    openPullRequests: () => writeFileSync(join(stateDir, "prs-open"), ""),
    passCi: () => writeFileSync(join(stateDir, "ci-passed"), ""),
  };
}

/**
 * A `gh` that answers the handful of calls the demo makes, from canned data.
 *
 * `--jq` is honoured by piping through the real `jq`, so the plugin on camera
 * reads exactly like one written against the real `gh`.
 */
export function writeFakeGh(binDir: string, stateDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const prs = JSON.stringify(
    PULL_REQUESTS.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: `https://github.com/${OWNER}/${API}/pull/${pr.number}`,
      headRefName: pr.branch,
    }))
  );
  const gh = join(binDir, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
# Stand-in for GitHub's gh, for the CodeHydra demo recording.
set -euo pipefail
state=${JSON.stringify(stateDir)}
jq_program=""
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) jq_program="$2"; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
emit() { if [ -n "$jq_program" ]; then jq -c "$jq_program"; else cat; fi; }
case "\${args[0]:-} \${args[1]:-}" in
  "pr list")
    if [ -e "$state/prs-open" ]; then echo ${JSON.stringify(prs)} | emit; else echo '[]' | emit; fi ;;
  "pr create")
    echo "https://github.com/${OWNER}/${API}/pull/${OWN_PR}" ;;
  "pr checks")
    if [ -e "$state/ci-passed" ]; then
      echo "test  pass  1m12s  https://github.com/${OWNER}/${API}/actions"
    else
      echo "test  pending  0  https://github.com/${OWNER}/${API}/actions"; exit 8
    fi ;;
  "pr diff")
    cat <<'DIFF'
diff --git a/hourly.mjs b/hourly.mjs
@@ -0,0 +1,6 @@
+export function hourly(forecast, from) {
+  return forecast.hours
+    .filter((hour) => hour.time >= from)
+    .slice(0, 12)
+    .map(({ time, temperature }) => ({ time, temperature }));
+}
DIFF
    ;;
  *) echo "gh (demo): unsupported: \${args[*]}" >&2; exit 1 ;;
esac
`
  );
  chmodSync(gh, 0o755);
}

/**
 * The plugin shown on camera: one automation, a workspace per open pull request.
 * Written the way the user guide's example is, against `gh`.
 */
export function reviewsPlugin(): string {
  return `description: A workspace per pull request waiting for review
automations:
  reviews: |
    gh pr list --repo ${slug(API)} --json number,title,url \\
      --jq '[.[] | {
        action: "workspace.create", project: "${API}",
        name: "pr-\\(.number)", key: .url,
        metadata: {title: "PR #\\(.number): \\(.title)", tags: {review: {color: "#e3b341"}}},
        prompt: "Review pull request #\\(.number) \\"\\(.title)\\": \\(.url)"
      }]'
`;
}
