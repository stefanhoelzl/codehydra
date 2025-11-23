import { vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

// Mock Tauri's invoke function
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

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
