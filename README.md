# ForgeOS Lite — TrueForge Hackathon Edition

ForgeOS Lite is an open-source, local-first harness for controlled changes to one Git project at a time. TrueForge is the central runtime for model access, sessions, tools, sandbox execution, and persistence.

> This repository contains the open-source ForgeOS Lite — TrueForge Hackathon Edition. It is a new implementation built during the Agent Harness Hackathon. It does not contain the proprietary ForgeOS product or its private orchestration, skills, runtimes, governance, deployment, or enterprise features.

## Phase 3 status

Phases 0 through 2 are merged. Phase 3 adds deterministic ordinary-text candidate generation, a reviewer-verdict identity, human `ApprovalRecord` binding, and a local approval-gated MCP application tool. Candidate generation compares a clean original Git revision with a separate Builder working copy without changing the original. Application supports only text-file addition, modification, and deletion against a clean working tree at the exact reviewed revision; it creates no commit and performs no remote Git operation.

The installed TrueForge 0.1.4 connector schema supports remote Streamable HTTP MCP servers, not stdio connectors. The Phase 3 server therefore binds only to loopback and requires a control-plane bearer token configured as a TrueForge connector header. Its `apply_candidate_patch` tool declares `readOnlyHint: false` and `destructiveHint: true`, while the TrueForge agent specification names that exact tool in `require_approval_for_tools`. TrueForge pauses with `tool.approval_required`; a human resumes the pending tool call with a `user.tool_approval` input. The ApprovalRecord binds the session, thread, tool-call, and approval-event identifiers and remains unusable until the control plane confirms that TrueForge accepted the exact allow resume. The MCP arguments contain only a sealed server-side context identifier and cannot select a target root, submit raw patch content, or claim an approval actor.

The live proof creates disposable original and Builder repositories, reaches `awaiting_approval`, observes the real TrueForge approval event, confirms the original is unchanged while paused, records the pending human decision, resumes with the supported approval input, confirms the accepted exact gate context, applies exactly one candidate, verifies the unchanged Git head, and reaches `completed`. A second candidate passes through another real TrueForge approval event and is then rejected after intentional base-revision drift. Run it against a configured local TrueForge 0.1.4 server with:

```sh
TRUEFORGE_BASE_URL=http://localhost:8790 \
TRUEFORGE_HUMAN_ACTOR_ID=your-stable-human-id \
npm run test:integration:approval
```

Phase 3 still defers the full Coordinator and Builder orchestration, an autonomous Reviewer runtime, durable journal persistence, general Python and static-project command support, the backend/API server, UI, user-project connection workflow, automatic Git commits, remote Git mutation, cloud execution, deployment, authentication, teams, billing, marketplace features, and ForgeOS Browser.

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

The protected integration branch is `main`. Phase 3 is developed on `feat/candidate-patch-approval-gate`, with the pull request title:

> Candidate patch generation and approval-required MCP gate

No substantive code should be merged without Qodo review evidence.

## Qodo Code Review Evidence

- [Phase 0 governance and repository bootstrap](https://github.com/Eddienews/forgeos-lite-trueforge/pull/1): Qodo findings were resolved before the human-approved squash merge.
- [Phase 1 mission contracts, state machine, and security boundaries](https://github.com/Eddienews/forgeos-lite-trueforge/pull/2): the initial Qodo review found four valid continuity issues. Follow-up work binds approval to the target project and base revision, rejects cross-mission evidence, preserves candidate identity from review through application, and binds completion evidence to the applied candidate hash. An additional automated review identified that the verdict digest also needed to be recomputed from canonical test evidence; that binding and its regression coverage were added. Qodo's latest review was clean and all review threads were resolved before the human-approved merge.
- [Phase 2 TrueForge session adapter and isolated execution foundation](https://github.com/Eddienews/forgeos-lite-trueforge/pull/3): the final head passed CI and Qodo review before the human-approved merge.

## License and marks

Source code is licensed under the MIT License. See [TRADEMARKS.md](TRADEMARKS.md) for restrictions concerning the ForgeOS name and identity, and [NOTICE.md](NOTICE.md) for project provenance.
