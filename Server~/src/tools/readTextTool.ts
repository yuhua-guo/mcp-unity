import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Logger } from "../utils/logger.js";
import * as fsp from "node:fs/promises";
import { resolveAndGuard, isProbablyTextFile } from "../utils/projectPaths.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const toolName = "read_text";
const toolDescription = "Read a text file under Assets/, Packages/, ProjectSettings/, or Library/PackageCache/.";

const paramsSchema = z.object({
  path: z.string().describe("Project-relative path beginning with Assets/, Packages/, ProjectSettings/, or Library/PackageCache/"),
  maxBytes: z.number().int().min(1).max(5_000_000).optional()
    .describe("Optional cap; default 1,000,000 to avoid huge token usage."),
});

export function registerReadTextTool(server: McpServer, logger: Logger) {
  logger.info(`Registering tool: ${toolName}`);

  server.tool(
    toolName,
    toolDescription,
    paramsSchema.shape,
    async (params: z.infer<typeof paramsSchema>): Promise<CallToolResult> => {
      const { full } = resolveAndGuard(params.path, "read");
      if (!(await isProbablyTextFile(full))) {
        throw new Error("File does not look like text (or unsupported extension).");
      }
      const cap = params.maxBytes ?? 1_000_000;
      const data = await fsp.readFile(full, "utf8");
      const text = data.length > cap ? data.slice(0, cap) : data;

      return { content: [{ type: "text", text }] };
    }
  );
}
