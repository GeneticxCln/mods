# Nine Claude Code mods

Private repo: add it from a session that has GitHub access to this account.

A local plugin marketplace (`mods`). Each folder is one plugin of function hooks.

| Plugin | What it does | Use |
|---|---|---|
| `savvy-progress` | Live progress band above the prompt: todos, elapsed time, context, cost and projection, subagent mascots | `/progress` (status in words), `/progress hide\|show` |
| `transcript-skins` | Re-themes your messages, replies, tool rows, edit diffs and the turn footer | `/skin tokyo\|noah\|paper\|mono\|off\|file.json` |
| `you-should-know` | Banner for breaking changes, data loss, exposed secrets, costs, work left for you | a toast, then `/know` |
| `file-tree` | Workspace tree pane; active files shimmer, changes yellow, committed green | `/tree` |
| `cache-tax` | Warns when the prompt cache is cold, what the reload costs, keeps it warm | `/keepwarm status\|on\|off` (also a toast when the cache goes cold) |
| `blast-radius` | Measures destructive commands and asks before they run | automatic |
| `reflect` | Offers to save your corrections as rules in CLAUDE.md | toast, then `/reflect save` or `/reflect dismiss` |
| `terminal-browser` | Text-mode browser pane for URLs, local files and PR `.diff`s | `/browse <url\|file>` |
| `replay-theater` | Step through every edit and command of the last task | `/replay` |

## Install

```
claude plugin marketplace add GeneticxCln/mods
claude plugin install savvy-progress@mods --scope user
```

(repeat the second line per plugin), or inside Claude Code: `/plugin marketplace add GeneticxCln/mods`, then `/plugin install <name>@mods`.

Options, all optional: `/plugin configure cache-tax@mods` (cache lifetime, input price per million tokens, most keep-warm pings), `savvy-progress` (mascot), `transcript-skins` (default skin), `you-should-know` (also ask a small model).
