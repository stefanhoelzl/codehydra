// src/lib/components/AgentStatusIndicator.test.ts

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import AgentStatusIndicator from './AgentStatusIndicator.svelte';
import type { AggregatedAgentStatus } from '$lib/types/agentStatus';

describe('AgentStatusIndicator', () => {
  // === Render Tests ===

  describe('rendering', () => {
    it('renders without crashing', () => {
      const status: AggregatedAgentStatus = { type: 'noAgents' };
      render(AgentStatusIndicator, { props: { status } });
      expect(screen.getByRole('status')).toBeTruthy();
    });

    it('applies small size class by default', () => {
      const status: AggregatedAgentStatus = { type: 'noAgents' };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.classList.contains('small')).toBe(true);
    });

    it('applies medium size class when specified', () => {
      const status: AggregatedAgentStatus = { type: 'noAgents' };
      render(AgentStatusIndicator, { props: { status, size: 'medium' } });
      const element = screen.getByRole('status');
      expect(element.classList.contains('medium')).toBe(true);
    });
  });

  // === Color Class Tests ===

  describe('color classes', () => {
    it('applies grey class for noAgents', () => {
      const status: AggregatedAgentStatus = { type: 'noAgents' };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.classList.contains('grey')).toBe(true);
    });

    it('applies green class for allIdle', () => {
      const status: AggregatedAgentStatus = { type: 'allIdle', count: 2 };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.classList.contains('green')).toBe(true);
    });

    it('applies red class for allBusy', () => {
      const status: AggregatedAgentStatus = { type: 'allBusy', count: 3 };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.classList.contains('red')).toBe(true);
    });

    it('applies mixed class for mixed status', () => {
      const status: AggregatedAgentStatus = { type: 'mixed', idle: 1, busy: 2 };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.classList.contains('mixed')).toBe(true);
    });
  });

  // === Tooltip Tests ===

  describe('tooltip', () => {
    it('shows correct tooltip for noAgents', () => {
      const status: AggregatedAgentStatus = { type: 'noAgents' };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.getAttribute('title')).toBe('No agents running');
    });

    it('shows correct tooltip for allIdle', () => {
      const status: AggregatedAgentStatus = { type: 'allIdle', count: 2 };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.getAttribute('title')).toBe('2 agents idle');
    });

    it('shows correct tooltip for allBusy', () => {
      const status: AggregatedAgentStatus = { type: 'allBusy', count: 1 };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.getAttribute('title')).toBe('1 agent busy');
    });

    it('shows correct tooltip for mixed', () => {
      const status: AggregatedAgentStatus = { type: 'mixed', idle: 2, busy: 3 };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.getAttribute('title')).toBe('2 idle, 3 busy');
    });
  });

  // === Accessibility Tests ===

  describe('accessibility', () => {
    it('has role="status"', () => {
      const status: AggregatedAgentStatus = { type: 'noAgents' };
      render(AgentStatusIndicator, { props: { status } });
      expect(screen.getByRole('status')).toBeTruthy();
    });

    it('has aria-label matching tooltip', () => {
      const status: AggregatedAgentStatus = { type: 'allIdle', count: 3 };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.getAttribute('aria-label')).toBe('3 agents idle');
    });
  });

  // === Mixed Indicator Structure Tests ===

  describe('mixed indicator structure', () => {
    it('renders child divs for mixed status', () => {
      const status: AggregatedAgentStatus = { type: 'mixed', idle: 1, busy: 1 };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.children.length).toBe(2);
    });

    it('does not render child divs for non-mixed status', () => {
      const status: AggregatedAgentStatus = { type: 'allIdle', count: 1 };
      render(AgentStatusIndicator, { props: { status } });
      const element = screen.getByRole('status');
      expect(element.children.length).toBe(0);
    });
  });

  // === Reactive Update Tests ===

  describe('reactive updates', () => {
    it('updates color when status prop changes from idle to busy', async () => {
      const { rerender } = render(AgentStatusIndicator, {
        props: { status: { type: 'allIdle', count: 1 } as AggregatedAgentStatus },
      });

      let element = screen.getByRole('status');
      expect(element.classList.contains('green')).toBe(true);

      await rerender({ status: { type: 'allBusy', count: 1 } as AggregatedAgentStatus });

      element = screen.getByRole('status');
      expect(element.classList.contains('red')).toBe(true);
      expect(element.classList.contains('green')).toBe(false);
    });

    it('updates tooltip when status changes', async () => {
      const { rerender } = render(AgentStatusIndicator, {
        props: { status: { type: 'noAgents' } as AggregatedAgentStatus },
      });

      let element = screen.getByRole('status');
      expect(element.getAttribute('title')).toBe('No agents running');

      await rerender({ status: { type: 'allIdle', count: 3 } as AggregatedAgentStatus });

      element = screen.getByRole('status');
      expect(element.getAttribute('title')).toBe('3 agents idle');
    });

    it('transitions from solid to mixed indicator', async () => {
      const { rerender } = render(AgentStatusIndicator, {
        props: { status: { type: 'allIdle', count: 2 } as AggregatedAgentStatus },
      });

      let element = screen.getByRole('status');
      expect(element.children.length).toBe(0);

      await rerender({ status: { type: 'mixed', idle: 1, busy: 1 } as AggregatedAgentStatus });

      element = screen.getByRole('status');
      expect(element.children.length).toBe(2);
      expect(element.classList.contains('mixed')).toBe(true);
    });

    it('updates aria-label for accessibility when status changes', async () => {
      const { rerender } = render(AgentStatusIndicator, {
        props: { status: { type: 'allBusy', count: 2 } as AggregatedAgentStatus },
      });

      let element = screen.getByRole('status');
      expect(element.getAttribute('aria-label')).toBe('2 agents busy');

      await rerender({ status: { type: 'mixed', idle: 3, busy: 1 } as AggregatedAgentStatus });

      element = screen.getByRole('status');
      expect(element.getAttribute('aria-label')).toBe('3 idle, 1 busy');
    });
  });
});
