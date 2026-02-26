/**
 * Configuration module.
 */

export {
  CONFIG,
  type ConfigValues,
  type ConfigKey,
  type ConfigAgentType,
  CONFIG_KEYS,
  FILE_KEYS,
  DEFAULT_CONFIG_VALUES,
  configKeyToEnvVar,
  envVarToConfigKey,
  parseConfigValue,
} from "./config-values";

// Legacy exports — kept for backwards compatibility with tests
export { ConfigService, createConfigService, type ConfigServiceDeps } from "./config-service";
export { type AppConfig, type VersionConfig, DEFAULT_APP_CONFIG } from "./types";
