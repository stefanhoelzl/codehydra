// src/lib/stores/agentStatus.test.ts

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  agentStatuses,
  agentCounts,
  getWorkspaceStatus,
  getWorkspaceCounts,
  updateWorkspaceStatus,
  updateWorkspaceCounts,
  removeWorkspaceStatus,
  clearAllStatuses,
  updateMultipleStatuses,
  createWorkspaceStatusDerived,
  createWorkspaceCountsDerived,
  initAgentStatusListener,
  resetNotificationService,
} from './agentStatus';
import type { AggregatedAgentStatus } from '$lib/types/agentStatus';
import { listen } from '@tauri-apps/api/event';

// Mock Tauri API
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.resolve({})),
}));

describe('agentStatus store', () => {
  beforeEach(() => {
    // Reset store before each test
    clearAllStatuses();
    resetNotificationService();
  });

  // === Initial State Tests ===

  describe('initial state', () => {
    it('starts with empty map', () => {
      const statuses = get(agentStatuses);
      expect(statuses.size).toBe(0);
    });
  });

  // === getWorkspaceStatus Tests ===

  describe('getWorkspaceStatus', () => {
    it('returns noAgents for unknown workspace', () => {
      const status = getWorkspaceStatus('/unknown/path');
      expect(status).toEqual({ type: 'noAgents' });
    });

    it('returns correct status for known workspace', () => {
      const expectedStatus: AggregatedAgentStatus = { type: 'allIdle', count: 2 };
      updateWorkspaceStatus('/test/path', expectedStatus);

      const status = getWorkspaceStatus('/test/path');
      expect(status).toEqual(expectedStatus);
    });
  });

  // === updateWorkspaceStatus Tests ===

  describe('updateWorkspaceStatus', () => {
    it('adds new workspace status', () => {
      const status: AggregatedAgentStatus = { type: 'allBusy', count: 3 };
      updateWorkspaceStatus('/workspace1', status);

      const statuses = get(agentStatuses);
      expect(statuses.size).toBe(1);
      expect(statuses.get('/workspace1')).toEqual(status);
    });

    it('updates existing workspace status', () => {
      const status1: AggregatedAgentStatus = { type: 'allIdle', count: 1 };
      const status2: AggregatedAgentStatus = { type: 'allBusy', count: 2 };

      updateWorkspaceStatus('/workspace1', status1);
      updateWorkspaceStatus('/workspace1', status2);

      const status = getWorkspaceStatus('/workspace1');
      expect(status).toEqual(status2);
    });

    it('handles multiple workspaces', () => {
      const status1: AggregatedAgentStatus = { type: 'allIdle', count: 1 };
      const status2: AggregatedAgentStatus = { type: 'allBusy', count: 2 };

      updateWorkspaceStatus('/workspace1', status1);
      updateWorkspaceStatus('/workspace2', status2);

      const statuses = get(agentStatuses);
      expect(statuses.size).toBe(2);
    });
  });

  // === removeWorkspaceStatus Tests ===

  describe('removeWorkspaceStatus', () => {
    it('removes existing workspace status', () => {
      const status: AggregatedAgentStatus = { type: 'allIdle', count: 1 };
      updateWorkspaceStatus('/workspace1', status);
      expect(get(agentStatuses).size).toBe(1);

      removeWorkspaceStatus('/workspace1');
      expect(get(agentStatuses).size).toBe(0);
    });

    it('handles removing non-existent workspace', () => {
      removeWorkspaceStatus('/nonexistent');
      expect(get(agentStatuses).size).toBe(0);
    });

    it('only removes specified workspace', () => {
      updateWorkspaceStatus('/workspace1', { type: 'allIdle', count: 1 });
      updateWorkspaceStatus('/workspace2', { type: 'allBusy', count: 2 });

      removeWorkspaceStatus('/workspace1');

      const statuses = get(agentStatuses);
      expect(statuses.size).toBe(1);
      expect(statuses.has('/workspace2')).toBe(true);
    });
  });

  // === clearAllStatuses Tests ===

  describe('clearAllStatuses', () => {
    it('clears all statuses', () => {
      updateWorkspaceStatus('/workspace1', { type: 'allIdle', count: 1 });
      updateWorkspaceStatus('/workspace2', { type: 'allBusy', count: 2 });
      expect(get(agentStatuses).size).toBe(2);

      clearAllStatuses();
      expect(get(agentStatuses).size).toBe(0);
    });

    it('handles clearing empty store', () => {
      clearAllStatuses();
      expect(get(agentStatuses).size).toBe(0);
    });
  });

  // === updateMultipleStatuses Tests ===

  describe('updateMultipleStatuses', () => {
    it('updates multiple statuses at once', () => {
      const updates = new Map<string, AggregatedAgentStatus>([
        ['/workspace1', { type: 'allIdle', count: 1 }],
        ['/workspace2', { type: 'allBusy', count: 2 }],
        ['/workspace3', { type: 'mixed', idle: 1, busy: 1 }],
      ]);

      updateMultipleStatuses(updates);

      const statuses = get(agentStatuses);
      expect(statuses.size).toBe(3);
    });

    it('merges with existing statuses', () => {
      updateWorkspaceStatus('/existing', { type: 'noAgents' });

      const updates = new Map<string, AggregatedAgentStatus>([
        ['/new', { type: 'allIdle', count: 1 }],
      ]);

      updateMultipleStatuses(updates);

      const statuses = get(agentStatuses);
      expect(statuses.size).toBe(2);
      expect(statuses.has('/existing')).toBe(true);
      expect(statuses.has('/new')).toBe(true);
    });

    it('overwrites existing statuses', () => {
      updateWorkspaceStatus('/workspace1', { type: 'noAgents' });

      const updates = new Map<string, AggregatedAgentStatus>([
        ['/workspace1', { type: 'allBusy', count: 3 }],
      ]);

      updateMultipleStatuses(updates);

      const status = getWorkspaceStatus('/workspace1');
      expect(status).toEqual({ type: 'allBusy', count: 3 });
    });
  });

  // === createWorkspaceStatusDerived Tests ===

  describe('createWorkspaceStatusDerived', () => {
    it('returns noAgents for unknown workspace', () => {
      const derived = createWorkspaceStatusDerived('/unknown');
      expect(get(derived)).toEqual({ type: 'noAgents' });
    });

    it('returns current status for known workspace', () => {
      updateWorkspaceStatus('/workspace1', { type: 'allIdle', count: 2 });
      const derived = createWorkspaceStatusDerived('/workspace1');
      expect(get(derived)).toEqual({ type: 'allIdle', count: 2 });
    });

    it('updates reactively when status changes', () => {
      const derived = createWorkspaceStatusDerived('/workspace1');
      expect(get(derived)).toEqual({ type: 'noAgents' });

      updateWorkspaceStatus('/workspace1', { type: 'allBusy', count: 3 });
      expect(get(derived)).toEqual({ type: 'allBusy', count: 3 });
    });

    it('returns noAgents when workspace is removed', () => {
      const path = '/workspace1';
      updateWorkspaceStatus(path, { type: 'allIdle', count: 2 });

      const derived = createWorkspaceStatusDerived(path);
      expect(get(derived)).toEqual({ type: 'allIdle', count: 2 });

      removeWorkspaceStatus(path);
      expect(get(derived)).toEqual({ type: 'noAgents' });
    });
  });

  // === initAgentStatusListener Tests ===

  describe('initAgentStatusListener', () => {
    it('registers event listener', async () => {
      await initAgentStatusListener();
      expect(listen).toHaveBeenCalledWith('agent-status-changed', expect.any(Function));
    });

    it('returns unlisten function', async () => {
      const mockUnlisten = vi.fn();
      vi.mocked(listen).mockResolvedValueOnce(mockUnlisten);

      const unlisten = await initAgentStatusListener();
      expect(unlisten).toBe(mockUnlisten);
    });

    it('updates store when receiving event', async () => {
      let eventCallback: ((event: { payload: unknown }) => void) | null = null;
      vi.mocked(listen).mockImplementationOnce(async (_event, callback) => {
        eventCallback = callback as (event: { payload: unknown }) => void;
        return () => {};
      });

      await initAgentStatusListener();

      // Simulate event
      eventCallback!({
        payload: {
          workspacePath: '/test',
          status: { type: 'allIdle', count: 2 },
          counts: { idle: 2, busy: 0 },
        },
      });

      const statuses = get(agentStatuses);
      expect(statuses.get('/test')).toEqual({ type: 'allIdle', count: 2 });
    });

    it('updates counts store when receiving event', async () => {
      let eventCallback: ((event: { payload: unknown }) => void) | null = null;
      vi.mocked(listen).mockImplementationOnce(async (_event, callback) => {
        eventCallback = callback as (event: { payload: unknown }) => void;
        return () => {};
      });

      await initAgentStatusListener();

      // Simulate event
      eventCallback!({
        payload: {
          workspacePath: '/test',
          status: { type: 'mixed', idle: 1, busy: 2 },
          counts: { idle: 1, busy: 2 },
        },
      });

      const counts = get(agentCounts);
      expect(counts.get('/test')).toEqual({ idle: 1, busy: 2 });
    });
  });

  // === agentCounts Store Tests ===

  describe('agentCounts store', () => {
    it('starts with empty map', () => {
      const counts = get(agentCounts);
      expect(counts.size).toBe(0);
    });

    it('stores raw counts', () => {
      updateWorkspaceCounts('/test', { idle: 2, busy: 1 });
      const counts = get(agentCounts).get('/test');
      expect(counts).toEqual({ idle: 2, busy: 1 });
    });

    it('creates new Map reference on update (Svelte reactivity)', () => {
      const before = get(agentCounts);
      updateWorkspaceCounts('/test', { idle: 1, busy: 0 });
      const after = get(agentCounts);
      expect(before).not.toBe(after);
    });
  });

  // === getWorkspaceCounts Tests ===

  describe('getWorkspaceCounts', () => {
    it('returns empty counts for unknown workspace', () => {
      const counts = getWorkspaceCounts('/unknown/path');
      expect(counts).toEqual({ idle: 0, busy: 0 });
    });

    it('returns correct counts for known workspace', () => {
      updateWorkspaceCounts('/test/path', { idle: 3, busy: 2 });
      const counts = getWorkspaceCounts('/test/path');
      expect(counts).toEqual({ idle: 3, busy: 2 });
    });
  });

  // === createWorkspaceCountsDerived Tests ===

  describe('createWorkspaceCountsDerived', () => {
    it('returns empty counts for unknown workspace', () => {
      const derived = createWorkspaceCountsDerived('/unknown');
      expect(get(derived)).toEqual({ idle: 0, busy: 0 });
    });

    it('returns current counts for known workspace', () => {
      updateWorkspaceCounts('/workspace1', { idle: 5, busy: 3 });
      const derived = createWorkspaceCountsDerived('/workspace1');
      expect(get(derived)).toEqual({ idle: 5, busy: 3 });
    });

    it('updates reactively when counts change', () => {
      const derived = createWorkspaceCountsDerived('/workspace1');
      expect(get(derived)).toEqual({ idle: 0, busy: 0 });

      updateWorkspaceCounts('/workspace1', { idle: 2, busy: 4 });
      expect(get(derived)).toEqual({ idle: 2, busy: 4 });
    });

    it('returns empty counts when workspace is removed', () => {
      const path = '/workspace1';
      updateWorkspaceStatus(path, { type: 'allIdle', count: 2 });
      updateWorkspaceCounts(path, { idle: 2, busy: 0 });

      const derived = createWorkspaceCountsDerived(path);
      expect(get(derived)).toEqual({ idle: 2, busy: 0 });

      removeWorkspaceStatus(path);
      expect(get(derived)).toEqual({ idle: 0, busy: 0 });
    });
  });

  // === clearAllStatuses clears counts too ===

  describe('clearAllStatuses clears counts', () => {
    it('clears both statuses and counts', () => {
      updateWorkspaceStatus('/ws1', { type: 'allIdle', count: 1 });
      updateWorkspaceCounts('/ws1', { idle: 1, busy: 0 });
      expect(get(agentStatuses).size).toBe(1);
      expect(get(agentCounts).size).toBe(1);

      clearAllStatuses();
      expect(get(agentStatuses).size).toBe(0);
      expect(get(agentCounts).size).toBe(0);
    });
  });
});
