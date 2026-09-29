// THROWAWAY: repro for the flaky "New workspace" click in cli.e2e.ts (ch lock beforeAll).
import { expect, test } from "@playwright/test";
import { createTestGitRepo } from "../src/utils/testing/test-utils";
import { createWorkspace, expandSidebar, openProject, useApp } from "./fixtures";

let repo: { path: string; cleanup: () => Promise<void> };
test.beforeAll(async () => {
  repo = await createTestGitRepo();
});
test.afterAll(async () => {
  await repo?.cleanup();
});

const app = useApp();

test("click New workspace right after each creation", async () => {
  test.setTimeout(900_000);
  await openProject(app(), repo.path);
  await createWorkspace(app(), "rp-0");
  const ui = app().uiPage();
  let misses = 0;
  const n = Number(process.env.REPRO_N ?? 8);
  for (let i = 1; i <= n; i++) {
    const panel = ui.getByRole("region", { name: "New workspace" });
    const record = `(() => { window.__ev = []; for (const t of ["pointermove","pointerdown","pointerup","click","mouseover"]) window.addEventListener(t, (e) => window.__ev.push(t + "@" + Math.round(e.clientX) + "," + Math.round(e.clientY) + ":" + (e.target && e.target.tagName)), true); return true; })()`;
    await ui.evaluate(record);
    const ws = await app().findTarget("workspace").catch(() => null);
    await ws?.frame.evaluate(record).catch(() => null);
    await expandSidebar(ui);
    const btn = ui.getByRole("button", { name: "New workspace" });
    const box = await btn.boundingBox();
    const top = await ui.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return el ? el.tagName + "." + el.className : "none"; }, [box!.x + box!.width / 2, box!.y + box!.height / 2]);
    await btn.click();
    await new Promise((r) => setTimeout(r, 300));
    const uiEv = await ui.evaluate("window.__ev").catch((e) => String(e));
    const wsEv = await ws?.frame.evaluate("window.__ev").catch((e) => String(e));
    console.log(`iteration ${i}: box=${JSON.stringify(box)} top=${top} uiEvents=${JSON.stringify(uiEv)} wsEvents=${JSON.stringify(wsEv)} wsUrl=${ws?.frame.url().slice(0, 60)}`);
    const opened = await panel
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    console.log(`iteration ${i}: panel ${opened ? "opened" : "MISSED"}`);
    if (!opened) {
      misses++;
      // Recover: click again so the loop can continue.
      await expandSidebar(ui);
      await ui.getByRole("button", { name: "New workspace" }).click();
      await expect(panel).toBeVisible();
    }
    await createWorkspace(app(), `rp-${i}`);
  }
  console.log(`misses: ${misses}/${n}`);
  expect(misses).toBe(0);
});
