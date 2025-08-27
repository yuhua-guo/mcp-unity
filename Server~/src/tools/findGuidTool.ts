import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Logger } from "../utils/logger.js";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { projectRoot, roots } from "../utils/projectPaths.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const toolName = "find_guid";
const toolDescription = "Resolve an asset GUID to its path and find references (YAML 'guid: ...').";

const paramsSchema = z.object({
  guid: z.string().regex(/^[0-9a-f]{32}$/i, "GUID must be 32 hex chars").describe("Asset GUID (from .meta)"),
  limit: z.number().int().min(1).max(1000).optional().describe("Max reference hits (default 200)"),
});

export function registerFindGuidTool(server: McpServer, logger: Logger) {
  logger.info(`Registering tool: ${toolName}`);

  server.tool(
    toolName,
    toolDescription,
    paramsSchema.shape,
    async (params: z.infer<typeof paramsSchema>): Promise<CallToolResult> => {
      const guidLower = params.guid.toLowerCase();
      const limit = params.limit ?? 200;

      // 1) Find asset path by scanning .meta files (Assets + Packages + PackageCache)
      let assetPath = "";
      const rootsToScan = [roots.assets, roots.packages, roots.packageCache];
      for (const root of rootsToScan) {
        if (!fs.existsSync(root)) continue;
        const found = await findMetaByGuid(root, guidLower, 2_000_000 /* safety cap meta scans */);
        if (found) { assetPath = found; break; }
      }

      // 2) Find references (YAML: "guid: XXXXX")
      const refs: { path: string; line: number; snippet: string }[] = [];
      const yamlExts = new Set([".prefab",".unity",".asset",".mat",".controller",".timeline",".playable",".overrideController"]);
      const scanRoots = [roots.assets, roots.packages, roots.projectSettings];
      for (const root of scanRoots) {
        if (!fs.existsSync(root)) continue;
        await scanYamlForGuid(root, guidLower, refs, limit);
        if (refs.length >= limit) break;
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ guid: params.guid, assetPath, refCount: refs.length, refs }, null, 2)
        }]
      };
    }
  );
}

async function findMetaByGuid(root: string, guidLower: string, maxMetas: number): Promise<string> {
  let metas = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (e.isFile() && p.toLowerCase().endsWith(".meta")) {
        metas++; if (metas > maxMetas) return "";
        const txt = await fsp.readFile(p, "utf8");
        const m = txt.match(/guid:\s*([0-9a-f]{32})/i);
        if (m && m[1].toLowerCase() === guidLower) {
          // asset path is file without .meta
          const asset = p.slice(0, -5);
          return path.relative(projectRoot, asset).replace(/\\/g, "/");
        }
      }
    }
  }
  return "";
}

async function scanYamlForGuid(root: string, guidLower: string, out: {path:string;line:number;snippet:string}[], limit:number) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (out.length >= limit) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      const ext = path.extname(e.name).toLowerCase();
      // scenes, prefabs, materials, ScriptableObjects, etc.
      if (![".unity",".prefab",".asset",".mat",".controller",".overridecontroller",".playable",".timeline"].includes(ext)) continue;
      const txt = await fsp.readFile(p, "utf8");
      let idx = txt.toLowerCase().indexOf(guidLower);
      if (idx >= 0) {
        const line = txt.slice(0, idx).split(/\r?\n/).length;
        const snippet = txt.slice(Math.max(0, idx-60), Math.min(txt.length, idx+60));
        out.push({ path: path.relative(projectRoot, p).replace(/\\/g, "/"), line, snippet });
      }
    }
  }
}
