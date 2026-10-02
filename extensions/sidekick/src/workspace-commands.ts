/**
 * The workspace commands the sidekick contributes: reveal / open a file with
 * the system, and read or edit the workspace's tags and metadata (interactive
 * from the command palette, or programmatic with an argument).
 */
import * as vscode from "vscode";
import cssColorNames from "color-name";
import { extractTags, isValidMetadataKey } from "../../../src/shared/api/types";
import { getErrorMessage } from "../../../src/shared/error-utils";
import { codehydraApi, tagKey } from "./codehydra-api";
import { emitApiCall } from "./connection";
import type { SystemPathApp } from "./types";

const SYSTEM_METADATA_KEYS = new Set(["base"]);

function validateMetadataKeyInput(v: string): string | null {
  if (!v) return "Key is required";
  if (!isValidMetadataKey(v)) {
    return "Must start with a letter, use only letters/digits/hyphens/dots (no trailing hyphens)";
  }
  return null;
}

const COLOR_ITEMS: vscode.QuickPickItem[] = [
  { label: "No color", description: "Tag without color" },
  ...Object.entries(cssColorNames).map(([name, [r, g, b]]) => ({
    label: name,
    description: `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`,
  })),
  { label: "Custom hex...", description: "Enter a hex color manually" },
];

/**
 * A command opening the given (else the active editor's) file with a system
 * app; failures are logged and shown.
 */
function openSystemPathCommand(
  app: SystemPathApp,
  failure: { log: string; message: string }
): (uri?: vscode.Uri) => Promise<void> {
  return async (uri) => {
    const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!targetUri || targetUri.scheme !== "file") return;

    try {
      await emitApiCall<void>("api:workspace:openSystemPath", { app, path: targetUri.fsPath });
    } catch (err) {
      const message = getErrorMessage(err);
      codehydraApi.log.error(failure.log, { error: message });
      await vscode.window.showErrorMessage(`${failure.message}: ${message}`);
    }
  };
}

function registerFileCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codehydra.revealInFileExplorer",
      openSystemPathCommand("explorer", {
        log: "Reveal in file explorer failed",
        message: "Failed to reveal in file explorer",
      })
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codehydra.openWithDefaultApp",
      openSystemPathCommand("default", {
        log: "Open with default app failed",
        message: "Failed to open with default application",
      })
    )
  );
}

/** Prompt for a tag's name and color; undefined when the user cancels. */
async function promptForTag(): Promise<{ name: string; color: string | undefined } | undefined> {
  const name = await vscode.window.showInputBox({
    title: "Tag Name",
    prompt: "Enter tag name (letters, digits, hyphens, dots)",
    validateInput: validateMetadataKeyInput,
  });
  if (!name) return undefined;

  const colorPick = await vscode.window.showQuickPick(COLOR_ITEMS, {
    title: "Tag Color",
    placeHolder: "Select a color or search by name",
  });
  if (!colorPick) return undefined;

  if (colorPick.label === "Custom hex...") {
    const hex = await vscode.window.showInputBox({
      title: "Tag Color",
      prompt: "Enter hex color (e.g. #ff0000)",
    });
    return { name, color: hex || undefined };
  }
  if (colorPick.label === "No color") {
    return { name, color: undefined };
  }
  return { name, color: colorPick.description };
}

function registerTagCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codehydra.getTags",
      async (): Promise<readonly { name: string; color?: string }[]> => {
        const metadata = await codehydraApi.workspace.getMetadata();
        const tags = extractTags(metadata);
        if (tags.length === 0) {
          await vscode.window.showInformationMessage("No tags on this workspace");
        } else {
          const items = tags.map((t) => ({
            label: t.name,
            description: t.color ?? "",
          }));
          await vscode.window.showQuickPick(items, {
            title: "Workspace Tags",
            placeHolder: "Tags (read-only)",
          });
        }
        return tags;
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codehydra.setTag",
      async (arg?: {
        name: string;
        color?: string;
        label?: string;
        description?: string;
      }): Promise<void> => {
        let name: string;
        let color: string | undefined;
        // Only the programmatic form carries these; the interactive flow prompts
        // for name and color alone rather than growing two more steps.
        let label: string | undefined;
        let description: string | undefined;

        if (arg && typeof arg.name === "string") {
          name = arg.name;
          color = typeof arg.color === "string" ? arg.color : undefined;
          label = typeof arg.label === "string" ? arg.label.trim() : undefined;
          description = typeof arg.description === "string" ? arg.description.trim() : undefined;
        } else {
          const picked = await promptForTag();
          if (!picked) return;
          ({ name, color } = picked);
        }

        const tag: { color?: string; label?: string; description?: string } = {};
        if (color !== undefined) tag.color = color;
        if (label !== undefined) tag.label = label;
        if (description !== undefined) tag.description = description;
        await codehydraApi.workspace.setMetadata(tagKey(name), JSON.stringify(tag));
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codehydra.deleteTag", async (arg?: string): Promise<void> => {
      let name: string;

      if (typeof arg === "string") {
        name = arg;
      } else {
        const metadata = await codehydraApi.workspace.getMetadata();
        const tags = extractTags(metadata);
        if (tags.length === 0) {
          await vscode.window.showInformationMessage("No tags to delete");
          return;
        }
        const picked = await vscode.window.showQuickPick(
          tags.map((t) => ({
            label: t.name,
            description: t.color ?? "",
          })),
          { title: "Delete Tag", placeHolder: "Select a tag to delete" }
        );
        if (!picked) return;
        name = picked.label;
      }

      await codehydraApi.workspace.setMetadata(tagKey(name), null);
    })
  );
}

function registerMetadataCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codehydra.getMetadata",
      async (): Promise<Record<string, string>> => {
        const metadata = await codehydraApi.workspace.getMetadata();
        const entries = Object.entries(metadata);
        if (entries.length === 0) {
          await vscode.window.showInformationMessage("No metadata on this workspace");
        } else {
          await vscode.window.showQuickPick(
            entries.map(([key, value]) => ({ label: key, description: value })),
            { title: "Workspace Metadata", placeHolder: "Metadata (read-only)" }
          );
        }
        return metadata;
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codehydra.setMetadata",
      async (arg?: { key: string; value: string }): Promise<void> => {
        let key: string;
        let value: string | null;

        if (arg && typeof arg.key === "string" && typeof arg.value === "string") {
          if (SYSTEM_METADATA_KEYS.has(arg.key)) {
            throw new Error(`Cannot set system metadata key: ${arg.key}`);
          }
          key = arg.key;
          value = arg.value;
        } else {
          const keyInput = await vscode.window.showInputBox({
            title: "Metadata Key",
            prompt:
              "Enter metadata key — e.g. 'title' sets the sidebar display title (letters, digits, hyphens, dots)",
            validateInput: (v) => {
              const error = validateMetadataKeyInput(v);
              if (error) return error;
              if (SYSTEM_METADATA_KEYS.has(v)) return `"${v}" is a system key and cannot be set`;
              return null;
            },
          });
          if (keyInput === undefined) return;
          key = keyInput;

          const valueInput = await vscode.window.showInputBox({
            title: "Metadata Value",
            prompt: `Enter value for "${key}" — leave empty to delete the key`,
          });
          if (valueInput === undefined) return;
          // An empty value deletes the key (you can't type null in an input box).
          value = valueInput === "" ? null : valueInput;
        }

        await codehydraApi.workspace.setMetadata(key, value);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codehydra.deleteMetadata",
      async (arg?: string): Promise<void> => {
        let key: string;

        if (typeof arg === "string") {
          if (SYSTEM_METADATA_KEYS.has(arg)) {
            throw new Error(`Cannot delete system metadata key: ${arg}`);
          }
          key = arg;
        } else {
          const metadata = await codehydraApi.workspace.getMetadata();
          const deletable = Object.keys(metadata).filter((k) => !SYSTEM_METADATA_KEYS.has(k));
          if (deletable.length === 0) {
            await vscode.window.showInformationMessage("No deletable metadata keys");
            return;
          }
          const picked = await vscode.window.showQuickPick(
            deletable.map((k) => ({ label: k, description: metadata[k] })),
            { title: "Delete Metadata", placeHolder: "Select a key to delete" }
          );
          if (!picked) return;
          key = picked.label;
        }

        await codehydraApi.workspace.setMetadata(key, null);
      }
    )
  );
}

/** Register the file, tag and metadata commands. */
export function registerWorkspaceCommands(context: vscode.ExtensionContext): void {
  registerFileCommands(context);
  registerTagCommands(context);
  registerMetadataCommands(context);
}
