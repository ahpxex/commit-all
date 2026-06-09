#!/usr/bin/env bun
/**
 * Discover git repos that need committing/pushing, using coding-agent records of
 * recently-active projects as the index — no filesystem scanning.
 *
 * Pipeline:
 *   1. Collect candidate paths from every supported agent (union, deduped).
 *   2. Resolve each to its git toplevel (drops non-repos, parents, dups).
 *   3. Classify with `git status --porcelain=v2 --branch` + remote/upstream probing.
 *   4. Filter to dirty-or-unpushed and bucket: ready / commit_only / blocked.
 *
 * The script reads each agent's config directly, so it sees ALL agents' recent
 * projects regardless of which agent is running it.
 *
 * Adding a new agent = one collector returning candidate paths, registered in
 * SOURCES. Each source must fail closed (return [] on any error / when absent).
 *
 * Run with Bun:  bun discover.ts [--pretty]
 *   (no flags) → JSON on stdout
 *   --pretty   → human-readable summary
 *
 * Zero dependencies: uses Bun built-ins (Bun.spawnSync, Bun.Glob, bun:sqlite).
 */
import { existsSync, statSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { Database } from "bun:sqlite";

const HOME = homedir();
const IS_MAC = process.platform === "darwin";

function runGit(repo: string, ...args: string[]): { code: number; out: string } {
  try {
    const p = Bun.spawnSync(["git", "-C", repo, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });
    return { code: p.exitCode, out: new TextDecoder().decode(p.stdout).trim() };
  } catch {
    return { code: 1, out: "" };
  }
}

/** Read only the head of a (possibly large) file, without loading the whole thing. */
function readHead(path: string, bytes = 65_536): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

// --------------------------------------------------------------------------- //
// 1. Candidate sources (one per coding agent) — each fails closed.
// --------------------------------------------------------------------------- //
type Source = () => string[];

/** Claude Code — `~/.claude.json` -> .projects keys (literal absolute paths). */
function srcClaudeCode(): string[] {
  try {
    const data = JSON.parse(readFileSync(join(HOME, ".claude.json"), "utf8"));
    return Object.keys(data?.projects ?? {});
  } catch {
    return [];
  }
}

/** Codex — `~/.codex/config.toml` [projects."…"] headers, plus session cwd. */
function srcCodex(): string[] {
  const out: string[] = [];

  // Trusted-projects table in config.toml.
  try {
    const cfg = readFileSync(join(HOME, ".codex", "config.toml"), "utf8");
    for (const line of cfg.split("\n")) {
      const m = line.match(/^\[projects\."(.+)"\]\s*$/);
      if (m) out.push(m[1]);
    }
  } catch {
    /* absent — skip */
  }

  // Session logs carry the actual cwd (complete record).
  try {
    const root = join(HOME, ".codex", "sessions");
    if (existsSync(root)) {
      const files: { p: string; m: number }[] = [];
      for (const rel of new Glob("**/*.jsonl").scanSync(root)) {
        const full = join(root, rel);
        try {
          files.push({ p: full, m: statSync(full).mtimeMs });
        } catch {
          /* skip unreadable */
        }
      }
      files.sort((a, b) => b.m - a.m); // most recent first
      for (const { p } of files.slice(0, 800)) {
        try {
          // session_meta sits at the top of the file.
          for (const line of readHead(p).split("\n").slice(0, 5)) {
            if (!line.trim()) continue;
            let d: any;
            try {
              d = JSON.parse(line);
            } catch {
              continue;
            }
            const cwd = d?.cwd ?? (typeof d?.payload === "object" ? d.payload?.cwd : null);
            if (cwd) {
              out.push(cwd);
              break;
            }
          }
        } catch {
          /* skip unreadable */
        }
      }
    }
  } catch {
    /* skip */
  }

  return out;
}

/** Cursor — VS Code-style state.vscdb -> history.recentlyOpenedPathsList. */
function srcCursor(): string[] {
  const db = IS_MAC
    ? join(HOME, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
    : join(HOME, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
  if (!existsSync(db)) return [];

  const out: string[] = [];
  try {
    const sqlite = new Database(db, { readonly: true });
    try {
      const row = sqlite
        .query("SELECT value FROM ItemTable WHERE key = ?")
        .get("history.recentlyOpenedPathsList") as { value: string } | null;
      if (row?.value) {
        for (const e of JSON.parse(row.value)?.entries ?? []) {
          const u: unknown = e.folderUri ?? e.fileUri;
          if (typeof u === "string" && u.startsWith("file://")) {
            out.push(decodeURIComponent(new URL(u).pathname));
          }
        }
      }
    } finally {
      sqlite.close();
    }
  } catch {
    return [];
  }
  return out;
}

// name -> collector. Add an agent here to extend discovery.
const SOURCES: Record<string, Source> = {
  "claude-code": srcClaudeCode,
  codex: srcCodex,
  cursor: srcCursor,
};

function collectCandidates(): { candidates: string[]; perSource: Record<string, number> } {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const perSource: Record<string, number> = {};

  for (const [name, fn] of Object.entries(SOURCES)) {
    let paths: string[] = [];
    try {
      paths = fn() ?? [];
    } catch {
      paths = [];
    }
    perSource[name] = paths.length;
    for (let p of paths) {
      if (!p) continue;
      if (p.startsWith("~")) p = join(HOME, p.slice(1));
      p = p.replace(/\/+$/, "");
      try {
        if (!seen.has(p) && existsSync(p) && statSync(p).isDirectory()) {
          seen.add(p);
          candidates.push(p);
        }
      } catch {
        /* skip */
      }
    }
  }
  return { candidates, perSource };
}

// --------------------------------------------------------------------------- //
// 2. Resolve to git toplevel + dedup
// --------------------------------------------------------------------------- //
function resolveRepos(paths: string[]): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const { code, out } = runGit(p, "rev-parse", "--show-toplevel");
    if (code === 0 && out && !seen.has(out)) {
      seen.add(out);
      roots.push(out);
    }
  }
  return roots;
}

// --------------------------------------------------------------------------- //
// 3. Classify
// --------------------------------------------------------------------------- //
type Bucket = "clean" | "ready" | "commit_only" | "blocked";

interface RepoStatus {
  root: string;
  branch: string;
  detached: boolean;
  dirty: boolean;
  dirtyCount: number;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  hasUpstream: boolean;
  branchOnRemote: boolean | null;
  needsAction: boolean;
  bucket: Bucket;
}

function classify(root: string): RepoStatus {
  const { out } = runGit(root, "status", "--porcelain=v2", "--branch");
  let branch = "(unknown)";
  let hasUpstream = false;
  let detached = false;
  let ahead = 0;
  let behind = 0;
  let dirtyCount = 0;

  for (const line of out.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length);
      detached = branch === "(detached)";
    } else if (line.startsWith("# branch.upstream ")) {
      hasUpstream = true;
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line && !line.startsWith("#")) {
      dirtyCount++;
    }
  }

  const hasRemote = runGit(root, "remote").out.trim().length > 0;

  // No upstream but a remote exists: probe origin/<branch> for implicit state.
  let branchOnRemote: boolean | null = null;
  if (!hasUpstream && hasRemote && !detached) {
    const v = runGit(root, "rev-parse", "--verify", "--quiet", `origin/${branch}`);
    if (v.code === 0) {
      branchOnRemote = true;
      const c = runGit(root, "rev-list", "--left-right", "--count", `origin/${branch}...HEAD`);
      if (c.code === 0 && c.out.includes("\t")) {
        const [b, a] = c.out.split("\t");
        behind = Number(b);
        ahead = Number(a);
      }
    } else {
      branchOnRemote = false; // local branch never pushed
    }
  }

  const dirty = dirtyCount > 0;
  const needsAction = dirty || ahead > 0 || (hasRemote && branchOnRemote === false);

  let bucket: Bucket;
  if (!needsAction) bucket = "clean";
  else if (behind > 0) bucket = "blocked"; // behind remote: commit local, don't auto-push
  else if (!hasRemote || (!hasUpstream && branchOnRemote === false)) bucket = "commit_only";
  else bucket = "ready";

  return {
    root, branch, detached, dirty, dirtyCount,
    ahead, behind, hasRemote, hasUpstream, branchOnRemote, needsAction, bucket,
  };
}

// --------------------------------------------------------------------------- //
// Main
// --------------------------------------------------------------------------- //
function main(): void {
  const pretty = process.argv.includes("--pretty");
  const { candidates, perSource } = collectCandidates();
  const roots = resolveRepos(candidates);
  const repos = roots.map(classify);
  const actionable = repos.filter((r) => r.bucket !== "clean");

  const buckets: Record<"ready" | "commit_only" | "blocked", RepoStatus[]> = {
    ready: [],
    commit_only: [],
    blocked: [],
  };
  for (const r of actionable) buckets[r.bucket as "ready" | "commit_only" | "blocked"].push(r);

  const result = {
    sources: perSource,
    candidate_count: candidates.length,
    repo_count: roots.length,
    actionable_count: actionable.length,
    clean_count: repos.length - actionable.length,
    buckets,
  };

  if (!pretty) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const labels: Record<string, string> = {
    ready: "✅ READY (commit + push)",
    commit_only: "📦 COMMIT-ONLY (no remote/upstream)",
    blocked: "⚠️  BLOCKED (behind remote — won't auto-push)",
  };
  const srcs = Object.entries(perSource).map(([k, v]) => `${k}=${v}`).join(", ");
  console.log(`Sources: ${srcs}`);
  console.log(
    `Scanned ${candidates.length} candidate paths -> ${roots.length} repos ` +
      `(${result.clean_count} clean, ${actionable.length} need action)\n`,
  );
  for (const key of ["ready", "commit_only", "blocked"] as const) {
    const items = buckets[key];
    if (!items.length) continue;
    console.log(labels[key]);
    for (const r of items) {
      const bits: string[] = [];
      if (r.dirty) bits.push(`${r.dirtyCount} changed`);
      if (r.ahead) bits.push(`ahead ${r.ahead}`);
      if (r.behind) bits.push(`behind ${r.behind}`);
      if (!r.hasRemote) bits.push("no remote");
      else if (r.branchOnRemote === false) bits.push("branch not on remote");
      console.log(`  ${r.root}  [${r.branch}]  (${bits.join(", ") || "n/a"})`);
    }
    console.log();
  }
}

main();
