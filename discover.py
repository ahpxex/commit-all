#!/usr/bin/env python3
"""Discover git repos that need committing/pushing, using coding-agent records of
recently-active projects as the index — no filesystem scanning.

Pipeline:
  1. Collect candidate paths from every supported agent (union, deduped).
  2. Resolve each to its git toplevel (drops non-repos, parents, dups).
  3. Classify with `git status --porcelain=v2 --branch` + remote/upstream probing.
  4. Filter to dirty-or-unpushed and bucket: ready / commit_only / blocked.

The script reads each agent's config directly, so it sees ALL agents' recent
projects regardless of which agent is running it.

Adding a new agent = one function returning a list of candidate paths, registered
in SOURCES. Each source must fail closed (return [] on any error / when absent).

Outputs JSON on stdout. Use --pretty for a human-readable summary instead.
"""
from __future__ import annotations

import glob
import json
import os
import re
import subprocess
import sys
from urllib.parse import unquote, urlparse

HOME = os.path.expanduser("~")
IS_MAC = sys.platform == "darwin"


def run_git(repo: str, *args: str) -> tuple[int, str]:
    """Run a git command in `repo`, returning (returncode, stdout-stripped)."""
    try:
        p = subprocess.run(
            ["git", "-C", repo, *args],
            capture_output=True, text=True, timeout=20,
        )
        return p.returncode, p.stdout.strip()
    except Exception:
        return 1, ""


# --------------------------------------------------------------------------- #
# 1. Candidate sources (one per coding agent) — each fails closed.
# --------------------------------------------------------------------------- #
def src_claude_code() -> list[str]:
    """Claude Code — `~/.claude.json` -> .projects keys (literal absolute paths)."""
    path = os.path.join(HOME, ".claude.json")
    try:
        with open(path) as f:
            return list(json.load(f).get("projects", {}).keys())
    except Exception:
        return []


def src_codex() -> list[str]:
    """Codex — `~/.codex/config.toml` [projects."…"] headers, plus session cwd."""
    out: list[str] = []
    # Trusted-projects table in config.toml.
    cfg = os.path.join(HOME, ".codex", "config.toml")
    try:
        with open(cfg) as f:
            for line in f:
                m = re.match(r'^\[projects\."(.+)"\]\s*$', line)
                if m:
                    out.append(m.group(1))
    except Exception:
        pass
    # Session logs carry the actual cwd (complete record).
    root = os.path.join(HOME, ".codex", "sessions")
    try:
        files = glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True)
        files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        for fp in files[:800]:
            try:
                with open(fp) as f:
                    for _ in range(5):  # session_meta sits at the top of the file
                        line = f.readline()
                        if not line:
                            break
                        d = json.loads(line)
                        if not isinstance(d, dict):
                            continue
                        cwd = d.get("cwd") or (
                            d.get("payload", {}).get("cwd")
                            if isinstance(d.get("payload"), dict) else None
                        )
                        if cwd:
                            out.append(cwd)
                            break
            except Exception:
                continue
    except Exception:
        pass
    return out


def src_cursor() -> list[str]:
    """Cursor — VS Code-style state.vscdb -> history.recentlyOpenedPathsList."""
    import sqlite3
    if IS_MAC:
        db = os.path.join(HOME, "Library", "Application Support", "Cursor",
                          "User", "globalStorage", "state.vscdb")
    else:
        db = os.path.join(HOME, ".config", "Cursor",
                          "User", "globalStorage", "state.vscdb")
    if not os.path.isfile(db):
        return []
    out: list[str] = []
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            row = con.execute(
                "SELECT value FROM ItemTable WHERE key=?",
                ("history.recentlyOpenedPathsList",),
            ).fetchone()
        finally:
            con.close()
        if row:
            for e in json.loads(row[0]).get("entries", []):
                u = e.get("folderUri") or e.get("fileUri")
                if isinstance(u, str) and u.startswith("file://"):
                    out.append(unquote(urlparse(u).path))
    except Exception:
        return []
    return out


# name -> collector. Add an agent here to extend discovery.
SOURCES = {
    "claude-code": src_claude_code,
    "codex": src_codex,
    "cursor": src_cursor,
}


def collect_candidates() -> tuple[list[str], dict[str, int]]:
    seen: set[str] = set()
    out: list[str] = []
    per_source: dict[str, int] = {}
    for name, fn in SOURCES.items():
        try:
            paths = fn() or []
        except Exception:
            paths = []
        per_source[name] = len(paths)
        for p in paths:
            if not p:
                continue
            p = os.path.expanduser(p.rstrip("/"))
            if p not in seen and os.path.isdir(p):
                seen.add(p)
                out.append(p)
    return out, per_source


# --------------------------------------------------------------------------- #
# 2. Resolve to git toplevel + dedup
# --------------------------------------------------------------------------- #
def resolve_repos(paths: list[str]) -> list[str]:
    roots, seen = [], set()
    for p in paths:
        rc, top = run_git(p, "rev-parse", "--show-toplevel")
        if rc == 0 and top and top not in seen:
            seen.add(top)
            roots.append(top)
    return roots


# --------------------------------------------------------------------------- #
# 3. Classify
# --------------------------------------------------------------------------- #
def classify(root: str) -> dict:
    rc, out = run_git(root, "status", "--porcelain=v2", "--branch")
    branch = "(unknown)"
    has_upstream = detached = False
    ahead = behind = dirty_count = 0

    for line in out.splitlines():
        if line.startswith("# branch.head "):
            branch = line[len("# branch.head "):]
            detached = branch == "(detached)"
        elif line.startswith("# branch.upstream "):
            has_upstream = True
        elif line.startswith("# branch.ab "):
            m = re.search(r"\+(\d+)\s+-(\d+)", line)
            if m:
                ahead, behind = int(m.group(1)), int(m.group(2))
        elif line and not line.startswith("#"):
            dirty_count += 1

    _, remotes = run_git(root, "remote")
    has_remote = bool(remotes.strip())

    # No upstream but a remote exists: probe origin/<branch> for implicit state.
    branch_on_remote = None
    if not has_upstream and has_remote and not detached:
        rc_v, _ = run_git(root, "rev-parse", "--verify", "--quiet", f"origin/{branch}")
        if rc_v == 0:
            branch_on_remote = True
            rc_c, counts = run_git(
                root, "rev-list", "--left-right", "--count", f"origin/{branch}...HEAD"
            )
            if rc_c == 0 and "\t" in counts:
                b, a = counts.split("\t")
                behind, ahead = int(b), int(a)
        else:
            branch_on_remote = False  # local branch never pushed

    dirty = dirty_count > 0
    needs_action = dirty or ahead > 0 or (has_remote and branch_on_remote is False)

    if not needs_action:
        bucket = "clean"
    elif behind > 0:
        bucket = "blocked"          # behind remote: commit local, don't auto-push
    elif not has_remote or (not has_upstream and branch_on_remote is False):
        bucket = "commit_only"      # nothing to push to / brand-new branch
    else:
        bucket = "ready"            # safe to commit + push

    return {
        "root": root, "branch": branch, "detached": detached,
        "dirty": dirty, "dirty_count": dirty_count,
        "ahead": ahead, "behind": behind,
        "has_remote": has_remote, "has_upstream": has_upstream,
        "branch_on_remote": branch_on_remote,
        "needs_action": needs_action, "bucket": bucket,
    }


def main() -> int:
    pretty = "--pretty" in sys.argv
    candidates, per_source = collect_candidates()
    roots = resolve_repos(candidates)
    repos = [classify(r) for r in roots]
    actionable = [r for r in repos if r["bucket"] != "clean"]

    buckets = {"ready": [], "commit_only": [], "blocked": []}
    for r in actionable:
        buckets[r["bucket"]].append(r)

    result = {
        "sources": per_source,
        "candidate_count": len(candidates),
        "repo_count": len(roots),
        "actionable_count": len(actionable),
        "clean_count": len(repos) - len(actionable),
        "buckets": buckets,
    }

    if not pretty:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    labels = {
        "ready": "✅ READY (commit + push)",
        "commit_only": "📦 COMMIT-ONLY (no remote/upstream)",
        "blocked": "⚠️  BLOCKED (behind remote — won't auto-push)",
    }
    srcs = ", ".join(f"{k}={v}" for k, v in per_source.items())
    print(f"Sources: {srcs}")
    print(f"Scanned {len(candidates)} candidate paths -> {len(roots)} repos "
          f"({result['clean_count']} clean, {len(actionable)} need action)\n")
    for key in ("ready", "commit_only", "blocked"):
        items = buckets[key]
        if not items:
            continue
        print(labels[key])
        for r in items:
            bits = []
            if r["dirty"]:
                bits.append(f"{r['dirty_count']} changed")
            if r["ahead"]:
                bits.append(f"ahead {r['ahead']}")
            if r["behind"]:
                bits.append(f"behind {r['behind']}")
            if not r["has_remote"]:
                bits.append("no remote")
            elif r["branch_on_remote"] is False:
                bits.append("branch not on remote")
            print(f"  {r['root']}  [{r['branch']}]  ({', '.join(bits) or 'n/a'})")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
