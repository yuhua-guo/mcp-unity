import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Logger } from "../utils/logger.js";
import * as fsp from "node:fs/promises";
import * as fssync from "node:fs";
import * as path from "node:path";
import { resolveAndGuard, normalizeLf, timestampUtc, projectRoot } from "../utils/projectPaths.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Try to load 'diff' if present (for unified diff)
let diffLib: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  diffLib = await import("diff");
} catch { /* optional */ }

// -------------------- Schema --------------------
const opReplaceRange = z.object({
  type: z.literal("replaceRange"),
  startLine: z.number().int().min(1).describe("1-based inclusive"),
  endLine: z.number().int().min(0).describe("0 means insert before line 1; otherwise inclusive"),
  text: z.string().describe("Replacement text (can be empty for delete)")
});

const opInsertAfterAnchor = z.object({
  type: z.literal("insertAfterAnchor"),
  anchor: z.string().describe("Regex (string) to find a line; first match used unless nth provided"),
  nth: z.number().int().min(1).optional().describe("1-based occurrence of anchor (default 1)"),
  text: z.string()
});

const opInsertBeforeAnchor = z.object({
  type: z.literal("insertBeforeAnchor"),
  anchor: z.string(),
  nth: z.number().int().min(1).optional(),
  text: z.string()
});

const structuredOpsSchema = z.array(z.union([opReplaceRange, opInsertAfterAnchor, opInsertBeforeAnchor]));

const paramsSchema = z.object({
  path: z.string().describe("Project-relative path under Assets/, Packages/, or ProjectSettings/"),
  // Provide exactly one of these:
  unifiedPatch: z.string().optional().describe("git-style unified diff that targets this single file"),
  ops: structuredOpsSchema.optional().describe("Structured patch operations when not using a unified diff"),
  // Options
  makeBackup: z.boolean().optional().describe("Default true; save .bak before writing"),
  normalizeEol: z.boolean().optional().describe("Default true; convert CRLF to LF for stable diffs"),
  dryRun: z.boolean().optional().describe("If true, validate and return the would-be result without writing")
});

// -------------------- Tool --------------------
const toolName = "write_patch";
const toolDescription =
  "Apply a patch to a text file (unified diff or structured ops). Safer and far more token-efficient than rewriting the whole file.";

export function registerWritePatchTool(server: McpServer, logger: Logger) {
  logger.info(`Registering tool: ${toolName}`);

  server.tool(
    toolName,
    toolDescription,
    paramsSchema.shape,
    async (params: z.infer<typeof paramsSchema>): Promise<CallToolResult> => {
      const { full } = resolveAndGuard(params.path, "write");

      // Read current file (if missing, fail — patches expect an existing file)
      if (!fssync.existsSync(full)) {
        throw new Error(`Target file does not exist: ${params.path}`);
      }
      const original = await fsp.readFile(full, "utf8");

      const normalize = params.normalizeEol !== false; // default true
      const src = normalize ? normalizeLf(original) : original;

      let patched: string;

      if (params.unifiedPatch) {
        if (!diffLib) {
          throw new Error("Unified diff support requires 'diff' package. Run: npm i diff");
        }
        const fileName = path.basename(full);
        // If patch references different filenames it still works, but we apply to the current content.
        // Build a fake single-file patch and apply it.
        const ok = diffLib.applyPatch; // function exists?
        if (!ok) throw new Error("diff.applyPatch not available.");
        // diff.applyPatch takes (source, patchString)
        const result = diffLib.applyPatch(src, params.unifiedPatch);
        if (result === false) {
          throw new Error("Failed to apply unified diff. Patch did not match target content.");
        }
        patched = String(result);
      } else if (params.ops && params.ops.length > 0) {
        patched = applyStructuredOps(src, params.ops);
      } else {
        throw new Error("Provide either 'unifiedPatch' or non-empty 'ops'.");
      }

      if (params.dryRun) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ path: params.path, dryRun: true, previewBytes: Math.min(patched.length, 2048) }, null, 2)
          }]
        };
      }

      // Backup then write
      if (params.makeBackup !== false) {
        await fsp.copyFile(full, `${full}.${timestampUtc()}.bak`);
      }
      await fsp.writeFile(full, patched, "utf8");

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ path: params.path, ok: true, bytes: patched.length }, null, 2)
        }]
      };
    }
  );
}

// -------------------- Structured ops engine --------------------
function applyStructuredOps(source: string, ops: z.infer<typeof structuredOpsSchema>): string {
  let lines = source.split(/\r?\n/);

  for (const op of ops) {
    switch (op.type) {
      case "replaceRange": {
        const start = op.startLine; // 1-based inclusive
        const end = op.endLine;     // inclusive (0 means insert before 1)
        const insertLines = splitPreserve(op.text);

        if (end === 0) {
          // insert before first line
          lines = [...insertLines, ...lines];
        } else {
          if (start < 1 || end < start - 1 || end > lines.length) {
            throw new Error(`replaceRange out of bounds: [${start}, ${end}] on file with ${lines.length} lines`);
          }
          // splice: replace lines[start-1..end-1] with insertLines
          lines.splice(start - 1, (end >= start ? (end - start + 1) : 0), ...insertLines);
        }
        break;
      }
      case "insertAfterAnchor": {
        const { anchor, nth = 1, text } = op;
        const idx = findAnchorLine(lines, anchor, nth);
        if (idx < 0) throw new Error(`insertAfterAnchor: anchor not found (nth=${nth})`);
        const insertLines = splitPreserve(text);
        lines.splice(idx + 1, 0, ...insertLines);
        break;
      }
      case "insertBeforeAnchor": {
        const { anchor, nth = 1, text } = op;
        const idx = findAnchorLine(lines, anchor, nth);
        if (idx < 0) throw new Error(`insertBeforeAnchor: anchor not found (nth=${nth})`);
        const insertLines = splitPreserve(text);
        lines.splice(idx, 0, ...insertLines);
        break;
      }
    }
  }

  return lines.join("\n");
}

// Keep trailing newline behavior stable: if text ends with \n, split preserves a final empty item
function splitPreserve(text: string): string[] {
  // Normalize incoming text newlines to LF; they will be joined with \n
  const t = normalizeLf(text);
  return t.endsWith("\n") ? t.slice(0, -1).split("\n").concat([""]) : t.split("\n");
}

function findAnchorLine(lines: string[], anchorRegexString: string, nth: number): number {
  const re = new RegExp(anchorRegexString);
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      count++;
      if (count === nth) return i;
    }
  }
  return -1;
}
