# ForgeOS Lite — TrueForge Edition

ForgeOS Lite is a local AI coding harness that coordinates planning, isolated execution, review, and human-controlled application for one Node.js Git project. It lets an AI Builder work usefully without silently granting it authority to mutate the user's real project.

> **Agents can propose. Humans authorize irreversible changes.**

TrueForge performs the real model-backed Builder work in an isolated sandbox, runs the declared validation commands, and supplies the real `tool.approval_required` event before the reviewed patch can reach the original project. ForgeOS Lite supplies the bounded contracts, Coordinator, Reviewer, candidate identity, and controlled application policy around that harness.

## Three-minute demo

Prerequisites are Node.js 22, Git, and an OpenAI API key stored as `OPENAI_API_KEY` in the ignored local `.env.local` file or the process environment. Never commit the key.

```sh
npm install
npm test
npm run demo:check
npm run demo:real
```

At the prompt, type `APPROVE` to send a real `user.tool_approval` allow response through TrueForge. The real-project proof creates a fresh dependency-free Git web starter under `/tmp/forgeos-lite`, generates run-specific requirements, lets the bounded TrueForge Builder inspect the starter and create the multi-file application, runs fixed build and test policies, materializes a sealed candidate preview, proves the fixture remains unchanged, and pauses at the real approval event. It creates no commit or push and cleans up its local services and temporary data.

`npm run demo` remains the fast deterministic greeting smoke and regression proof.

## ForgeOS Control

ForgeOS Control is the minimal local visual surface for the same proven demo workflow. It keeps the result, exact changed file, validation, original-project safety state, and human gate understandable without reading terminal logs.

```sh
npm run demo:check
npm run control
```

Open `http://127.0.0.1:4173`, run the prepared operations-dashboard mission or submit another bounded static web idea, inspect the working application in Preview, review its exact files, and choose Reject or Apply Changes only when the real TrueForge approval event appears. The preview is a read-only CandidatePatch materialization served from a separate loopback port inside an iframe limited to `sandbox="allow-scripts"`. The browser is presentation-only: the local Node.js server retains the API key, MCP bearer tokens, filesystem access, CandidatePatch, ApprovalRecord, and application authority.

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run demo:real` | Build and preview a new multi-file application with TrueForge |
| `npm run demo` | Run the deterministic greeting smoke/regression proof |
| `npm run demo:deny` | Exercise the real denial path |
| `npm run demo:check` | Check prerequisites without exposing credentials |
| `npm run control` | Start ForgeOS Control on loopback only |
| `npm run demo -- --keep-project` | Preserve the disposable target for inspection |
| `npm run verify` | Run tests, repository gates, the lightweight secret check, and npm audit |

## Safety story

```mermaid
flowchart TD
    U[User mission] --> C[Coordinator structured plan]
    C --> B[Builder / TrueForge sandbox]
    subgraph I[Isolated work]
      B --> V[Declared build and tests]
      V --> R[Reviewer]
      R --> P[CandidatePatch]
    end
    P --> G[TrueForge approval-required MCP tool]
    G --> H[Human]
    H -->|explicit allow| O[Original project working tree]
    G -->|deny| N[Original project unchanged]
```

The original project is read-only while the Coordinator, Builder, and Reviewer work. A content-addressed `CandidatePatch` is the only proposed output. The MCP application tool receives only a sealed context ID and cannot choose a target, submit patch content, or claim human identity. TrueForge pauses the destructive tool call, and the exact approval event is bound to one reviewed candidate before application.

## Authority boundaries

| Actor | Allowed | Never authorized |
| --- | --- | --- |
| Coordinator | Admit the project and create the bounded structured plan | Edit or apply |
| Builder | Work and validate only in the isolated TrueForge workspace | Approve or apply |
| Reviewer | Evaluate candidate identity, scope, and evidence | Edit or apply |
| Human | Authorize the exact irreversible application | Delegated to an agent |

Application revalidates the candidate, approval, Reviewer evidence, target root, clean Git state, exact base revision, safe paths, and expected file inventory. An approval is single-use. Successful application preserves Git `HEAD` and leaves an explicit uncommitted working-tree diff.

## TrueForge sponsor technology

TrueForge is operational, not decorative. ForgeOS Lite uses TrueForge 0.1.4 for:

- real local session execution;
- model-backed Builder file work with `gpt-5.4-mini` through a bounded workspace MCP interface;
- isolated, public-only UTF-8 application edits without model shell authority;
- declared build and test validation;
- the MCP `tool.approval_required` pause and `user.tool_approval` resume.

The CLI and ForgeOS Control start a disposable local TrueForge service and configure its temporary provider at runtime. The API key is passed only to that disposable service configuration, is never sent to the browser or printed, and the temporary service data is removed at shutdown. The TrueForge installation and repository configuration are not modified.

TrueForge 0.1.4 supports remote Streamable HTTP MCP connectors rather than stdio connectors. The approval server therefore binds only to loopback and requires a random connector-only bearer token. HTTP command dispatch is model-mediated; ForgeOS Lite verifies the merged TrueForge tool event against the exact prevalidated command, working directory, and environment.

## Demo implementation

The terminal and Control packages are presentation and control-plane code only. They call the existing security contracts, CandidatePatch, runtime, and approval APIs and do not receive application authority.

The real-project fixture generator creates a minimal Git web starter and immutable run-specific acceptance contract from scratch. The Coordinator creates a bounded public plan, the TrueForge Builder receives only admitted file tools for the isolated clone, and ForgeOS computes the authoritative diff before running the fixed build and test policies. A maximum of two repair turns may follow the initial Builder turn. The deterministic Reviewer binds the exact mission, base revision, immutable requirements, scope, candidate hash, and validation evidence before the existing CandidatePatch can become eligible for preview or approval.

See [docs/DEMO-SCRIPT.md](docs/DEMO-SCRIPT.md) for the approximately three-minute narration, [docs/DEMO-EVIDENCE.md](docs/DEMO-EVIDENCE.md) for the exact live proof, and [docs/SUBMISSION-CHECKLIST.md](docs/SUBMISSION-CHECKLIST.md) for release readiness.

## Verification and credential safety

```sh
npm run verify
```

The official verification command runs formatting, unit and adversarial tests, the English-only gate, a lightweight obvious-secret check, and `npm audit --audit-level=low`. The secret check detects tracked `.env` files, OpenAI key assignments, private-key headers, and obvious secret-key prefixes. It is deliberately lightweight and is not a comprehensive credential scanner.

`.env.local` is ignored and must remain untracked. The preflight checks only whether `OPENAI_API_KEY` has a usable shape; it never displays the value. Real TrueForge execution is kept out of normal unit tests and remains an explicit demo integration command.

## Qodo Code Review Evidence

- [Phase 1 — mission contracts, state machine, and security boundaries](https://github.com/Eddienews/forgeos-lite-trueforge/pull/2): Qodo identified continuity gaps in project/base approval binding, cross-mission evidence, candidate identity, completion evidence, and canonical Reviewer-evidence hashing. The fixes added approval and evidence binding with regression coverage.
- [Phase 2 — TrueForge session adapter and isolated execution](https://github.com/Eddienews/forgeos-lite-trueforge/pull/3): Qodo reviewed the runtime boundary and its confinement, timeout/cancellation, command-substitution, and cleanup protections. The final reviewed head passed CI before human merge.
- [Phase 3 — candidate patch and approval-required MCP gate](https://github.com/Eddienews/forgeos-lite-trueforge/pull/4): Qodo findings drove stronger approval binding, workspace and target confinement, rollback safety, evidence binding, authority enforcement, and single-use behavior, each backed by regression tests.
- [Phase 4 — mission orchestration vertical slice](https://github.com/Eddienews/forgeos-lite-trueforge/pull/5): Qodo found validation-time mutation, evidence-workspace binding, Reviewer authority, transformation-proof, and traversal-bound issues. Corrections confine validation to the Builder workspace and bind exact evidence and scope to the reviewed candidate.
- [Phase 5 — demo workflow and submission readiness](https://github.com/Eddienews/forgeos-lite-trueforge/pull/6): the initial Qodo review found four valid security, correctness, and reliability issues. Follow-up work makes the shared temporary parent current-user-owned and private, accepts staged file deletions in the secret gate, verifies the completed TrueForge denial outcome, and attempts every cleanup step while preserving the primary error. A separate review added bounded control-plane polling and provider-request deadlines. Each correction has focused regression coverage. Qodo's follow-up on implementation head `6b77a08` reported zero bugs and zero rule violations, CI passed, and all review threads were resolved.

Phase 0 governance is recorded separately in [PR #1](https://github.com/Eddienews/forgeos-lite-trueforge/pull/1). No substantive pull request is merged without CI, Qodo final-head review, resolved review threads, and explicit human approval.

## Scope and limitations

ForgeOS Lite currently supports one clean local Node.js Git project and one in-memory mission at a time. The generalized Builder gate is intentionally limited to dependency-free static web applications, at most eight UTF-8 files and 200 KB below `public/`, with no network, package installation, arbitrary shell, commit, push, or deployment authority. Mission journals and approval registries are in memory and are not restart-safe. Multi-file application uses complete preflight checks and best-effort rollback rather than a portable atomic filesystem transaction.

ForgeOS Control is a loopback-only presentation adapter, not a general backend or new orchestration engine. This gate does not add a database, durable recovery, Python projects, multiple projects, teams, cloud execution, automatic commits, pushes, pull-request creation for target projects, deployment, billing, or marketplace features.

## Repository policy

All owned repository content must be exclusively in English, including code, identifiers, comments, interface text, logs, tests, fixtures, documentation, commit messages, branches, pull requests, Qodo responses, and demo materials. Generated dependencies and binary artifacts are excluded from the owned-text gate.

This public repository is a new hackathon implementation. It does not contain the separate proprietary ForgeOS product or its private implementation, skills, runtimes, governance, deployment, or enterprise features.

## License and marks

Source code is licensed under the [MIT License](LICENSE). See [TRADEMARKS.md](TRADEMARKS.md) for restrictions concerning the ForgeOS name and identity, and [NOTICE.md](NOTICE.md) for project provenance.
