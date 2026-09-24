# CodeHydra API Reference

CodeHydra exposes APIs at two levels:

| Level       | Scope          | Consumers                            |
| ----------- | -------------- | ------------------------------------ |
| **Private** | Full API       | CodeHydra renderer UI only           |
| **Public**  | Workspace-only | VS Code extensions, external systems |

Every operation the Public API exposes comes from one **operation registry**
(`src/api/`). MCP, the plugin wire and the `ch` CLI are generic adapters over it:
none contains per-operation code, so an operation cannot exist on one surface and
be missing — or behave differently — on another. See
[CLAUDE.md](../CLAUDE.md#key-concepts) for the registry's shape.

## Quick Links

- [Public API](#public-api) - Workspace-scoped API for external consumers
  - [VS Code Extension Access](#vs-code-extension-access)
  - [WebSocket Access](#websocket-access)
  - [`ch` CLI](#ch-cli) - the same operations from a shell, and MCP over stdio
- [VS Code Object Serialization](#vs-code-object-serialization) - Format for passing VS Code objects through JSON
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

| Method               | Signature                                                                              | Description                                                           |
| -------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `getStatus`          | `(options?: { refresh?: boolean }) => Promise<WorkspaceStatus>`                        | Get workspace status (dirty flag, unmerged commits, agent status)     |
| `getAgentSession`    | `() => Promise<AgentSession \| null>`                                                  | Get agent session info (port + sessionId, null if server not running) |
| `restartAgentServer` | `() => Promise<number>`                                                                | Restart agent server, preserving port, returns port                   |
| `getMetadata`        | `() => Promise<Record<string, string>>`                                                | Get all metadata (always includes `base` key)                         |
| `setMetadata`        | `(key: string, value: string \| null) => Promise<void>`                                | Set or delete a metadata key                                          |
| `getTags`            | `() => Promise<readonly WorkspaceTag[]>`                                               | Get all tags (metadata entries with the `tags.` prefix)               |
| `setTag`             | `(name: string, options?: TagOptions) => Promise<void>`                                | Set or update a tag (full replace — an omitted option is cleared)     |
| `deleteTag`          | `(name: string) => Promise<void>`                                                      | Delete a tag                                                          |
| `executeCommand`     | `(command: string, args?: readonly unknown[]) => Promise<unknown>`                     | Execute a VS Code command (10-second timeout)                         |
| `create`             | `(name: string, base: string, options?: WorkspaceCreateOptions) => Promise<Workspace>` | Create a new workspace in the same project                            |

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

#### Connect to the Agent Server

```typescript
const session = await api.workspace.getAgentSession();
if (session !== null) {
  // Connect to the agent server at http://127.0.0.1:${session.port}
  // Primary session ID is available as session.sessionId
  const response = await fetch(`http://127.0.0.1:${session.port}/api/sessions`);
  const sessions = await response.json();
}
```

#### Restart OpenCode Server

```typescript
// Restart the OpenCode server to reload configuration changes
try {
  const port = await api.workspace.restartAgentServer();
  console.log(`OpenCode server restarted on port ${port}`);
} catch (error) {
  console.error("Failed to restart:", error);
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

#### Create a New Workspace

```typescript
// Create a new workspace in the same project
const workspace = await api.workspace.create("feature-auth", "main");
console.log("Created workspace:", workspace.name, "at", workspace.path);

// Create workspace with an initial prompt for the AI agent
const workspace = await api.workspace.create("fix-bug-123", "main", {
  initialPrompt: "Fix the login validation bug described in issue #123",
});

// Create workspace with initial prompt and specific agent
const workspace = await api.workspace.create("refactor-api", "main", {
  initialPrompt: { prompt: "Refactor the API module for better testability", agent: "coder" },
  stealFocus: false, // Don't switch to the new workspace
});
```

**Notes:**

- The new workspace is created in the same project as the current workspace
- `initialPrompt` can be a string (uses default agent) or `{ prompt, agent }` object
- If `stealFocus` is `false`, the UI stays on the current workspace (unless no workspace is active); if `true` or omitted, it switches to the new one — but only when the user has not moved to a different workspace while it was being created, since a completing creation never pulls the view back
- The new workspace appears in the sidebar as a "creating" row as soon as the call starts, regardless of `stealFocus`
- The initial prompt is sent asynchronously after the workspace is ready (fire-and-forget)

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

Third-party VS Code extensions running inside VSCodium can access the public API through the codehydra extension's exports.

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
`extensions/sidekick/api.d.ts`

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
  readonly unmergedCommits: number;
  readonly agent: AgentStatus;
}

interface PromptModel {
  readonly providerID: string;
  readonly modelID: string;
}

type InitialPrompt = string | { prompt: string; agent?: string; model?: PromptModel };

interface WorkspaceCreateOptions {
  initialPrompt?: InitialPrompt;
  stealFocus?: boolean;
}

interface Workspace {
  readonly projectId: string;
  readonly name: string;
  readonly branch: string | null;
  /** Always contains a `base` key with the base branch */
  readonly metadata: Readonly<Record<string, string>>;
  readonly path: string;
  readonly url?: string;
}

interface AgentSession {
  readonly port: number;
  readonly sessionId: string;
}

interface WorkspaceTag {
  readonly name: string;
  /** Renders the tag as a pill; without one it is bare text. */
  readonly color?: string;
  /** Shown instead of the name — any UTF-8, typically an emoji. */
  readonly label?: string;
  /** Sidebar hover text, shown instead of the name in the tooltip. */
  readonly description?: string;
}

type TagOptions = { color?: string; label?: string; description?: string };

interface WorkspaceApi {
  getStatus(options?: { refresh?: boolean }): Promise<WorkspaceStatus>;
  getAgentSession(): Promise<AgentSession | null>;
  restartAgentServer(): Promise<number>;
  getMetadata(): Promise<Readonly<Record<string, string>>>;
  setMetadata(key: string, value: string | null): Promise<void>;
  getTags(): Promise<readonly WorkspaceTag[]>;
  setTag(name: string, options?: TagOptions): Promise<void>;
  deleteTag(name: string): Promise<void>;
  executeCommand(command: string, args?: readonly unknown[]): Promise<unknown>;
  create(name: string, base: string, options?: WorkspaceCreateOptions): Promise<Workspace>;
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

1. Read port from `_CH_PLUGIN_PORT` environment variable
2. Connect via Socket.IO to `http://localhost:${port}`
3. Authenticate with workspace path

#### Client kinds

The wire carries three kinds of client, declared in the handshake. They differ in
what they may call and in how operations are addressed.

| Kind     | Handshake                                                   | Addresses operations as      |
| -------- | ----------------------------------------------------------- | ---------------------------- |
| _(none)_ | `{ workspacePath }` — an extension. **Unchanged.**          | `api:workspace:getStatus`, … |
| `cli`    | `{ client: "cli", token, cwd? , workspacePath?, project? }` | `api:operation:<name>`       |
| `mcp`    | `{ client: "mcp", token, cwd?, workspacePath? }`            | `api:operation:<name>`       |

The historical channel names are a compatibility surface for extensions, so they
are kept exactly as they are and never grow for a new client. `ch` and the stdio
MCP shim address operations by registry name instead, which is why adding an
operation does not widen the extension-facing contract.

For a `cli` client, `workspacePath` is the `--workspace` reference (a name or a
path) and `project` the `--project` to look it up in; `cwd` is always sent. The
connection then acts on the named workspace, while the workspace `cwd` sits in
stays the **caller** — what a name is looked up relative to, and who
`agent.message` signs as. For `mcp` and extensions, the caller is the
workspace they present.

**Naming a target.** Every operation that can act on another workspace takes
`workspace` (a name or an absolute path) and `project` (a name or path to look
the name up in). A name is looked up in the caller's project first, where a match
wins; otherwise it must be unique across the other open projects (several →
`usage`, none → `not-found`). `project` without `workspace` is `usage`. These
two fields replace the former path-only `workspacePath` field — a breaking
rename, with no alias. `ch` hides both: its global `--workspace` / `--project`
name the target for the whole connection instead.

Two further differences matter for anyone writing a client:

- **Token.** `cli` and `mcp` clients must present the token from `plugin.token`
  in `state.json`. An extension's handshake carries none and is unaffected.
- **Non-exclusive.** A `cli`/`mcp` connection never becomes the workspace's
  registered socket, so it cannot displace an extension or strand a teardown
  waiting on one — which is also why it may connect during teardown, and with no
  workspace at all (for operations like `project.list` that need none).

```typescript
import { io, Socket } from "socket.io-client";

const port = process.env._CH_PLUGIN_PORT;
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

| Event                              | Request Payload                        | Response                                   |
| ---------------------------------- | -------------------------------------- | ------------------------------------------ |
| `api:workspace:getStatus`          | `GetWorkspaceStatusRequest` (optional) | `PluginResult<WorkspaceStatus>`            |
| `api:workspace:getAgentSession`    | None                                   | `PluginResult<AgentSession \| null>`       |
| `api:workspace:restartAgentServer` | None                                   | `PluginResult<number>`                     |
| `api:workspace:getMetadata`        | None                                   | `PluginResult<Record<string, string>>`     |
| `api:workspace:setMetadata`        | `SetMetadataRequest`                   | `PluginResult<void>`                       |
| `api:workspace:executeCommand`     | `ExecuteCommandRequest`                | `PluginResult<unknown>`                    |
| `api:workspace:openSystemPath`     | `OpenSystemPathRequest`                | `PluginResult<void>`                       |
| `api:workspace:delete`             | `DeleteWorkspaceRequest` (optional)    | `PluginResult<DeleteWorkspaceResponse>`    |
| `api:workspace:create`             | `WorkspaceCreateRequest`               | `PluginResult<Workspace>`                  |
| `api:workspace:agentLifecycle`     | `AgentLifecycleRequest`                | (none, fire-and-forget)                    |
| `api:log`                          | `LogRequest`                           | (none, fire-and-forget)                    |
| `api:workspace:hibernate`          | None                                   | `PluginResult<{ started: boolean }>`       |
| `api:workspace:wake`               | None                                   | `PluginResult<Workspace>`                  |
| `api:workspace:setTitle`           | `{ title: string \| null }`            | `PluginResult<void>`                       |
| `api:workspace:listTags`           | None                                   | `PluginResult<WorkspaceTag[]>`             |
| `api:workspace:setTag`             | `{ name: string } & TagOptions`        | `PluginResult<void>`                       |
| `api:workspace:removeTag`          | `{ name: string }`                     | `PluginResult<void>`                       |
| `api:workspace:openAgent`          | None                                   | `PluginResult<unknown>`                    |
| `api:workspace:closeAgent`         | None                                   | `PluginResult<{ closed: boolean }>`        |
| `api:workspace:sendAgentMessage`   | `SendAgentMessageRequest`              | `PluginResult<null>`                       |
| `api:workspace:setAgentStatus`     | `{ status: "idle" \| "busy" }`         | `PluginResult<void>`                       |
| `api:workspace:showMessage`        | `ShowMessageRequest`                   | `PluginResult<{ result: string \| null }>` |
| `api:workspace:openBrowser`        | `{ url: string }`                      | `PluginResult<unknown>`                    |
| `api:workspace:openDiff`           | `{ left, right, title? }`              | `PluginResult<unknown>`                    |
| `api:workspace:goto`               | `{ location: string }`                 | `PluginResult<unknown>`                    |
| `api:workspace:previewMarkdown`    | `{ path: string }`                     | `PluginResult<unknown>`                    |
| `api:project:list`                 | None                                   | `PluginResult<Project[]>`                  |
| `api:reportIssue`                  | `{ description: string }`              | `PluginResult<{ submitted: true }>`        |
| `api:config:get`                   | `{ key: string }`                      | `PluginResult<unknown>`                    |
| `api:config:list`                  | None                                   | `PluginResult<ConfigRow[]>`                |
| `api:config:set`                   | `{ key: string, value: string }`       | `PluginResult<ConfigRow>`                  |
| `api:config:reset`                 | `{ key: string }`                      | `PluginResult<ConfigRow>`                  |
| `api:notification:show`            | `NotificationShowRequest`              | `PluginResult<{ id } \| { choice }>`       |
| `api:notification:close`           | `{ id: string }`                       | `PluginResult<{ closed: true }>`           |
| `api:registry:describe`            | `{ target: "mcp" \| "cli" }`           | `PluginResult<OperationDescriptor[]>`      |

Everything below `api:log` is new: these operations existed only as MCP tools
before the registry, and are now on both surfaces. Purely additive — no existing
channel changed shape. `ConfigRow` is `{ key, value, default, source, applies, validValues, description }`
(see [Config](#config) below).

**Two behaviour changes to `api:workspace:delete`**, both deliberate:

- `keepBranch` now defaults to **`false`**, matching what the MCP tool has always
  done and what "delete" plainly means. It previously defaulted to `true` here.
- It now **blocks** until deletion finishes and reports real failures, instead of
  returning `{ started: true }` immediately. Pass `wait: false` for the old
  fire-and-forget behaviour.

It also gained `ignoreWarnings`, which the MCP tool already had.

### Event Channels (Server → Client)

| Event                 | Request Payload           | Response                                 | Description                                     |
| --------------------- | ------------------------- | ---------------------------------------- | ----------------------------------------------- |
| `config`              | `PluginConfig`            | (none)                                   | Configuration sent after connection             |
| `command`             | `CommandRequest`          | `PluginResult<unknown>`                  | Execute VS Code command                         |
| `shutdown`            | None                      | `PluginResult<void>`                     | Terminate extension host for workspace deletion |
| `ui:showNotification` | `ShowNotificationRequest` | `PluginResult<ShowNotificationResponse>` | Show a modal notification; acked on dismissal   |
| `ui:statusBarUpdate`  | `StatusBarUpdateRequest`  | `PluginResult<void>`                     | Create or update a status bar item              |
| `ui:statusBarDispose` | `StatusBarDisposeRequest` | `PluginResult<void>`                     | Dispose a status bar item                       |
| `ui:showQuickPick`    | `ShowQuickPickRequest`    | `PluginResult<ShowQuickPickResponse>`    | Show a quick pick list                          |
| `ui:showInputBox`     | `ShowInputBoxRequest`     | `PluginResult<ShowInputBoxResponse>`     | Show an input box                               |

The authoritative declarations for all events and payloads are in `src/shared/plugin-protocol.ts` (compiled by both the CodeHydra server and the sidekick extension).

### Response Format

```typescript
type PluginResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; category?: ApiErrorCategory };
```

`category` (`usage`, `no-workspace`, `conflict`, `not-found`, `failed`) says what kind of
failure it was, so a client can branch without parsing `error`. It is additive: a client that
ignores it reads `error` exactly as before. The `ch` CLI maps it to its exit code.

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

interface PromptModel {
  providerID: string;
  modelID: string;
}

type InitialPrompt = string | { prompt: string; agent?: string; model?: PromptModel };

interface WorkspaceCreateRequest {
  name: string; // Name for the new workspace (becomes branch name)
  base: string; // Base branch to create the workspace from
  initialPrompt?: InitialPrompt; // Optional initial prompt to send to AI agent
  stealFocus?: boolean; // If true, switch to the new workspace. Default: false for API calls
}

interface GetWorkspaceStatusRequest {
  refresh?: boolean; // If true, fetch the remote before reading status (best-effort)
}

interface OpenSystemPathRequest {
  app: "default" | "explorer"; // "explorer" = show in file manager, "default" = open with default app
  path: string; // Absolute path to the file or folder
}

interface AgentLifecycleRequest {
  event: "open" | "close"; // Agent terminal opened/closed
}

interface LogRequest {
  level: string; // silly | debug | info | warn | error
  message: string;
  context?: Record<string, string | number | boolean | null>;
}

interface Workspace {
  projectId: string; // Identifier of the project this workspace belongs to
  name: string; // Workspace name (also the branch name)
  branch: string | null; // Current branch, or null for detached HEAD
  metadata: Readonly<Record<string, string>>; // Always contains a `base` key with the base branch
  path: string; // Absolute path to the workspace directory
  url?: string; // IDE server URL; absent while the workspace is hibernated
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

  async getAgentSession(): Promise<AgentSession | null> {
    return this.emit("api:workspace:getAgentSession");
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
const port = process.env._CH_PLUGIN_PORT;
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

## `ch` CLI

`ch` is the same operations from a shell. It ships in `<dataRoot>/bin` and is on
the PATH of every CodeHydra terminal; add that directory to your own PATH to use
it from an ordinary shell.

```console
$ ch ws status                       # the workspace containing the current directory
$ ch ws create feature-x main --prompt "add the export button"
$ ch ws create review-x --agent claude --permission-mode plan --agent-name reviewer
$ ch ws switch feature-x             # by name, from anywhere
$ ch ws delete --keep-branch
$ ch project open .                  # a path, or a git URL to clone
$ ch project list
$ ch project close ohi               # by name
$ ch project close ohi --remove-local-repo   # also delete its directory (no workspaces left)
$ ch ws notify "build finished" --level warning   # for the user
$ ch ws agent message "main is green again"      # for the agent
$ ch ws diff old.ts new.ts           # builds the $vscode Uri wrappers for you
$ ch lock take device "smoke test"   # wait for, then hold, a shared resource
$ ch config set sidebar.width 300    # writes config.json, like the settings dialog
```

Run `ch --help` for the command list, or `ch <command> --help` for one command's
arguments. Both are built from the running app's registry, so they describe the
operations that instance actually has.

### Conventions

|               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workspace** | Resolved from the current directory — the deepest workspace containing it. `--workspace <name\|path>` overrides (a name: your own project first, then unique elsewhere), and `--project <name\|path>` scopes that name to one project; an unknown name fails the first command that needs a workspace with exit `6`, an ambiguous one with exit `2`. `--project` without `--workspace` is exit `2`, except where the command has its own `--project` (`ws create`). |
| **Arguments** | Flags mirror field names (`--keep-branch` for `keepBranch`); a repeated flag builds a list; a value starting with `[` or `{` is parsed as JSON. `--input '<json>'` supplies the whole payload, so anything expressible through MCP is expressible here. A flag that is neither global nor a field of the operation is a usage error.                                                                                                                                |
| **Output**    | `--format json                                                                                                                                                                                                                                                                                                                                                                                                                                                      | text | auto`. `auto`, the default, is JSON when stdout is not a terminal — a pipe, or an agent's shell — and human-readable when it is. Errors follow the format: JSON mode writes `{"error","exitCode"}` to stderr. |
| **Instance**  | Found by resolving `ch`'s own path to its data directory and reading `plugin.port` and `plugin.token` from `state.json`. `_CH_PLUGIN_PORT` + `_CH_PLUGIN_TOKEN` (given to agents, and to `ch mcp`) take precedence over that; `_CH_DATA_DIR=<path>` beats both and targets the instance with that data directory. `pnpm preview` sets it for the app it launches, so `ch` inside the preview reaches the preview.                                                   |

### Exit codes

| Code | Meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| `0`  | Success                                                               |
| `1`  | The operation ran and failed                                          |
| `2`  | Usage error — unknown command, bad arguments                          |
| `3`  | CodeHydra could not be reached                                        |
| `4`  | The operation needs a workspace and none was found                    |
| `5`  | Refused: someone else holds it (`ch lock take --no-wait`)             |
| `6`  | Not there, or not yours (`ch lock release` of a lock you do not hold) |

`3` and `4` are separate from `1` on purpose: a script that cannot tell "the app
is not running" and "you are in the wrong directory" from "the operation was
refused" cannot retry sensibly. `5` and `6` go further for the refusals a script
most often branches on. The code comes from the failure's `category`, not from the
wording of its message.

Calls have no client-side timeout — `ch lock take` waits its turn, `ch ws ask` waits
for a person — so bound a wait yourself when you need one (`timeout 60 ch …`). An app
that goes away mid-call still ends the call, as exit `3`.

### Locks

`ch lock` gives workspaces turns at a resource only one may touch at a time — one
physical phone, one port, one staging database — without a lock file or a background
process.

```console
$ ch lock take device "install and run the smoke test"   # waits its turn, then returns
$ ch lock ls
name    project  holder  held  reason                           waiting
device           ios     4m    install and run the smoke test   android
$ ch lock release device
$ ch lock run device -- ./install.sh                      # take, run, release
$ ch bg ch lock run device "long session"                 # hold until killed
```

- **The holder is the workspace**, not a process: `take` returns once the lock is granted
  and the hold continues with nothing running, across agent turns. It ends on
  `ch lock release` (no name: everything this workspace holds), when the workspace
  hibernates, or when it is deleted. Closing the agent terminal does not release it.
- **Waiting is FIFO and the grant is atomic**, so there is no gap to lose a race in.
  `take` waits unbounded and prints nothing while it does; run it as a background call.
  `--no-wait` fails at once with exit `5` instead. Over MCP (`lock_take`) it never waits.
- **Re-taking a lock you hold** succeeds and changes nothing. **Releasing one you do not
  hold** is exit `6` — usually a sign the hold ended earlier than you thought.
- **Names** are free-form (`[A-Za-z0-9-_]+`) and exist while held. `--scope global`
  (default) is shared by every workspace of every open project; `--scope project` only by
  this project's. `ch lock ls` shows both, with the project named for a project lock.
- **No implicit steal.** A waiter never takes a held lock. To break one whose holder is
  stuck, release it as the holder from any shell:
  `ch lock release <name> --workspace <holder>`. That ends the hold, not whatever the
  holder is still running.
- **`ch lock run`** ties the lock to its own process: it is released when the command
  exits or `ch` is killed, and only if `run` acquired it — inside an existing hold it
  leaves that hold alone. With no command it holds until killed; start that under
  `ch bg`, or the workspace stays busy for as long as it holds.
- **Advisory.** CodeHydra coordinates; whether a command may run without the lock is for
  your project to enforce, e.g. a hook that checks `ch lock ls --format json`.
- **Sidebar.** A holder shows a `🔒 <names>` tag and a waiter `⏳ <names>`, with the
  reasons as the tooltip. Locks live in memory and are all gone after a restart.

### Sidebar notifications

`ch notification show|close` (MCP `notification_show` / `notification_close`, plugin
`api:notification:show` / `api:notification:close`) raises cards in CodeHydra's own
sidebar — the ones CodeHydra uses for clone progress and errors — through the
`notification:show` / `notification:close` intents. Unlike `ch ws notify` (a toast in one
workspace's editor) they need no workspace.

```console
$ ch notification show "Nightly build finished"
$ ch notification show "Building" --type spinner --percent 20 --format json
{"id":"ntf-3"}
$ ch notification show "Building" --id ntf-3 --type spinner --percent 80
$ ch notification close ntf-3
$ ch notification show "Deploy?" --actions Deploy --actions Skip --wait --attach
choice  Deploy
```

`NotificationShowRequest` is `{ title, message?, type? ("info" default | "warning" |
"error" | "spinner"), percent? (0–100), dismissible? (true), actions?: string[], id?,
attach?, workspace?, project?, wait?, timeout? (seconds) }`.

- **Ids** are minted by CodeHydra. `id` updates that card; a card that is no longer open
  (dismissed) is exit `6`. `close` of a card that is gone does nothing.
- **Collapsing.** A show whose text (title, message, type, dismissible, actions) and
  attached workspace match an open card joins it — the card shows a counter and the
  call gets its id — and the card closes once every show holding it has closed it.
  Progress is not part of the match.
- **Attachment.** `attach` ties the card to the caller's workspace, `workspace` to a
  named one: the card names the workspace, clicking its title switches there, and
  `workspace:deleted` closes it. Otherwise it is app-wide.
- **Waiting.** `wait` blocks and returns `{ choice }`: the clicked action, or `null` on
  dismiss, `timeout`, or the workspace going away. A choice or dismiss closes the card
  and answers every caller waiting on it. A waiter whose connection drops gives up its
  hold, so the question goes away with its last waiter.

### Agent messages

`ch ws agent message <text>` (MCP `workspace_send_agent_message`, plugin
`api:workspace:sendAgentMessage`) puts text into a workspace's **running** agent's
conversation through the `agent:send-message` intent. It is the agent's channel, as the
notifications above, `ws notify`, `ws status-bar` and `ws ask` are the user's.

`SendAgentMessageRequest` is `{ text, wake? (false), workspace?, project? }`. `text` given as
`-` on the command line is read from stdin. The result is `null` once the agent has taken
the message (sent, not read).

- **Sender.** Set from the connection, never from the input:
  `CodeHydra · workspace <name>` for the caller's workspace (a shell's cwd, even when
  `--workspace` names another), `CodeHydra · ch` for a shell outside every workspace, and `CodeHydra · auto-workspace <source>` for events-mode
  automatic workspaces.
- **No agent.** A hibernated workspace fails fast. Without `wake`, a closed agent terminal
  fails too (category `not-found`, exit 6). The operation reports this as
  `{ sent: false, reason }` rather than throwing, so it is not logged as a fault. A
  Claude agent whose terminal is open but which has not announced its inbox yet is
  starting, not absent: the send waits up to 30 s for it even without `wake`. `wake` runs `workspace:wake` (in the background) or
  reopens the agent terminal, then lets the send wait up to 90 s for the agent to become
  reachable.
- **Claude Code.** The SessionStart hook forwards the session's inbox
  (`CLAUDE_CODE_MESSAGING_SOCKET` / `CLAUDE_CODE_MESSAGING_TOKEN`) to the bridge. The
  message is written there as JSON lines, an auth line and then
  `{"type":"user","message":{"role":"user","content":…}}`, with the content wrapped in
  `<cross-session-message from-name="…">`. The docs describe the format wrongly as plain
  text; `server-manager.boundary.test.ts` pins it against the real CLI. No `from-mode` is
  declared, so on macOS and Linux a bypass-permissions session holds the message for its
  user's approval (Claude verifies the sender by process tree, and CodeHydra is not its
  child). On Windows Claude verifies by the token instead, which the auth line must carry,
  so the message counts as the session's own and is delivered in every mode.
- **OpenCode.** `session.promptAsync` on the primary session, prefixed `[from <sender>]`.
  A busy session runs it as its own turn once the current one ends.

### Progress events

The plugin server pushes selected domain events to CLI and MCP clients on
`api:event`, as `{ type, payload }`. Forwarding is opt-in per event, so an event
reaches clients because it was declared, not because it was emitted:

| Event                                                                 | Carries                                                                                                                       |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `clone:progress`                                                      | `{ stage, progress, name, url }` — percentage during a clone                                                                  |
| `project:opened` / `project:open-failed`                              | the project, or the error                                                                                                     |
| `workspace:loading` / `workspace:created` / `workspace:create-failed` | creation start, finish, failure                                                                                               |
| `workspace:deletion-progress`                                         | full state each step: labelled operations, `completed`, `hasErrors`, and `blockingProcesses` when a worktree will not release |

A client scoped to a workspace receives only that workspace's events. A
workspace-less client receives instance-wide ones too — which is what makes a
clone visible, since a clone has no workspace and `project open <url>` is run
from outside every worktree.

### Config

`ch config get|set|reset|list` reads and writes the running app's settings — the
same keys, validation and write path as the settings dialog (MCP: `config_get`,
`config_set`, `config_reset`, `config_list`).

```console
$ ch config get log.level                   # the bare value in effect
$ ch config list                            # key, value, default, source, applies, help
$ ch config set auto-tag.new false          # parsed as --auto-tag.new=false would be
$ ch config set version.claude ""           # empty clears a nullable key
$ ch config set electron.flags -- --disable-gpu   # `--` for a value that starts with a dash
$ ch config reset sidebar.width             # remove from config.json
```

|               |                                                                                                                                                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Keys**      | Exactly the settings dialog's: every registered key except `help` and deprecated ones. Any other key is not found (exit 6); a value the key rejects is a usage error (exit 2).                                                                                         |
| **Values**    | Always a string, run through the key's own parser — the one `--key=value` and `CH_*` use.                                                                                                                                                                              |
| **Rows**      | `set`, `reset` and `list` return `{ key, value, default, source, applies, validValues, description }` (the last two `null` when a key has none). `source` is `default`, `user` (config.json), `env` or `cli`; `applies: restart` means the change waits for a restart. |
| **Secrets**   | A `redact` key reads as `<redacted>` everywhere. An `omit` key (`auto-workspace.sources`) reads as `<omitted>` in `list`, in the clear from `get`.                                                                                                                     |
| **Overrides** | A set over an env var or CLI flag applies now, but the override wins again on the next start — `source` stays `env`/`cli` to say so.                                                                                                                                   |

The app must be running: `ch config` never edits config.json on its own.

### Guide

`ch guide [section]` prints the user guide (docs/USER_GUIDE.md, shipped with the
app) as markdown — the whole guide, or one `##` section by its slug. An unknown
slug fails with exit 6 and lists the valid ones. MCP: `guide`. It is how agents
learn how CodeHydra works; their system prompt points here.

```console
$ ch guide                     # the whole guide
$ ch guide repository-hooks    # one section
```

Unlike other commands, the result is printed as-is when stdout is not a TTY:
`text: true` on the CLI and MCP mappings marks a result as a document. `--format json`
still wraps it in JSON.

### MCP

`ch mcp` runs CodeHydra's MCP server over stdio. Both bundled agents launch it
this way, and any MCP client can:

```jsonc
{
  "type": "stdio",
  "command": "<node>",
  "args": ["<dataRoot>/bin/ch.cjs", "mcp"],
  "env": { "_CH_WORKSPACE_PATH": "…", "_CH_PLUGIN_PORT": "…", "_CH_PLUGIN_TOKEN": "…" },
}
```

The tool list comes from the same registry as the CLI's commands. Passing the
connection in the environment means the shim reads no state file and needs
nothing on PATH.

### Other subcommands

| Command                          | Purpose                                                                                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ch bg <cmd…>`                   | Run a command without keeping the workspace busy. Never contacts the app. Exits with the command's code, or 128 + the signal number if a signal killed it.                    |
| `ch lock run <name> [-- <cmd…>]` | Take a lock and run a command, or hold until killed. See [Locks](#locks).                                                                                                     |
| `ch claude` / `ch opencode`      | The agent launchers. The sidekick types these into the agent terminal; there are no separate launcher scripts. Extra arguments are passed on to `claude` / `opencode attach`. |

---

## VS Code Object Serialization

VS Code commands often require class instances (Uri, Position, Range, etc.) that cannot be serialized through JSON. The `executeCommand` method supports a `$vscode` wrapper format to pass these objects through MCP or WebSocket interfaces.

### Supported Types

| Type      | `$vscode` Value | Required Fields     | Field Types            | Reconstruction                  |
| --------- | --------------- | ------------------- | ---------------------- | ------------------------------- |
| Uri       | `"Uri"`         | `value`             | `string`               | `Uri.parse(value)`              |
| Position  | `"Position"`    | `line`, `character` | `number`, `number`     | `new Position(line, character)` |
| Range     | `"Range"`       | `start`, `end`      | `Position`, `Position` | `new Range(start, end)`         |
| Selection | `"Selection"`   | `anchor`, `active`  | `Position`, `Position` | `new Selection(anchor, active)` |
| Location  | `"Location"`    | `uri`, `range`      | `Uri`, `Range`         | `new Location(uri, range)`      |

### JSON Format Examples

#### Uri

```json
{ "$vscode": "Uri", "value": "file:///path/to/file.ts" }
```

#### Position

```json
{ "$vscode": "Position", "line": 10, "character": 5 }
```

#### Range

```json
{
  "$vscode": "Range",
  "start": { "$vscode": "Position", "line": 10, "character": 5 },
  "end": { "$vscode": "Position", "line": 10, "character": 20 }
}
```

#### Selection

```json
{
  "$vscode": "Selection",
  "anchor": { "$vscode": "Position", "line": 5, "character": 0 },
  "active": { "$vscode": "Position", "line": 10, "character": 15 }
}
```

#### Location (fully nested)

```json
{
  "$vscode": "Location",
  "uri": { "$vscode": "Uri", "value": "file:///path/to/file.ts" },
  "range": {
    "$vscode": "Range",
    "start": { "$vscode": "Position", "line": 10, "character": 5 },
    "end": { "$vscode": "Position", "line": 10, "character": 20 }
  }
}
```

### Usage Example

```typescript
// Open a file using vscode.open command with a Uri argument
await api.workspace.executeCommand("vscode.open", [
  { $vscode: "Uri", value: "file:///c:/path/to/file.ts" },
]);

// Go to a specific location
await api.workspace.executeCommand("editor.action.goToLocations", [
  { $vscode: "Uri", value: "file:///c:/path/to/file.ts" },
  { $vscode: "Position", line: 10, character: 0 },
  [
    {
      $vscode: "Location",
      uri: { $vscode: "Uri", value: "file:///c:/path/to/other.ts" },
      range: {
        $vscode: "Range",
        start: { $vscode: "Position", line: 5, character: 0 },
        end: { $vscode: "Position", line: 5, character: 10 },
      },
    },
  ],
]);
```

### Nested Object Handling

The reconstruction is recursive, processing:

- Arrays: each element is recursively processed
- Objects: each property value is recursively processed
- `$vscode` markers: validated and reconstructed using VS Code constructors

Plain objects and primitives pass through unchanged. Mixed objects work correctly:

```json
{
  "label": "Go to definition",
  "location": { "$vscode": "Location", "uri": {...}, "range": {...} }
}
```

Result: `{ label: "Go to definition", location: <Location instance> }`

### Error Messages

**Unknown type:**

```
Unknown VS Code object type: "Unknown". Supported types: Uri, Position, Range, Selection, Location
```

**Missing field:**

```
Invalid VS Code Position: missing required field "line"
```

**Invalid field type:**

```
Invalid VS Code Position: field "line" must be a number, got string
```

### Limitations

- **Circular references**: Not supported. Will cause stack overflow.
- **$vscode key collision**: If your data genuinely contains a `$vscode` key, wrap it in another object: `{ "data": { "$vscode": "literal" } }`.

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

| Method  | Signature                                                                | Description                            |
| ------- | ------------------------------------------------------------------------ | -------------------------------------- |
| `open`  | `(path: string) => Promise<Project>`                                     | Open a git repository as a project     |
| `close` | `(projectId: ProjectId, options?: ProjectCloseOptions) => Promise<void>` | Close a project and all its workspaces |
| `list`  | `() => Promise<readonly Project[]>`                                      | List all open projects                 |
| `get`   | `(projectId: ProjectId) => Promise<Project \| undefined>`                | Get a project by ID                    |

**`ProjectCloseOptions`:**

```typescript
interface ProjectCloseOptions {
  /**
   * If true, delete the project's own directory from disk — the clone for a
   * project opened from a URL, the user's own working copy for a local one.
   * Implies removing all workspaces (their worktrees would otherwise be
   * orphaned), which only the close confirmation dialog can establish: a
   * dispatch with no dialog behind it is rejected while the project still has
   * workspaces.
   */
  removeLocalRepo?: boolean;
}
```

Cloning from a git URL and base-branch listing are owned by the main-process creation module (the `project:open` intent's `git` payload and the `project:get-bases` intent); they are no longer exposed over renderer IPC.

#### `workspaces` - Workspace Management

| Method               | Signature                                                                                                                                                                                                                      | Description                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`             | `(projectId: ProjectId, name: string, base: string) => Promise<Workspace>`                                                                                                                                                     | Create a new workspace from a base branch                                                                                                                                                                                                                                                                                                                                 |
| `remove`             | `(projectId: ProjectId, workspaceName: WorkspaceName, options?: { keepBranch?: boolean; skipSwitch?: boolean; force?: boolean; unblock?: "kill" \| "close" \| "ignore"; isRetry?: boolean }) => Promise<{ started: boolean }>` | Start workspace removal (fire-and-forget). Returns `{ started: false }` if blocked by idempotency. Options: `force: true` to bypass errors and idempotency, `unblock: "kill"` to kill blocking processes, `"close"` to close file handles (Windows only, requires UAC elevation), `"ignore"` to skip detection entirely. Set `isRetry: true` to skip proactive detection. |
| `get`                | `(projectId: ProjectId, workspaceName: WorkspaceName) => Promise<Workspace \| undefined>`                                                                                                                                      | Get a workspace                                                                                                                                                                                                                                                                                                                                                           |
| `getStatus`          | `(projectId: ProjectId, workspaceName: WorkspaceName) => Promise<WorkspaceStatus>`                                                                                                                                             | Get workspace status                                                                                                                                                                                                                                                                                                                                                      |
| `getOpenCodeSession` | `(projectId: ProjectId, workspaceName: WorkspaceName) => Promise<OpenCodeSession \| null>`                                                                                                                                     | Get OpenCode session info (port + sessionId)                                                                                                                                                                                                                                                                                                                              |
| `restartAgentServer` | `(projectId: ProjectId, workspaceName: WorkspaceName) => Promise<number>`                                                                                                                                                      | Restart agent server, preserving port                                                                                                                                                                                                                                                                                                                                     |
| `setMetadata`        | `(projectId: ProjectId, workspaceName: WorkspaceName, key: string, value: string \| null) => Promise<void>`                                                                                                                    | Set/delete metadata                                                                                                                                                                                                                                                                                                                                                       |
| `getMetadata`        | `(projectId: ProjectId, workspaceName: WorkspaceName) => Promise<Record<string, string>>`                                                                                                                                      | Get all metadata                                                                                                                                                                                                                                                                                                                                                          |
| `executeCommand`     | `(projectId: ProjectId, workspaceName: WorkspaceName, command: string, args?: readonly unknown[]) => Promise<unknown>`                                                                                                         | Execute a VS Code command                                                                                                                                                                                                                                                                                                                                                 |

#### `ui` - UI State Management

| Method               | Signature                                                                                | Description                    |
| -------------------- | ---------------------------------------------------------------------------------------- | ------------------------------ |
| `selectFolder`       | `() => Promise<string \| null>`                                                          | Open native folder picker      |
| `getActiveWorkspace` | `() => Promise<WorkspaceRef \| null>`                                                    | Get currently active workspace |
| `switchWorkspace`    | `(projectId: ProjectId, workspaceName: WorkspaceName, focus?: boolean) => Promise<void>` | Switch to a workspace          |
| `setMode`            | `(mode: UIMode) => Promise<void>`                                                        | Set UI mode                    |

#### `lifecycle` - Application Lifecycle

| Method          | Signature                                   | Description                                             |
| --------------- | ------------------------------------------- | ------------------------------------------------------- |
| `getState`      | `() => Promise<AppStateResult>`             | Get app state and selected agent                        |
| `setAgent`      | `(agent: ConfigAgentType) => Promise<void>` | Save agent selection to config (called after UI choice) |
| `setup`         | `() => Promise<SetupResult>`                | Run first-time setup (does NOT start services)          |
| `startServices` | `() => Promise<SetupResult>`                | Start app services (idempotent, called after loading)   |
| `quit`          | `() => Promise<void>`                       | Quit the application                                    |

**`AppStateResult` return type:**

```typescript
interface AppStateResult {
  state: AppState; // "agent-selection" | "setup" | "loading" | "ready"
  agent: ConfigAgentType | null; // "claude" | "opencode" | null
}
```

**Note:** `getState()` never returns `state: "ready"` - the "ready" state is only reached after `startServices()` completes successfully.

### Events

| Event                         | Payload                                          | Description                                                                  |
| ----------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| `project:opened`              | `{ project: Project }`                           | Project was opened                                                           |
| `project:closed`              | `{ projectId: ProjectId }`                       | Project was closed                                                           |
| `project:bases-updated`       | `{ projectId: ProjectId, bases: BaseInfo[] }`    | Base branches refreshed                                                      |
| `workspace:created`           | `{ projectId: ProjectId, workspace: Workspace }` | Workspace created                                                            |
| `workspace:removed`           | `WorkspaceRef`                                   | Workspace removed                                                            |
| `workspace:switched`          | `WorkspaceRef \| null`                           | Active workspace changed                                                     |
| `workspace:status-changed`    | `WorkspaceRef & { status: WorkspaceStatus }`     | Status changed                                                               |
| `workspace:metadata-changed`  | `{ projectId, workspaceName, key, value }`       | Metadata updated                                                             |
| `workspace:loading-changed`   | `{ path: string, loading: boolean }`             | Workspace loading state changed                                              |
| `workspace:deletion-progress` | `DeletionProgress`                               | Workspace deletion progress update (includes `blockingProcesses` on Windows) |
| `ui:mode-changed`             | `{ mode: UIMode, previousMode: UIMode }`         | UI mode changed                                                              |
| `setup:progress`              | `{ step: SetupStep, message: string }`           | Setup progress (legacy)                                                      |
| `lifecycle:setup-progress`    | `SetupRowProgress`                               | Setup row progress update (3-row model)                                      |

**`SetupRowProgress` payload:**

```typescript
type SetupRowId = "vscode" | "agent" | "setup";
type SetupRowStatus = "pending" | "running" | "done" | "failed";

interface SetupRowProgress {
  id: SetupRowId; // Which row this update is for
  status: SetupRowStatus; // Current status
  progress?: number; // Progress percentage (0-100), only for "running"
  message?: string; // Status message to display
  error?: string; // Error message when status is "failed"
}
```

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
  readonly remoteUrl?: string; // Original git URL if project was cloned
}
```

**Note:** The `remoteUrl` field is present only for projects that were cloned from a git URL (the creation form's clone flow). For projects opened locally via `projects.open()`, this field is undefined.

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
  readonly base?: string;
  readonly derives?: string;
}
```

| Field      | Type      | Description                                                                                                                                                         |
| ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`     | `string`  | Full branch reference (e.g., "main" or "origin/main")                                                                                                               |
| `isRemote` | `boolean` | Whether this is a remote-tracking branch                                                                                                                            |
| `base`     | `string?` | Suggested base branch for creating a workspace. For local branches: `codehydra.base` config value, or matching `origin/*` branch. For remote branches: the full ref |
| `derives`  | `string?` | Derivable workspace name if a workspace can be created from this branch. Set for local branches without worktrees or remote branches without local counterparts     |

#### `UIMode`

```typescript
type UIMode = "workspace" | "dialog" | "shortcut" | "hover";
```

#### `AppState`

```typescript
type AppState = "agent-selection" | "setup" | "loading" | "ready";
```

**States:**

- `agent-selection`: First run, no agent selected yet (shows AgentSelectionDialog)
- `setup`: Agent selected but binaries need to be downloaded (shows SetupScreen)
- `loading`: All binaries available, services starting (shows loading screen)
- `ready`: Services started, application fully operational

**Note:** `getState()` never returns "ready" - that state is only reached after `startServices()` completes successfully.

#### `ConfigAgentType`

```typescript
type ConfigAgentType = "claude" | "opencode";
```

User-selectable agent types. Stored in `config.json` after initial selection.

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

#### `DeletionProgress`

```typescript
interface DeletionProgress {
  readonly workspacePath: WorkspacePath;
  readonly workspaceName: WorkspaceName;
  readonly projectId: ProjectId;
  readonly keepBranch: boolean;
  readonly operations: readonly DeletionOperation[];
  readonly completed: boolean;
  readonly hasErrors: boolean;
  readonly blockingProcesses?: readonly BlockingProcess[]; // Windows only
}

type DeletionOperationId =
  | "closing-handles"
  | "killing-blockers"
  | "kill-terminals"
  | "stop-server"
  | "cleanup-vscode"
  | "detecting-blockers"
  | "cleanup-workspace";

type DeletionOperationStatus = "pending" | "in-progress" | "done" | "error";

interface DeletionOperation {
  readonly id: DeletionOperationId;
  readonly label: string;
  readonly status: DeletionOperationStatus;
  readonly error?: string;
}
```

#### `BlockingProcess`

```typescript
interface BlockingProcess {
  readonly pid: number;
  readonly name: string; // Process name (e.g., "node.exe")
  readonly commandLine: string; // Full command line
  readonly files: readonly string[]; // Paths relative to workspace
  readonly cwd: string | null; // Working directory relative to workspace, or null
}
```

**Field details:**

- `files` - File handles held by this process, paths relative to workspace root
- `cwd` - Process working directory if within workspace (blocks deletion), null otherwise

**Note:** `blockingProcesses` is only populated on Windows when deletion fails due to locked files (EBUSY, EACCES, EPERM). On other platforms, it's always undefined.

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

## Environment Variables

CodeHydra sets environment variables in workspace terminals for integration with extensions and tools.

### General Variables

| Variable          | Description                                            |
| ----------------- | ------------------------------------------------------ |
| `_CH_PLUGIN_PORT` | Socket.IO plugin server port for WebSocket connections |

### Claude Provider Variables

These variables are set when using the Claude agent provider.

| Variable                   | Description                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `_CH_CLAUDE_SETTINGS`      | Path to hooks configuration file                                                                                                                                                                                                                                                                                               |
| `_CH_CLAUDE_MCP_CONFIG`    | Path to MCP configuration file                                                                                                                                                                                                                                                                                                 |
| `_CH_CLAUDE_SYSTEM_PROMPT` | Path to the composed CodeHydra system prompt (`codehydra-prompt-claude.md`), passed to Claude as `--append-system-prompt-file`. Shared by all workspaces (runtime bin dir); required, the wrapper refuses to launch without it. OpenCode gets its own file through `instructions` in `OPENCODE_CONFIG_CONTENT`, not an env var |
| `_CH_BRIDGE_PORT`          | HTTP bridge server port for hook notifications                                                                                                                                                                                                                                                                                 |
| `_CH_PLUGIN_TOKEN`         | Token `ch` and `ch mcp` present when connecting to the plugin server                                                                                                                                                                                                                                                           |
| `_CH_WORKSPACE_PATH`       | Absolute path to the workspace directory                                                                                                                                                                                                                                                                                       |
| `_CH_INITIAL_PROMPT_FILE`  | (Optional) Path to initial prompt JSON file. Contains `{ prompt, model?, agent? }`. The file is deleted after first read by the Claude wrapper.                                                                                                                                                                                |

---

## Source Files

| Purpose              | File                            |
| -------------------- | ------------------------------- |
| Operation registry   | `src/api/registry.ts`           |
| Operation vocabulary | `src/api/names.ts`              |
| Operations           | `src/api/entries/`              |
| Adapter mappings     | `src/api/adapters/*-map.ts`     |
| `ch` CLI             | `src/cli/`                      |
| Core Interface       | `src/shared/api/interfaces.ts`  |
| Type Definitions     | `src/shared/api/types.ts`       |
| IPC Channels         | `src/shared/ipc.ts`             |
| Preload (window.api) | `src/preload/index.ts`          |
| Plugin Protocol      | `src/shared/plugin-protocol.ts` |
| External API Types   | `extensions/sidekick/api.d.ts`  |
