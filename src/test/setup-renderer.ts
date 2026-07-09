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
