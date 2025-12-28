/**
 * Webview entry point for MarkdownReviewEditor.
 * Initializes the Svelte app and message handling.
 */

import App from './App.svelte';
import { mount } from 'svelte';
import { initializeMessageListener } from '../lib/services/opencode-client';
import { initializeTheme } from '../lib/styles/theme';
import '../lib/styles/theme.css';

// Initialize message listener for extension communication
initializeMessageListener();

// Initialize theme system
initializeTheme();

// Mount the Svelte app
const app = mount(App, {
	target: document.getElementById('app')!
});

export default app;
