/**
 * HTTP utilities with timeout support.
 */

/**
 * Options for fetch with timeout.
 */
export interface FetchWithTimeoutOptions {
  /** Timeout in milliseconds (default: 5000) */
  readonly timeout?: number;
  /** Optional external abort signal */
  readonly signal?: AbortSignal;
}

/**
 * Fetch with timeout support.
 * Automatically aborts the request if it takes longer than the specified timeout.
 *
 * @param url URL to fetch
 * @param options Timeout and abort signal options
 * @returns Fetch response
 * @throws DOMException with name "AbortError" on timeout or external abort
 */
export async function fetchWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions = {}
): Promise<Response> {
  const { timeout = 5000, signal: externalSignal } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  }, timeout);

  // If an external signal is provided, listen for its abort
  const onExternalAbort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort);
    }
  }

  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}
