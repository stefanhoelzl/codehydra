/**
 * Shared subscription helpers for the shell boundaries.
 */

/** Anything that can report whether it has been torn down. */
interface Destroyable {
  isDestroyed(): boolean;
}

/**
 * Wrap an `off()` action so it becomes a no-op once `target` (an Electron
 * window or webContents) has been destroyed — calling `off()` on a destroyed
 * emitter throws. Every boundary event-subscription returns one of these.
 */
export function guardedUnsubscribe(target: Destroyable, off: () => void): () => void {
  return () => {
    if (!target.isDestroyed()) {
      off();
    }
  };
}
