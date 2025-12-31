/**
 * Create a handler registry with add/forEach/clear operations
 * Returns an unsubscribe function from add()
 */
export function createHandlerRegistry<T>(): {
  add: (handler: T) => () => void;
  forEach: (fn: (h: T) => void) => void;
  clear: () => void;
} {
  const handlers: T[] = [];
  return {
    add: (handler) => {
      handlers.push(handler);
      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
    forEach: (fn) => handlers.forEach(fn),
    clear: () => {
      handlers.length = 0;
    },
  };
}
