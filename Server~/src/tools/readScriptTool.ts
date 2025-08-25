import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Logger } from "../utils/logger.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// ---- config & guards ----
const projectRoot = path.resolve(process.cwd());
const assetsRoot = path.join(projectRoot, "Assets");
const packagesRoot = path.join(projectRoot, "Packages");
const packageCacheRoot = path.join(projectRoot, "Library", "PackageCache");

function isUnder(child: string, parent: string) {
  const a = path.resolve(child), b = path.resolve(parent);
  return a === b || a.startsWith(b + path.sep);
}

function guardAndResolve(relPath: string) {
  const full = path.resolve(projectRoot, relPath.replace(/\\/g, "/"));
  if (!(isUnder(full, assetsRoot) || isUnder(full, packagesRoot))) {
    throw new Error("Only Assets/ and Packages/ are allowed.");
  }
  if (isUnder(full, packageCacheRoot)) {
    throw new Error("Library/PackageCache is read-only.");
  }
  if (!full.toLowerCase().endsWith(".cs")) {
    throw new Error("Only .cs files are allowed.");
  }
  return full;
}

// ---- tool metadata ----
const toolName = "read_script";
const toolDescription =
  "Read a .cs file from Assets/ or embedded Packages/ using a project-relative path (e.g., Assets/Scripts/Foo.cs).";

// schema MUST use .shape because server.tool expects a Zod shape object
const paramsSchema = z.object({
  path: z.string().describe("Project-relative path to a .cs file (Assets/... or Packages/...)"),
});

// ---- registration ----
export function registerReadScriptTool(server: McpServer, logger: Logger) {
  logger.info(`Registering tool: ${toolName}`);

  server.tool(
    toolName,
    toolDescription,
    paramsSchema.shape,
    async (params: z.infer<typeof paramsSchema>): Promise<CallToolResult> => {
      try {
        logger.info(`Executing tool: ${toolName}`, params);
        const full = guardAndResolve(params.path);
        const content = await fs.readFile(full, "utf8");
        return {
          content: [{ type: "text", text: content }],
        };
      } catch (err) {
        logger.error(`Tool execution failed: ${toolName}`, err);
        throw err;
      }
    }
  );
}
