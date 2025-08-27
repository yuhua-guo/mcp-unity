import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Logger } from "../utils/logger.js";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { roots, projectRoot, resolveAndGuard, isProbablyTextFile } from "../utils/projectPaths.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const toolName = "list_entries";
const toolDescription = "List files and folders under a path within Assets/, Packages/, ProjectSettings/, or Library/PackageCache/.";

const paramsSchema = z.object({
  path: z.string().describe("Project-relative path to a folder (Assets/... or Packages/... etc.). You may pass just the root like 'Assets/'."),
  maxDepth: z.number().int().min(0).max(10).optional().describe("0 = just this dir; 1 = include children; default 1"),
  maxItems: z.number().int().min(1).max(10000).optional().describe("Safety cap; default 500"),
  onlyTextFiles: z.boolean().optional().describe("If true, include only text-like files; default false"),
});

export function registerListEntriesTool(server: McpServer, logger: Logger) {
  logger.info(`Registering tool: ${toolName}`);

  server.tool(
    toolName,
    toolDescription,
    paramsSchema.shape,
    async (params: z.infer<typeof paramsSchema>): Promise<CallToolResult> => {
      const { full } = resolveAndGuard(params.path.endsWith("/") ? params.path : params.path + "/", "read");
      const maxDepth = params.maxDepth ?? 1;
      const maxItems = params.maxItems ?? 500;
      const onlyText = !!params.onlyTextFiles;

      const results: { path: string; type: "file" | "dir"; size?: number }[] = [];

      async function walk(dir: string, depth: number) {
        if (results.length >= maxItems) return;
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (results.length >= maxItems) break;
          const p = path.join(dir, e.name);
          const rel = path.relative(projectRoot, p).replace(/\\/g, "/");

          if (e.isDirectory()) {
            results.push({ path: rel + "/", type: "dir" });
            if (depth < maxDepth) await walk(p, depth + 1);
          } else if (e.isFile()) {
            if (onlyText && !(await isProbablyTextFile(p))) continue;
            const size = fs.statSync(p).size;
            results.push({ path: rel, type: "file", size });
          }
        }
      }

      // Ensure the input path is a directory
      const stat = await fsp.stat(full);
      if (!stat.isDirectory()) throw new Error("Path must be a directory to list entries.");

      await walk(full, 0);

      return { content: [{ type: "text", text: JSON.stringify({ count: results.length, items: results }, null, 2) }] };
    }
  );
}
