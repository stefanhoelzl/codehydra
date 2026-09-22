/**
 * HelpModule integration tests: the guide is read from the runtime bin dir,
 * opened as a markdown dialog with a Close button, and opened only once.
 */

import { describe, it, expect } from "vitest";
import { createHelpModule } from "./help-module";
import { createMockDialogManager } from "./presentation/dialog-manager.state-mock";
import { createFileSystemMock, file } from "../boundaries/platform/filesystem.state-mock";
import { createMockPathProvider } from "../boundaries/platform/path-provider.test-utils";
import { createMockLogger } from "../boundaries/platform/logging.test-utils";

const GUIDE = "# User Guide\n\n## Repository hooks\n";

function setup(options: { guide?: boolean } = {}) {
  const pathProvider = createMockPathProvider();
  const guidePath = pathProvider.runtimePath("bin/USER_GUIDE.md").toString();
  const fileSystem = createFileSystemMock({
    entries: options.guide === false ? {} : { [guidePath]: file(GUIDE) },
  });
  const dialogs = createMockDialogManager();
  const help = createHelpModule({
    ui: dialogs.ui,
    fileSystem,
    pathProvider,
    logger: createMockLogger(),
  });
  return { help, dialogs };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("HelpModule", () => {
  it("reads the shipped guide", async () => {
    const { help } = setup();
    expect(await help.readUserGuide()).toBe(GUIDE);
  });

  it("opens the guide as a markdown dialog with a Close button", async () => {
    const { help, dialogs } = setup();

    help.openHelp();
    await flush();

    expect(dialogs.handles).toHaveLength(1);
    const [markdown, footer] = dialogs.lastHandle!.config.sections;
    expect(markdown).toEqual({ type: "markdown", content: GUIDE });
    expect(footer).toMatchObject({
      type: "group",
      items: [{ type: "button", id: "close", role: "cancel" }],
    });

    dialogs.lastHandle!.emitAction("close");
    expect(dialogs.lastHandle!.closed).toBe(true);
  });

  it("does not stack a second dialog while one is open", async () => {
    const { help, dialogs } = setup();

    help.openHelp();
    help.openHelp();
    await flush();
    help.openHelp();
    await flush();

    expect(dialogs.handles).toHaveLength(1);
  });

  it("opens nothing when the guide cannot be read", async () => {
    const { help, dialogs } = setup({ guide: false });

    help.openHelp();
    await flush();

    expect(dialogs.handles).toHaveLength(0);
  });
});
