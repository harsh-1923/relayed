# genui spikes

Evidence for [`docs/AGENT-RESPONSES.md`](../../docs/AGENT-RESPONSES.md). A
standalone npm project, not a workspace member — like `spikes/electron-verify`.
Not app code: `library.mjs` is the shape `@relayed/genui` is proposed to take,
nothing more.

## Install

```bash
cd spikes/genui
npm run install:safe   # --ignore-scripts, so OpenUI's install telemetry never runs
```

## The spikes

| Script | Question | Cost to run |
|---|---|---|
| `1-prompt.mjs` | What do the generated instructions say, and does the validator catch each mistake? | none |
| `2-claude.mjs <variants>` | Does the person's own Claude Code use `show_ui` well, and does it repair from errors? | Claude usage: 12–26 read-only turns |
| `3-pi.mjs` | Same, through `apps/agent`'s pi and provider table | model credits: 14 read-only turns |
| `4-render/build.mjs` | Does the renderer work under relayed's CSP, streaming real input, isolating errors, reporting clicks? | none; open `4-render/dist/*/` over HTTP |
| `5-guard.mjs` | What happens to a stored block when the library changes, and can a check tell safe from unsafe? | none |

```bash
node 1-prompt.mjs
node 2-claude.mjs tool,inline 3                    # round one
node 2-claude.mjs tool-nudged,inline-nudged,repair 3   # round two
node --env-file-if-exists=../../.env 3-pi.mjs 3
node 4-render/build.mjs && (cd 4-render/dist && python3 -m http.server 5391)
node 5-guard.mjs
```

### What keeps 2 and 3 safe to run

- Read-only by construction: Claude Code gets `tools: ['Read', 'Glob', 'Grep']`,
  pi gets `read, grep, find, ls`, and both get `show_ui`. Nothing else is callable.
- `persistSession: false`: no transcript is written under `~/.claude/projects`.
- Claude Code receives a scrubbed environment (`claude-env.mjs`): no inherited
  `CLAUDE_*` or `ANTHROPIC_*`, so it signs in as the person, not as whatever
  process launched the spike.
- `apps/agent` is imported, never modified.

## Results

Summaries in `results/`; the table in the doc's evidence section is built from them.

| File | Contents |
|---|---|
| `1-instructions.txt` | The exact text both runtimes append |
| `1-prompt.json` | Instruction size, what the prompt mentions, every validator case |
| `2-claude/summary-tool+inline.json` | Round one |
| `2-claude/summary-tool-nudged+inline-nudged+repair.json` | Round two |
| `2-claude/<variant>-<prompt>.json` | Every run: blocks, errors, the reply, the source |
| `2-claude/stream-fixture-*.json` | Real partial sources as Claude streamed them; spike 4 plays one back |
| `3-pi/summary.json`, `3-pi/<prompt>.json` | The pi runs |
| `4-render.json` | What each page reported, and the bundle by package |
| `5-guard.json` | How a stored block reads under each library change, and what the guard said |

`spec-snapshot.json` is the snapshot `5-guard.mjs` compares against — in the app
it becomes the committed file the guard test reads.
