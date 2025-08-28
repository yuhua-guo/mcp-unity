import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Logger } from "../utils/logger.js";
import * as fsp from "node:fs/promises";
import * as fssync from "node:fs";
import * as path from "node:path";
import { resolveAndGuard, normalizeLf, timestampUtc, projectRoot } from "../utils/projectPaths.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Optional: 'diff' for strict unified patch first-attempt
let diffLib: any = null;
try { diffLib = await import("diff"); } catch {}

type WhitespaceMode = "strict" | "ignore-space-change" | "ignore-all-space";

const opReplaceRange = z.object({
  type: z.literal("replaceRange"),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(0),
  text: z.string()
});
const opInsertAfterAnchor = z.object({
  type: z.literal("insertAfterAnchor"),
  anchor: z.string(),
  nth: z.number().int().min(1).optional(),
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
  path: z.string(),
  unifiedPatch: z.string().optional(),
  ops: structuredOpsSchema.optional(),
  makeBackup: z.boolean().optional(),           // default true
  normalizeEol: z.boolean().optional(),         // default true
  ensureFinalNewline: z.boolean().optional(),   // default true
  dryRun: z.boolean().optional(),
  validateOnly: z.boolean().optional(),         // validation with diagnostics; no write
  preview: z.boolean().optional(),              // include changed line ranges + diffstat
  whitespaceMode: z.enum(["strict","ignore-space-change","ignore-all-space"]).optional(),
  fuzz: z.number().int().min(0).max(10).optional()
});

const toolName = "write_patch";
const toolDescription =
  "Apply patch to a text file (unified diff or structured ops). Now supports preview/validate, whitespace tolerance, and fuzz.";

export function registerWritePatchTool(server: McpServer, logger: Logger) {
  server.tool(
    toolName,
    toolDescription,
    paramsSchema.shape,
    async (params: z.infer<typeof paramsSchema>): Promise<CallToolResult> => {
      const { full } = resolveAndGuard(params.path, "write");
      if (!fssync.existsSync(full)) throw new Error(`Target does not exist: ${params.path}`);

      const normalize = params.normalizeEol !== false;         // default true
      const ensureFinal = params.ensureFinalNewline !== false; // default true
      const wsMode: WhitespaceMode = params.whitespaceMode ?? "strict";
      const fuzz = params.fuzz ?? 2;

      const original = await fsp.readFile(full, "utf8");
      let src = normalize ? normalizeLf(original) : original;
      if (ensureFinal && !src.endsWith("\n")) src += "\n";

      let patched = src;
      let diagnostics: any = { changedRanges: [] as Array<{start:number,end:number}>, diffstat: {added:0, removed:0} };

      if (params.unifiedPatch) {
        // 1) Try strict apply via 'diff'
        if (diffLib?.applyPatch) {
          const attempt = diffLib.applyPatch(src, params.unifiedPatch);
          if (attempt !== false) {
            patched = String(attempt);
          } else {
            // 2) Fallback to tolerant applier
            const res = tolerantApplyUnified(src, params.unifiedPatch, { wsMode, fuzz });
            if (!res.ok) {
              throw new Error(formatUnifiedError(res, params));
            }
            patched = res.text;
            diagnostics = res.diagnostics ?? diagnostics;
          }
        } else {
          const res = tolerantApplyUnified(src, params.unifiedPatch, { wsMode, fuzz });
          if (!res.ok) throw new Error(formatUnifiedError(res, params));
          patched = res.text;
          diagnostics = res.diagnostics ?? diagnostics;
        }
      } else if (params.ops && params.ops.length > 0) {
        const res = applyStructuredOpsWithDiag(src, params.ops);
        patched = res.text;
        diagnostics = res.diagnostics;
      } else {
        throw new Error("Provide either 'unifiedPatch' or non-empty 'ops'.");
      }

      if (params.validateOnly || params.dryRun) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              path: params.path,
              ok: true,
              mode: params.unifiedPatch ? "unified" : "ops",
              preview: !!params.preview,
              diagnostics: params.preview ? diagnostics : { note: "pass preview:true to include changed ranges/diffstat" }
            }, null, 2)
          }]
        };
      }

      if (params.makeBackup !== false) {
        await fsp.copyFile(full, `${full}.${timestampUtc()}.bak`);
      }
      await fsp.writeFile(full, patched, "utf8");

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            path: params.path,
            ok: true,
            bytes: patched.length,
            diagnostics: params.preview ? diagnostics : undefined
          }, null, 2)
        }]
      };
    }
  );
}

/* ----------------- helpers ----------------- */

function applyStructuredOpsWithDiag(source: string, ops: z.infer<typeof structuredOpsSchema>) {
  let lines = source.split("\n");
  const changed: Array<{start:number,end:number}> = [];

  const insertBlock = (at:number, text:string) => {
    const block = splitPreserve(text);
    lines.splice(at, 0, ...block);
    changed.push({ start: at+1, end: at+block.length });
  };

  for (const op of ops) {
    switch (op.type) {
      case "replaceRange": {
        const start = op.startLine; const end = op.endLine;
        const block = splitPreserve(op.text);
        if (end === 0) {
          lines = [...block, ...lines];
          changed.push({ start: 1, end: block.length });
        } else {
          if (start < 1 || end < start - 1 || end > lines.length) {
            throw new Error(`replaceRange out of bounds: [${start}, ${end}] on ${lines.length} lines`);
          }
          lines.splice(start-1, (end>=start? end-start+1 : 0), ...block);
          changed.push({ start, end: start + block.length - 1 });
        }
        break;
      }
      case "insertAfterAnchor": {
        const idx = findAnchorLine(lines, op.anchor, op.nth ?? 1);
        if (idx < 0) throw new Error(`insertAfterAnchor: anchor not found`);
        insertBlock(idx+1, op.text);
        break;
      }
      case "insertBeforeAnchor": {
        const idx = findAnchorLine(lines, op.anchor, op.nth ?? 1);
        if (idx < 0) throw new Error(`insertBeforeAnchor: anchor not found`);
        insertBlock(idx, op.text);
        break;
      }
    }
  }

  const text = lines.join("\n");
  const diffstat = { added: 0, removed: 0 };
  changed.forEach(r => diffstat.added += (r.end - r.start + 1));
  return { text, diagnostics: { changedRanges: mergedRanges(changed), diffstat } };
}

function splitPreserve(text: string): string[] {
  const t = normalizeLf(text);
  return t.endsWith("\n") ? t.slice(0, -1).split("\n").concat([""]) : t.split("\n");
}

function findAnchorLine(lines: string[], anchor: string, nth: number): number {
  const re = new RegExp(anchor);
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) { count++; if (count === nth) return i; }
  }
  return -1;
}

function mergedRanges(rs: Array<{start:number,end:number}>) {
  if (rs.length === 0) return rs;
  rs.sort((a,b)=>a.start-b.start);
  const out = [rs[0]];
  for (let i=1;i<rs.length;i++){
    const last = out[out.length-1];
    const cur = rs[i];
    if (cur.start <= last.end + 1) last.end = Math.max(last.end, cur.end);
    else out.push({ ...cur });
  }
  return out;
}

/* -------- tolerant unified apply (best-effort) -------- */

function normalizeWs(s: string, mode: WhitespaceMode) {
  if (mode === "strict") return s;
  if (mode === "ignore-space-change") return s.replace(/[ \t]+/g, " ").trimEnd();
  // ignore-all-space
  return s.replace(/[ \t]+/g, "").trimEnd();
}

type TolerantResult = { ok: true; text: string; diagnostics?: any } | { ok: false; error: string; diag?: any };

function tolerantApplyUnified(source: string, patch: string, opts: { wsMode: WhitespaceMode, fuzz: number }): TolerantResult {
  const srcLines = source.split("\n");
  const hunks = parseUnifiedHunks(patch);
  if (hunks.length === 0) return { ok: false, error: "No hunks found in unified diff." };

  let out = [...srcLines];
  const changed: Array<{start:number,end:number}> = [];

  // Apply from last to first to keep line numbers stable
  for (let h = hunks.length - 1; h >= 0; h--) {
    const hk = hunks[h];

    // Try to locate hunk start within fuzz window by matching context lines
    const target = locateHunk(out, hk, opts.wsMode, opts.fuzz);
    if (!target.ok) {
      return { ok: false, error: target.error, diag: { hunk: hk } };
    }

    // Apply changes at index
    const { startIndex } = target;
    const beforeLen = hk.removeLines.length;
    const afterLines = hk.addLines;

    out.splice(startIndex, beforeLen, ...afterLines);
    changed.push({ start: startIndex + 1, end: startIndex + afterLines.length });
  }

  const diffstat = { added: 0, removed: 0 };
  hunks.forEach(h => { diffstat.added += h.addLines.length; diffstat.removed += h.removeLines.length; });

  return { ok: true, text: out.join("\n"), diagnostics: { changedRanges: mergedRanges(changed), diffstat } };
}

function parseUnifiedHunks(patch: string) {
  // very small parser: looks for @@ -a,b +c,d @@
  const lines = normalizeLf(patch).split("\n");
  const hunks: Array<{ aStart:number; aLen:number; bStart:number; bLen:number; lines:string[]; removeLines:string[]; addLines:string[] }> = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/);
    if (!m) { i++; continue; }
    const aStart = parseInt(m[1],10);
    const aLen = m[2] ? parseInt(m[2],10) : 1;
    const bStart = parseInt(m[3],10);
    const bLen = m[4] ? parseInt(m[4],10) : 1;
    i++;

    const chunk: string[] = [];
    const removeLines: string[] = [];
    const addLines: string[] = [];

    while (i < lines.length && /^[ +\-\\]/.test(lines[i])) {
      const line = lines[i];
      if (line.startsWith("-")) removeLines.push(line.slice(1));
      else if (line.startsWith("+")) addLines.push(line.slice(1));
      else if (line.startsWith(" ") || line.startsWith("\\")) {
        // context or "\ No newline at end of file" → treat context as neutral
        chunk.push(line.startsWith(" ") ? line.slice(1) : "");
      }
      i++;
    }

    hunks.push({ aStart, aLen, bStart, bLen, lines: chunk, removeLines, addLines });
  }
  return hunks;
}

function locateHunk(docLines: string[], hunk: any, wsMode: WhitespaceMode, fuzz: number)
  : { ok: true; startIndex: number } | { ok: false; error: string } {

  // Ideal position (1-based to 0-based)
  const ideal = Math.max(0, hunk.aStart - 1);
  const windowStart = Math.max(0, ideal - fuzz);
  const windowEnd = Math.min(docLines.length, ideal + fuzz);

  // Build normalized versions of to-be-removed lines for match check
  const norm = (s:string)=>normalizeWs(s, wsMode);
  const removeNorm = hunk.removeLines.map(norm);

  for (let start = windowStart; start <= windowEnd; start++) {
    // Compare the block that would be removed (length may be 0)
    const slice = docLines.slice(start, start + removeNorm.length).map(norm);
    if (arraysEqual(slice, removeNorm)) {
      return { ok: true, startIndex: start };
    }
  }

  // If strict block match fails, try to anchor on the first +/- context lines inside a wider radius
  // (lightweight fallback — not as strong as GNU patch, but helpful)
  const needle = removeNorm[0] ?? "";
  if (needle) {
    for (let i = Math.max(0, ideal - 50); i < Math.min(docLines.length, ideal + 50); i++) {
      if (norm(docLines[i]) === needle) {
        return { ok: true, startIndex: i };
      }
    }
  }

  // Construct a helpful error
  const got = docLines.slice(ideal, ideal + removeNorm.length).map((s, idx) => `${ideal + idx + 1}: ${s}`);
  const exp = hunk.removeLines.map((s:string, idx:number) => `${ideal + idx + 1}: ${s}`);
  return {
    ok: false,
    error:
      `Unified hunk failed to match near declared start ${hunk.aStart}.\n` +
      `Try whitespaceMode="ignore-space-change" or "ignore-all-space", or increase fuzz.\n` +
      `Expected (first lines):\n${exp.slice(0,3).join("\n")}\n` +
      `Got (first lines):\n${got.slice(0,3).join("\n")}`
  };
}

function arraysEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  for (let i=0;i<a.length;i++) if (a[i] !== b[i]) return false;
  return true;
}

function formatUnifiedError(res: {error:string, diag?:any}, params:any) {
  const hint = `Hints: set "whitespaceMode":"ignore-space-change" (or "ignore-all-space"), or "fuzz":3, or prefer structured "ops".`;
  return `Failed to apply unified diff.\n${res.error}\n${hint}`;
}
