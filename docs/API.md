# CodeHydra API Reference

CodeHydra exposes APIs at two levels:

| Level       | Scope          | Consumers                            |
| ----------- | -------------- | ------------------------------------ |
| **Private** | Full API       | CodeHydra renderer UI only           |
| **Public**  | Workspace-only | VS Code extensions, external systems |

## Quick Links

- [Public API](#public-api) - Workspace-scoped API for external consumers
  - [VS Code Extension Access](#vs-code-extension-access)
  - [WebSocket Access](#websocket-access)
- [Private API](#private-api) - Full API for CodeHydra internals
- [Type Definitions](#type-definitions) - Shared types

For architectural details, see [docs/ARCHITECTURE.md](ARCHITECTURE.md).

---

## Public API

The public API provides a **workspace-scoped subset** of CodeHydra's functionality, designed for external consumers. Each connection operates on a single workspace.

### Access Methods

| Method                                         | Use Case                       | Connection                      |
| ---------------------------------------------- | ------------------------------ | ------------------------------- |
| [VS Code Extension](#vs-code-extension-access) | Third-party VS Code extensions | Via codehydra extension exports |
| [WebSocket](#websocket-access)                 | Other external systems         | Direct Socket.IO connection     |

Both methods provide the same API contract - only the transport differs.

### API Reference

#### Connection

| Method      | Signature             | Description                                                            |
| ----------- | --------------------- | ---------------------------------------------------------------------- |
| `whenReady` | `() => Promise<void>` | Wait for connection to CodeHydra. Call before using workspace methods. |

#### `workspace` Namespace

All methods operate on the **connected workspace**.

| Method            | Signature                                                            | Description                                       |
| ----------------- | -------------------------------------------------------------------- | ------------------------------------------------- |
| `getStatus`       | `() => Promise<WorkspaceStatus>`                                     | Get workspace status (dirty flag, agent status)   |
| `getOpencodePort` | `() => Promise<number \| null>`                                      | Get OpenCode server port (null if not running)    |
| `getMetadata`     | `() => Promise<Record<string, string>>`                              | Get all metadata (always includes `base` key)     |
| `setMetadata`     | `(key: string, value: string \| null) => Promise<void>`              | Set or delete a metadata key                      |
| `executeCommand`  | `(command: string, args?: unknown[]) => Promise<unknown>`            | Execute a VS Code command (10-second timeout)     |
| `delete`          | `(options?: { keepBranch?: boolean }) => Promise<{ started: true }>` | Delete the workspace (terminates OpenCode, async) |

#### `log` Namespace

Structured logging to CodeHydra's centralized logging system. All methods are fire-and-forget.

| Method  | Signature                                         | Description                                      |
| ------- | ------------------------------------------------- | ------------------------------------------------ |
| `silly` | `(message: string, context?: LogContext) => void` | Most verbose - per-iteration details             |
| `debug` | `(message: string, context?: LogContext) => void` | Development tracing information                  |
| `info`  | `(message: string, context?: LogContext) => void` | Significant operations (start/stop, completions) |
| `warn`  | `(message: string, context?: LogContext) => void` | Recoverable issues or deprecated behavior        |
| `error` | `(message: string, context?: LogContext) => void` | Failures that require attention                  |

**LogContext Type:**

```typescript
type LogContext = Record<string, string | number | boolean | null>;
```

**Note:** Logs appear in CodeHydra's log files with the `[extension]` scope. The workspace path is automatically appended to the context.

### Usage Examples

#### Check if Workspace Has Uncommitted Changes

```typescript
const status = await api.workspace.getStatus();
if (status.isDirty) {
  console.log("You have uncommitted changes");
}
```

#### Get Agent Status

```typescript
const status = await api.workspace.getStatus();
switch (status.agent.type) {
  case "none":
    console.log("No AI agents active");
    break;
  case "idle":
    console.log(`${status.agent.counts.total} agent(s), all idle`);
    break;
  case "busy":
    console.log(`${status.agent.counts.busy} agent(s) working`);
    break;
  case "mixed":
    console.log(`${status.agent.counts.busy} busy, ${status.agent.counts.idle} idle`);
    break;
}
```

#### Connect to OpenCode Server

```typescript
const port = await api.workspace.getOpencodePort();
if (port !== null) {
  // Connect to OpenCode API at http://localhost:${port}
  const response = await fetch(`http://localhost:${port}/api/sessions`);
  const sessions = await response.json();
}
```

#### Store Custom Workspace Metadata

```typescript
// Set metadata
await api.workspace.setMetadata("note", "Working on feature X");
await api.workspace.setMetadata("model-name", "claude-3-5-sonnet");

// Read metadata
const metadata = await api.workspace.getMetadata();
console.log("Base branch:", metadata.base); // Always present
console.log("Note:", metadata.note);

// Delete metadata
await api.workspace.setMetadata("note", null);
```

#### Delete Current Workspace

```typescript
// Delete workspace (removes worktree and branch)
const result = await api.workspace.delete();
console.log("Deletion started:", result.started);

// Delete workspace but keep the git branch
const result = await api.workspace.delete({ keepBranch: true });
```

**Note:** Deletion is async - the Promise resolves immediately with `{ started: true }`. The actual cleanup happens in the background.

#### Execute VS Code Commands

```typescript
// Save all files
await api.workspace.executeCommand("workbench.action.files.saveAll");

// Open settings
await api.workspace.executeCommand("workbench.action.openSettings");

// Command with return value (some commands return data)
const text = await api.workspace.executeCommand("editor.action.getSelectedText");

// Command with arguments
await api.workspace.executeCommand("vscode.openFolder", ["/path/to/folder"]);
```

**Note:** Most VS Code commands return `undefined`. The return type is `unknown` because command return types are not statically typed. Commands have a 10-second timeout.

### Metadata Key Format

Metadata keys must follow this format:

- Start with a letter (a-z, A-Z)
- Contain only letters, digits, and hyphens
- Not end with a hyphen
- Maximum 64 characters

**Valid keys:** `base`, `note`, `model-name`, `AI-model`  
**Invalid keys:** `_private`, `my_key`, `123note`, `note-`

### Error Handling

All API methods return rejected Promises on failure. The rejection reason is a string error message:

```typescript
try {
  await api.workspace.setMetadata("key", "value");
} catch (error) {
  // error is a string describing what went wrong
  console.error("Failed to set metadata:", error);
}
```

### Timeout

All API calls have a **10-second timeout**. If CodeHydra doesn't respond within this time, the Promise is rejected.

---

## VS Code Extension Access

Third-party VS Code extensions running inside code-server can access the public API through the codehydra extension's exports.

### Getting the API

```typescript
import * as vscode from "vscode";

async function getCodehydraApi() {
  const ext = vscode.extensions.getExtension("codehydra.codehydra");
  const api = ext?.exports?.codehydra;

  if (!api) {
    throw new Error("CodeHydra extension not available");
  }

  // Wait for connection to CodeHydra
  await api.whenReady();

  return api;
}
```

### Complete Example

```typescript
import * as vscode from "vscode";

export async function activate(context: vscode.ExtensionContext) {
  // Get the CodeHydra API
  const ext = vscode.extensions.getExtension("codehydra.codehydra");
  const api = ext?.exports?.codehydra;

  if (!api) {
    vscode.window.showWarningMessage("CodeHydra extension not available");
    return;
  }

  await api.whenReady();

  // Register a command that uses the API
  const disposable = vscode.commands.registerCommand("myext.showStatus", async () => {
    try {
      const status = await api.workspace.getStatus();
      const dirty = status.isDirty ? "dirty" : "clean";
      const agents =
        status.agent.type === "none" ? "no agents" : `${status.agent.counts.total} agent(s)`;

      vscode.window.showInformationMessage(`Workspace: ${dirty}, ${agents}`);
    } catch (error) {
      vscode.window.showErrorMessage(`API error: ${error}`);
    }
  });

  context.subscriptions.push(disposable);
}
```

### Type Declarations

For TypeScript support, copy the type declarations from:  
`extensions/codehydra-sidekick/api.d.ts`

Or use these inline definitions:

```typescript
interface AgentStatusCounts {
  readonly idle: number;
  readonly busy: number;
  readonly total: number;
}

type AgentStatus =
  | { readonly type: "none" }
  | { readonly type: "idle"; readonly counts: AgentStatusCounts }
  | { readonly type: "busy"; readonly counts: AgentStatusCounts }
  | { readonly type: "mixed"; readonly counts: AgentStatusCounts };

interface WorkspaceStatus {
  readonly isDirty: boolean;
  readonly agent: AgentStatus;
}

interface WorkspaceApi {
  getStatus(): Promise<WorkspaceStatus>;
  getOpencodePort(): Promise<number | null>;
  getMetadata(): Promise<Readonly<Record<string, string>>>;
  setMetadata(key: string, value: string | null): Promise<void>;
  executeCommand(command: string, args?: readonly unknown[]): Promise<unknown>;
  delete(options?: { keepBranch?: boolean }): Promise<{ started: boolean }>;
}

interface CodehydraApi {
  whenReady(): Promise<void>;
  readonly workspace: WorkspaceApi;
}
```

---

## WebSocket Access

External systems can connect directly to CodeHydra's plugin server via Socket.IO WebSocket.

### Architecture

```
┌───────────────────────────────────────────────────────────────┐
│               CodeHydra (Electron Main Process)               │
│                                                               │
│   ┌─────────────────────────────────────────────────────┐     │
│   │              PluginServer (Socket.IO)               │     │
│   │                   :dynamic port                     │     │
│   │                                                     │     │
│   │   Handles: api:workspace:* events                   │     │
│   └─────────────────────────────────────────────────────┘     │
│                            ▲                                   │
└────────────────────────────┼───────────────────────────────────┘
                             │ localhost:port (WebSocket)
                             │
              ┌──────────────┴──────────────┐
              │                             │
    ┌─────────▼─────────┐       ┌───────────▼───────────┐
    │ codehydra ext     │       │ Your external system  │
    │ (built-in client) │       │ (custom client)       │
    └───────────────────┘       └───────────────────────┘
```

### Connection

1. Read port from `CODEHYDRA_PLUGIN_PORT` environment variable
2. Connect via Socket.IO to `http://localhost:${port}`
3. Authenticate with workspace path

```typescript
import { io, Socket } from "socket.io-client";

const port = process.env.CODEHYDRA_PLUGIN_PORT;
if (!port) {
  throw new Error("Not running inside CodeHydra workspace");
}

const socket = io(`http://localhost:${port}`, {
  auth: {
    workspacePath: "/absolute/path/to/workspace",
  },
});

socket.on("connect", () => {
  console.log("Connected to CodeHydra");
});

socket.on("connect_error", (error) => {
  console.error("Connection failed:", error.message);
});
```

### Event Channels (Client → Server)

All events use acknowledgment callbacks for request/response pattern.

| Event                           | Request Payload          | Response                                |
| ------------------------------- | ------------------------ | --------------------------------------- |
| `api:workspace:getStatus`       | None                     | `PluginResult<WorkspaceStatus>`         |
| `api:workspace:getOpencodePort` | None                     | `PluginResult<number \| null>`          |
| `api:workspace:getMetadata`     | None                     | `PluginResult<Record<string, string>>`  |
| `api:workspace:setMetadata`     | `SetMetadataRequest`     | `PluginResult<void>`                    |
| `api:workspace:executeCommand`  | `ExecuteCommandRequest`  | `PluginResult<unknown>`                 |
| `api:workspace:delete`          | `DeleteWorkspaceRequest` | `PluginResult<DeleteWorkspaceResponse>` |

### Event Channels (Server → Client)

| Event      | Request Payload  | Response                | Description                                     |
| ---------- | ---------------- | ----------------------- | ----------------------------------------------- |
| `config`   | `PluginConfig`   | (none)                  | Configuration sent after connection             |
| `command`  | `CommandRequest` | `PluginResult<unknown>` | Execute VS Code command                         |
| `shutdown` | None             | `PluginResult<void>`    | Terminate extension host for workspace deletion |

### Response Format

```typescript
type PluginResult<T> = { success: true; data: T } | { success: false; error: string };
```

### Request Types

```typescript
interface SetMetadataRequest {
  key: string; // Must match /^[A-Za-z][A-Za-z0-9-]*$/ and not end with hyphen
  value: string | null; // null to delete
}

interface ExecuteCommandRequest {
  command: string; // VS Code command identifier (e.g., "workbench.action.files.save")
  args?: unknown[]; // Optional arguments to pass to the command
}

interface DeleteWorkspaceRequest {
  keepBranch?: boolean; // If true, keep the git branch after deletion. Default: false
}

interface DeleteWorkspaceResponse {
  started: boolean; // True if deletion was started (deletion is async)
}
```

### Example Client

```typescript
import { io, Socket } from "socket.io-client";

class CodehydraClient {
  private socket: Socket;
  private connected = false;

  constructor(port: number, workspacePath: string) {
    this.socket = io(`http://localhost:${port}`, {
      auth: { workspacePath },
    });

    this.socket.on("connect", () => {
      this.connected = true;
    });

    this.socket.on("disconnect", () => {
      this.connected = false;
    });
  }

  async whenReady(): Promise<void> {
    if (this.connected) return;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout"));
      }, 10000);

      this.socket.once("connect", () => {
        clearTimeout(timeout);
        resolve();
      });

      this.socket.once("connect_error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async getStatus(): Promise<WorkspaceStatus> {
    return this.emit("api:workspace:getStatus");
  }

  async getOpencodePort(): Promise<number | null> {
    return this.emit("api:workspace:getOpencodePort");
  }

  async getMetadata(): Promise<Record<string, string>> {
    return this.emit("api:workspace:getMetadata");
  }

  async setMetadata(key: string, value: string | null): Promise<void> {
    return this.emit("api:workspace:setMetadata", { key, value });
  }

  private emit<T>(event: string, payload?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Request timeout"));
      }, 10000);

      const callback = (result: PluginResult<T>) => {
        clearTimeout(timeout);
        if (result.success) {
          resolve(result.data);
        } else {
          reject(new Error(result.error));
        }
      };

      if (payload !== undefined) {
        this.socket.emit(event, payload, callback);
      } else {
        this.socket.emit(event, callback);
      }
    });
  }

  disconnect(): void {
    this.socket.disconnect();
  }
}

// Usage
const port = process.env.CODEHYDRA_PLUGIN_PORT;
if (!port) {
  throw new Error("Not running inside CodeHydra workspace");
}

const client = new CodehydraClient(parseInt(port), "/path/to/workspace");

await client.whenReady();
const status = await client.getStatus();
console.log("Dirty:", status.isDirty);
```

### Server-to-Client Commands

CodeHydra can also send commands TO connected clients:

```typescript
interface CommandRequest {
  command: string; // VS Code command ID
  args?: unknown[]; // Optional arguments
}

// Handle incoming commands
socket.on("command", (request: CommandRequest, ack: (result: PluginResult<unknown>) => void) => {
  try {
    // Execute the command
    const result = executeCommand(request.command, request.args);
    ack({ success: true, data: result });
  } catch (error) {
    ack({ success: false, error: String(error) });
  }
});
```

This is used by CodeHydra to send startup commands (close sidebars, open terminal) when a workspace connects.

---

## Private API

The private API is used exclusively by CodeHydra's renderer process (Svelte UI) to communicate with the main Electron process via IPC. **This API is not intended for external consumers.**

### Access Pattern

```typescript
// In renderer code, import from $lib/api for mockability
import { projects, workspaces, ui, lifecycle, on } from "$lib/api";

// Open a project
const project = await projects.open("/path/to/repo");

// Create a workspace
const workspace = await workspaces.create(project.id, "feature-x", "main");

// Subscribe to events
const unsubscribe = on("workspace:switched", (event) => {
  console.log(`Switched to ${event.workspaceName}`);
});
```

### API Namespaces

#### `projects` - Project Management

| Method       | Signature                                                  | Description                            |
| ------------ | ---------------------------------------------------------- | -------------------------------------- |
| `open`       | `(path: string) => Promise<Project>`                       | Open a git repository as a project     |
| `close`      | `(projectId: ProjectId) => Promise<void>`                  | Close a project and all its workspaces |
| `list`       | `() => Promise<readonly Project[]>`                        | List all open projects                 |
| `get`        | `(projectId: ProjectId) => Promise<Project \| undefined>`  | Get a project by ID                    |
| `fetchBases` | `(projectId: ProjectId) => Promise<{ bases: BaseInfo[] }>` | Fetch available base branches          |

#### `workspaces` - Workspace Management

| Method            | Signature                                                                                                              | Description                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `create`          | `(projectId: ProjectId, name: string, base: string) => Promise<Workspace>`                                             | Create a new workspace from a base branch |
| `remove`          | `(projectId: ProjectId, workspaceName: WorkspaceName, keepBranch?: boolean) => Promise<{ started: true }>`             | Start workspace removal (fire-and-forget) |
| `forceRemove`     | `(projectId: ProjectId, workspaceName: WorkspaceName) => Promise<void>`                                                | Force remove (skip cleanup)               |
| `get`             | `(projectId: ProjectId, workspaceName: WorkspaceName) => Promise<Workspace \| undefined>`                              | Get a workspace                           |
| `getStatus`       | `(projectId: ProjectId, workspaceName: WorkspaceName) => Promise<WorkspaceStatus>`                                     | Get workspace status                      |
| `getOpencodePort` | `(projectId: ProjectId, workspaceName: WorkspaceName) => Promise<number \| null>`                                      | Get OpenCode server port                  |
| `setMetadata`     | `(projectId: ProjectId, workspaceName: WorkspaceName, key: string, value: string \| null) => Promise<void>`            | Set/delete metadata                       |
| `getMetadata`     | `(projectId: ProjectId, workspaceName: WorkspaceName) => Promise<Record<string, string>>`                              | Get all metadata                          |
| `executeCommand`  | `(projectId: ProjectId, workspaceName: WorkspaceName, command: string, args?: readonly unknown[]) => Promise<unknown>` | Execute a VS Code command                 |

#### `ui` - UI State Management

| Method               | Signature                                                                                | Description                    |
| -------------------- | ---------------------------------------------------------------------------------------- | ------------------------------ |
| `selectFolder`       | `() => Promise<string \| null>`                                                          | Open native folder picker      |
| `getActiveWorkspace` | `() => Promise<WorkspaceRef \| null>`                                                    | Get currently active workspace |
| `switchWorkspace`    | `(projectId: ProjectId, workspaceName: WorkspaceName, focus?: boolean) => Promise<void>` | Switch to a workspace          |
| `setMode`            | `(mode: UIMode) => Promise<void>`                                                        | Set UI mode                    |

#### `lifecycle` - Application Lifecycle

| Method     | Signature                    | Description                        |
| ---------- | ---------------------------- | ---------------------------------- |
| `getState` | `() => Promise<AppState>`    | Get app state ("setup" or "ready") |
| `setup`    | `() => Promise<SetupResult>` | Run first-time setup               |
| `quit`     | `() => Promise<void>`        | Quit the application               |

### Events

| Event                         | Payload                                          | Description                        |
| ----------------------------- | ------------------------------------------------ | ---------------------------------- |
| `project:opened`              | `{ project: Project }`                           | Project was opened                 |
| `project:closed`              | `{ projectId: ProjectId }`                       | Project was closed                 |
| `project:bases-updated`       | `{ projectId: ProjectId, bases: BaseInfo[] }`    | Base branches refreshed            |
| `workspace:created`           | `{ projectId: ProjectId, workspace: Workspace }` | Workspace created                  |
| `workspace:removed`           | `WorkspaceRef`                                   | Workspace removed                  |
| `workspace:switched`          | `WorkspaceRef \| null`                           | Active workspace changed           |
| `workspace:status-changed`    | `WorkspaceRef & { status: WorkspaceStatus }`     | Status changed                     |
| `workspace:metadata-changed`  | `{ projectId, workspaceName, key, value }`       | Metadata updated                   |
| `workspace:deletion-progress` | `DeletionProgress`                               | Workspace deletion progress update |
| `ui:mode-changed`             | `{ mode: UIMode, previousMode: UIMode }`         | UI mode changed                    |
| `setup:progress`              | `{ step: SetupStep, message: string }`           | Setup progress                     |

---

## Type Definitions

### Core Types

#### `ProjectId`

Branded string identifying a project. Format: `<name>-<8-hex-hash>`

```typescript
type ProjectId = string & { readonly [ProjectIdBrand]: true };
// Example: "my-app-a1b2c3d4"
```

#### `WorkspaceName`

Branded string identifying a workspace. Typically matches the git branch name.

```typescript
type WorkspaceName = string & { readonly [WorkspaceNameBrand]: true };
// Example: "feature-x"
```

#### `Project`

```typescript
interface Project {
  readonly id: ProjectId;
  readonly name: string; // Folder name
  readonly path: string; // Absolute path
  readonly workspaces: readonly Workspace[];
  readonly defaultBaseBranch?: string;
}
```

#### `Workspace`

```typescript
interface Workspace {
  readonly projectId: ProjectId;
  readonly name: WorkspaceName;
  readonly branch: string | null; // null for detached HEAD
  readonly metadata: Readonly<Record<string, string>>;
  readonly path: string;
}
```

#### `WorkspaceRef`

```typescript
interface WorkspaceRef {
  readonly projectId: ProjectId;
  readonly workspaceName: WorkspaceName;
  readonly path: string;
}
```

#### `WorkspaceStatus`

```typescript
interface WorkspaceStatus {
  readonly isDirty: boolean;
  readonly agent: AgentStatus;
}
```

#### `AgentStatus`

```typescript
type AgentStatus =
  | { readonly type: "none" }
  | { readonly type: "idle"; readonly counts: AgentStatusCounts }
  | { readonly type: "busy"; readonly counts: AgentStatusCounts }
  | { readonly type: "mixed"; readonly counts: AgentStatusCounts };

interface AgentStatusCounts {
  readonly idle: number;
  readonly busy: number;
  readonly total: number;
}
```

#### `BaseInfo`

```typescript
interface BaseInfo {
  readonly name: string;
  readonly isRemote: boolean;
}
```

#### `UIMode`

```typescript
type UIMode = "workspace" | "dialog" | "shortcut" | "hover";
```

#### `AppState`

```typescript
type AppState = "setup" | "ready";
```

#### `SetupProgress` / `SetupResult`

```typescript
type SetupStep = "binary-download" | "extensions" | "settings";

interface SetupProgress {
  readonly step: SetupStep;
  readonly message: string;
}

type SetupResult =
  | { readonly success: true }
  | { readonly success: false; readonly message: string; readonly code: string };
```

---

## API Comparison

| Aspect              | Private API                       | Public API                        |
| ------------------- | --------------------------------- | --------------------------------- |
| **Access**          | `window.api` via Electron preload | Extension exports or WebSocket    |
| **Scope**           | Full API (all namespaces)         | Workspace-scoped only             |
| **Identifiers**     | `ProjectId` + `WorkspaceName`     | Auto-resolved from workspace path |
| **Events**          | Full event subscription           | Polling only (no events)          |
| **Cross-workspace** | Yes (switch, list, etc.)          | No (own workspace only)           |
| **UI Control**      | Yes (`ui.*` methods)              | No                                |
| **Lifecycle**       | Yes (`lifecycle.*` methods)       | No                                |
| **Intended Use**    | CodeHydra internals only          | External consumers                |

---

## Source Files

| Purpose              | File                                     |
| -------------------- | ---------------------------------------- |
| Core Interface       | `src/shared/api/interfaces.ts`           |
| Type Definitions     | `src/shared/api/types.ts`                |
| IPC Channels         | `src/shared/ipc.ts`                      |
| Preload (window.api) | `src/preload/index.ts`                   |
| Plugin Protocol      | `src/shared/plugin-protocol.ts`          |
| External API Types   | `extensions/codehydra-sidekick/api.d.ts` |
