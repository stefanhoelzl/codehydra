/**
 * WorkspaceMetadataStore - a workspace's metadata, held in memory and persisted
 * to one JSON file in the worktree's private git directory
 * (`.git/worktrees/<id>/codehydra.json`).
 *
 * The file belongs to the worktree rather than to its branch, so it survives a
 * branch rename and a detached HEAD, follows `git worktree move`/`repair`, and
 * goes away with `git worktree remove`/`prune`. Writing it takes no git lock.
 *
 * Memory is authoritative while the app runs: a workspace's file is read once
 * (when its project is discovered, or when it is created or adopted) and every
 * later read is served from memory. A write replaces the file atomically (temp
 * file + rename) before memory changes, so a failed write leaves both as they
 * were. Writes to one workspace run one after another; different workspaces
 * write in parallel.
 */

import { z } from "zod/v4";
import type { FileSystemBoundary } from "./filesystem";
import type { Logger } from "./logging";
import { FileSystemError, getErrorMessage } from "../../shared/errors/service-errors";
import { metadataTier, type MetadataTier } from "../../utils/metadata-tier";
import { Path } from "../../utils/path/path";

/** File name inside the worktree's git directory. */
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

interface Entry {
  readonly file: Path;
  metadata: Metadata;
  /** Tail of this workspace's write queue. */
  writes: Promise<void>;
}

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

export class WorkspaceMetadataStore {
  /** Workspace path (normalized string) → its entry. */
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly fileSystem: FileSystemBoundary,
    private readonly logger: Logger
  ) {}

  /** The metadata file of a worktree whose git directory is `gitDir`. */
  static fileIn(gitDir: Path): Path {
    return new Path(gitDir, METADATA_FILE_NAME);
  }

  /**
   * Read a metadata file. Null when there is none — a worktree CodeHydra has
   * not written one for yet. A file that cannot be parsed reads as empty (and is
   * logged): the next write replaces it.
   */
  async read(file: Path): Promise<Metadata | null> {
    let content: string;
    try {
      content = await this.fileSystem.readFile(file);
    } catch (error) {
      if (error instanceof FileSystemError && error.fsCode === "ENOENT") return null;
      throw error;
    }
    try {
      const parsed = metadataFileSchema.parse(JSON.parse(content));
      return { ...parsed.internal, ...parsed.protected, ...parsed.public };
    } catch (error) {
      this.logger
        .scoped({ path: file.toString() })
        .warn("Unreadable workspace metadata file; treating it as empty", {
          error: getErrorMessage(error),
        });
      return {};
    }
  }

  /** Hold a workspace's already-persisted metadata in memory. */
  track(workspacePath: Path, file: Path, metadata: Metadata): void {
    const existing = this.entries.get(workspacePath.toString());
    this.entries.set(workspacePath.toString(), {
      file,
      metadata: { ...metadata },
      writes: existing?.writes ?? Promise.resolve(),
    });
  }

  /** Persist a workspace's whole metadata and hold it in memory. */
  async initialize(workspacePath: Path, file: Path, metadata: Metadata): Promise<void> {
    await this.persist(file, metadata);
    this.track(workspacePath, file, metadata);
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
      await this.persist(entry.file, next);
      entry.metadata = next;
    });
    entry.writes = write.catch(() => undefined);
    return write;
  }

  /** Drop a workspace from memory (its file goes with its worktree). */
  forget(workspacePath: Path): void {
    this.entries.delete(workspacePath.toString());
  }

  /** Replace `file` atomically: write a sibling temp file, then rename it over. */
  private async persist(file: Path, metadata: Metadata): Promise<void> {
    const temp = new Path(file.dirname, `${file.basename}.${process.pid}.${++tempCounter}.tmp`);
    await this.fileSystem.writeFile(temp, JSON.stringify(toFile(metadata), null, 2) + "\n");
    try {
      await this.fileSystem.rename(temp, file);
    } catch (error) {
      await this.fileSystem.unlink(temp).catch(() => undefined);
      throw error;
    }
  }
}
