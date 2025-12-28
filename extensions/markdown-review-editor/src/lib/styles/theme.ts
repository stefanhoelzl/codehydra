/**
 * Theme utilities for VS Code webview.
 * Inherits theme from VS Code via message passing.
 */

export type Theme = 'light' | 'dark';

// Current theme state
let currentTheme: Theme = 'dark';

// Callbacks for theme changes
const themeChangeCallbacks: Array<(theme: Theme) => void> = [];

/**
 * Get the current theme.
 */
export function getTheme(): Theme {
	return currentTheme;
}

/**
 * Set the theme and update DOM.
 */
export function setTheme(theme: Theme): void {
	currentTheme = theme;
	document.documentElement.setAttribute('data-theme', theme);

	// Notify callbacks
	for (const callback of themeChangeCallbacks) {
		callback(theme);
	}
}

/**
 * Subscribe to theme changes.
 * Returns unsubscribe function.
 */
export function onThemeChange(callback: (theme: Theme) => void): () => void {
	themeChangeCallbacks.push(callback);
	return () => {
		const index = themeChangeCallbacks.indexOf(callback);
		if (index >= 0) {
			themeChangeCallbacks.splice(index, 1);
		}
	};
}

/**
 * Initialize theme system.
 * Listens for theme change events from VS Code.
 */
export function initializeTheme(): void {
	// Listen for theme changes from extension host
	window.addEventListener('vscode-theme-change', ((event: CustomEvent) => {
		const { kind } = event.detail;
		setTheme(kind as Theme);
	}) as EventListener);

	// Set initial theme based on body class or default to dark
	// VS Code adds vscode-light/vscode-dark classes to body
	if (document.body.classList.contains('vscode-light')) {
		setTheme('light');
	} else {
		setTheme('dark');
	}
}

// Legacy exports for compatibility (no-ops in VS Code context)
export function getStoredTheme(): Theme {
	return currentTheme;
}

export function getResolvedTheme(): Theme {
	return currentTheme;
}

export function toggleTheme(): Theme {
	// In VS Code context, we don't toggle - theme is controlled by VS Code
	// This is kept for compatibility but does nothing
	return currentTheme;
}
