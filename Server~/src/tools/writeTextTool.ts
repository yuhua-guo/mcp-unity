import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Logger } from "../utils/logger.js";
import * as fsp from "node:fs/promises";
import * as fssync from "node:fs";
import * as path from "node:path";
import { resolveAndGuard, isProbablyTextFile, normalizeLf, timestampUtc } from "../utils/projectPaths.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const toolName = "write_text";
const toolDescription = "Write a text file under Assets/, Packages/ (editable), or ProjectSettings/ (read-only for PackageCache).";

const paramsSchema = z.object({
  path: z.string().describe("Project-relative path under Assets/, Packages/, or ProjectSettings/"),
  content: z.string().describe("UTF-8 text content"),
  //makeBackup: z.boolean().optional().describe("Default: true; create .bak before overwriting"),
});

export function registerWriteTextTool(server: McpServer, logger: Logger) {
  logger.info(`Registering tool: ${toolName}`);

  server.tool(
    toolName,
    toolDescription,
    paramsSchema.shape,
    async (params: z.infer<typeof paramsSchema>): Promise<CallToolResult> => {
      const { full, root } = resolveAndGuard(params.path, "write");

      // ensure destination is a text file (basic check: existing file or extension/binary sniff for new)
      if (fssync.existsSync(full)) {
        if (!(await isProbablyTextFile(full))) throw new Error("Target file is not text.");
      } else {
        // for new files, we allow creation; no sniff—just write text
      }

      await fsp.mkdir(path.dirname(full), { recursive: true });

      //if (params.makeBackup !== false && fssync.existsSync(full)) {
      //  await fsp.copyFile(full, `${full}.${timestampUtc()}.bak`);
      //}

      await fsp.writeFile(full, normalizeLf(params.content), "utf8");

      return { content: [{ type: "text", text: JSON.stringify({ path: params.path, root, ok: true }, null, 2) }] };
    }
  );
}
