/**
 * Archive extraction interface and implementations.
 */

import * as tar from "tar";
import yauzl from "yauzl";
import * as fs from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { ArchiveError } from "./errors.js";

/**
 * Interface for extracting archives.
 */
export interface ArchiveExtractor {
  /**
   * Extract an archive to a destination directory.
   *
   * @param archivePath - Path to the archive file
   * @param destDir - Directory to extract to (will be created if it doesn't exist)
   * @throws ArchiveError on extraction failure
   */
  extract(archivePath: string, destDir: string): Promise<void>;
}

/**
 * Extractor for .tar.gz archives using the `tar` package.
 */
export class TarExtractor implements ArchiveExtractor {
  async extract(archivePath: string, destDir: string): Promise<void> {
    try {
      await fs.promises.mkdir(destDir, { recursive: true });
      await tar.extract({
        file: archivePath,
        cwd: destDir,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("EACCES") || message.includes("EPERM")) {
        throw new ArchiveError(
          `Permission denied extracting to ${destDir}: ${message}`,
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
  async extract(archivePath: string, destDir: string): Promise<void> {
    try {
      await fs.promises.mkdir(destDir, { recursive: true });
      await this.extractZip(archivePath, destDir);
    } catch (error) {
      if (error instanceof ArchiveError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("EACCES") || message.includes("EPERM")) {
        throw new ArchiveError(
          `Permission denied extracting to ${destDir}: ${message}`,
          "PERMISSION_DENIED"
        );
      }
      throw new ArchiveError(`Failed to extract ${archivePath}: ${message}`, "EXTRACTION_FAILED");
    }
  }

  private extractZip(archivePath: string, destDir: string): Promise<void> {
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

        zipfile.readEntry();
        zipfile.on("entry", (entry) => {
          const entryPath = path.join(destDir, entry.fileName);

          // Security check: prevent path traversal
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

          if (entry.fileName.endsWith("/")) {
            // Directory entry
            fs.promises
              .mkdir(entryPath, { recursive: true })
              .then(() => zipfile.readEntry())
              .catch(reject);
          } else {
            // File entry
            fs.promises
              .mkdir(path.dirname(entryPath), { recursive: true })
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

                  const writeStream = fs.createWriteStream(entryPath);
                  pipeline(readStream, writeStream)
                    .then(async () => {
                      // Preserve file mode from external attributes (Unix mode is in upper 16 bits)
                      const mode = (entry.externalFileAttributes >> 16) & 0o777;
                      if (mode !== 0) {
                        await fs.promises.chmod(entryPath, mode);
                      }
                    })
                    .then(() => zipfile.readEntry())
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

  async extract(archivePath: string, destDir: string): Promise<void> {
    const lowerPath = archivePath.toLowerCase();

    if (lowerPath.endsWith(".tar.gz") || lowerPath.endsWith(".tgz")) {
      return this.tarExtractor.extract(archivePath, destDir);
    }

    if (lowerPath.endsWith(".zip")) {
      return this.zipExtractor.extract(archivePath, destDir);
    }

    throw new ArchiveError(
      `Unsupported archive format: ${archivePath}. Supported formats: .tar.gz, .tgz, .zip`,
      "INVALID_ARCHIVE"
    );
  }
}
