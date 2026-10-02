/**
 * Prepend a directory to a child process environment's PATH.
 *
 * Windows resolves PATH case-insensitively, but a Node env object copied from
 * `process.env` can hold it under any spelling (`Path` is the usual one), and a
 * second spelling next to it lets the un-prefixed copy win. So the existing key
 * is reused whatever its case, and any other spelling is dropped. The delimiter
 * comes from the target platform, not the host, so callers stay testable.
 */
export function prependPath(
  env: NodeJS.ProcessEnv,
  dir: string,
  platform: NodeJS.Platform
): NodeJS.ProcessEnv {
  const keys = Object.keys(env).filter((key) => key.toUpperCase() === "PATH");
  const pathKey = keys[0] ?? "PATH";
  const current = env[pathKey];
  const delimiter = platform === "win32" ? ";" : ":";
  const result: NodeJS.ProcessEnv = { ...env };
  for (const key of keys) delete result[key];
  result[pathKey] = current ? `${dir}${delimiter}${current}` : dir;
  return result;
}
