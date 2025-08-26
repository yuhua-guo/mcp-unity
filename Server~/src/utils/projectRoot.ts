import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function looksLikeUnityProject(dir: string) {
  return fs.existsSync(path.join(dir, "Assets")) &&
         fs.existsSync(path.join(dir, "ProjectSettings"));
}

function ascendUntil(predicate: (d: string) => boolean, start: string) {
  let dir = path.resolve(start);
  while (true) {
    if (predicate(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return ""; // not found
    dir = parent;
  }
}

export function findProjectRoot(): string {
  // 1) Explicit env wins
  const env = process.env.UNITY_PROJECT_PATH;
  if (env && looksLikeUnityProject(env)) return path.resolve(env);

  // 2) Try the current working directory (Claude/launcher may set it)
  if (looksLikeUnityProject(process.cwd())) return path.resolve(process.cwd());

  // 3) Try walking up from cwd
  const fromCwd = ascendUntil(looksLikeUnityProject, process.cwd());
  if (fromCwd) return fromCwd;

  // 4) Try walking up from the server's file location (build or src)
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fromHere = ascendUntil(looksLikeUnityProject, here);
  if (fromHere) return fromHere;

  // 5) As a last resort: walk up from the package cache location to find the project
  // (When running from Library/PackageCache/.../Server~/build/index.js)
  const cacheGuess = ascendUntil(looksLikeUnityProject, path.join(here, "..", "..", "..", "..", ".."));
  if (cacheGuess) return cacheGuess;

  throw new Error(
    "Could not locate Unity project root. Set UNITY_PROJECT_PATH env or start the server from within the project."
  );
}
