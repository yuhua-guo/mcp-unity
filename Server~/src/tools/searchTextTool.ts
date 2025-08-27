import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Logger } from "../utils/logger.js";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { roots, projectRoot, resolveAndGuard, isProbablyTextFile } from "../utils/projectPaths.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const toolName = "search_text";
const toolDescription =
  "Search text within allowed roots (Assets/, Packages/, ProjectSettings/, Library/PackageCache). Returns compact, paginated matches.";

const paramsSchema = z.object({
  // Either an absolute root path (e.g., "Assets/") or a deeper folder
  rootPath: z.string().describe("Folder to search under, e.g., 'Assets/' or 'Packages/com.foo/'."),
  // Regex or plain string (case-insensitive by default)
  query: z.string().describe("Regex or plain text to search for."),
  regex: z.boolean().optional().describe("If true, 'query' is treated as a JavaScript regex (with 'i' flag)."),
  // File filtering
  includeExts: z.array(z.string()).optional().describe("Optional list like ['.cs','.shader','.yaml']. Defaults to text-like files."),
  excludeDirs: z.array(z.string()).optional().describe("Relative dir names to skip (e.g., ['Library','Temp'])."),
  // Pagination & verbosity
  offset: z.number().int().min(0).optional().describe("Result offset (default 0)"),
  limit: z.number().int().min(1).max(200).optional().describe("Max matches to return (default 50)"),
  context: z.number().int().min(0).max(200).optional().describe("Snippet context chars around match (default 60)"),
});

export function registerSearchTextTool(server: McpServer, logger: Logger) {
  logger.info(`Registering tool: ${toolName}`);

  server.tool(
    toolName,
    toolDescription,
    paramsSchema.shape,
    async (params: z.infer<typeof paramsSchema>): Promise<CallToolResult> => {
      const { rootPath, query, regex = false } = params;
      const offset = params.offset ?? 0;
      const limit  = params.limit  ?? 50;
      const ctx    = params.context ?? 60;
      const includeExts = params.includeExts?.map(e => e.toLowerCase());
      const excludeDirs = new Set((params.excludeDirs ?? []).map(s => s.toLowerCase()));

      // Resolve & guard root folder
      const { full } = resolveAndGuard(rootPath.endsWith("/") ? rootPath : rootPath + "/", "read");
      const stat = await fsp.stat(full);
      if (!stat.isDirectory()) throw new Error("rootPath must be a directory.");

      // Prepare matcher
      const re = regex ? new RegExp(query, "i") : null;
      const qLower = regex ? "" : query.toLowerCase();

      const matches: { path: string; line: number; snippet: string }[] = [];
      let scanned = 0;

      async function walk(dir: string) {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          const p = path.join(dir, e.name);
          const rel = path.relative(projectRoot, p).replace(/\\/g, "/");
          const nameLower = e.name.toLowerCase();

          if (e.isDirectory()) {
            if (excludeDirs.has(nameLower)) continue;
            await walk(p);
            if (matches.length >= offset + limit) return;
          } else if (e.isFile()) {
            // Filter by extension / text-likeness
            const ext = path.extname(nameLower);
            if (includeExts && includeExts.length > 0) {
              if (!includeExts.includes(ext)) continue;
            } else {
              // No exts provided → only search text-like files
              if (!(await isProbablyTextFile(p))) continue;
            }

            scanned++;
            const text = await fsp.readFile(p, "utf8");
            let pos = -1;
            while (true) {
              pos = re ? text.search(re) : text.toLowerCase().indexOf(qLower, pos + 1);
              if (pos < 0) break;

              // compute line number & snippet
              const before = text.lastIndexOf("\n", pos);
              const line = text.slice(0, pos).split(/\r?\n/).length;
              const start = Math.max(0, pos - ctx);
              const end   = Math.min(text.length, pos + (regex ? (RegExp.lastMatch?.length ?? qLower.length) : qLower.length) + ctx);
              const snippet = text.slice(start, end);

              matches.push({ path: rel, line, snippet });
              if (matches.length >= offset + limit) break;
              // Move past this match
              pos += Math.max(1, (regex ? (RegExp.lastMatch?.length ?? 1) : qLower.length));
            }
            if (matches.length >= offset + limit) return;
          }
        }
      }

      await walk(full);

      const total = matches.length;
      const window = matches.slice(offset, offset + limit);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            query, regex, scannedFiles: scanned,
            totalMatches: total,
            offset, limit,
            items: window
          }, null, 2)
        }]
      };
    }
  );
}
