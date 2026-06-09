# commit-all

A coding-agent skill that commits — and pushes where safe — **every git repo you've
recently worked in**, in one shot.

The hard part of "commit everything" isn't committing; it's *finding* the repos.
`commit-all` doesn't scan your filesystem. Instead it reads your coding agents' own
records of recently-opened projects and uses those as the index of active work. So
coverage automatically tracks where you actually code, with zero configuration.

Works as a [Skill](https://skills.sh) across any agent the `skills` CLI supports
(Claude Code, Codex, Cursor, Gemini CLI, Copilot, and 70+ more).

---

## How it works

```
agent project records  ──►  resolve to git root  ──►  classify  ──►  commit / push
(Claude Code, Codex,        git rev-parse              git status      by bucket
 Cursor; deduped union)     --show-toplevel            --porcelain=v2
```

1. **Collect** candidate paths from every supported agent (union, deduped):

   | Agent | Source |
   |-------|--------|
   | Claude Code | `~/.claude.json` → `.projects` keys |
   | Codex | `~/.codex/config.toml` `[projects."…"]` + `~/.codex/sessions/**/*.jsonl` cwd |
   | Cursor | `…/globalStorage/state.vscdb` → `history.recentlyOpenedPathsList` |

   The script reads each agent's config directly, so it sees **all** agents' projects
   no matter which agent invokes the skill.

2. **Resolve** each path to its git toplevel (`git rev-parse --show-toplevel`).
   Non-repos, parent directories, and duplicates drop out automatically.

3. **Classify** each repo (`git status --porcelain=v2 --branch` plus remote/upstream
   probing) and sort into buckets:

   | Bucket | Meaning | Action |
   |--------|---------|--------|
   | `ready` | dirty or ahead, has a push target | **commit + push** |
   | `commit_only` | no remote, or branch not on remote yet | **commit only** |
   | `blocked` | behind the remote | **commit locally, never auto-push** |
   | _clean_ | nothing to commit, already synced | skipped silently |

4. **Commit** each actionable repo with a message generated from its diff, then
   **push** per bucket. Behind repos are reported, not force-pushed.

**Tradeoff:** a repo you've never opened in a supported agent won't be discovered —
intentional, since it keeps the list to active work.

---

## Install

Via the [`skills`](https://skills.sh) CLI — it installs into every coding agent it
detects on your machine:

```bash
# From a published GitHub repo (shorthand, full URL, or any git URL)
npx skills add <owner>/<repo>

# From a local checkout
npx skills add /path/to/commit-all

# Manage
npx skills list
npx skills remove commit-all
```

Requirements: `git` and [`bun`](https://bun.sh) (discovery is a single TypeScript
file using only Bun built-ins — no `bun install` needed).

---

## Usage

In any installed agent:

```
/commit-all
```

or just ask it to "commit all my repos" / "提交所有仓库". The skill will:

1. Run discovery and show you the actionable repos grouped by bucket.
2. **Ask for confirmation** before writing anything.
3. Commit each repo with a generated message and push where safe.
4. Print a per-repo summary (committed / pushed / skipped / blocked).

You can also run discovery standalone to preview, without committing:

```bash
bun discover.ts --pretty   # human-readable
bun discover.ts            # JSON
```

---

## Safety

- **Confirmation required** before any commit or push — this writes across many repos
  and is hard to undo.
- **Behind-remote repos are never auto-pushed.** They're reported so you can
  `pull --rebase` (or merge) yourself first. No automatic pull/rebase/force.
- **Secret guard:** if a staged diff adds a `.env`, key file, token, or credential,
  the skill pauses and asks instead of committing it.
- **Upstreams aren't created silently:** pushing a brand-new branch with `-u` is
  confirmed first.

---

## Extending discovery to another agent

Discovery sources live in a registry in `discover.ts`:

```ts
const SOURCES: Record<string, Source> = {
  "claude-code": srcClaudeCode,
  codex: srcCodex,
  cursor: srcCursor,
};
```

Add a collector that returns an array of candidate paths (and **fails closed** —
returns `[]` if that agent isn't installed or anything goes wrong), then register it:

```ts
function srcMyAgent(): string[] {
  // ...
  return paths;
}

SOURCES["myagent"] = srcMyAgent;
```

Everything downstream (resolve, classify, bucket) is agent-agnostic and needs no
changes.

---

## Files

| File | Purpose |
|------|---------|
| `SKILL.md` | Skill definition + workflow the agent follows |
| `discover.ts` | Discovery, resolution, and classification (Bun, zero deps) |
| `README.md` | This file |
