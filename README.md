# ForgeOS Lite — TrueForge Hackathon Edition

ForgeOS Lite is an open-source, local-first harness for controlled changes to one Git project at a time. TrueForge is the central runtime for model access, sessions, tools, sandbox execution, and persistence.

> This repository contains the open-source ForgeOS Lite — TrueForge Hackathon Edition. It is a new implementation built during the Agent Harness Hackathon. It does not contain the proprietary ForgeOS product or its private orchestration, skills, runtimes, governance, deployment, or enterprise features.

## Phase 2 status

Phase 0 governance and the Phase 1 contract foundation are merged. Phase 2 adds `packages/runtime-trueforge`, a small adapter boundary for controlled TrueForge sessions, Node.js lifecycle policy execution, workspace confinement, normalized public execution evidence, clean shutdown, and deterministic fake-runtime tests. A separate live proof uses the qualified local TrueForge 0.1.4 installation to create a session, run `npm test` inside an isolated disposable sandbox, produce a fixture file, capture exit and output evidence, and release the session.

Phase 2 does not implement the MCP approval server, patch application, candidate generation, a Reviewer runtime, durable mission-journal storage, a backend server, an interface, authentication, deployment, or any Phase 3 behavior.

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

The protected integration branch is `main`. Phase 2 is developed on `feat/trueforge-session-foundation`, with the pull request title:

> TrueForge session adapter and isolated execution foundation

No substantive code should be merged without Qodo review evidence.

## Qodo Code Review Evidence

- [Phase 0 governance and repository bootstrap](https://github.com/Eddienews/forgeos-lite-trueforge/pull/1): Qodo findings were resolved before the human-approved squash merge.
- [Phase 1 mission contracts, state machine, and security boundaries](https://github.com/Eddienews/forgeos-lite-trueforge/pull/2): the initial Qodo review found four valid continuity issues. Follow-up work binds approval to the target project and base revision, rejects cross-mission evidence, preserves candidate identity from review through application, and binds completion evidence to the applied candidate hash. An additional automated review identified that the verdict digest also needed to be recomputed from canonical test evidence; that binding and its regression coverage were added. Qodo's latest review was clean and all review threads were resolved before the human-approved merge.

## License and marks

Source code is licensed under the MIT License. See [TRADEMARKS.md](TRADEMARKS.md) for restrictions concerning the ForgeOS name and identity, and [NOTICE.md](NOTICE.md) for project provenance.
