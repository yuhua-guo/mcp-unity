import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Logger } from "../utils/logger.js";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { roots, projectRoot, resolveAndGuard, isProbablyTextFile } from "../utils/projectPaths.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const toolName = "search_class";
const toolDescription = "Find C# class/interface/struct/enum definitions by name (regex-safe).";

const paramsSchema = z.object({
  className: z.string().describe("Name without namespace, e.g., 'PlayerController'"),
  rootPath: z.string().optional().describe("Where to search (default 'Assets/')"),
  limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
});

export function registerSearchClassTool(server: McpServer, logger: Logger) {
  logger.info(`Registering tool: ${toolName}`);

  server.tool(
    toolName,
    toolDescription,
    paramsSchema.shape,
    async (params: z.infer<typeof paramsSchema>): Promise<CallToolResult> => {
      const rootPath = params.rootPath ?? "Assets/";
      const { full } = resolveAndGuard(rootPath.endsWith("/") ? rootPath : rootPath + "/", "read");
      const limit = params.limit ?? 50;
      const name = params.className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b(class|struct|interface|enum)\\s+${name}\\b`);
      const results: { path: string; line: number; kind: string; snippet: string }[] = [];

      async function walk(dir: string) {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { await walk(p); if (results.length >= limit) return; }
          else if (e.isFile() && p.toLowerCase().endsWith(".cs")) {
            const rel = path.relative(projectRoot, p).replace(/\\/g, "/");
            const text = await fsp.readFile(p, "utf8");
            const m = text.match(re);
            if (m) {
              const pos = m.index ?? 0;
              const line = text.slice(0, pos).split(/\r?\n/).length;
              const snippet = text.split(/\r?\n/).slice(Math.max(0, line-2), line+2).join("\n");
              results.push({ path: rel, line, kind: m[1], snippet });
              if (results.length >= limit) return;
            }
          }
        }
      }
      await walk(full);
      return { content: [{ type: "text", text: JSON.stringify({ className: params.className, items: results }, null, 2) }] };
    }
  );
}
