# Hackathon Plan

## Objective

Deliver a reproducible open-source demonstration in which TrueForge coordinates separate agent profiles, runs changes and tests in a sandbox copy, pauses before applying a reviewed candidate patch to a real project, and preserves the session after reconnection.

## Deadline

August 30, 2026 at 20:00 Europe/London time.

## Delivery principles

- TrueForge remains central and visible in the demonstration.
- Every substantive change is developed on a branch and reviewed by Qodo in a public pull request before merge.
- Existing proprietary ForgeOS materials are not copied or adapted.
- The implementation stays minimal, local, and reproducible.
- All repository and product content is exclusively English.
- No substantive implementation begins until Phase 0 is approved.

## Planned pull requests

### PR 1: Mission contracts, state machine, and security boundaries

Branch: `feat/mission-contract-foundation`

- Public schemas for missions, events, evidence, manifests, and candidate patches.
- Guarded state transitions.
- Runtime policy identifiers instead of arbitrary commands.
- Contract and security-boundary tests.

Phase 1 implementation status on this branch:

- Dependency-free ESM packages provide exact-key runtime validators and documented public APIs.
- Fixed profiles and authority subset checks enforce least privilege.
- An in-memory event journal provides canonical SHA-256 chaining, idempotent replay, trusted anchors, and cache-divergence reporting.
- TrueForge integration, MCP tools, filesystem operations, command execution, durable persistence, server, and UI remain deferred.

### PR 2: TrueForge session adapter and isolated execution foundation

Branch: `feat/trueforge-session-foundation`

- Dedicated TrueForge adapter and replaceable driver boundary.
- Controlled execution-only session lifecycle.
- Node.js structured policy execution inside one confined workspace.
- Normalized execution, failure, and timeout evidence.
- Unit and adversarial tests with deterministic fake runtimes.
- One real TrueForge 0.1.4 sandbox execution in a disposable fixture.

Phase 2 explicitly defers MCP tools, approval-required patch application, candidate generation, durable mission-journal storage, the Reviewer runtime, the backend server, the interface, and deployment.

### PR 3: Reviewed candidate patch approval

Branch: `feat/candidate-patch-approval-gate`

- Deterministic ordinary-text candidate creation and hash binding.
- Reviewer verdict and explicit human `ApprovalRecord` binding.
- Approval-required local `apply_candidate_patch` MCP tool using the installed TrueForge 0.1.4 mechanism.
- Canonical path, symlink, replay, substitution, dirty-tree, and stale-base defenses.
- Positive TrueForge approval evidence and negative live base-drift evidence.

Phase 3 intentionally keeps approval consumption in memory and does not claim restart recovery. Full Coordinator, Builder, and Reviewer runtimes, durable storage, the backend, the interface, automated commits, remote Git mutation, cloud, deployment, teams, billing, marketplace work, and ForgeOS Browser remain deferred.

### PR 4: Mission Control, example, and submission evidence

Branch: `feat/mission-control-demo`

- Timeline interface and reconnection behavior.
- Reproducible sample project.
- End-to-end tests, security evidence, setup documentation, screenshots, and demo script.
- Final Qodo evidence and approximately three-minute demonstration.

## Milestones and budget

| Milestone | Target effort | Exit condition |
| --- | ---: | --- |
| Phase 0 governance | 2 hours | Clean repository, policy documents, language gate, local Git |
| Contracts and state | 6 hours | PR 1 reviewed and tests pass |
| TrueForge and sandbox tools | 10 hours | PR 2 reviewed; real sandbox execution visible |
| Patch approval boundary | 8 hours | PR 3 reviewed; deny and allow behavior proven |
| Interface and persistence | 6 hours | Timeline survives refresh and reconnect |
| Submission evidence | 6 hours | Reproducible setup, Qodo trail, video, and write-up |
| Contingency | 4 hours | Reserved for TrueForge version or macOS constraints |

## Decision gates

### Gate A: Foundation

Proceed only if contracts reject arbitrary commands and state transitions are deterministic.

### Gate B: Harness

Proceed only if TrueForge visibly calls a real MCP tool and executes the Builder inside the local sandbox.

### Gate C: Approval

Proceed only if denial causes no real-project write, approval applies exactly one reviewed patch, and replay is rejected.

### Gate D: Submission

Proceed only if refresh and reconnection preserve state, the demo completes in three minutes, all tests pass, and representative Qodo-reviewed pull requests are public.

## Qodo workflow

After explicit authorization to create a remote repository:

1. Create the public GitHub repository without pushing proprietary history or files.
2. Sign in at `https://app.qodo.ai/signin` with the GitHub account that owns the repository.
3. In Qodo onboarding, link the Git account and choose the option to install the Qodo application.
4. On the GitHub installation screen, choose `Only select repositories` and select only the public hackathon repository.
5. Review the requested GitHub permissions before approving the installation.
6. Push a substantive branch and open its pull request. Qodo should start the review automatically on the linked repository.
7. Address each valid finding or document a specific reason for dismissal, then request or wait for follow-up review before merge.
8. Record the pull-request link, material findings, decisions, corrections, and follow-up result in the README section named `Qodo Code Review Evidence`.

Do not install Qodo locally or transmit repository data before explicit authorization at the time of connection.
