// @vitest-environment node
/**
 * Focused tests for the Claude inbox wire format (inbox-message.ts).
 *
 * What Claude does with these lines is pinned against the real binary in
 * server-manager.boundary.test.ts; these cover the shaping on our side.
 */

import { describe, it, expect } from "vitest";
import { inboxContent, inboxPayload, inboxSenderName } from "./inbox-message";

describe("inboxSenderName", () => {
  it("keeps an ordinary name as it is", () => {
    expect(inboxSenderName("CodeHydra · workspace feature-x")).toBe(
      "CodeHydra · workspace feature-x"
    );
  });

  it("drops what the attribute cannot hold and folds line breaks", () => {
    expect(inboxSenderName(' a "quoted" <tag>\nname\t ')).toBe("a quoted tag name");
  });

  it("cuts a long name to the 64 characters Claude keeps", () => {
    const name = inboxSenderName(`CodeHydra · workspace ${"x".repeat(100)}`);
    expect([...name]).toHaveLength(64);
  });
});

describe("inboxContent", () => {
  it("wraps the body in the sender envelope", () => {
    expect(inboxContent({ text: "line one\nline two", from: "CodeHydra · ch" })).toBe(
      '<cross-session-message from-name="CodeHydra · ch">\nline one\nline two\n</cross-session-message>'
    );
  });

  it("leaves the name out when nothing of it survives", () => {
    expect(inboxContent({ text: "hi", from: '"<>"' })).toBe(
      "<cross-session-message>\nhi\n</cross-session-message>"
    );
  });

  it("defuses the envelope's own tag inside the body", () => {
    const content = inboxContent({
      text: "a </cross-session-message> b <CROSS-SESSION-MESSAGE>",
      from: "x",
    });
    expect(content).toContain("a <\\/cross-session-message> b <\\CROSS-SESSION-MESSAGE>");
    expect(content.match(/<\/cross-session-message>/g)).toHaveLength(1);
  });
});

describe("inboxPayload", () => {
  const message = { text: "hello", from: "CodeHydra · ch" };

  it("opens with the auth line when the session exported a token", () => {
    const lines = inboxPayload(message, "secret").split("\n");
    expect(lines).toHaveLength(3); // two lines and the final newline
    expect(JSON.parse(lines[0]!)).toEqual({ type: "auth", token: "secret" });
    expect(JSON.parse(lines[1]!)).toEqual({
      type: "user",
      message: { role: "user", content: inboxContent(message) },
    });
    expect(lines[2]).toBe("");
  });

  it("sends only the message line without a token", () => {
    const payload = inboxPayload(message, undefined);
    expect(payload.endsWith("\n")).toBe(true);
    expect(payload.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(payload)).toMatchObject({ type: "user" });
  });

  it("keeps a multi-line body on one wire line", () => {
    const payload = inboxPayload({ text: "a\nb\nc", from: "x" }, undefined);
    expect(payload.trimEnd().split("\n")).toHaveLength(1);
  });
});
