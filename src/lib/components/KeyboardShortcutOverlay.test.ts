import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import KeyboardShortcutOverlay from './KeyboardShortcutOverlay.svelte';
import { chimeShortcutActive, resetKeyboardNavigationState } from '$lib/stores/keyboardNavigation';
import { CHIME_SHORTCUTS } from '$lib/config/keybindings';

describe('KeyboardShortcutOverlay', () => {
  beforeEach(() => {
    resetKeyboardNavigationState();
  });

  afterEach(() => {
    resetKeyboardNavigationState();
  });

  it('is hidden when chimeShortcutActive is false', () => {
    render(KeyboardShortcutOverlay);

    // Query by role should not find anything
    const overlay = screen.queryByRole('status');
    expect(overlay).not.toBeInTheDocument();
  });

  it('is visible when chimeShortcutActive is true', async () => {
    render(KeyboardShortcutOverlay);

    // Activate shortcut mode
    chimeShortcutActive.set(true);

    // Wait for the DOM to update
    await new Promise((r) => setTimeout(r, 0));

    const overlay = screen.getByRole('status');
    expect(overlay).toBeInTheDocument();
  });

  it('has role="status" and aria-live="polite" for accessibility', async () => {
    render(KeyboardShortcutOverlay);
    chimeShortcutActive.set(true);

    await new Promise((r) => setTimeout(r, 0));

    const overlay = screen.getByRole('status');
    expect(overlay).toHaveAttribute('aria-live', 'polite');
  });

  it('displays navigation shortcut label and description', async () => {
    render(KeyboardShortcutOverlay);
    chimeShortcutActive.set(true);

    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByText(CHIME_SHORTCUTS.navigateUp.label)).toBeInTheDocument();
    expect(screen.getByText(CHIME_SHORTCUTS.navigateUp.description)).toBeInTheDocument();
  });

  it('displays create workspace shortcut label and description', async () => {
    render(KeyboardShortcutOverlay);
    chimeShortcutActive.set(true);

    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByText(CHIME_SHORTCUTS.createWorkspace.label)).toBeInTheDocument();
    expect(screen.getByText(CHIME_SHORTCUTS.createWorkspace.description)).toBeInTheDocument();
  });

  it('displays remove workspace shortcut label and description', async () => {
    render(KeyboardShortcutOverlay);
    chimeShortcutActive.set(true);

    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByText(CHIME_SHORTCUTS.removeWorkspace.label)).toBeInTheDocument();
    expect(screen.getByText(CHIME_SHORTCUTS.removeWorkspace.description)).toBeInTheDocument();
  });

  it('displays jump to workspace shortcut label and description', async () => {
    render(KeyboardShortcutOverlay);
    chimeShortcutActive.set(true);

    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByText(CHIME_SHORTCUTS.jumpToWorkspace.label)).toBeInTheDocument();
    expect(screen.getByText(CHIME_SHORTCUTS.jumpToWorkspace.description)).toBeInTheDocument();
  });

  it('has overlay class', async () => {
    render(KeyboardShortcutOverlay);
    chimeShortcutActive.set(true);

    await new Promise((r) => setTimeout(r, 0));

    const overlay = screen.getByRole('status');
    expect(overlay).toHaveClass('overlay');
    // Note: z-index 999 is defined in CSS but getComputedStyle may not return it in happy-dom
  });
});
