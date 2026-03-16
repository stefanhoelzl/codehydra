/**
 * Archive extraction boundary module.
 */

export type { ArchiveExtractor } from "./archive-extractor.js";
export { TarExtractor, ZipExtractor, DefaultArchiveExtractor } from "./archive-extractor.js";

export { createArchiveExtractorMock } from "./archive-extractor.state-mock.js";
export type { MockArchiveExtractor } from "./archive-extractor.state-mock.js";
