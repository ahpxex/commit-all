---
name: commit-all
version: 1.0.0
description: One-click commit (and push) across all recently-active git repos. Discovers repos from coding agents' own records of recent projects (Claude Code, Codex, Cursor — no directory scanning), classifies each by push-readiness, then commits with auto-generated messages and pushes where safe. Use when the user wants to "commit everything", "提交所有仓库", "一键提交", sync/save work across multiple projects, or commit-and-push their active repos at end of day.
metadata:
  requires:
    bins: ["git", "bun"]
---

# commit-all

One command to commit — and push where safe — every git repo you've recently worked
in. Repos are discovered from your coding agents' own records of recent projects, not
by scanning the filesystem, so coverage tracks where you actually work.

## How discovery works

`discover.ts` (run with [Bun](https://bun.sh)) builds the repo list from every
supported coding agent, then resolves and classifies. It reads each agent's config
directly, so it sees **all** agents' recent projects regardless of which agent is
running the skill.

1. **Collect** candidate paths (union, deduped) from each agent source:
   - Claude Code — `~/.claude.json` → `.projects` keys
   - Codex — `~/.codex/config.toml` `[projects."…"]` + `~/.codex/sessions/**/*.jsonl` cwd
   - Cursor — `…/globalStorage/state.vscdb` → `history.recentlyOpenedPathsList`
   - Adding an agent is one collector function in `discover.ts`'s `SOURCES` registry.
2. **Resolve** each path to its git toplevel (`git rev-parse --show-toplevel`) —
   non-repos, parent dirs, and duplicates fall out automatically.
3. **Classify** each repo with `git status --porcelain=v2 --branch` + remote/upstream
   probing, and bucket it:
   - `ready` — dirty or ahead, has a push target → **commit + push**
   - `commit_only` — no remote, or branch not on remote yet → **commit only**
   - `blocked` — behind the remote → **commit local changes, do NOT auto-push**
   - clean & synced repos are skipped silently

Tradeoff to be aware of: a repo you've never opened in a supported agent won't be
discovered. That's intentional — it keeps the list to active work.

## Workflow

1. **Discover.** Run the bundled script with Bun — it lives in the same directory as
   this `SKILL.md`. Use that directory's absolute path:
   ```bash
   bun "<this-skill-dir>/discover.ts"
   ```
   Parse the JSON. (Add `--pretty` if you just want to show the user a summary.)

2. **Report & confirm.** Show the user the actionable repos grouped by bucket
   (`ready` / `commit_only` / `blocked`), with branch and a short change summary for
   each. If `actionable_count` is 0, tell them everything is clean and stop.
   **Always get an explicit go-ahead before committing** — this writes commits and
   pushes to remotes across many repos, which is hard to undo. Mention exactly what
   will be pushed vs only committed.

3. **Commit each repo.** For every repo in `ready`, `commit_only`, and `blocked`:
   - Inspect the change so the message is meaningful:
     ```bash
     git -C "<root>" add -A
     git -C "<root>" diff --staged --stat
     git -C "<root>" diff --staged          # skim for the actual intent
     ```
   - Write a concise, specific commit message from the diff (imperative subject,
     ~50 chars; add a body only if the change is non-trivial). Do not invent a
     generic "update files" message when the diff shows real intent.
   - Commit:
     ```bash
     git -C "<root>" commit -m "<message>"
     ```
   - **Watch for secrets** before committing: if `git diff --staged` shows a newly
     added `.env`, key file, token, or credential, pause and ask rather than commit it.

4. **Push by bucket.**
   - `ready` → `git -C "<root>" push`
   - `commit_only` with a remote but the branch isn't on it yet → confirm, then
     `git -C "<root>" push -u origin <branch>` (this is the one case where you create
     an upstream — get a nod first). With no remote at all, skip and note it.
   - `blocked` → **do not push.** Report that it's behind by N and needs a manual
     `pull --rebase` (or merge) first. Never auto-pull/rebase/force here.

5. **Summarize.** One compact table: per repo — committed? pushed? skipped/blocked?
   Surface anything that failed (push rejected, etc.) with the exact git error.

## Notes

- Submodules: repos with `.gitmodules` (e.g. a parent on a feature branch) — commit
  the superproject normally; don't recurse into submodules unless the user asks.
- Detached HEAD: commit is fine, but flag it — there's no branch to push.
- Keep the loop sequential and report each repo as you go, so a failure midway is
  obvious and the rest still proceed.
