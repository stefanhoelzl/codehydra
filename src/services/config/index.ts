/**
 * Configuration service module.
 */

export { ConfigService, createConfigService, type ConfigServiceDeps } from "./config-service";
export {
  type AppConfig,
  type ConfigAgentType,
  type VersionConfig,
  DEFAULT_APP_CONFIG,
} from "./types";
