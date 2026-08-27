/**
 * The registry's contents.
 *
 * This is the one list. Everything the MCP, plugin and CLI adapters expose is
 * assembled here, so a surface cannot gain or lose an operation by accident.
 */

import { OperationRegistry } from "../registry";
import type { Logger } from "../../boundaries/platform/logging";
import type { EntryDeps } from "./deps";
import { workspaceEntries } from "./workspace";
import { metadataEntries } from "./metadata";
import { agentEntries } from "./agent";
import { vscodeEntries } from "./vscode";
import { appEntries } from "./app";

export type { EntryDeps } from "./deps";

/** What a caller supplies; the registry back-reference is wired here. */
export type RegistryDeps = Omit<EntryDeps, "registry">;

export function createRegistry(deps: RegistryDeps, logger: Logger): OperationRegistry {
  // The describe entry needs the finished registry it is itself a member of, so
  // the reference is closed over and filled in below rather than passed in.
  const box: { current?: OperationRegistry } = {};
  const full: EntryDeps = {
    ...deps,
    registry: () => {
      if (!box.current) throw new Error("Registry accessed before construction finished");
      return box.current;
    },
  };

  box.current = new OperationRegistry([
    ...workspaceEntries(full),
    ...metadataEntries(full),
    ...agentEntries(full),
    ...vscodeEntries(full),
    ...appEntries(full, logger),
  ]);
  return box.current;
}
