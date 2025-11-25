import { describe, it, expect } from 'vitest';
import {
  getDisplayKeyForIndex,
  CHIME_SHORTCUTS,
  DIALOG_SHORTCUTS,
  CHIME_ACTIVATION,
} from './keybindings';

describe('keybindings', () => {
  describe('CHIME_ACTIVATION', () => {
    it('has display format for UI', () => {
      expect(CHIME_ACTIVATION.display).toBe('Alt+X');
    });
  });

  describe('getDisplayKeyForIndex', () => {
    it('returns correct display key for indices 1-9', () => {
      expect(getDisplayKeyForIndex(1)).toBe('1');
      expect(getDisplayKeyForIndex(5)).toBe('5');
      expect(getDisplayKeyForIndex(9)).toBe('9');
    });

    it('returns 0 for index 10', () => {
      expect(getDisplayKeyForIndex(10)).toBe('0');
    });

    it('returns null for index greater than 10', () => {
      expect(getDisplayKeyForIndex(11)).toBe(null);
      expect(getDisplayKeyForIndex(100)).toBe(null);
    });

    it('returns null for index less than 1', () => {
      expect(getDisplayKeyForIndex(0)).toBe(null);
      expect(getDisplayKeyForIndex(-1)).toBe(null);
    });
  });

  describe('DIALOG_SHORTCUTS', () => {
    it('has Enter for confirm', () => {
      expect(DIALOG_SHORTCUTS.confirm.key).toBe('Enter');
    });

    it('has Escape for cancel', () => {
      expect(DIALOG_SHORTCUTS.cancel.key).toBe('Escape');
    });
  });

  describe('CHIME_SHORTCUTS structure', () => {
    it('has all required shortcuts defined', () => {
      expect(CHIME_SHORTCUTS.navigateUp).toBeDefined();
      expect(CHIME_SHORTCUTS.navigateDown).toBeDefined();
      expect(CHIME_SHORTCUTS.createWorkspace).toBeDefined();
      expect(CHIME_SHORTCUTS.removeWorkspace).toBeDefined();
      expect(CHIME_SHORTCUTS.jumpToWorkspace).toBeDefined();
    });

    it('has labels for UI display', () => {
      expect(CHIME_SHORTCUTS.navigateUp.label).toBe('\u2191\u2193');
      expect(CHIME_SHORTCUTS.createWorkspace.label).toBe('\u23CE');
      expect(CHIME_SHORTCUTS.removeWorkspace.label).toBe('\u232B');
      expect(CHIME_SHORTCUTS.jumpToWorkspace.label).toBe('1-0');
    });

    it('has descriptions for overlay', () => {
      expect(CHIME_SHORTCUTS.navigateUp.description).toBe('Navigate');
      expect(CHIME_SHORTCUTS.createWorkspace.description).toBe('New');
      expect(CHIME_SHORTCUTS.removeWorkspace.description).toBe('Del');
      expect(CHIME_SHORTCUTS.jumpToWorkspace.description).toBe('Jump');
    });
  });
});
