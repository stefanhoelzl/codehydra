/**
 * Global constants injected by Vite at build time.
 */

/**
 * Application version string.
 *
 * Release builds: "YYYY.MM.DD" or "YYYY.MM.DD.N"
 * Dev builds: "{commit-date}-dev.{short-hash}[-dirty]"
 */
declare const __APP_VERSION__: string;

/**
 * PostHog API key for telemetry.
 * Injected from POSTHOG_API_KEY environment variable during build.
 * Undefined in development unless .env.local is configured.
 */
declare const __POSTHOG_API_KEY__: string | undefined;

/**
 * PostHog host URL for telemetry.
 * Injected from POSTHOG_HOST environment variable during build.
 * Defaults to EU region (https://eu.posthog.com).
 */
declare const __POSTHOG_HOST__: string | undefined;

/**
 * Provider for auto-update feed (e.g., "github").
 * Injected from CODEHYDRA_UPDATE_PROVIDER during build.
 */
declare const __UPDATE_PROVIDER__: string | undefined;

/**
 * Owner for auto-update feed (e.g., GitHub username or org).
 * Injected from CODEHYDRA_UPDATE_OWNER during build.
 */
declare const __UPDATE_OWNER__: string | undefined;

/**
 * Repository for auto-update feed.
 * Injected from CODEHYDRA_UPDATE_REPO during build.
 */
declare const __UPDATE_REPO__: string | undefined;
