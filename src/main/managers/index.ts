/**
 * Barrel export for manager modules.
 */

export { WindowManager } from "../../boundaries/shell/window/window-manager";
export {
  ViewManager,
  SIDEBAR_MINIMIZED_WIDTH,
  type ViewManagerConfig,
} from "../../boundaries/shell/view/view-manager";
export type { IViewManager, Unsubscribe } from "../../boundaries/shell/view/view-manager.interface";
