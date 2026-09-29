/**
 * Archive extraction interface and implementations.
 */

import * as tar from "tar";
import yauzl from "yauzl";
import * as fs from "node:fs";
import * as path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { ArchiveError, getErrorMessage } from "../../shared/errors/service-errors.js";
import { Path } from "../../utils/path/path.js";

/**
 * Progress callback for archive extraction. Unit-agnostic: `processed`/`total`
 * are compressed bytes for tar (bytes consumed from the archive) and entry
 * counts for zip (entries extracted / total entries). Either way
 * `processed / total` yields a valid completion fraction.
 */
export type ExtractProgressCallback = (processed: number, total: number) => void;

/** The `code` a thrown value carries (Node errno, tar's `TAR_*`, zlib's `Z_*`), if any. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * Map an extraction failure to an ArchiveError. Shared by both extractors.
 *
 * Classified by the error's `code`, never its message: a message embeds the
 * archive path, and a path containing "TAR" once turned a missing file into a
 * corrupt archive. OS permission errors (EACCES/EPERM) are PERMISSION_DENIED.
 * `isFormatError` decides what the extractor's own library reports as a
 * damaged archive.
 */
function mapExtractionFailure(
  error: unknown,
  archivePath: string,
  destPath: string,
  isFormatError: (code: string | undefined) => boolean
): ArchiveError {
  const message = getErrorMessage(error);
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM") {
    return new ArchiveError(
      `Permission denied extracting to ${destPath}: ${message}`,
      "PERMISSION_DENIED"
    );
  }
  if (isFormatError(code)) {
    return new ArchiveError(
      `Invalid or corrupt archive at ${archivePath}: ${message}`,
      "INVALID_ARCHIVE"
    );
  }
  return new ArchiveError(`Failed to extract ${archivePath}: ${message}`, "EXTRACTION_FAILED");
}

/** tar reports a malformed archive as `TAR_*`, its gunzip as zlib's `Z_*`. */
function isTarFormatError(code: string | undefined): boolean {
  return code !== undefined && (code.startsWith("TAR_") || code.startsWith("Z_"));
}

/**
 * yauzl raises a malformed zip as a plain Error with no `code`, and we inflate
 * entries with zlib (`Z_*`); every other code came from the filesystem
 * (ENOENT, EISDIR, …).
 */
function isZipFormatError(code: string | undefined): boolean {
  return code === undefined || code.startsWith("Z_");
}

/**
 * Interface for extracting archives.
 */
export interface ArchiveExtractor {
  /**
   * Extract an archive to a destination directory.
   *
   * @param archivePath - Path to the archive file
   * @param destDir - Directory to extract to (will be created if it doesn't exist)
   * @param onProgress - Optional callback invoked with extraction progress
   * @throws ArchiveError on extraction failure
   */
  extract(archivePath: string, destDir: Path, onProgress?: ExtractProgressCallback): Promise<void>;
}

/**
 * Extractor for .tar.gz archives using the `tar` package.
 */
export class TarExtractor implements ArchiveExtractor {
  async extract(
    archivePath: string,
    destDir: Path,
    onProgress?: ExtractProgressCallback
  ): Promise<void> {
    const destPath = destDir.toNative();
    try {
      await fs.promises.mkdir(destPath, { recursive: true });
      // Stream from disk so we can count compressed bytes consumed against the
      // archive's total size. `tar.extract` with no `file` returns a writable
      // Unpack stream; pipeline waits for all entries to be written to disk.
      const { size: total } = await fs.promises.stat(archivePath);
      let processed = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb): void {
          processed += chunk.length;
          onProgress?.(processed, total);
          cb(null, chunk);
        },
      });
      await pipeline(fs.createReadStream(archivePath), counter, tar.extract({ cwd: destPath }));
    } catch (error) {
      throw mapExtractionFailure(error, archivePath, destPath, isTarFormatError);
    }
  }
}

/**
 * Extractor for .zip archives using the `yauzl` package.
 */
export class ZipExtractor implements ArchiveExtractor {
  async extract(
    archivePath: string,
    destDir: Path,
    onProgress?: ExtractProgressCallback
  ): Promise<void> {
    const destPath = destDir.toNative();
    try {
      await fs.promises.mkdir(destPath, { recursive: true });
      await this.extractZip(archivePath, destDir, onProgress);
    } catch (error) {
      if (error instanceof ArchiveError) {
        throw error;
      }
      throw mapExtractionFailure(error, archivePath, destPath, isZipFormatError);
    }
  }

  private extractZip(
    archivePath: string,
    destDir: Path,
    onProgress?: ExtractProgressCallback
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      yauzl.open(archivePath, { lazyEntries: true }, (err, zipfile) => {
        if (err) {
          reject(err);
          return;
        }

        // zip's central directory gives the total entry count upfront, so we
        // report progress by entries completed rather than bytes.
        const total = zipfile.entryCount;
        let processed = 0;
        const advance = (): void => {
          processed += 1;
          onProgress?.(processed, total);
          zipfile.readEntry();
        };

        zipfile.readEntry();
        zipfile.on("entry", (entry) => {
          // Use Path class to construct entry path - this automatically handles normalization
          // and ensures consistent separator usage regardless of platform
          let entryPath: Path;
          try {
            entryPath = new Path(destDir, entry.fileName);
          } catch (error) {
            zipfile.close();
            reject(
              new ArchiveError(
                `Invalid path in archive: ${entry.fileName} - ${getErrorMessage(error)}`,
                "INVALID_ARCHIVE"
              )
            );
            return;
          }

          // Security check: prevent path traversal
          // We can reliably use startsWith because Path ensures canonical format
          if (!entryPath.startsWith(destDir)) {
            zipfile.close();
            reject(
              new ArchiveError(
                `Path traversal detected in archive: ${entry.fileName}`,
                "INVALID_ARCHIVE"
              )
            );
            return;
          }

          const nativeEntryPath = entryPath.toNative();

          if (entry.fileName.endsWith("/")) {
            // Directory entry
            fs.promises
              .mkdir(nativeEntryPath, { recursive: true })
              .then(() => advance())
              .catch(reject);
          } else {
            // File entry
            fs.promises
              .mkdir(path.dirname(nativeEntryPath), { recursive: true })
              .then(() => {
                writeEntry(zipfile, entry, nativeEntryPath)
                  .then(() => advance())
                  .catch(reject);
              })
              .catch(reject);
          }
        });

        zipfile.on("end", () => resolve());
        zipfile.on("error", reject);
      });
    });
  }
}

/** Zip compression methods we can handle. 0 = stored, 8 = deflate. */
const ZIP_STORED = 0;
const ZIP_DEFLATE = 8;

/** Collect a readable stream into one Buffer. */
function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/**
 * Write one zip entry to disk, decompressing it ourselves.
 *
 * We deliberately do NOT let yauzl stream the entry through zlib. Inside an Electron
 * **main process**, yauzl's read stream piped into zlib stalls near the end of a large
 * entry and never emits `end` — measured at 96,204,314 of 96,277,872 bytes, with the
 * write side idle, no backpressure and no error.
 *
 * It is not zlib, and it is not Electron's patched fs. Inside Electron, all of these
 * work: `inflateRawSync` on the whole buffer (0.3s); `createInflateRaw()` fed a buffer;
 * `fs.createReadStream(...).pipe(createInflateRaw())`; and yauzl's reader drained on its
 * own. Only the combination stalls — yauzl reads through `fd-slicer`, which implements
 * its own Readable over `fs.read`, and piping *that* into zlib deadlocks. Plain Node
 * does all of it fine. `validateEntrySizes: false` does not help.
 *
 * That deadlock froze first-run setup forever on Windows and macOS, which fetch
 * `opencode-*.zip`; Linux was untouched only because it fetches a `.tar.gz`.
 *
 * So: read the raw entry bytes (yauzl's reader is fine on its own), inflate
 * synchronously, write once. The cost is holding one entry in memory — measured at a
 * ~200MB transient peak for the 152MB Windows agent binary.
 *
 * `fflate` is the obvious escape hatch if that peak ever matters: its inflate is pure
 * JS, so it sidesteps this entirely, and streaming it halves the peak. Measured in
 * Electron on the 96MB entry: this code 257ms, fflate.unzipSync 627ms,
 * fflate.Unzip streaming 877ms. It was not adopted because UnzipFileInfo exposes no
 * external attributes, so entry file modes are lost — survivable only because
 * binary-download chmods its executable afterwards. Note `extract-zip` is not a fix:
 * it wraps yauzl and streams entries through zlib, reproducing the deadlock.
 */
async function writeEntry(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  destPath: string
): Promise<void> {
  const method = entry.compressionMethod;
  if (method !== ZIP_STORED && method !== ZIP_DEFLATE) {
    throw new ArchiveError(
      `Unsupported compression method ${method} for entry ${entry.fileName}`,
      "INVALID_ARCHIVE"
    );
  }

  const raw = await new Promise<Buffer>((resolve, reject) => {
    const onStream: Parameters<typeof zipfile.openReadStream>[1] = (err, readStream) => {
      if (err) {
        reject(err);
        return;
      }
      collect(readStream).then(resolve, reject);
    };

    if (method === ZIP_DEFLATE) {
      // Hand back the still-deflated bytes; we inflate them ourselves below.
      // `decompress: false` is only legal for deflated entries.
      zipfile.openReadStream(
        entry,
        { decompress: false, decrypt: null, start: null, end: null },
        onStream
      );
    } else {
      zipfile.openReadStream(entry, onStream);
    }
  });

  const contents = method === ZIP_DEFLATE ? zlib.inflateRawSync(raw) : raw;

  if (contents.length !== entry.uncompressedSize) {
    throw new ArchiveError(
      `Size mismatch for entry ${entry.fileName}: expected ${entry.uncompressedSize}, got ${contents.length}`,
      "INVALID_ARCHIVE"
    );
  }

  await fs.promises.writeFile(destPath, contents);

  // Preserve file mode from external attributes (Unix mode is in upper 16 bits)
  const mode = (entry.externalFileAttributes >> 16) & 0o777;
  if (mode !== 0) {
    await fs.promises.chmod(destPath, mode);
  }
}

/**
 * Archive extractor that selects the appropriate implementation based on file extension.
 */
export class DefaultArchiveExtractor implements ArchiveExtractor {
  private readonly tarExtractor: TarExtractor;
  private readonly zipExtractor: ZipExtractor;

  constructor() {
    this.tarExtractor = new TarExtractor();
    this.zipExtractor = new ZipExtractor();
  }

  async extract(
    archivePath: string,
    destDir: Path,
    onProgress?: ExtractProgressCallback
  ): Promise<void> {
    const lowerPath = archivePath.toLowerCase();

    if (lowerPath.endsWith(".tar.gz") || lowerPath.endsWith(".tgz")) {
      return this.tarExtractor.extract(archivePath, destDir, onProgress);
    }

    if (lowerPath.endsWith(".zip")) {
      return this.zipExtractor.extract(archivePath, destDir, onProgress);
    }

    throw new ArchiveError(
      `Unsupported archive format: ${archivePath}. Supported formats: .tar.gz, .tgz, .zip`,
      "INVALID_ARCHIVE"
    );
  }
}
