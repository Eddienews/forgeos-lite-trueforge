# Architecture

## System context

TrueForge is the central agent harness. ForgeOS Lite supplies domain contracts, mission coordination, review policy, candidate application, and a terminal demo surface. It does not replace TrueForge model access, sessions, sandboxing, or tool orchestration.

## Workspace

```text
packages/
  contracts/              Public schemas and event contracts
  core/                   Mission state and handoff rules
  runtime-trueforge/      TrueForge session and execution boundary
  candidate-patch/        Deterministic reviewed text changes
  mcp-server/             Approval-gated candidate application
  orchestrator/           Fixed Phase 4 mission vertical slice
  cli/                    Phase 5 presentation and control plane
scripts/
  create-demo-project.mjs Fresh disposable Git fixture generator
docs/                     Architecture, security, and event material
```

Phase 1 implements `packages/contracts` and `packages/core`. Phase 2 implements `packages/runtime-trueforge`. Phase 3 implements `packages/candidate-patch` and `packages/mcp-server`. Phase 4 implements `packages/orchestrator`. Phase 5 adds `packages/cli` and a generated disposable fixture without changing the authority architecture. A web interface, application server, durable persistence, and general autonomous orchestration remain deferred.

## Phase 1 public APIs

`packages/contracts` exposes fail-closed validation and security primitives:

- `validateProjectManifest`, `validateMission`, `validateAgentProfile`, `validateHandoff`, `validateCandidatePatch`, and `validateApprovalRecord` reject unknown fields and invalid values.
- `getAgentProfile` returns one fixed least-privilege profile.
- `approvalMatchesCandidate` and `assertUniqueApprovalId` bind explicit human decisions to one reviewed candidate.
- `assertSafeRelativePath`, `assertCommandToken`, `assertAuthoritySubset`, and `assertNoForbiddenFields` enforce reusable boundaries.
- `canonicalJson`, `sha256`, and `hashesEqual` provide deterministic hashing and constant-time comparison for valid SHA-256 values.

`packages/core` exposes the deterministic mission lifecycle:

- `MISSION_TRANSITIONS` is the explicit transition table.
- `validateMissionTransition` enforces transition and evidence guards.
- `createMissionEvent` and `validateMissionEvent` define the append-only event contract.
- `verifyMissionJournal` verifies sequence continuity, hash chaining, and an optional trusted anchor.
- `replayMissionJournal` derives current state and reports mutable-cache divergence.
- `InMemoryMissionJournal` provides idempotent in-memory append and replay behavior for Phase 1 tests.

These Phase 1 APIs do not execute commands, access the filesystem, connect to TrueForge, or apply patches.

## Phase 2 public APIs

`packages/runtime-trueforge` isolates execution from the mission state machine:

- `createTrueForgeSession` validates the trusted workspace root and Phase 1 project manifest, creates one driver-backed session, and binds the returned workspace below the configured root.
- `TrueForgeRuntimeSession` exposes execution-only state: `ready`, `executing`, `closing`, `failed`, and `closed`. It does not replace or reinterpret mission state.
- `createTrueForgeHttpDriver` uses the loopback TrueForge HTTP API, creates an inline-agent session, discovers its local sandbox through a harmless `pwd` probe, executes one validated command, reads merged TrueForge events within the same deadline, and deletes the session during shutdown.
- The runtime resolves a requested relative working directory to its canonical confined host path before handing it to the driver. Public evidence retains the validated relative path and does not expose the host path.
- `validateRuntimeEvidence` accepts only execution identifiers, mission binding, timestamps, exit status, the structured command, a relative working directory, stdout, stderr, timeout state, and a bounded runtime error.
- `runtimeCommandFingerprint` canonicalizes only the public structured command representation.

The public execution request names one known lifecycle action. The adapter selects the corresponding command from the already validated Phase 1 manifest and derives fixed argv internally. Phase 2 implements the Node.js policies `npm-ci`, `npm-test`, and `npm-run-build` with argument-free mappings. Policy-specific argument allowlists remain deferred so npm configuration cannot redirect execution. The adapter exposes no shell-string, raw-command, arbitrary-module, or unsafe bypass option.

## Phase 3 public APIs

`packages/candidate-patch` provides the narrow patch surface:

- `generateCandidateArtifact` compares two repositories at one exact commit and emits canonical add, modify, and delete operations for ordinary bounded UTF-8 text files.
- `validateCandidateArtifact`, `serializeCandidateArtifact`, and `candidateArtifactSha256` enforce exact fields, sorted unique paths, canonical line endings, and content hashes.
- `createReviewerVerdict` binds the closed reviewer decision to the candidate artifact and canonical test evidence.
- `createReviewedCandidatePatch` uses the existing `CandidatePatch` contract instead of defining a competing candidate type.
- `applyCandidateArtifact` performs two complete preflight passes, applies only the prepared plan, verifies the resulting content and changed-file inventory, preserves the Git head, and returns uncommitted working-tree application evidence. A failed mutation or final verification triggers best-effort rollback.

`packages/mcp-server` provides the irreversible boundary:

- `CandidateApplicationRegistry` seals candidate, artifact, target root, reviewer identity, and human approval outside model-controlled tool arguments. A recorded decision remains pending until the trusted control plane confirms the exact TrueForge session, thread, tool-call, and approval-event binding after TrueForge accepts the allow resume.
- `createHumanApprovalRecord` is a trusted control-plane helper. The MCP tool never creates an approval and does not accept an actor field.
- `startLoopbackMcpServer` exposes only `apply_candidate_patch({ contextId })` over local Streamable HTTP and rejects clients without the connector-only bearer token.
- One approval ID is globally single-use within the registry, and one context consumes approval on its first application attempt whether that attempt succeeds or fails.

## Phase 4 public APIs

`packages/orchestrator` coordinates the existing boundaries without exposing raw command execution:

- `intakeNodeProject` admits one canonical, clean, non-symlink Git root, resolves its exact `HEAD`, and constructs the existing `ProjectManifest` from closed Node.js policy identifiers.
- `createCoordinatorPlan` and `validateCoordinatorPlan` define an exact structured plan containing ordered actor/action steps, declared and validation policy IDs, expected file scope, a file-count limit, public risk notes, and a timestamp. Unknown actions, undeclared policies, authority expansion, private reasoning, raw conversation history, and secrets fail closed.
- `validateBuilderResult` accepts only public Builder identity, workspace identity, base revision, executed policy and evidence identifiers, canonical changed files, explicit completion or failure state, and timestamps.
- `reviewCandidateEvidence` deterministically approves or rejects using the admitted base, expected scope, file-count limit, Builder result, candidate artifact, and exact declared validation evidence. The fixed Reviewer profile has no edit or application authority.
- `createMissionOrchestrator` exposes `runMission`, `resumeMission`, `getMissionSummary`, and `getPendingApplicationContext`. The pending application context is available only after journal replay derives `awaiting_approval`; Phase 4 never creates an `ApprovalRecord` or registers an MCP application context itself.

The controlled Phase 4 Builder pattern uses the already declared `npm-run-build` policy to perform one project-defined deterministic transformation in the isolated clone. The same declared build policy and required `npm-test` policy then run as validation through the existing TrueForge session. This is not a general file-editing language or autonomous coding loop.

The existing hash-chained journal now also accepts a closed set of `mission.milestone` events. Milestones record public plan, workspace, Builder, validation, Reviewer, and candidate progress without changing state. Replay skips milestones when deriving state and continues to validate their exact shape, hash, ordering, actor, timestamp, and forbidden fields.

## Agent profiles

- **Coordinator:** inspects project metadata, validates the manifest, creates the plan, and delegates bounded work.
- **Builder:** prepares a sandbox copy, changes only that copy, and runs approved install, test, and build policies.
- **Reviewer:** evaluates the plan, candidate diff, test evidence, build evidence, and boundary checks. It cannot apply a patch.

## Project lifecycle

```text
draft -> planned -> approved -> building -> reviewing
      -> awaiting_approval -> applying -> completed
```

Any active state may transition to `blocked` or `cancelled` when its explicit guard permits it. State transitions are append-only events with stable identifiers and timestamps.

## Project manifest

`forgeos.project.json` identifies a supported runtime and names predefined lifecycle intents. It must not provide arbitrary shell strings. The server validates the schema, maps each intent to an explicit policy for the selected runtime, and rejects unknown keys or unsupported operations.

Conceptual input:

```json
{
  "name": "sample-project",
  "runtime": "node",
  "install": "npm-ci",
  "test": "npm-test",
  "build": "npm-run-build"
}
```

The values above are policy identifiers, not commands. Phase 1 represents lifecycle commands as either a known policy with structured argument tokens or an explicit `not_applicable` value. Phase 2 maps the three Node.js policies to fixed argv and executes them inside the bound TrueForge workspace. Python and static policy execution remain deferred.

## MCP tool boundary

Read-only tools require no approval:

- `inspect_project`
- `read_project_file`
- `list_project_files`
- `get_project_manifest`
- `get_candidate_diff`
- `get_test_evidence`

Sandbox-only tools operate exclusively on the prepared copy:

- `prepare_sandbox_copy`
- `run_declared_install`
- `run_declared_tests`
- `run_declared_build`
- `create_candidate_patch`

The only implemented real-project write tool is `apply_candidate_patch`. It declares the standard MCP hints `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, and `openWorldHint: false`. The installed TrueForge 0.1.4 `AgentSpec` attaches the configured connector with `require_approval_for_tools: ["apply_candidate_patch"]`. TrueForge then emits `tool.approval_required` and resumes the pending tool call only from a human `user.tool_approval` input containing the exact thread and tool-call identifiers.

TrueForge 0.1.4 accepts configured MCP connectors with `type: "remote"`; its installed schema has no stdio connector variant. Phase 3 therefore uses Streamable HTTP on `127.0.0.1` or `::1` only. A random bearer token is stored in the TrueForge connector header and required by the MCP endpoint, preventing direct unauthenticated loopback calls. The tool receives only a context ID. Candidate data, project root, and `ApprovalRecord` are server-side sealed values and are all recomputed or revalidated immediately before mutation.

The ApprovalRecord contains an `approvalContext` with the exact TrueForge session, thread, tool-call, and `tool.approval_required` event identifiers. Recording the human decision does not arm it. The MCP request waits while the control plane sends `user.tool_approval`; only after TrueForge accepts that resume does an exact context confirmation make the record usable. A failed resume leaves the candidate unapplied.

The target must be a canonical Git repository root with a clean working tree and `HEAD` exactly equal to the candidate base revision. Ignored additions, symlink components, Git internals, binary content, submodules, executable modes, unsupported Git objects, and noncanonical paths fail closed. No commit, push, reset, force operation, tag, branch, or remote mutation is performed.

## Data and persistence

TrueForge owns agent session persistence. ForgeOS Lite stores public mission contracts and emits timeline events through the server. The adapter maps TrueForge session, agent, tool, sandbox, and approval events into stable public contracts without exposing credentials or private chain-of-thought.

Phase 1 implements only in-memory journal construction, verification, and replay. Phase 2 execution evidence and Phase 3 candidate, approval, and application evidence are returned to their callers but are not durably stored. Phase 4 retains its plan, Builder result, validation summaries, candidate, pending application context, and replayed timeline in one in-memory orchestrator process. The Phase 3 live proof uses the same journal to distinguish `awaiting_approval`, `applying`, and `completed`; `applying` is entered from the MCP callback only after TrueForge has resumed the approved tool and the exact human record has been validated. Filesystem journal persistence, the application server, and reconnection behavior remain deferred. A trusted journal anchor is required to detect removal of the final event because a hash chain alone cannot prove that its tail is complete.

## Phase 2 runtime limits

- The HTTP driver is restricted to a loopback standalone TrueForge endpoint.
- TrueForge owns the isolated sandbox path below a trusted application-supplied root; ForgeOS Lite does not mount or mutate a user's external project.
- TrueForge 0.1.4 returns combined command output in its sandbox tool response. The adapter exposes that response as stdout and keeps stderr empty when the upstream response has no separate stderr channel.
- Command dispatch through the HTTP driver is model-mediated. The driver compares the merged TrueForge tool call with the exact derived command, working directory, and environment and reports any substitution as a runtime failure. The local sandbox remains the confinement boundary.
- Startup validation failures trigger a bounded session cleanup attempt. Failed timeout cancellation leaves the session failed, and a transient shutdown failure can be retried without admitting more execution.
- Durable evidence, restart recovery, and non-Node policy execution remain deferred.

## Phase 3 application limits

- The application plan is validated twice before its first write. Writes are sequential because Node.js does not provide a portable multi-file atomic filesystem transaction; any failure triggers reverse-order best-effort rollback and consumes the approval.
- Final file opens reject a symlink at the file itself. A concurrently hostile process that swaps a parent directory after the final preflight remains outside the single-user Phase 3 guarantee; later phases need stronger operating-system isolation or directory-relative file descriptors.
- Approval and application replay protection are in memory for one server process. Restart-safe approval consumption requires durable storage and remains deferred.
- The local proof uses a configured model provider and the authenticated or explicitly identified human operating the TrueForge client. The MCP tool cannot infer, accept, or manufacture human identity.

## Phase 4 orchestration limits

- Intake supports one local Node.js Git project and one active mission at a time.
- The only Builder transformation pattern is an argument-free declared `npm-run-build` policy in a fresh clone. General autonomous editing, Python, static projects, and policy arguments remain deferred.
- The orchestrator fingerprints isolated Git metadata and every file or symlink in the TrueForge workspace outside the clone around Builder work. Empty provider-created runtime directories are normalized out of that comparison, while any outside file content or symlink still fails closed. TrueForge's sandbox remains the operating-system confinement boundary during command execution.
- Candidate content is hashed immediately after Builder completion and recomputed after every declared validation policy. Validation must preserve that exact candidate, isolated Git metadata, and the outside-workspace fingerprint before Reviewer evaluation begins.
- Reviewer validation requires the exact declared policy inventory, one successful runtime record per policy, mission and Builder-workspace binding, unique execution identities, and no reuse of Builder execution evidence. Builder proof must identify exactly the declared transformation policies with one evidence identity per policy.
- The fixed Reviewer evaluates deterministic public evidence and does not run an open-ended model review.
- Mission summaries and pending application contexts are in memory and do not survive process restart.
- Phase 4 stops before human approval. Phase 3 remains the only application path.

## Language boundary

All owned source and generated project artifacts use English. A dependency-free repository check scans supported text formats, while CI and review prevent unchecked content from merging. Vendored dependencies and generated outputs are excluded and remain outside owned-language claims.
