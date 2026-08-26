# Architecture

## System context

TrueForge is the central agent harness. ForgeOS Lite supplies domain contracts, project tools, mission coordination, review policy, and a Mission Control interface. It does not replace TrueForge model access, sessions, sandboxing, tool orchestration, or persistence.

## Workspace

```text
apps/
  web/                    Mission Control interface
  server/                 Local API and event stream
packages/
  contracts/              Public schemas and event contracts
  core/                   Mission state and handoff rules
  trueforge-adapter/      TrueForge integration boundary
  project-mcp/            Project inspection and patch tools
examples/
  sample-project/         Reproducible demonstration project
docs/                     Architecture, security, and event material
```

Phase 1 implements `packages/contracts` and `packages/core`. The remaining workspace directories are deferred to later reviewed pull requests.

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

These APIs do not execute commands, access the filesystem, connect to TrueForge, or apply patches.

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

The values above are policy identifiers, not commands. Phase 1 represents lifecycle commands as either a known policy with structured argument tokens or an explicit `not_applicable` value. Runtime policy execution is deferred to Phase 2.

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

The only real-project write tool is `apply_candidate_patch`. Its MCP annotations and TrueForge configuration must require approval. Before applying, it recomputes the patch hash, revalidates paths and symlinks, verifies review evidence, checks replay state, and displays affected files and test results.

## Data and persistence

TrueForge owns agent session persistence. ForgeOS Lite stores public mission contracts and emits timeline events through the server. The adapter maps TrueForge session, agent, tool, sandbox, and approval events into stable public contracts without exposing credentials or private chain-of-thought.

Phase 1 implements only in-memory journal construction, verification, and replay. Filesystem persistence, the server, the TrueForge adapter, and reconnection behavior remain deferred. A trusted journal anchor is required to detect removal of the final event because a hash chain alone cannot prove that its tail is complete.

## Language boundary

All owned source and generated project artifacts use English. A dependency-free repository check scans supported text formats, while CI and review prevent unchecked content from merging. Vendored dependencies and generated outputs are excluded and remain outside owned-language claims.
