import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// --- Project root detection (env → cwd → ascend) ---
function looksLikeUnityProject(dir: string) {
  return fs.existsSync(path.join(dir, "Assets")) &&
         fs.existsSync(path.join(dir, "ProjectSettings"));
}

function ascendUntil(start: string, pred: (d: string) => boolean) {
  let dir = path.resolve(start);
  while (true) {
    if (pred(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return "";
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
  const up = ascendUntil(process.cwd(), looksLikeUnityProject);
  if (up) return up;

  // 4) Try walking up from the server's file location (build or src)
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fromHere = ascendUntil(here, looksLikeUnityProject);
  if (fromHere) return fromHere;

  // 5) As a last resort: walk up from the package cache location to find the project
  // (When running from Library/PackageCache/.../Server~/build/index.js)
  const guess = ascendUntil(path.join(here, "..", "..", "..", "..", ".."), looksLikeUnityProject);
  if (guess) return guess;

  throw new Error("Cannot locate Unity project root. Set UNITY_PROJECT_PATH env.");
}

// --- Roots & policy ---
export const projectRoot = findProjectRoot();
export const roots = {
  assets: path.join(projectRoot, "Assets"),
  packages: path.join(projectRoot, "Packages"),
  projectSettings: path.join(projectRoot, "ProjectSettings"),
  packageCache: path.join(projectRoot, "Library", "PackageCache"),
};

export type RootName = keyof typeof roots;

export const WRITE_ALLOWED: Record<RootName, boolean> = {
  assets: true,
  packages: true,          // but NOT in Library/PackageCache
  projectSettings: true,
  packageCache: false,     // read-only
};

// --- Resolve & guard ---
function isUnder(child: string, parent: string) {
  const a = path.resolve(child), b = path.resolve(parent);
  return a === b || a.startsWith(b + path.sep);
}

/** Accepts a project-relative path like "Assets/…", "Packages/…", "ProjectSettings/…", "Library/PackageCache/…" */
export function resolveAndGuard(relPath: string, mode: "read" | "write") {
  const clean = relPath.replace(/\\/g, "/");
  const full = path.resolve(projectRoot, clean);

  let hit: RootName | "" = "";
  (Object.keys(roots) as RootName[]).forEach(r => {
    if (isUnder(full, roots[r])) hit = hit || r;
  });
  if (!hit) throw new Error("Path must be under Assets/, Packages/, ProjectSettings/, or Library/PackageCache/.");

  if (mode === "write") {
    if (!WRITE_ALLOWED[hit]) throw new Error(`Writes are not allowed under ${hit}.`);
    // Extra: if it's "packages", ensure it's NOT actually within Library/PackageCache (some symlink tricks)
    if (isUnder(full, roots.packageCache)) throw new Error("Writes to Library/PackageCache are forbidden.");
  }

  return { full, root: hit as RootName };
}

// --- Text-file detection ---
const TEXT_EXTS = new Set([
  // common Unity & config
  ".cs",".shader",".cginc",".compute",".hlsl",".glsl",".meta",".asmdef",".asmref",
  ".json",".yaml",".yml",".xml",".txt",".md",".csv",".ini",".prop",".properties",".toml",
  ".uxml",".uss",
  // assets
  ".unity", ".asset", ".prefab",
  ".mat", ".vfx", ".lighting", ".giparams",
  ".controller", ".playable", ".inputactions",
  // code-ish
  ".js",".ts",".jsx",".tsx",".c",".h",".hpp",".cpp",".mm",".m",".gradle",".bat",".ps1",".sh"
]);

export async function isProbablyTextFile(full: string, maxProbe = 4096): Promise<boolean> {
  const ext = path.extname(full).toLowerCase();
  if (TEXT_EXTS.has(ext)) return true;

  try {
    const fh = await fsp.open(full, "r");
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(Math.min(maxProbe, (await fh.stat()).size || maxProbe)), 0, Math.min(maxProbe, (await fh.stat()).size || maxProbe), 0);
    await fh.close();
    // Heuristic: treat file as binary if it contains lots of NULs or very few printable chars
    let nonPrintable = 0, total = bytesRead;
    for (let i = 0; i < bytesRead; i++) {
      const c = buffer[i];
      if (c === 0) { nonPrintable++; continue; }
      if (c < 9 || (c > 13 && c < 32)) nonPrintable++;
    }
    return nonPrintable / Math.max(1,total) < 0.1;
  } catch {
    return false;
  }
}

// Normalize to LF for diff-friendly writes
export function normalizeLf(s: string) { return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n"); }
export function timestampUtc() {
  const d = new Date(), p = (n:number)=>String(n).padStart(2,"0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
