import { vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

// Mock Tauri's invoke function
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Mock @tauri-apps/plugin-global-shortcut
type ShortcutCallback = () => void;
const registeredShortcuts = new Map<string, ShortcutCallback>();

vi.mock('@tauri-apps/plugin-global-shortcut', () => ({
  register: vi.fn(async (shortcut: string, callback: ShortcutCallback) => {
    registeredShortcuts.set(shortcut, callback);
  }),
  unregister: vi.fn(async (shortcut: string) => {
    registeredShortcuts.delete(shortcut);
  }),
  isRegistered: vi.fn(async (shortcut: string) => {
    return registeredShortcuts.has(shortcut);
  }),
}));

// Helper to simulate global shortcut press in tests
export function simulateGlobalShortcut(shortcut: string): void {
  const callback = registeredShortcuts.get(shortcut);
  if (callback) callback();
}

export function clearRegisteredShortcuts(): void {
  registeredShortcuts.clear();
}

// Mock Element.animate for happy-dom (not supported)
if (!Element.prototype.animate) {
  Element.prototype.animate = function () {
    return {
      finished: Promise.resolve(),
      onfinish: null,
      cancel: () => {},
      play: () => {},
      pause: () => {},
      finish: () => {},
      reverse: () => {},
    } as unknown as Animation;
  };
}

// Mock vscode-elements web components
// These are custom elements that need to be registered for happy-dom
class MockVSCodeElement extends HTMLElement {
  static get observedAttributes() {
    return ['value', 'disabled'];
  }

  value = '';

  constructor() {
    super();
  }

  focus() {
    // Mock focus behavior
    this.dispatchEvent(new FocusEvent('focus'));
  }

  attributeChangedCallback(name: string, _oldValue: string, newValue: string) {
    if (name === 'value') {
      this.value = newValue;
    }
  }
}

// Register mock elements if not already registered
const elements = [
  'vscode-textfield',
  'vscode-single-select',
  'vscode-option',
  'vscode-button',
  'vscode-icon',
];

elements.forEach((tagName) => {
  if (!customElements.get(tagName)) {
    customElements.define(tagName, class extends MockVSCodeElement {});
  }
});
