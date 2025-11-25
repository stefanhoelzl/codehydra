// src/lib/services/workspaceInit.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkspaceInitService, INIT_TIMEOUT_MS } from './workspaceInit';
import type { AgentStatusCounts } from '$lib/types/agentStatus';

describe('WorkspaceInitService', () => {
  let service: WorkspaceInitService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = new WorkspaceInitService();
  });

  afterEach(() => {
    service.cleanupAllTimeouts();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  // ============================================================
  // State Transitions
  // ============================================================
  describe('State transitions', () => {
    it('startInitialization sets state to "initializing" when no agents present', () => {
      service.startInitialization('/path/to/workspace');

      expect(service.getState('/path/to/workspace')).toBe('initializing');
    });

    it('startInitialization sets state to "ready" immediately when agents already present', () => {
      const counts: AgentStatusCounts = { idle: 1, busy: 0 };
      service.startInitialization('/path/to/workspace', counts);

      expect(service.getState('/path/to/workspace')).toBe('ready');
    });

    it('startInitialization sets state to "ready" when busy agents present', () => {
      const counts: AgentStatusCounts = { idle: 0, busy: 1 };
      service.startInitialization('/path/to/workspace', counts);

      expect(service.getState('/path/to/workspace')).toBe('ready');
    });

    it('startInitialization does nothing if workspace already in state map (double-init guard)', () => {
      // First initialization
      service.startInitialization('/path/to/workspace');
      expect(service.getState('/path/to/workspace')).toBe('initializing');

      // Try to initialize again with agents present
      const counts: AgentStatusCounts = { idle: 1, busy: 0 };
      service.startInitialization('/path/to/workspace', counts);

      // Should still be 'initializing', not changed to 'ready'
      expect(service.getState('/path/to/workspace')).toBe('initializing');
    });

    it('markWorkspaceReady transitions from "initializing" to "ready"', () => {
      service.startInitialization('/path/to/workspace');
      expect(service.getState('/path/to/workspace')).toBe('initializing');

      service.markWorkspaceReady('/path/to/workspace');
      expect(service.getState('/path/to/workspace')).toBe('ready');
    });

    it('markWorkspaceReady does nothing if state is not "initializing"', () => {
      // Set to loading
      service.setLoading('/path/to/workspace');
      expect(service.getState('/path/to/workspace')).toBe('loading');

      // Try to mark ready
      service.markWorkspaceReady('/path/to/workspace');

      // Should still be 'loading'
      expect(service.getState('/path/to/workspace')).toBe('loading');
    });

    it('markWorkspaceReady does nothing for non-existent workspace', () => {
      service.markWorkspaceReady('/non/existent');
      expect(service.getState('/non/existent')).toBeUndefined();
    });

    it('setLoading sets state to "loading"', () => {
      service.setLoading('/path/to/workspace');
      expect(service.getState('/path/to/workspace')).toBe('loading');
    });

    it('setLoading clears previous error', () => {
      service.setError('/path/to/workspace', 'Some error');
      expect(service.getError('/path/to/workspace')).toBe('Some error');

      service.setLoading('/path/to/workspace');
      expect(service.getError('/path/to/workspace')).toBeUndefined();
    });

    it('setError sets state to "error" with message', () => {
      service.setError('/path/to/workspace', 'Connection failed');

      expect(service.getState('/path/to/workspace')).toBe('error');
      expect(service.getError('/path/to/workspace')).toBe('Connection failed');
    });
  });

  // ============================================================
  // Timeout Behavior
  // ============================================================
  describe('Timeout behavior', () => {
    it('startInitialization starts a timeout when entering "initializing"', () => {
      service.startInitialization('/path/to/workspace');

      expect(service.hasInitTimeout('/path/to/workspace')).toBe(true);
    });

    it('startInitialization does not start timeout when setting "ready" immediately', () => {
      const counts: AgentStatusCounts = { idle: 1, busy: 0 };
      service.startInitialization('/path/to/workspace', counts);

      expect(service.hasInitTimeout('/path/to/workspace')).toBe(false);
    });

    it('timeout fires after INIT_TIMEOUT_MS and transitions to "ready"', () => {
      service.startInitialization('/path/to/workspace');
      expect(service.getState('/path/to/workspace')).toBe('initializing');

      // Advance time by timeout duration
      vi.advanceTimersByTime(INIT_TIMEOUT_MS);

      expect(service.getState('/path/to/workspace')).toBe('ready');
    });

    it('timeout is cleared after it fires', () => {
      service.startInitialization('/path/to/workspace');
      expect(service.hasInitTimeout('/path/to/workspace')).toBe(true);

      vi.advanceTimersByTime(INIT_TIMEOUT_MS);

      expect(service.hasInitTimeout('/path/to/workspace')).toBe(false);
    });

    it('markWorkspaceReady clears pending timeout', () => {
      service.startInitialization('/path/to/workspace');
      expect(service.hasInitTimeout('/path/to/workspace')).toBe(true);

      service.markWorkspaceReady('/path/to/workspace');

      expect(service.hasInitTimeout('/path/to/workspace')).toBe(false);
    });

    it('clearInitTimeout clears timeout and removes from tracking map', () => {
      service.startInitialization('/path/to/workspace');
      expect(service.hasInitTimeout('/path/to/workspace')).toBe(true);

      service.clearInitTimeout('/path/to/workspace');

      expect(service.hasInitTimeout('/path/to/workspace')).toBe(false);
    });

    it('clearInitTimeout is safe to call on non-existent workspace', () => {
      expect(() => service.clearInitTimeout('/non/existent')).not.toThrow();
    });
  });

  // ============================================================
  // Agent Detection
  // ============================================================
  describe('Agent detection', () => {
    it('checkAgentsPresent returns true when idle > 0', () => {
      const counts: AgentStatusCounts = { idle: 1, busy: 0 };
      expect(service.checkAgentsPresent(counts)).toBe(true);
    });

    it('checkAgentsPresent returns true when busy > 0', () => {
      const counts: AgentStatusCounts = { idle: 0, busy: 2 };
      expect(service.checkAgentsPresent(counts)).toBe(true);
    });

    it('checkAgentsPresent returns true when both idle and busy > 0', () => {
      const counts: AgentStatusCounts = { idle: 1, busy: 1 };
      expect(service.checkAgentsPresent(counts)).toBe(true);
    });

    it('checkAgentsPresent returns false when both are 0', () => {
      const counts: AgentStatusCounts = { idle: 0, busy: 0 };
      expect(service.checkAgentsPresent(counts)).toBe(false);
    });

    it('checkAgentsPresent returns false when counts is undefined', () => {
      expect(service.checkAgentsPresent(undefined)).toBe(false);
    });

    it('checkAndUpdateFromAgentCounts marks initializing workspaces ready when agents detected', () => {
      service.startInitialization('/path/to/workspace1');
      service.startInitialization('/path/to/workspace2');

      const allCounts = new Map<string, AgentStatusCounts>([
        ['/path/to/workspace1', { idle: 1, busy: 0 }],
        ['/path/to/workspace2', { idle: 0, busy: 0 }],
      ]);

      service.checkAndUpdateFromAgentCounts(allCounts);

      expect(service.getState('/path/to/workspace1')).toBe('ready');
      expect(service.getState('/path/to/workspace2')).toBe('initializing');
    });
  });

  // ============================================================
  // Cleanup
  // ============================================================
  describe('Cleanup', () => {
    it('cleanupWorkspace clears timeout for workspace', () => {
      service.startInitialization('/path/to/workspace');
      expect(service.hasInitTimeout('/path/to/workspace')).toBe(true);

      service.cleanupWorkspace('/path/to/workspace');

      expect(service.hasInitTimeout('/path/to/workspace')).toBe(false);
    });

    it('cleanupWorkspace removes workspace from state map', () => {
      service.startInitialization('/path/to/workspace');
      expect(service.getState('/path/to/workspace')).toBe('initializing');

      service.cleanupWorkspace('/path/to/workspace');

      expect(service.getState('/path/to/workspace')).toBeUndefined();
    });

    it('cleanupWorkspace removes workspace from errors map', () => {
      service.setError('/path/to/workspace', 'Some error');
      expect(service.getError('/path/to/workspace')).toBe('Some error');

      service.cleanupWorkspace('/path/to/workspace');

      expect(service.getError('/path/to/workspace')).toBeUndefined();
    });

    it('cleanupAllTimeouts clears all pending timeouts', () => {
      service.startInitialization('/path/to/workspace1');
      service.startInitialization('/path/to/workspace2');
      service.startInitialization('/path/to/workspace3');

      expect(service.hasInitTimeout('/path/to/workspace1')).toBe(true);
      expect(service.hasInitTimeout('/path/to/workspace2')).toBe(true);
      expect(service.hasInitTimeout('/path/to/workspace3')).toBe(true);

      service.cleanupAllTimeouts();

      expect(service.hasInitTimeout('/path/to/workspace1')).toBe(false);
      expect(service.hasInitTimeout('/path/to/workspace2')).toBe(false);
      expect(service.hasInitTimeout('/path/to/workspace3')).toBe(false);
    });

    it('cleanupAllTimeouts does not affect workspace states', () => {
      service.startInitialization('/path/to/workspace');
      expect(service.getState('/path/to/workspace')).toBe('initializing');

      service.cleanupAllTimeouts();

      // State should still exist, just timeout cleared
      expect(service.getState('/path/to/workspace')).toBe('initializing');
    });
  });

  // ============================================================
  // Multiple Workspaces
  // ============================================================
  describe('Multiple workspaces', () => {
    it('each workspace has independent state', () => {
      service.startInitialization('/path/to/workspace1');
      service.setLoading('/path/to/workspace2');
      service.setError('/path/to/workspace3', 'Error');

      expect(service.getState('/path/to/workspace1')).toBe('initializing');
      expect(service.getState('/path/to/workspace2')).toBe('loading');
      expect(service.getState('/path/to/workspace3')).toBe('error');
    });

    it('each workspace has independent timeout', () => {
      service.startInitialization('/path/to/workspace1');
      service.startInitialization('/path/to/workspace2');

      // Mark first as ready (clears its timeout)
      service.markWorkspaceReady('/path/to/workspace1');

      expect(service.hasInitTimeout('/path/to/workspace1')).toBe(false);
      expect(service.hasInitTimeout('/path/to/workspace2')).toBe(true);

      // Second should still transition after timeout
      vi.advanceTimersByTime(INIT_TIMEOUT_MS);
      expect(service.getState('/path/to/workspace2')).toBe('ready');
    });
  });

  // ============================================================
  // SvelteMap Reactivity
  // ============================================================
  describe('SvelteMap reactivity', () => {
    it('workspaceState is a SvelteMap', () => {
      expect(service.workspaceState).toBeInstanceOf(Map);
      // SvelteMap extends Map
      expect(service.workspaceState.set).toBeDefined();
      expect(service.workspaceState.get).toBeDefined();
      expect(service.workspaceState.delete).toBeDefined();
    });

    it('workspaceErrors is a SvelteMap', () => {
      expect(service.workspaceErrors).toBeInstanceOf(Map);
    });
  });
});
