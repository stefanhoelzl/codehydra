import { describe, it, expect, expectTypeOf } from "vitest";
import {
  createWindowHandle,
  createViewHandle,
  createSessionHandle,
  type WindowHandle,
  type ViewHandle,
  type SessionHandle,
} from "./types";

describe("Handle creation", () => {
  describe("createWindowHandle", () => {
    it("creates a WindowHandle with correct id", () => {
      const handle = createWindowHandle("window-1");

      expect(handle.id).toBe("window-1");
      expect(handle.__brand).toBe("WindowHandle");
    });
  });

  describe("createViewHandle", () => {
    it("creates a ViewHandle with correct id", () => {
      const handle = createViewHandle("view-42");

      expect(handle.id).toBe("view-42");
      expect(handle.__brand).toBe("ViewHandle");
    });
  });

  describe("createSessionHandle", () => {
    it("creates a SessionHandle with correct id", () => {
      const handle = createSessionHandle("session-123");

      expect(handle.id).toBe("session-123");
      expect(handle.__brand).toBe("SessionHandle");
    });
  });
});

describe("Handle type safety", () => {
  it("WindowHandle has correct type shape", () => {
    const handle = createWindowHandle("test");
    expectTypeOf(handle).toEqualTypeOf<WindowHandle>();
    expectTypeOf(handle.id).toBeString();
    expectTypeOf(handle.__brand).toEqualTypeOf<"WindowHandle">();
  });

  it("ViewHandle has correct type shape", () => {
    const handle = createViewHandle("test");
    expectTypeOf(handle).toEqualTypeOf<ViewHandle>();
    expectTypeOf(handle.id).toBeString();
    expectTypeOf(handle.__brand).toEqualTypeOf<"ViewHandle">();
  });

  it("SessionHandle has correct type shape", () => {
    const handle = createSessionHandle("test");
    expectTypeOf(handle).toEqualTypeOf<SessionHandle>();
    expectTypeOf(handle.id).toBeString();
    expectTypeOf(handle.__brand).toEqualTypeOf<"SessionHandle">();
  });

  // Type-level tests: branded types prevent mixing
  // These are compile-time checks - if they compile, the test passes
  it("branded types are distinct at type level", () => {
    // These assignments would fail at compile time if types were not branded:
    // const windowAsView: ViewHandle = createWindowHandle("test"); // Error!
    // const viewAsSession: SessionHandle = createViewHandle("test"); // Error!

    // Same brand can be assigned
    const window1: WindowHandle = createWindowHandle("w1");
    const window2: WindowHandle = createWindowHandle("w2");
    expect(window1.__brand).toBe(window2.__brand);

    // Different brands have different values
    const view: ViewHandle = createViewHandle("v1");
    const session: SessionHandle = createSessionHandle("s1");
    expect(window1.__brand).not.toBe(view.__brand);
    expect(view.__brand).not.toBe(session.__brand);
  });
});

describe("Handle equality", () => {
  it("handles with same id are structurally equal", () => {
    const handle1 = createWindowHandle("window-1");
    const handle2 = createWindowHandle("window-1");

    expect(handle1.id).toBe(handle2.id);
    expect(handle1.__brand).toBe(handle2.__brand);
  });

  it("handles with different ids are not equal", () => {
    const handle1 = createWindowHandle("window-1");
    const handle2 = createWindowHandle("window-2");

    expect(handle1.id).not.toBe(handle2.id);
  });
});
