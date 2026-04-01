# Agent Context Kit extraction plan

- [ ] Read and inventory all source files from both layers plus the blog post and efficacy audit.
- [ ] Create a standalone TypeScript package skeleton for `agent-context-kit`.
- [ ] Extract and adapt runtime tool-result sanitizer logic into framework-agnostic modules.
- [ ] Extract and adapt artifact storage and truncation utilities into framework-agnostic modules.
- [ ] Extract and adapt runtime guard/context-pressure logic into framework-agnostic modules.
- [ ] Extract and adapt compaction modules, prompts, entity scoring, task graph, recovery, and workspace salvage into framework-agnostic modules.
- [ ] Write public-facing documentation: README, architecture, integration guide, efficacy audit.
- [ ] Verify the package compiles with `npx tsc --noEmit`.
- [ ] Write `SUMMARY.md` with results and notable implementation details.
