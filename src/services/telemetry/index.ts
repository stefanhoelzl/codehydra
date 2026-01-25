/**
 * Telemetry service exports.
 */

export type {
  TelemetryService,
  TelemetryServiceDeps,
  PostHogClient,
  PostHogClientFactory,
} from "./types";

export { PostHogTelemetryService, createTelemetryService } from "./posthog-telemetry-service";
