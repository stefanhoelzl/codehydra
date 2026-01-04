import { defineConfig, mergeConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';
import baseConfig from '../vite.config.ext';

/**
 * Markdown Review Editor extension Vite config.
 *
 * This extension has two build outputs:
 * 1. Extension host code (Node.js, CommonJS) - built by the base config
 * 2. Webview code (browser, ESM, Svelte) - built by the writeBundle plugin
 *
 * The writeBundle plugin triggers a separate Vite build for the webview
 * after the extension bundle is complete.
 */
export default mergeConfig(
	baseConfig,
	defineConfig({
		plugins: [
			// Build webview after extension bundle is complete
			{
				name: 'build-webview',
				async writeBundle() {
					const { build } = await import('vite');
					await build({
						configFile: false,
						plugins: [
							svelte({
								onwarn(warning) {
									// Allow specific a11y warnings for intentional UI patterns:
									// - CommentEditor container uses click/mousedown for activation convenience
									// - Discussion thread uses mouseup for copy-on-select behavior
									if (warning.code?.startsWith('a11y_')) {
										return; // Suppress a11y warnings
									}
									// Treat all other Svelte warnings as errors
									throw new Error(`Svelte warning: ${warning.message}`);
								}
							})
						],
						build: {
							outDir: resolve(__dirname, 'dist/webview'),
							emptyOutDir: true,
							rollupOptions: {
								input: resolve(__dirname, 'src/webview/main.ts'),
								output: {
									entryFileNames: 'index.js',
									assetFileNames: 'index.[ext]'
								}
							},
							minify: false,
							sourcemap: false
						},
						resolve: {
							alias: {
								$lib: resolve(__dirname, 'src/lib')
							}
						}
					});
				}
			}
		],
		build: {
			lib: {
				entry: 'src/extension/extension.ts'
			},
			outDir: 'dist'
		}
	})
);
