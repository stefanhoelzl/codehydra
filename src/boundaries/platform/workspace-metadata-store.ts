/**
 * WorkspaceMetadataStore - every open workspace's metadata, held in memory and
 * persisted to one JSON file per workspace.
 *
 * Owned by the core workspace registry (`modules/workspace-registry-module.ts`).
 * Where a workspace's file lives is its project type's call, handed over as a
 * locator: git keeps it in the worktree's private git directory
 * (`.git/worktrees/<id>/codehydra.json`), so it follows `git worktree move` and
 * goes away with `git worktree remove`. The locator runs once, on the first
 * write; reads never need it.
 *
 * Memory is authoritative while the app runs: a workspace's metadata is handed
 * over when it is tracked (its type read the file at discovery), and every later
 * read is served from memory. A write replaces the file atomically (temp file +
 * rename) before memory changes, so a failed write leaves both as they were.
 * Writes to one workspace run one after another; different workspaces write in
 * parallel.
 *
 * `readMetadataFile` / `writeMetadataFile` are the file format on its own, for a
 * type that reads or writes a file before the workspace is tracked (git's
 * discovery and adoption).
 */

import { z } from "zod/v4";
import type { FileSystemBoundary } from "./filesystem";
import type { Logger } from "./logging";
import { FileSystemError, getErrorMessage } from "../../shared/errors/service-errors";
import { metadataTier, type MetadataTier } from "../../utils/metadata-tier";
import { Path } from "../../utils/path/path";

/** File name inside a worktree's git directory. */
export const METADATA_FILE_NAME = "codehydra.json";

const FILE_VERSION = 1;

/** Makes temp-file names unique within this process. */
let tempCounter = 0;

const sectionSchema = z.record(z.string(), z.string());

/** On-disk shape: one flat key → value section per tier. */
const metadataFileSchema = z.object({
  version: z.literal(FILE_VERSION),
  internal: sectionSchema,
  protected: sectionSchema,
  public: sectionSchema,
});

type MetadataFile = z.infer<typeof metadataFileSchema>;

export type Metadata = Readonly<Record<string, string>>;

/** Finds a workspace's metadata file. Called at most once per tracked workspace. */
export type MetadataLocator = () => Promise<Path>;

export type MetadataFileSystem = Pick<
  FileSystemBoundary,
  "readFile" | "writeFile" | "rename" | "unlink"
>;

function toFile(metadata: Metadata): MetadataFile {
  const sections: Record<MetadataTier, Record<string, string>> = {
    internal: {},
    protected: {},
    public: {},
  };
  for (const [key, value] of Object.entries(metadata)) {
    sections[metadataTier(key)][key] = value;
  }
  return { version: FILE_VERSION, ...sections };
}

/**
 * Read a metadata file. Null when there is none — a workspace CodeHydra has not
 * written one for yet. A file that cannot be parsed reads as empty (and is
 * logged): the next write replaces it.
 */
export async function readMetadataFile(
  fileSystem: Pick<FileSystemBoundary, "readFile">,
  logger: Logger,
  file: Path
): Promise<Metadata | null> {
  let content: string;
  try {
    content = await fileSystem.readFile(file);
  } catch (error) {
    if (error instanceof FileSystemError && error.fsCode === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = metadataFileSchema.parse(JSON.parse(content));
    return { ...parsed.internal, ...parsed.protected, ...parsed.public };
  } catch (error) {
    logger
      .scoped({ path: file.toString() })
      .warn("Unreadable workspace metadata file; treating it as empty", {
        error: getErrorMessage(error),
      });
    return {};
  }
}

/** Replace `file` atomically: write a sibling temp file, then rename it over. */
export async function writeMetadataFile(
  fileSystem: MetadataFileSystem,
  file: Path,
  metadata: Metadata
): Promise<void> {
  const temp = new Path(file.dirname, `${file.basename}.${process.pid}.${++tempCounter}.tmp`);
  await fileSystem.writeFile(temp, JSON.stringify(toFile(metadata), null, 2) + "\n");
  try {
    await fileSystem.rename(temp, file);
  } catch (error) {
    await fileSystem.unlink(temp).catch(() => undefined);
    throw error;
  }
}

interface Entry {
  readonly locate: MetadataLocator;
  /** The located file, once a write needed it. */
  file: Promise<Path> | undefined;
  metadata: Metadata;
  /** Tail of this workspace's write queue. */
  writes: Promise<void>;
}

export class WorkspaceMetadataStore {
  /** Workspace path (normalized string) → its entry. */
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly fileSystem: MetadataFileSystem) {}

  /** Hold a workspace's already-persisted metadata in memory. */
  track(workspacePath: Path, locate: MetadataLocator, metadata: Metadata): void {
    const existing = this.entries.get(workspacePath.toString());
    this.entries.set(workspacePath.toString(), {
      locate,
      file: undefined,
      metadata: { ...metadata },
      writes: existing?.writes ?? Promise.resolve(),
    });
  }

  /**
   * Hold a new workspace's metadata and write its whole file, first in its
   * queue. Memory holds it at once, so a write that fails leaves the next one
   * (which writes every key) to create the file.
   */
  initialize(workspacePath: Path, locate: MetadataLocator, metadata: Metadata): Promise<void> {
    this.track(workspacePath, locate, metadata);
    const entry = this.entries.get(workspacePath.toString())!;
    const write = entry.writes.then(() => this.persist(entry, entry.metadata));
    entry.writes = write.catch(() => undefined);
    return write;
  }

  /** A workspace's metadata, or undefined when the store does not hold it. */
  get(workspacePath: Path): Metadata | undefined {
    return this.entries.get(workspacePath.toString())?.metadata;
  }

  /**
   * Set one key (null deletes it). Queued behind this workspace's earlier
   * writes; the file is replaced before memory changes.
   *
   * @throws Error when the store does not hold the workspace or the write fails
   */
  set(workspacePath: Path, key: string, value: string | null): Promise<void> {
    const entry = this.entries.get(workspacePath.toString());
    if (!entry) {
      return Promise.reject(
        new Error(`No metadata held for workspace: ${workspacePath.toString()}`)
      );
    }
    const write = entry.writes.then(async () => {
      const next: Record<string, string> = { ...entry.metadata };
      if (value === null) {
        if (!(key in next)) return;
        delete next[key];
      } else {
        if (next[key] === value) return;
        next[key] = value;
      }
      await this.persist(entry, next);
      entry.metadata = next;
    });
    entry.writes = write.catch(() => undefined);
    return write;
  }

  /** Drop a workspace from memory; its file stays. */
  forget(workspacePath: Path): void {
    this.entries.delete(workspacePath.toString());
  }

  private async persist(entry: Entry, metadata: Metadata): Promise<void> {
    // A failed lookup is retried by the next write.
    entry.file ??= entry.locate().catch((error: unknown) => {
      entry.file = undefined;
      throw error;
    });
    await writeMetadataFile(this.fileSystem, await entry.file, metadata);
  }
}
