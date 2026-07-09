/**
 * `vi.mock("electron")` resolves here (a root `__mocks__` sibling of
 * node_modules). The fake itself lives under `src/` so it stays inside the
 * `rootDir` of `src/tsconfig.node.json`; re-exporting keeps it a single module
 * instance, which is the whole point of a shared fake.
 */
export * from "../src/test/mocks/electron";
