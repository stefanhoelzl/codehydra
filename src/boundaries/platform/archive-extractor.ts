/**
 * Archive extraction interface and implementations.
 */

import * as tar from "tar";
import yauzl from "yauzl";
import * as fs from "node:fs";
import * as path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ArchiveError, getErrorMessage } from "../../shared/errors/service-errors.js";
import { Path } from "../../utils/path/path.js";

/**
 * Progress callback for archive extraction. Unit-agnostic: `processed`/`total`
 * are compressed bytes for tar (bytes consumed from the archive) and entry
 * counts for zip (entries extracted / total entries). Either way
 * `processed / total` yields a valid completion fraction.
 */
export type ExtractProgressCallback = (processed: number, total: number) => void;

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
      const message = getErrorMessage(error);
      if (message.includes("EACCES") || message.includes("EPERM")) {
        throw new ArchiveError(
          `Permission denied extracting to ${destPath}: ${message}`,
          "PERMISSION_DENIED"
        );
      }
      if (
        message.includes("TAR") ||
        message.includes("zlib") ||
        message.includes("unexpected end")
      ) {
        throw new ArchiveError(
          `Invalid or corrupt archive at ${archivePath}: ${message}`,
          "INVALID_ARCHIVE"
        );
      }
      throw new ArchiveError(`Failed to extract ${archivePath}: ${message}`, "EXTRACTION_FAILED");
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
      const message = getErrorMessage(error);
      if (message.includes("EACCES") || message.includes("EPERM")) {
        throw new ArchiveError(
          `Permission denied extracting to ${destPath}: ${message}`,
          "PERMISSION_DENIED"
        );
      }
      throw new ArchiveError(`Failed to extract ${archivePath}: ${message}`, "EXTRACTION_FAILED");
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
          if (err.message.includes("end of central directory")) {
            reject(
              new ArchiveError(
                `Invalid or corrupt zip archive at ${archivePath}: ${err.message}`,
                "INVALID_ARCHIVE"
              )
            );
          } else {
            reject(
              new ArchiveError(
                `Failed to open zip archive at ${archivePath}: ${err.message}`,
                "EXTRACTION_FAILED"
              )
            );
          }
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
                zipfile.openReadStream(entry, (err, readStream) => {
                  if (err) {
                    reject(
                      new ArchiveError(
                        `Failed to read entry ${entry.fileName}: ${err.message}`,
                        "EXTRACTION_FAILED"
                      )
                    );
                    return;
                  }

                  const writeStream = fs.createWriteStream(nativeEntryPath);
                  pipeline(readStream, writeStream)
                    .then(async () => {
                      // Preserve file mode from external attributes (Unix mode is in upper 16 bits)
                      const mode = (entry.externalFileAttributes >> 16) & 0o777;
                      if (mode !== 0) {
                        await fs.promises.chmod(nativeEntryPath, mode);
                      }
                    })
                    .then(() => advance())
                    .catch(reject);
                });
              })
              .catch(reject);
          }
        });

        zipfile.on("end", () => resolve());
        zipfile.on("error", (err) => {
          reject(
            new ArchiveError(`Error reading zip archive: ${err.message}`, "EXTRACTION_FAILED")
          );
        });
      });
    });
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
