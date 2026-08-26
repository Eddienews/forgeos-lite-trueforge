# ForgeOS Lite — TrueForge Hackathon Edition

ForgeOS Lite is an open-source, local-first harness for controlled changes to one Git project at a time. TrueForge is the central runtime for model access, sessions, tools, sandbox execution, and persistence.

> This repository contains the open-source ForgeOS Lite — TrueForge Hackathon Edition. It is a new implementation built during the Agent Harness Hackathon. It does not contain the proprietary ForgeOS product or its private orchestration, skills, runtimes, governance, deployment, or enterprise features.

## Phase 1 status

Phase 0 governance is merged. The Phase 1 branch implements dependency-free mission contracts, fixed agent profiles, guarded state transitions, security utilities, and an in-memory hash-chained event journal. TrueForge sessions, MCP tools, sandbox execution, patch application, durable persistence, the server, and the interface remain deferred to later reviewed pull requests.

## Product boundary

- One local user and one Git project per session.
- The real project remains read-only during agent execution.
- Build and test activity occurs in a sandbox copy.
- A reviewed candidate patch is the only proposed output.
- Applying a candidate patch requires a human-approved MCP tool call.
- No arbitrary shell command may originate from `forgeos.project.json`.

## Language policy

All owned repository content must be written exclusively in English. This includes code, identifiers, comments, user interface text, accessibility labels, errors, logs, API responses, schemas, configuration, tests, fixtures, documentation, commit messages, branches, pull requests, Qodo responses, demo materials, screenshots, and sample data. Portuguese translations, examples, comments, and bilingual strings are not permitted.

Run the language policy check with:

```sh
npm test
```

The check scans owned text files and excludes vendored dependencies and generated artifacts. Unavoidable third-party content must remain outside owned project files and must be reported during review.

## Development status

The protected integration branch is `main`. Phase 1 is developed on `feat/mission-contract-foundation`, with the pull request title:

> Mission contracts, state machine, and security boundaries

No substantive code should be merged without Qodo review evidence.

## Qodo Code Review Evidence

- [Phase 0 governance and repository bootstrap](https://github.com/Eddienews/forgeos-lite-trueforge/pull/1): Qodo findings were resolved before the human-approved squash merge.
- [Phase 1 mission contracts, state machine, and security boundaries](https://github.com/Eddienews/forgeos-lite-trueforge/pull/2): the initial Qodo review found four valid continuity issues. Follow-up work binds approval to the target project and base revision, rejects cross-mission evidence, preserves candidate identity from review through application, and binds completion evidence to the applied candidate hash. Follow-up review is required before merge.

## License and marks

Source code is licensed under the MIT License. See [TRADEMARKS.md](TRADEMARKS.md) for restrictions concerning the ForgeOS name and identity, and [NOTICE.md](NOTICE.md) for project provenance.
