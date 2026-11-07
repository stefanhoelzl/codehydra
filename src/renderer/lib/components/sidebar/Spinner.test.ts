/**
 * Tests for the sidebar Spinner: its variants, and that every spinner runs on
 * the shared clock (spin-clock.ts) so all of them step on the same frames.
 */

import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import Spinner from "./Spinner.svelte";

/** A running animation as the element would report it: started whenever it mounted. */
interface FakeAnimation {
  startTime: number | null;
}

/** Give elements a Web Animations `getAnimations`, which happy-dom lacks. */
function withAnimations(): Map<Element, FakeAnimation[]> {
  const byElement = new Map<Element, FakeAnimation[]>();
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value(this: Element): FakeAnimation[] {
      let list = byElement.get(this);
      if (list === undefined) {
        list = [{ startTime: 1234 }];
        byElement.set(this, list);
      }
      return list;
    },
  });
  return byElement;
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

describe("Spinner", () => {
  it("renders a neutral ring by default", () => {
    const { container } = render(Spinner);
    const ring = container.querySelector(".ring");
    expect(ring).not.toBeNull();
    expect(ring?.classList.contains("busy")).toBe(false);
    expect(ring?.classList.contains("small")).toBe(false);
    expect(ring?.classList.contains("still")).toBe(false);
  });

  it("renders the busy, small and still variants, a title and extra classes", () => {
    const { container } = render(Spinner, {
      props: { tone: "busy", small: true, still: true, title: "Agent working", class: "pending" },
    });
    const ring = container.querySelector(".ring");
    expect(ring?.className).toMatch(/\bbusy\b/);
    expect(ring?.className).toMatch(/\bsmall\b/);
    expect(ring?.className).toMatch(/\bstill\b/);
    expect(ring?.className).toMatch(/\bpending\b/);
    expect(ring?.getAttribute("title")).toBe("Agent working");
  });

  it("pins every spinner's animation to the shared clock when it mounts", () => {
    const animations = withAnimations();
    const first = render(Spinner).container.querySelector(".ring");
    const second = render(Spinner, { props: { tone: "busy" } }).container.querySelector(".ring");

    expect(first && animations.get(first)).toEqual([{ startTime: 0 }]);
    expect(second && animations.get(second)).toEqual([{ startTime: 0 }]);
  });

  it("pins a restarted animation again when it starts", async () => {
    const animations = withAnimations();
    const ring = render(Spinner).container.querySelector(".ring");
    if (ring === null) throw new Error("no ring");

    // The animation was turned off and on again: a new one, at its own start.
    animations.set(ring, [{ startTime: 5678 }]);
    await fireEvent(ring, new Event("animationstart"));

    expect(animations.get(ring)).toEqual([{ startTime: 0 }]);
  });
});
