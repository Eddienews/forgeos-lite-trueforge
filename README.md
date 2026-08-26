# ForgeOS Lite — TrueForge Hackathon Edition

ForgeOS Lite is an open-source, local-first harness for controlled changes to one Git project at a time. TrueForge is the central runtime for model access, sessions, tools, sandbox execution, and persistence.

> This repository contains the open-source ForgeOS Lite — TrueForge Hackathon Edition. It is a new implementation built during the Agent Harness Hackathon. It does not contain the proprietary ForgeOS product or its private orchestration, skills, runtimes, governance, deployment, or enterprise features.

## Phase 4 status

Phases 0 through 3 are merged. Phase 4 adds the first complete mission-orchestration vertical slice for one local Node.js Git project. Strict project and mission intake create the existing contracts, a fixed Coordinator produces a public structured plan, and the existing TrueForge runtime executes a declared `npm-run-build` transformation plus declared build and test validation in a fresh isolated Git clone. A fixed Reviewer evaluates only the candidate, scope, base identity, Builder result, and validation evidence. A successful run creates the existing reviewed `CandidatePatch`, records replayable milestones in the existing journal, cleans the TrueForge session and Builder workspace, proves the original is unchanged, and stops at `awaiting_approval`.

The installed TrueForge 0.1.4 connector schema supports remote Streamable HTTP MCP servers, not stdio connectors. The Phase 3 server therefore binds only to loopback and requires a control-plane bearer token configured as a TrueForge connector header. Its `apply_candidate_patch` tool declares `readOnlyHint: false` and `destructiveHint: true`, while the TrueForge agent specification names that exact tool in `require_approval_for_tools`. TrueForge pauses with `tool.approval_required`; a human resumes the pending tool call with a `user.tool_approval` input. The ApprovalRecord binds the session, thread, tool-call, and approval-event identifiers and remains unusable until the control plane confirms that TrueForge accepted the exact allow resume. The MCP arguments contain only a sealed server-side context identifier and cannot select a target root, submit raw patch content, or claim an approval actor.

The Phase 4 live proof creates two disposable Node.js Git projects and uses `gpt-5.4-mini` through real TrueForge 0.1.4 sessions. The positive mission performs a controlled source change and declared build and test policies, reaches `awaiting_approval`, and prints human approval as the explicit next action. The negative mission completes the Builder change but fails declared `npm-test` validation, records exactly one validation-failure milestone, exposes no candidate or application context, and leaves the original unchanged. Run it against a configured local TrueForge 0.1.4 server with:

```sh
TRUEFORGE_BASE_URL=http://localhost:8790 \
TRUEFORGE_WORKSPACE_ROOT=/absolute/trusted/trueforge/workspace/root \
npm run test:integration:mission
```

Phase 3 still provides the separately proven human-approval and controlled-application boundary:

```sh
TRUEFORGE_BASE_URL=http://localhost:8790 \
TRUEFORGE_HUMAN_ACTOR_ID=your-stable-human-id \
npm run test:integration:approval
```

Phase 4 verification includes 150 passing unit and adversarial tests: 126 retained regression tests from Phases 0 through 3 and 24 Phase 4 orchestration tests. Repository formatting and English-language gates pass across 43 owned files, and `npm audit --audit-level=low` reports zero vulnerabilities.

Phase 4 remains intentionally fixed rather than autonomous. It defers UI, the backend/API server, durable journal persistence, process-restart recovery, general autonomous Coordinator, Builder, and Reviewer agents, Python and static projects, multi-project support, automatic Git commits, remote Git mutation, cloud execution, deployment, authentication, teams, billing, marketplace features, and ForgeOS Browser.

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

The protected integration branch is `main`. Phase 4 is developed on `feat/mission-orchestration-vertical-slice`, with the pull request title:

> End-to-end mission orchestration vertical slice

No substantive code should be merged without Qodo review evidence.

## Qodo Code Review Evidence

- [Phase 0 governance and repository bootstrap](https://github.com/Eddienews/forgeos-lite-trueforge/pull/1): Qodo findings were resolved before the human-approved squash merge.
- [Phase 1 mission contracts, state machine, and security boundaries](https://github.com/Eddienews/forgeos-lite-trueforge/pull/2): the initial Qodo review found four valid continuity issues. Follow-up work binds approval to the target project and base revision, rejects cross-mission evidence, preserves candidate identity from review through application, and binds completion evidence to the applied candidate hash. An additional automated review identified that the verdict digest also needed to be recomputed from canonical test evidence; that binding and its regression coverage were added. Qodo's latest review was clean and all review threads were resolved before the human-approved merge.
- [Phase 2 TrueForge session adapter and isolated execution foundation](https://github.com/Eddienews/forgeos-lite-trueforge/pull/3): the final head passed CI and Qodo review before the human-approved merge.
- [Phase 3 candidate patch generation and approval-required MCP gate](https://github.com/Eddienews/forgeos-lite-trueforge/pull/4): four Qodo security and correctness findings and two additional automated findings were corrected with regression coverage. The final head had a clean Qodo report, successful CI, and zero unresolved review threads before the human-approved merge.

## License and marks

Source code is licensed under the MIT License. See [TRADEMARKS.md](TRADEMARKS.md) for restrictions concerning the ForgeOS name and identity, and [NOTICE.md](NOTICE.md) for project provenance.
