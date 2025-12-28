// Components
export { default as HtmlAnnotator } from './components/HtmlAnnotator.svelte';

// Utilities
export {
	snapSelection,
	type SnappedSelection,
	generateAnnotationId,
	wrapSelectionWithAnnotation,
	wrapTextNodesWithHighlight,
	removeAnnotation,
	type AnnotationRemovalResult
} from './utils/selection';

// Theme
export {
	type Theme,
	getStoredTheme,
	setTheme,
	getResolvedTheme,
	initializeTheme,
	toggleTheme
} from './styles/theme';
