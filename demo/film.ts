/**
 * Filming the demo: a private Xvfb, an ffmpeg x11grab of it, and the edit.
 *
 * The edit is a cut list. A "dead" wait (an agent working, a poll tick) keeps
 * KEEP seconds of motion at each end and drops the middle, with a short
 * crossfade over each splice so the result reads as an edit, not a glitch.
 * A chapter is a title card spliced in where the story moves on; whatever the
 * recorder does to set the next chapter up is cut, hidden behind the card.
 * Captions are burned in at the top, timed to the cut timeline, and the
 * landing-page poster is lifted from the raw grab so it is a frame of the
 * delivered video.
 *
 * With filming off (`DEMO_FILM=0`, the CI smoke run) only the Xvfb runs: the
 * story is driven and asserted, and nothing is grabbed or encoded.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ffmpegPath from "ffmpeg-static";

/** Logical window size; rendered at SCALE for a crisp downscale. */
export const LOGICAL = { w: 1600, h: 1000 };
export const SCALE = 2;
const DEVICE = { w: LOGICAL.w * SCALE, h: LOGICAL.h * SCALE };
const FPS = 30;

// KEEP is per cut END, so every cut contributes 2*KEEP of footage.
const KEEP = 0.6;
const XFADE = 0.15;
/** A chapter card's length (longer with a detail to read), and the slower fade into and out of it. */
const CARD = 2.4;
const CARD_WITH_DETAIL = 7;
const CARD_FADE = 0.35;
const CARD_COLOR = "0x0d1117";

const FFMPEG = ffmpegPath as unknown as string;

export function log(message: string): void {
  // This IS the recorder's user-facing output.
  console.log(`[demo] ${message}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface Film {
  /** Whether frames are being grabbed (false for the smoke run). */
  readonly filming: boolean;
  /** Start grabbing. */
  start(): void;
  /**
   * Start chapter `title` with a card. `setup` runs behind it: everything it
   * does on screen is cut. Captions end at the card.
   */
  chapter(
    title: string,
    options?: {
      setup?: () => Promise<void>;
      /** Shown under the title in a monospace block, e.g. a config file. */
      detail?: string;
    }
  ): Promise<void>;
  /** Show `text` from now until the next caption or chapter. */
  caption(text: string): void;
  /**
   * Dim everything but `box` (logical pixels) from now until the next
   * spotlight or chapter — the caption's subject when it is not the workspace
   * on screen. `null` ends the current one.
   */
  spotlight(box: Box | null): void;
  /** Run a wait whose middle is cut, keeping `tailS` seconds before it ends. */
  timed<T>(fn: () => Promise<T>, tailS?: number): Promise<T>;
  /** Mark "now" as the poster frame. Only from a beat that is never cut. */
  markPoster(): void;
  /** Stop grabbing. Safe to call twice. */
  stop(): Promise<void>;
  /** Stop grabbing and take the display down — only once the app is gone. */
  close(): Promise<void>;
  /** Cut, caption and encode the grab into `output`, and lift the poster. */
  encode(output: string, poster: string): void;
}

/**
 * Start a private Xvfb on `display` at the device size, and return the film.
 *
 * A stale Xvfb from a crashed run leaves its socket behind; reusing it would
 * silently record at the old screen size, so its owner is terminated (only if
 * it really is Xvfb) and the lock cleared first.
 */
export async function startFilm(options: {
  display: string;
  workDir: string;
  filming: boolean;
}): Promise<Film> {
  const { display, workDir, filming } = options;
  const num = display.replace(":", "");
  const socket = `/tmp/.X11-unix/X${num}`;
  const lock = `/tmp/.X${num}-lock`;
  if (existsSync(lock)) {
    try {
      const pid = Number(readFileSync(lock, "utf-8").trim());
      if (pid > 0 && readFileSync(`/proc/${pid}/comm`, "utf-8").trim() === "Xvfb") {
        process.kill(pid, "SIGTERM");
        await sleep(500);
      }
    } catch {
      // No such process, or unreadable: fall through and clear the lock.
    }
    rmSync(lock, { force: true });
    rmSync(socket, { force: true });
  }

  const xvfb = spawn(
    "Xvfb",
    [display, "-screen", "0", `${DEVICE.w}x${DEVICE.h}x24`, "-nolisten", "tcp"],
    { stdio: "ignore" }
  );
  for (let i = 0; i < 50 && !existsSync(socket); i++) await sleep(100);
  if (!existsSync(socket)) throw new Error(`Xvfb did not come up on ${display}`);

  mkdirSync(workDir, { recursive: true });
  const rawPath = join(workDir, "raw.mp4");
  let ffmpeg: ChildProcess | undefined;
  let startMs = 0;
  let totalS = 0;
  let posterAtS: number | null = null;
  const cuts: Array<{ start: number; end: number }> = [];
  const captions: Array<{ rawS: number; text: string }> = [];
  const chapters: Chapter[] = [];
  const spotlights: Array<{ rawS: number; box: Box | null }> = [];
  const now = (): number => (Date.now() - startMs) / 1000;

  async function stopGrab(): Promise<void> {
    if (startMs > 0 && totalS === 0) totalS = now();
    const running = ffmpeg;
    ffmpeg = undefined;
    if (running) {
      // "q" makes ffmpeg finish the file (writes the moov atom).
      await new Promise<void>((resolve) => {
        running.on("exit", () => resolve());
        running.stdin?.write("q");
        running.stdin?.end();
      });
    }
  }

  return {
    filming,

    start() {
      startMs = Date.now();
      if (!filming) return;
      ffmpeg = spawn(
        FFMPEG,
        [
          "-y",
          "-f",
          "x11grab",
          "-draw_mouse",
          "0",
          "-framerate",
          String(FPS),
          "-video_size",
          `${DEVICE.w}x${DEVICE.h}`,
          "-i",
          display,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "20",
          "-pix_fmt",
          "yuv420p",
          rawPath,
        ],
        { stdio: ["pipe", "ignore", "ignore"] }
      );
    },

    async chapter(title, options = {}) {
      log(`chapter ${chapters.length + 1}: ${title}`);
      const start = now();
      await options.setup?.();
      if (startMs === 0) return;
      chapters.push({
        rawS: start,
        title,
        number: chapters.length + 1,
        ...(options.detail !== undefined && { detail: options.detail }),
      });
      cuts.push({ start, end: now() });
    },

    spotlight(box) {
      if (startMs > 0) spotlights.push({ rawS: now(), box });
    },

    caption(text) {
      if (startMs > 0) captions.push({ rawS: now(), text });
      log(`caption: ${text}`);
    },

    async timed(fn, tailS = KEEP) {
      const start = now();
      const result = await fn();
      const end = now();
      if (end - start > KEEP + tailS + 1) cuts.push({ start: start + KEEP, end: end - tailS });
      return result;
    },

    markPoster() {
      if (startMs > 0) posterAtS = now();
    },

    stop: stopGrab,

    async close() {
      await stopGrab();
      xvfb.kill();
    },

    encode(output, poster) {
      if (!filming) return;
      const pieces = arrange(keptSegments(cuts, totalS), chapters);
      log(
        `cut ${totalS.toFixed(1)}s raw to ` +
          pieces
            .map((p) =>
              p.kind === "raw"
                ? `${p.start.toFixed(1)}-${p.end.toFixed(1)}`
                : `[${p.chapter.number}]`
            )
            .join(" ")
      );
      const timeline = layout(pieces);
      log(`final cut: ${timeline.total.toFixed(1)}s`);
      const captionFile = writeCaptions(captions, spotlights, timeline, workDir);
      encodeFinal(rawPath, output, timeline, captionFile);
      log(`video → ${output}`);
      if (posterAtS === null) throw new Error("no poster frame was marked");
      extractPoster(rawPath, poster, posterAtS);
      log(`poster → ${poster} (raw t=${posterAtS.toFixed(1)}s)`);
    },
  };
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Chapter {
  readonly rawS: number;
  readonly title: string;
  readonly number: number;
  readonly detail?: string;
}

function cardLength(chapter: Chapter): number {
  return chapter.detail === undefined ? CARD : CARD_WITH_DETAIL;
}

type Piece =
  | { readonly kind: "raw"; readonly start: number; readonly end: number }
  | { readonly kind: "card"; readonly chapter: Chapter };

/** The pieces on the timeline, each with where it starts and its fade into the next. */
interface Timeline {
  readonly pieces: ReadonlyArray<{ piece: Piece; at: number; duration: number; fadeOut: number }>;
  readonly total: number;
}

/**
 * Splice each chapter's card into the kept footage at its raw time. The span
 * its setup ran in is a cut, so footage before and after already part there;
 * a setup too short to cut still splits the footage at that moment.
 */
function arrange(
  segments: ReadonlyArray<{ start: number; end: number }>,
  chapters: readonly Chapter[]
): Piece[] {
  const pieces: Piece[] = [];
  const pending = [...chapters].sort((a, b) => a.rawS - b.rawS);
  for (const segment of segments) {
    let start = segment.start;
    while (pending.length > 0 && pending[0]!.rawS < segment.end) {
      const chapter = pending.shift()!;
      if (chapter.rawS - start > XFADE + 0.1) {
        pieces.push({ kind: "raw", start, end: chapter.rawS });
        start = chapter.rawS;
      }
      pieces.push({ kind: "card", chapter });
    }
    pieces.push({ kind: "raw", start, end: segment.end });
  }
  for (const chapter of pending) pieces.push({ kind: "card", chapter });
  return pieces;
}

function layout(pieces: readonly Piece[]): Timeline {
  let at = 0;
  const placed = pieces.map((piece, i) => {
    const duration = piece.kind === "raw" ? piece.end - piece.start : cardLength(piece.chapter);
    const next = pieces[i + 1];
    const fadeOut =
      next === undefined ? 0 : piece.kind === "card" || next.kind === "card" ? CARD_FADE : XFADE;
    const entry = { piece, at, duration, fadeOut };
    at += duration - fadeOut;
    return entry;
  });
  return { pieces: placed, total: at };
}

/** Kept segments = [0, total] minus the merged, clamped cut spans (dropping slivers). */
function keptSegments(
  cutSpans: ReadonlyArray<{ start: number; end: number }>,
  total: number
): Array<{ start: number; end: number }> {
  const cuts = cutSpans
    .map((c) => ({ start: Math.max(0, c.start), end: Math.min(total, c.end) }))
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start);
  const kept: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const c of cuts) {
    if (c.start > cursor) kept.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < total) kept.push({ start: cursor, end: total });
  // Slivers shorter than a crossfade can't be faded; drop them.
  return kept.filter((s) => s.end - s.start > XFADE + 0.1);
}

/**
 * Map a raw-capture time to its position on the timeline. A time inside a cut
 * span maps to the next kept moment.
 */
function rawToCut(rawS: number, timeline: Timeline): number {
  for (const { piece, at } of timeline.pieces) {
    if (piece.kind !== "raw") continue;
    if (rawS < piece.start) return at;
    // Half-open: a moment on a splice belongs to what follows it, so a caption
    // given as a chapter starts lands after its card, not before it.
    if (rawS < piece.end) return at + (rawS - piece.start);
  }
  return timeline.total;
}

/**
 * A block of code as ASS text: braces escaped (they open override blocks),
 * spaces made hard (so indentation survives) and every line padded to the
 * longest, so the centred lines stay left-aligned in a monospace font.
 * Backslashes pass through: only `\N`, `\n` and `\h` mean anything to
 * libass outside braces, and the plugin has none of them.
 */
function assCode(code: string): string {
  const lines = code.replace(/\n$/, "").split("\n");
  const width = Math.max(...lines.map((line) => line.length));
  return lines
    .map((line) =>
      line
        .padEnd(width)
        .replace(/[{}]/g, (brace) => `\\${brace}`)
        .replace(/ /g, "\\h")
    )
    .join("\\N");
}

/** Format seconds as an ASS timestamp (H:MM:SS.cc). */
function assTime(s: number): string {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/**
 * Write the ASS subtitle file: the captions, timed to the timeline, and each
 * chapter card's title. A caption runs until the next caption or card. Bold
 * white on a translucent box, top-centre over the workspace (the agent's
 * prompt line is at the bottom). Rendered by ffmpeg-static's libass `ass`
 * filter (it has no `drawtext`); DejaVu Sans is resolved via fontconfig.
 */
function writeCaptions(
  captions: ReadonlyArray<{ rawS: number; text: string }>,
  spotlights: ReadonlyArray<{ rawS: number; box: Box | null }>,
  timeline: Timeline,
  workDir: string
): string {
  const cards = timeline.pieces.flatMap(({ piece, at, duration }) =>
    piece.kind === "card" ? [{ at, duration, chapter: piece.chapter }] : []
  );
  const breaks = [...captions.map((c) => rawToCut(c.rawS, timeline)), ...cards.map((c) => c.at)];
  const dialogue = captions
    .map((c) => {
      const t = rawToCut(c.rawS, timeline);
      const end = Math.min(timeline.total, ...breaks.filter((b) => b > t));
      if (end - t < 0.5) return null; // too brief to read
      return `Dialogue: 1,${assTime(t)},${assTime(end)},Cap,,0,0,0,,${c.text}`;
    })
    .filter((d): d is string => d !== null);
  // A translucent shade over all but the box, under the captions.
  const { w, h } = LOGICAL;
  const spots = spotlights.map((spot) => ({ t: rawToCut(spot.rawS, timeline), box: spot.box }));
  for (const [i, { t, box }] of spots.entries()) {
    if (box === null) continue;
    const end = Math.min(
      timeline.total,
      ...[...cards.map((c) => c.at), ...spots.slice(i + 1).map((s) => s.t)].filter((b) => b > t)
    );
    const x0 = Math.round(box.x);
    const y0 = Math.round(box.y);
    const x1 = Math.round(box.x + box.width);
    const y1 = Math.round(box.y + box.height);
    const rect = (ax: number, ay: number, bx: number, by: number): string =>
      `m ${ax} ${ay} l ${bx} ${ay} l ${bx} ${by} l ${ax} ${by}`;
    const shape = [
      rect(0, 0, w, y0),
      rect(0, y1, w, h),
      rect(0, y0, x0, y1),
      rect(x1, y0, w, y1),
    ].join(" ");
    dialogue.push(
      `Dialogue: 0,${assTime(t)},${assTime(end)},Shade,,0,0,0,,{\\pos(0,0)\\fad(300,0)\\p1}${shape}{\\p0}`
    );
  }
  for (const { at, duration, chapter } of cards) {
    const from = assTime(at + CARD_FADE);
    const to = assTime(at + duration - CARD_FADE);
    const heading = `{\\fs30\\b0\\c&H9E948B&}Chapter ${chapter.number}{\\r}\\N${chapter.title}`;
    if (chapter.detail === undefined) {
      dialogue.push(`Dialogue: 0,${from},${to},Chapter,,0,0,0,,${heading}`);
      continue;
    }
    dialogue.push(
      `Dialogue: 0,${from},${to},Chapter,,0,0,0,,{\\an2\\pos(${w / 2},${h * 0.3})}${heading}`
    );
    dialogue.push(
      `Dialogue: 0,${from},${to},Code,,0,0,0,,{\\an8\\pos(${w / 2},${h * 0.36})}${assCode(chapter.detail)}`
    );
  }

  const header =
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${LOGICAL.w}\nPlayResY: ${LOGICAL.h}\nWrapStyle: 2\n\n` +
    `[V4+ Styles]\n` +
    `Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    // MarginL clears the docked sidebar, so the caption centres over the workspace.
    `Style: Cap, DejaVu Sans, 28, &H00FFFFFF, &H00000000, &HB0000000, -1, 3, 6, 0, 8, 330, 80, 22, 1\n` +
    `Style: Shade, DejaVu Sans, 20, &H38000000, &H00000000, &H00000000, 0, 1, 0, 0, 7, 0, 0, 0, 1\n` +
    `Style: Code, DejaVu Sans Mono, 22, &H00E6EDF3, &H00000000, &H00000000, 0, 1, 0, 0, 7, 0, 0, 0, 1\n` +
    `Style: Chapter, DejaVu Sans, 60, &H00FFFFFF, &H00000000, &H00000000, -1, 1, 0, 0, 5, 80, 80, 0, 1\n\n` +
    `[Events]\n` +
    `Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const path = join(workDir, "captions.ass");
  writeFileSync(path, header + dialogue.join("\n") + "\n");
  return path;
}

const ENCODE_ARGS = [
  "-c:v",
  "libx264",
  "-preset",
  "medium",
  "-crf",
  "20",
  "-pix_fmt",
  "yuv420p",
  "-movflags",
  "+faststart",
];

/**
 * Downscale the 2x grab, drop the cut spans, splice in the chapter cards,
 * crossfade each join, burn the captions.
 */
function encodeFinal(
  rawPath: string,
  output: string,
  timeline: Timeline,
  captionFile: string
): void {
  mkdirSync(dirname(output), { recursive: true });
  const size = `${LOGICAL.w}x${LOGICAL.h}`;
  const scale = `scale=${LOGICAL.w}:${LOGICAL.h}:flags=lanczos`;
  const parts: string[] = [];
  timeline.pieces.forEach(({ piece }, i) => {
    // Normalize framerate / SAR / format on each piece: xfade rejects inputs
    // whose frame timing or pixel format differ, which trimmed spans otherwise do.
    parts.push(
      piece.kind === "raw"
        ? `[0:v]trim=start=${piece.start.toFixed(3)}:end=${piece.end.toFixed(3)},` +
            `setpts=PTS-STARTPTS,fps=${FPS},${scale},setsar=1,format=yuv420p[v${i}]`
        : `color=c=${CARD_COLOR}:s=${size}:r=${FPS}:d=${cardLength(piece.chapter)},` +
            `setsar=1,format=yuv420p[v${i}]`
    );
  });
  let cur = "v0";
  timeline.pieces.slice(1).forEach(({ at }, idx) => {
    const i = idx + 1;
    const fade = timeline.pieces[idx]!.fadeOut;
    parts.push(
      `[${cur}][v${i}]xfade=transition=fade:duration=${fade}:offset=${at.toFixed(3)}[x${i}]`
    );
    cur = `x${i}`;
  });
  parts.push(`[${cur}]ass='${captionFile}'[capped]`);
  execFileSync(
    FFMPEG,
    [
      "-y",
      "-i",
      rawPath,
      "-filter_complex",
      parts.join(";"),
      "-map",
      "[capped]",
      ...ENCODE_ARGS,
      output,
    ],
    { stdio: "ignore" }
  );
}

/**
 * Lift one frame out of the raw grab and downscale it exactly as the video is
 * downscaled, so the poster is pixel-for-pixel a frame of the delivered mp4.
 */
function extractPoster(rawPath: string, poster: string, atS: number): void {
  mkdirSync(dirname(poster), { recursive: true });
  execFileSync(
    FFMPEG,
    [
      "-y",
      "-ss",
      atS.toFixed(3),
      "-i",
      rawPath,
      "-frames:v",
      "1",
      "-update",
      "1",
      "-vf",
      `scale=${LOGICAL.w}:${LOGICAL.h}:flags=lanczos`,
      "-compression_level",
      "100",
      poster,
    ],
    { stdio: "ignore" }
  );
}
