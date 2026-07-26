/**
 * Setup file for renderer tests.
 * Loads vscode-elements and provides happy-dom compatibility mocks.
 */

import { PropertySymbol } from "happy-dom";

// Neuter <iframe> page loading. happy-dom's HTMLIFrameElement navigates a real
// child frame whenever it is connected, or its src/srcdoc changes — for
// WorkspaceFrames that means HTTP requests to the IDE server. Overriding the
// four hooks that reach #loadPage() skips the navigation; each delegates to the
// HTMLElement implementation, i.e. what the real hook calls as super. Nothing we
// render reads contentWindow (it stays null either way).
//
// This mock is the only thing keeping renderer tests off the network, so a
// happy-dom upgrade that renames the hooks must fail here rather than quietly
// let the iframes load.
{
  const hooks = [
    PropertySymbol.connectedToDocument,
    PropertySymbol.disconnectedFromDocument,
    PropertySymbol.onSetAttribute,
    PropertySymbol.onRemoveAttribute,
  ];
  const iframeProto = HTMLIFrameElement.prototype as unknown as Record<
    symbol,
    (this: HTMLIFrameElement, ...args: unknown[]) => unknown
  >;
  const elementProto = Object.getPrototypeOf(HTMLIFrameElement.prototype) as Record<
    symbol,
    ((this: HTMLIFrameElement, ...args: unknown[]) => unknown) | undefined
  >;
  for (const hook of hooks) {
    const inherited = elementProto[hook];
    if (typeof inherited !== "function") {
      // happy-dom renamed or dropped the hook: fail loudly instead of silently
      // letting the tests issue real requests to the IDE server URL.
      throw new Error(`happy-dom iframe mock is stale: no HTMLElement hook ${String(hook)}`);
    }
    iframeProto[hook] = function (...args) {
      return inherited.apply(this, args);
    };
  }
}

// Mock Element.animate for Svelte 5 transitions in happy-dom. Svelte 5 drives
// css-based transitions (e.g. the sidebar's in:arrivalFlash) through the Web
// Animations API, which happy-dom does not implement — an unmocked call throws
// "element.animate is not a function" and the transitioning element never
// renders. This returns an inert Animation stub: the element mounts, the
// (visual-only) animation is a no-op, and nothing under test reads it back.
if (typeof Element.prototype.animate !== "function") {
  Element.prototype.animate = function (): Animation {
    let onfinish: ((this: Animation, ev: AnimationPlaybackEvent) => unknown) | null = null;
    let oncancel: ((this: Animation, ev: AnimationPlaybackEvent) => unknown) | null = null;
    const animation = {
      currentTime: 0,
      startTime: 0,
      playbackRate: 1,
      playState: "finished" as AnimationPlayState,
      pending: false,
      effect: null,
      finished: Promise.resolve(),
      ready: Promise.resolve(),
      get onfinish() {
        return onfinish;
      },
      set onfinish(fn) {
        onfinish = fn;
      },
      get oncancel() {
        return oncancel;
      },
      set oncancel(fn) {
        oncancel = fn;
      },
      cancel: () => {},
      finish: () => {},
      play: () => {},
      pause: () => {},
      reverse: () => {},
      persist: () => {},
      commitStyles: () => {},
      updatePlaybackRate: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
    return animation as unknown as Animation;
  };
}

// Mock attachInternals for vscode-elements in happy-dom
if (typeof HTMLElement.prototype.attachInternals === "undefined") {
  HTMLElement.prototype.attachInternals = function () {
    return {
      setFormValue: () => {},
      setValidity: () => {},
      states: new Set(),
    } as unknown as ElementInternals;
  };
}

// Create codicon stylesheet link required by vscode-icon component
// Must be created before vscode-elements are imported
const link = document.createElement("link");
link.rel = "stylesheet";
link.id = "vscode-codicon-stylesheet";
link.href = ""; // Empty href is fine for tests - we just need the element to exist
document.head.appendChild(link);

// Import vscode-elements so custom elements are registered
import "@vscode-elements/elements/dist/bundled.js";
