/**
 * Claude Code's per-session inbox — the wire format CodeHydra writes to it.
 *
 * Every Claude session binds an inbox socket for cross-session messages and
 * exports its path and a per-session token to hooks as
 * `CLAUDE_CODE_MESSAGING_SOCKET` / `CLAUDE_CODE_MESSAGING_TOKEN` (documented).
 * What goes over it is NOT documented — the docs call it plain text, but plain
 * lines are ignored. Observed on 2.1.281 and pinned by
 * `server-manager.boundary.test.ts`:
 *
 *   {"type":"auth","token":"<token>"}                       (required on Windows)
 *   {"type":"user","message":{"role":"user","content":"<envelope>"}}
 *
 * The envelope names the sender. Claude parses it only when it re-renders to
 * exactly the same text, so every part here is normalized to what Claude would
 * render itself; anything else still arrives, just without the sender name.
 *
 *   <cross-session-message from-name="CodeHydra · workspace foo">
 *   body
 *   </cross-session-message>
 *
 * No `from-mode` is declared, deliberately: a session that bypasses permission
 * prompts then holds the message for its user's approval, as it would any
 * message from outside it.
 */

import type { AgentMessage } from "../types";

/** The envelope's tag name. */
const TAG = "cross-session-message";

/** Claude cuts a sender name longer than this, which breaks the envelope. */
const MAX_FROM_NAME_LENGTH = 64;

/**
 * A sender name Claude will accept verbatim: no characters the attribute
 * cannot hold (`"`, `<`, `>`), no control or line-break characters, trimmed,
 * and no longer than Claude keeps.
 */
export function inboxSenderName(from: string): string {
  const cleaned = from
    .replace(/\s+/g, " ")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}"<>]/gu, "")
    .trim();
  return [...cleaned].slice(0, MAX_FROM_NAME_LENGTH).join("").trim();
}

/**
 * The body, with anything that would read as the envelope's own tag defused
 * the way Claude defuses it (`<` becomes `<\`).
 */
function escapeBody(text: string): string {
  return text.replace(new RegExp(`<(?=/?${TAG})`, "gi"), "<\\");
}

/** The message content: the body inside the sender envelope. */
export function inboxContent(message: AgentMessage): string {
  const name = inboxSenderName(message.from);
  const attribute = name === "" ? "" : ` from-name="${name}"`;
  return `<${TAG}${attribute}>\n${escapeBody(message.text)}\n</${TAG}>`;
}

/**
 * Everything written to the inbox socket for one message: the auth line (when
 * the session exported a token) and the message line, each newline-terminated.
 */
export function inboxPayload(message: AgentMessage, token: string | undefined): string {
  const lines: string[] = [];
  if (token !== undefined && token !== "") {
    lines.push(JSON.stringify({ type: "auth", token }));
  }
  lines.push(
    JSON.stringify({ type: "user", message: { role: "user", content: inboxContent(message) } })
  );
  return lines.map((line) => `${line}\n`).join("");
}
