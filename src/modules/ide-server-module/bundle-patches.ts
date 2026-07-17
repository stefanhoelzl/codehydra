/**
 * Patches applied to the downloaded VSCodium (reh-web) bundle.
 *
 * The bundle is vendored code we don't build, so upstream bugs that break
 * CodeHydra have to be fixed in place. Each fix is a search-and-replace against
 * one file, declared as data in `TEXT_PATCHES` and applied by one engine — a new
 * fix is a table entry, not a new module.
 *
 * ## Why not a .patch file
 *
 * `workbench.js` is a 17 MB minified bundle whose target line is ~12,000
 * characters long. A unified diff of the one-token change below is 108 KB, and
 * its hunk is anchored to ~96,000 characters of surrounding minified context —
 * so any unrelated upstream edit near it, or the identifier churn of a re-minify
 * on the next VSCodium bump, invalidates it. The patterns here anchor on a few
 * dozen characters and capture the minified identifiers, so they survive that
 * churn.
 *
 * ## When this runs
 *
 * Once per startup, from the `app:start` "start" hook, before the IDE server is
 * spawned. That single call site covers both cases: `app:start` downloads a
 * missing bundle (the `app:setup` sub-operation) *before* it reaches the "start"
 * hook, so a fresh bundle is patched on the way up — and so is a bundle that was
 * downloaded long ago, which a post-download-only pass would never revisit. The
 * bundle directory is version-scoped and a re-download only happens when it is
 * missing entirely, so an install that predates a patch is otherwise never
 * touched again.
 *
 * Every patch is therefore **idempotent** — it runs on every startup, over a
 * bundle that is usually already patched. That comes for free: the patched form is
 * its own marker (`applied`), so there is no sidecar marker file that could go
 * stale when the bundle is re-downloaded.
 *
 * ## Patching the file is only half of it
 *
 * The distribution serves its static assets with a year-long `Cache-Control` and
 * no ETag, under a URL keyed on the VSCodium commit — which patching does not
 * change. A patched file on disk is therefore *not* a patched workbench in the
 * iframe: the session keeps serving the copy it cached the first time it loaded
 * that version, and the patch sits inert behind it. `applyBundlePatches` reports
 * whether it rewrote anything so its caller can drop those caches; the `start`
 * hook in `ide-server-module.ts` is where that happens, and why.
 *
 * ## When a patch stops matching
 *
 * A patch that finds neither its original nor its patched shape has drifted from
 * upstream — a bug in *this* file, not in the user's install. What happens next
 * depends on who is running:
 *
 * - **Unpackaged (dev)**: throw. Whoever bumped `VSCODIUM_VERSION` finds out the
 *   moment they run the app, rather than shipping a patch that quietly stopped
 *   working. `pnpm dev` failing to start is exactly the alarm we want.
 * - **Packaged (users)**: log at error level and carry on. The bundle is left
 *   untouched, so the app still runs — it just still has the upstream bug. Failing
 *   startup would take down every workspace over (say) a broken clipboard, which
 *   is far worse than the bug being patched.
 *
 * Note this is a *local* guard, not a CI gate: nothing in CI runs the app
 * unpackaged (the e2e jobs launch the packaged artifact), so drift is caught when
 * a developer runs the app, not by a red build.
 */

import { join } from "node:path";

import type { FileSystemBoundary } from "../../boundaries/platform/filesystem";
import type { Logger } from "../../boundaries/platform/logging-types";
import type { SupportedPlatform } from "../../boundaries/platform/platform-info";
import { IdeServerError, getErrorMessage } from "../../shared/errors/service-errors";

// =============================================================================
// The patches
// =============================================================================

/** A search-and-replace against one file in the bundle. */
export interface TextPatch {
  /** Short identifier, used in logs. */
  readonly id: string;
  /** Bundle-relative path of the file to patch (forward slashes). */
  readonly file: string;
  /**
   * The unpatched shape. Must be global — every occurrence is rewritten. Minified
   * targets shift their identifiers between versions, so capture them rather than
   * matching them literally, and anchor on the stable string literals.
   */
  readonly find: RegExp;
  /** Builds the replacement from `find`'s capture groups. */
  readonly replace: (...groups: string[]) => string;
  /** Matches the patched shape. Doubles as the already-applied marker. */
  readonly applied: RegExp;
  /** What breaks if `find` no longer matches — surfaced in the error. */
  readonly whenMissing: string;
  /** Apply only on this platform. Omitted = every platform. */
  readonly platform?: SupportedPlatform;
}

/**
 * OSC 52 clipboard patch.
 *
 * Terminal programs copy to the clipboard by emitting the OSC 52 escape sequence
 * (`ESC ]52;c;<base64> BEL`). Claude Code, tmux copy-mode and vim/neovim yanks
 * all rely on it, and Claude Code has no native-clipboard fallback — it prints
 * "Copied N characters to clipboard" whether or not the terminal honored it.
 *
 * The sequence reaches the workbench (the PTY passes it through and xterm's
 * clipboard addon registers an OSC 52 handler), but the write is then thrown
 * away. The terminal hands the addon a clipboard provider that always names a
 * clipboard *type* (`"clipboard"`, or `"selection"` for the `p` parameter), and
 * `BrowserClipboardService.writeText` short-circuits on any type:
 *
 *     async writeText(e, t) { …; if (t) { this.mapTextToType.set(t, e); return } … navigator.clipboard.writeText(e) }
 *
 * So the text lands in an in-memory `Map` and never reaches the system clipboard.
 * Nothing throws and nothing logs. On VS Code *desktop* the native clipboard
 * service honors the "clipboard" type and writes through — which is why the same
 * terminal program copies fine outside CodeHydra. This is an upstream VS Code
 * *web* bug: `"clipboard"` should mean the system clipboard, and only
 * `"selection"` (the Linux primary selection behind middle-click paste) belongs
 * in that map.
 *
 * Passing no type at all falls through to `navigator.clipboard.writeText`, which
 * already works in the workspace iframe (a `127.0.0.1` secure context whose
 * `allow` grants `clipboard-write`). The `"p"` branch is preserved, so
 * primary-selection semantics are unchanged.
 *
 * The *read* path is deliberately left alone: routing it to the real clipboard
 * would let any process that can write to a terminal exfiltrate the user's
 * clipboard via `ESC ]52;c;?`. Reads keep returning the in-memory map, which —
 * now that writes bypass it — is simply empty.
 */
const OSC52_CLIPBOARD: TextPatch = {
  id: "osc52-clipboard",
  file: "out/vs/code/browser/workbench/workbench.js",
  find: /async writeText\(([\w$]+),([\w$]+)\)\{return ([\w$]+)\.writeText\(\2,\1==="p"\?"selection":"clipboard"\)\}/g,
  replace: (selectionType, text, clipboard) =>
    `async writeText(${selectionType},${text}){return ${clipboard}.writeText(${text},${selectionType}==="p"?"selection":void 0)}`,
  applied:
    /async writeText\(([\w$]+),([\w$]+)\)\{return ([\w$]+)\.writeText\(\2,\1==="p"\?"selection":void 0\)\}/,
  whenMissing: "OSC 52 copy from terminals will not reach the system clipboard",
};

/**
 * Persist extension secrets (sign-in tokens).
 *
 * `context.secrets` is where extensions keep credentials — the GitHub Pull
 * Requests extension reaches it through `vscode.authentication.getSession`, which
 * the built-in `github-authentication` extension backs with a secret under
 * `{"extensionId":"vscode.github-authentication","key":"github.auth"}`. The
 * extension host is remote, so that call proxies to the *workbench page's*
 * `ISecretStorageService`: the iframe decides where the token lives, not the
 * server.
 *
 * In web, that service never persists on its own. `BrowserSecretStorageService`
 * hands its base class `_useInMemoryStorage: true` outright (`super(!0,…)`), and
 * the browser's encryption service answers `isEncryptionAvailable()` with a flat
 * `false`, so the one remaining branch logs "Encryption is not available, falling
 * back to in-memory storage" and keeps secrets in a plain `Map`. The only escape
 * is an embedder-supplied `secretStorageProvider`, and the workbench bootstrap
 * gates that on:
 *
 *     secretStorageProvider: config.remoteAuthority && !secretKeyPath ? void 0 : new LocalStorageSecretStorageProvider(crypto)
 *
 * reh-web always sets `remoteAuthority` (the server fills it from the request
 * host), and `secretKeyPath` comes from a `vscode-secret-key-path` cookie that
 * only Codespaces-style embedders set — nothing in the bundle or in CodeHydra
 * does. So the provider is always `undefined` and every secret lives in the
 * iframe's heap: a token minted in one workspace is invisible to the next, and any
 * reload, hibernation or restart drops it. That is the whole bug — users had to
 * sign in to GitHub again in every workspace, over and over.
 *
 * This is a regression from our own migration, not new upstream breakage.
 * code-server — the IDE server we shipped before VSCodium — patched this exact
 * expression, replacing the cookie lookup with a path it always computes
 * (`location.pathname + "/mint-key"`), so `!secretKeyPath` was never true and the
 * provider was always installed, sealed against a 256-bit key from its own
 * `/mint-key` route. Stock VSCodium has no such route and no such patch.
 *
 * Forcing the provider on restores persistence. The crypto argument is whatever
 * the bootstrap already built, which — with the cookie absent — is the
 * *transparent* crypto, so secrets land as plaintext JSON in `localStorage` under
 * `secrets.provider`. That is a deliberate trade: every workspace is an iframe on
 * the same `127.0.0.1` origin inside the shared `persist:codehydra-global`
 * partition, so localStorage is exactly the storage that makes one sign-in cover
 * every workspace and survive a restart. code-server's encryption bought little
 * over it — its key came from an unauthenticated localhost route that any local
 * process could mint from, the same process that could already read the
 * partition off disk.
 *
 * A `secrets.provider` blob left behind by the code-server era is sealed with a
 * key we no longer have, so the provider's `load()` fails to `JSON.parse` it,
 * catches, and clears the key — old data degrades to a fresh sign-in rather than
 * breaking startup.
 */
const SECRET_STORAGE_PERSISTENCE: TextPatch = {
  id: "secret-storage-persistence",
  file: "out/vs/code/browser/workbench/workbench.js",
  find: /secretStorageProvider:[\w$]+\.remoteAuthority&&![\w$]+\?void 0:new ([\w$]+)\(([\w$]+)\)/g,
  replace: (provider, crypto) => `secretStorageProvider:new ${provider}(${crypto})`,
  applied: /secretStorageProvider:new [\w$]+\([\w$]+\)/,
  whenMissing:
    "extension sign-ins (e.g. the GitHub Pull Requests extension) will not persist and must be repeated in every workspace",
};

/**
 * Forward-slash-normalize the native file watcher's ignore globs (Windows only).
 *
 * `@parcel/watcher` compiles each glob `ignore` pattern into a C++ `std::regex`
 * via picomatch's regex source. VS Code passes absolute *backslash* paths as
 * ignore globs to exclude a bare-repo worktree's external `.git` dir, and the
 * watcher lowercases them — so `C:\Users\…` becomes `c:\users\…`. The `\u` in
 * `\users` is an invalid escape in `std::regex`'s ECMAScript grammar and throws
 * `regex_error(error_escape)`, aborting `subscribe()`. Recursive watching is then
 * disabled for every workspace, so saving a file no longer refreshes the Source
 * Control view (upstream: parcel-bundler/watcher#194).
 *
 * `wrapper.js` funnels all four watcher entry points (`subscribe`, `unsubscribe`,
 * `writeSnapshot`, `getEventsSince`) through one `normalizeOptions`, whose loop
 * over `ignore` is where each value is handed to `picomatch.makeRe` (glob) or
 * `path.resolve` (plain path). Normalizing there fixes every caller at once.
 *
 * Forward-slash globs match identically on Windows (picomatch runs with
 * `windows: true` either way, and VS Code's own built-in excludes are already
 * forward-slash), so rewriting the separators only prevents the crash — it does
 * not change matching behavior. Gated to Windows because on POSIX a backslash is
 * a legal filename character and picomatch's escape character, so rewriting it
 * there could change what a glob means.
 */
const WATCHER_IGNORE_SEPARATORS: TextPatch = {
  id: "watcher-ignore-separators",
  file: "node_modules/@parcel/watcher/wrapper.js",
  platform: "win32",
  find: /for \(const value of ignore\) \{/g,
  replace: () =>
    'for (const chRawValue of ignore) {\n      const value = typeof chRawValue === "string" ? chRawValue.replace(/\\\\/g, "/") : chRawValue;',
  applied: /const chRawValue of ignore/,
  whenMissing:
    "file watching stays broken on Windows (saving a file will not refresh the Source Control view)",
};

/** Every patch. */
const TEXT_PATCHES: readonly TextPatch[] = [
  OSC52_CLIPBOARD,
  SECRET_STORAGE_PERSISTENCE,
  WATCHER_IGNORE_SEPARATORS,
];

// =============================================================================
// Engine
// =============================================================================

/** Suffix of the scratch file a rewrite is staged in before the rename. */
const TEMP_SUFFIX = ".ch-tmp";

/** Outcome of a single patch pass. */
export type TextPatchResult = "applied" | "already-applied" | "not-found";

/** FileSystem surface the patches need — a narrow slice of the boundary. */
export type BundlePatchFs = Pick<FileSystemBoundary, "readFile" | "writeFile" | "rename">;

export interface BundlePatchDeps {
  readonly fileSystemLayer: BundlePatchFs;
  readonly logger: Logger;
  readonly platform: SupportedPlatform;
  /**
   * Packaged build? A patch that cannot be applied is fatal when unpackaged (dev
   * — fail loudly in front of whoever bumped the bundle) and merely logged when
   * packaged (users — degrade to the upstream bug rather than refusing to start).
   */
  readonly isPackaged: boolean;
}

/**
 * Apply one patch to the bundle. Idempotent: a second pass detects the patched
 * form and rewrites nothing.
 *
 * Never throws on a stale anchor — it reports `"not-found"` and logs at error
 * level. Escalating that to a thrown error in dev is `applyBundlePatches`'s job,
 * so this stays a pure "what happened" report.
 */
export async function applyTextPatch(
  deps: Pick<BundlePatchDeps, "fileSystemLayer" | "logger">,
  bundleDir: string,
  patch: TextPatch
): Promise<TextPatchResult> {
  const { fileSystemLayer: fs, logger } = deps;
  const filePath = join(bundleDir, ...patch.file.split("/"));

  let source: string;
  try {
    source = await fs.readFile(filePath);
  } catch (error) {
    logger.error(`Bundle patch "${patch.id}": file unreadable — ${patch.whenMissing}`, {
      filePath,
      error: getErrorMessage(error),
    });
    return "not-found";
  }

  let occurrences = 0;
  const patched = source.replace(patch.find, (...args) => {
    occurrences++;
    // String.replace passes (match, ...groups, offset, whole). No named groups.
    const groups = args.slice(1, -2) as string[];
    return patch.replace(...groups);
  });

  if (occurrences === 0) {
    if (patch.applied.test(source)) {
      logger.debug(`Bundle patch "${patch.id}" already applied`, { filePath });
      return "already-applied";
    }
    // Neither shape found: upstream moved and our anchor is stale.
    logger.error(
      `Bundle patch "${patch.id}": neither the original nor the patched shape found — ${patch.whenMissing}`,
      { filePath }
    );
    return "not-found";
  }

  // Stage and rename: a crash mid-write must never leave a truncated file behind,
  // which would break every workspace until the bundle is re-downloaded.
  const tempPath = `${filePath}${TEMP_SUFFIX}`;
  await fs.writeFile(tempPath, patched);
  await fs.rename(tempPath, filePath);

  logger.info(`Applied bundle patch "${patch.id}"`, { filePath, occurrences });
  return "applied";
}

/**
 * Apply every bundle patch that targets this platform.
 *
 * Returns whether any patch actually rewrote a file — i.e. whether the bundle on
 * disk now differs from what the IDE server may already have served. The caller
 * owes the caches an invalidation when it does; see the module doc.
 *
 * Unpackaged (dev): a patch that cannot be applied throws, failing startup, so the
 * developer who bumped the bundle cannot miss it. Packaged: every failure is
 * logged and swallowed — one stale anchor must not keep the IDE server (and with
 * it every workspace) from starting. See the module doc.
 */
export async function applyBundlePatches(
  deps: BundlePatchDeps,
  bundleDir: string
): Promise<boolean> {
  const { fileSystemLayer, logger, platform, isPackaged } = deps;
  const failed: string[] = [];
  let rewroteBundle = false;

  for (const patch of TEXT_PATCHES) {
    if (patch.platform !== undefined && patch.platform !== platform) continue;

    try {
      const result = await applyTextPatch({ fileSystemLayer, logger }, bundleDir, patch);
      logger.debug("Bundle patch pass complete", { id: patch.id, result });
      if (result === "applied") rewroteBundle = true;
      if (result === "not-found") failed.push(patch.id);
    } catch (error) {
      // An I/O failure (unwritable bundle, …) rather than a stale anchor.
      logger.error(`Bundle patch "${patch.id}" failed`, { error: getErrorMessage(error) });
      failed.push(patch.id);
    }
  }

  if (failed.length > 0 && !isPackaged) {
    throw new IdeServerError(
      `Bundle patch(es) could not be applied: ${failed.join(", ")}. The VSCodium bundle ` +
        `(${bundleDir}) no longer matches what the patch expects — most likely a version bump ` +
        `reshaped the target. Open the file each patch names and update its find/applied ` +
        `patterns in bundle-patches.ts. (Packaged builds log this and start anyway.)`
    );
  }

  return rewroteBundle;
}
