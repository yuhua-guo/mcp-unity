import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Logger } from "../utils/logger.js";
import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as path from "node:path";
import { findProjectRoot } from "../utils/projectRoot.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const projectRoot = findProjectRoot();
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

const lf = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
const stamp = () => {
  const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
};

const toolName = "write_script";
const toolDescription =
  "Write UTF-8 content to a .cs file under Assets/ or embedded Packages/. Creates a timestamped .bak if the file exists.";

const paramsSchema = z.object({
  path: z.string().describe("Project-relative path to write (Assets/... or Packages/...)"),
  content: z.string().describe("UTF-8 file content to write"),
});

export function registerWriteScriptTool(server: McpServer, logger: Logger) {
  logger.info(`Registering tool: ${toolName}`);

  server.tool(
    toolName,
    toolDescription,
    paramsSchema.shape,
    async (params: z.infer<typeof paramsSchema>): Promise<CallToolResult> => {
      try {
        logger.info(`Executing tool: ${toolName}`, params);
        const full = guardAndResolve(params.path);

        await fs.mkdir(path.dirname(full), { recursive: true });

        if (fssync.existsSync(full)) {
          await fs.copyFile(full, `${full}.${stamp()}.bak`);
        }

        await fs.writeFile(full, lf(params.content), "utf8");

        // Optional: add a follow-up call to a Unity "refresh" tool if you want immediate recompile.
        // Otherwise Unity usually detects changes automatically.

        return {
          content: [{ type: "text", text: JSON.stringify({ path: params.path, ok: true }, null, 2) }],
        };
      } catch (err) {
        logger.error(`Tool execution failed: ${toolName}`, err);
        throw err;
      }
    }
  );
}
