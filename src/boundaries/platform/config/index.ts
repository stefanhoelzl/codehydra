/**
 * Configuration module.
 */

export {
  type ConfigKeyDefinition,
  type ComputedDefaultContext,
  parseBool,
  configBoolean,
  configEnum,
} from "./config-definition";

export {
  type ConfigAgentType,
  type AutoUpdatePreference,
  envVarToConfigKey,
  generateHelpText,
} from "./config-values";

export { type Config, type ConfigDeps, DefaultConfig } from "./config";
