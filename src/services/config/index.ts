/**
 * Configuration module.
 */

export {
  type ConfigKeyDefinition,
  type ComputedDefaultContext,
  parseBool,
} from "./config-definition";

export {
  type ConfigAgentType,
  type AutoUpdatePreference,
  envVarToConfigKey,
  generateHelpText,
} from "./config-values";

// Legacy exports — kept for backwards compatibility with tests
export { ConfigService, createConfigService, type ConfigServiceDeps } from "./config-service";
export { type AppConfig, type VersionConfig, DEFAULT_APP_CONFIG } from "./types";
