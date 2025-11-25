// src/lib/components/AgentStatusIndicator.test.ts

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import AgentStatusIndicator from './AgentStatusIndicator.svelte';
import type { AgentStatusCounts } from '$lib/types/agentStatus';

describe('AgentStatusIndicator', () => {
  // === Render Tests ===

  describe('rendering', () => {
    it('renders without crashing', () => {
      const counts: AgentStatusCounts = { idle: 0, busy: 0 };
      render(AgentStatusIndicator, { props: { counts } });
      expect(screen.getByRole('status')).toBeTruthy();
    });

    it('applies small size class by default', () => {
      const counts: AgentStatusCounts = { idle: 0, busy: 0 };
      render(AgentStatusIndicator, { props: { counts } });
      const element = screen.getByRole('status');
      expect(element.classList.contains('small')).toBe(true);
    });

    it('applies medium size class when specified', () => {
      const counts: AgentStatusCounts = { idle: 0, busy: 0 };
      render(AgentStatusIndicator, { props: { counts, size: 'medium' } });
      const element = screen.getByRole('status');
      expect(element.classList.contains('medium')).toBe(true);
    });
  });

  // === Color Class Tests ===

  describe('color classes', () => {
    it('applies grey class for zero counts', () => {
      const counts: AgentStatusCounts = { idle: 0, busy: 0 };
      render(AgentStatusIndicator, { props: { counts } });
      const element = screen.getByRole('status');
      expect(element.classList.contains('grey')).toBe(true);
    });

    it('applies green class for all idle', () => {
      const counts: AgentStatusCounts = { idle: 2, busy: 0 };
      render(AgentStatusIndicator, { props: { counts } });
      const element = screen.getByRole('status');
      expect(element.classList.contains('green')).toBe(true);
    });

    it('applies red class for all busy', () => {
      const counts: AgentStatusCounts = { idle: 0, busy: 3 };
      render(AgentStatusIndicator, { props: { counts } });
      const element = screen.getByRole('status');
      expect(element.classList.contains('red')).toBe(true);
    });

    it('applies mixed class for mixed status', () => {
      const counts: AgentStatusCounts = { idle: 1, busy: 2 };
      render(AgentStatusIndicator, { props: { counts } });
      const element = screen.getByRole('status');
      expect(element.classList.contains('mixed')).toBe(true);
    });
  });

  // === Tooltip Tests ===

  describe('tooltip', () => {
    it('shows correct tooltip for zero counts', () => {
      const counts: AgentStatusCounts = { idle: 0, busy: 0 };
      render(AgentStatusIndicator, { props: { counts } });
      const element = screen.getByRole('status');
      expect(element.getAttribute('title')).toBe('No agents running');
    });

    it('shows correct tooltip for all idle', () => {
      const counts: AgentStatusCounts = { idle: 2, busy: 0 };
      render(AgentStatusIndicator, { props: { counts } });
      const element = screen.getByRole('status');
      expect(element.getAttribute('title')).toBe('2 agents idle');
    });

    it('shows correct tooltip for single idle agent', () => {
      const counts: AgentStatusCounts = { idle: 1, busy: 0 };
      render(AgentStatusIndicator, { props: { counts } });
      const element = screen.getByRole('status');
      expect(element.getAttribute('title')).toBe('1 agent idle');
    });

    it('shows correct tooltip for all busy', () => {
      const counts: AgentStatusCounts = { idle: 0, busy: 1 };
      render(AgentStatusIndicator, { props: { counts } });
      const element = screen.getByRole('status');
      expect(element.getAttribute('title')).toBe('1 agent busy');
    });

    it('shows correct tooltip for mixed', () => {
      const counts: AgentStatusCounts = { idle: 2, busy: 3 };
      render(AgentStatusIndicator, { props: { counts } });
      const element = screen.getByRole('status');
      expect(element.getAttribute('title')).toBe('2 idle, 3 busy');
    });
  });

  // === Accessibility Tests ===

  describe('accessibility', () => {
    it('has role="status"', () => {
      const counts: AgentStatusCounts = { idle: 0, busy: 0 };
      render(AgentStatusIndicator, { props: { counts } });
      expect(screen.getByRole('status')).toBeTruthy();
    });

    it('has aria-label matching tooltip', () => {
      const counts: AgentStatusCounts = { idle: 3, busy: 0 };
      render(AgentStatusIndicator, { props: { counts } });
      const element = screen.getByRole('status');
      expect(element.getAttribute('aria-label')).toBe('3 agents idle');
    });
  });

  // === Mixed Indicator Structure Tests ===

  describe('mixed indicator structure', () => {
    it('renders child divs for mixed status', () => {
      const counts: AgentStatusCounts = { idle: 1, busy: 1 };
      render(AgentStatusIndicator, { props: { counts } });
      const element = screen.getByRole('status');
      expect(element.children.length).toBe(2);
    });

    it('does not render child divs for non-mixed status', () => {
      const counts: AgentStatusCounts = { idle: 1, busy: 0 };
      render(AgentStatusIndicator, { props: { counts } });
      const element = screen.getByRole('status');
      expect(element.children.length).toBe(0);
    });
  });

  // === Reactive Update Tests ===

  describe('reactive updates', () => {
    it('updates color when counts prop changes from idle to busy', async () => {
      const { rerender } = render(AgentStatusIndicator, {
        props: { counts: { idle: 1, busy: 0 } as AgentStatusCounts },
      });

      let element = screen.getByRole('status');
      expect(element.classList.contains('green')).toBe(true);

      await rerender({ counts: { idle: 0, busy: 1 } as AgentStatusCounts });

      element = screen.getByRole('status');
      expect(element.classList.contains('red')).toBe(true);
      expect(element.classList.contains('green')).toBe(false);
    });

    it('updates tooltip when counts change', async () => {
      const { rerender } = render(AgentStatusIndicator, {
        props: { counts: { idle: 0, busy: 0 } as AgentStatusCounts },
      });

      let element = screen.getByRole('status');
      expect(element.getAttribute('title')).toBe('No agents running');

      await rerender({ counts: { idle: 3, busy: 0 } as AgentStatusCounts });

      element = screen.getByRole('status');
      expect(element.getAttribute('title')).toBe('3 agents idle');
    });

    it('transitions from solid to mixed indicator', async () => {
      const { rerender } = render(AgentStatusIndicator, {
        props: { counts: { idle: 2, busy: 0 } as AgentStatusCounts },
      });

      let element = screen.getByRole('status');
      expect(element.children.length).toBe(0);

      await rerender({ counts: { idle: 1, busy: 1 } as AgentStatusCounts });

      element = screen.getByRole('status');
      expect(element.children.length).toBe(2);
      expect(element.classList.contains('mixed')).toBe(true);
    });

    it('updates aria-label for accessibility when counts change', async () => {
      const { rerender } = render(AgentStatusIndicator, {
        props: { counts: { idle: 0, busy: 2 } as AgentStatusCounts },
      });

      let element = screen.getByRole('status');
      expect(element.getAttribute('aria-label')).toBe('2 agents busy');

      await rerender({ counts: { idle: 3, busy: 1 } as AgentStatusCounts });

      element = screen.getByRole('status');
      expect(element.getAttribute('aria-label')).toBe('3 idle, 1 busy');
    });

    it('handles large agent counts correctly', () => {
      const counts: AgentStatusCounts = { idle: 100, busy: 50 };
      render(AgentStatusIndicator, { props: { counts } });
      const element = screen.getByRole('status');
      expect(element.getAttribute('title')).toBe('100 idle, 50 busy');
    });

    it('transitions correctly when counts change', async () => {
      const { rerender } = render(AgentStatusIndicator, {
        props: { counts: { idle: 1, busy: 0 } as AgentStatusCounts },
      });
      expect(screen.getByRole('status').classList.contains('green')).toBe(true);

      await rerender({ counts: { idle: 0, busy: 0 } as AgentStatusCounts });
      expect(screen.getByRole('status').classList.contains('grey')).toBe(true);
    });
  });
});
