/**
 * Configuration module.
 */

export {
  type ConfigValues,
  type ConfigAgentType,
  DEFAULT_CONFIG_VALUES,
  FILE_LAYER_KEYS,
  ENV_LAYER_KEYS,
} from "./config-values";

// Legacy exports — kept for backwards compatibility with tests
export { ConfigService, createConfigService, type ConfigServiceDeps } from "./config-service";
export { type AppConfig, type VersionConfig, DEFAULT_APP_CONFIG } from "./types";
