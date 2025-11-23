// src/lib/types/agentStatus.test.ts

import { describe, it, expect } from 'vitest';
import {
  getStatusColor,
  getStatusTooltip,
  getTotalAgents,
  createNoAgentsStatus,
  type AggregatedAgentStatus,
} from './agentStatus';

describe('agentStatus types', () => {
  // === getStatusColor Tests ===

  describe('getStatusColor', () => {
    it('returns grey for noAgents', () => {
      const status: AggregatedAgentStatus = { type: 'noAgents' };
      expect(getStatusColor(status)).toBe('grey');
    });

    it('returns green for allIdle', () => {
      const status: AggregatedAgentStatus = { type: 'allIdle', count: 2 };
      expect(getStatusColor(status)).toBe('green');
    });

    it('returns red for allBusy', () => {
      const status: AggregatedAgentStatus = { type: 'allBusy', count: 3 };
      expect(getStatusColor(status)).toBe('red');
    });

    it('returns mixed for mixed status', () => {
      const status: AggregatedAgentStatus = { type: 'mixed', idle: 1, busy: 2 };
      expect(getStatusColor(status)).toBe('mixed');
    });
  });

  // === getStatusTooltip Tests ===

  describe('getStatusTooltip', () => {
    it('returns correct text for noAgents', () => {
      const status: AggregatedAgentStatus = { type: 'noAgents' };
      expect(getStatusTooltip(status)).toBe('No agents running');
    });

    it('returns singular text for 1 idle agent', () => {
      const status: AggregatedAgentStatus = { type: 'allIdle', count: 1 };
      expect(getStatusTooltip(status)).toBe('1 agent idle');
    });

    it('returns plural text for multiple idle agents', () => {
      const status: AggregatedAgentStatus = { type: 'allIdle', count: 3 };
      expect(getStatusTooltip(status)).toBe('3 agents idle');
    });

    it('returns singular text for 1 busy agent', () => {
      const status: AggregatedAgentStatus = { type: 'allBusy', count: 1 };
      expect(getStatusTooltip(status)).toBe('1 agent busy');
    });

    it('returns plural text for multiple busy agents', () => {
      const status: AggregatedAgentStatus = { type: 'allBusy', count: 2 };
      expect(getStatusTooltip(status)).toBe('2 agents busy');
    });

    it('returns combined text for mixed status', () => {
      const status: AggregatedAgentStatus = { type: 'mixed', idle: 1, busy: 2 };
      expect(getStatusTooltip(status)).toBe('1 idle, 2 busy');
    });
  });

  // === getTotalAgents Tests ===

  describe('getTotalAgents', () => {
    it('returns 0 for noAgents', () => {
      const status: AggregatedAgentStatus = { type: 'noAgents' };
      expect(getTotalAgents(status)).toBe(0);
    });

    it('returns count for allIdle', () => {
      const status: AggregatedAgentStatus = { type: 'allIdle', count: 5 };
      expect(getTotalAgents(status)).toBe(5);
    });

    it('returns count for allBusy', () => {
      const status: AggregatedAgentStatus = { type: 'allBusy', count: 3 };
      expect(getTotalAgents(status)).toBe(3);
    });

    it('returns sum for mixed', () => {
      const status: AggregatedAgentStatus = { type: 'mixed', idle: 2, busy: 4 };
      expect(getTotalAgents(status)).toBe(6);
    });
  });

  // === createNoAgentsStatus Tests ===

  describe('createNoAgentsStatus', () => {
    it('creates noAgents status', () => {
      const status = createNoAgentsStatus();
      expect(status).toEqual({ type: 'noAgents' });
    });
  });
});
