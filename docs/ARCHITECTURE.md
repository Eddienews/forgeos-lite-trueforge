# Architecture

## System context

TrueForge is the central agent harness. ForgeOS Lite supplies domain contracts, project tools, mission coordination, review policy, and a Mission Control interface. It does not replace TrueForge model access, sessions, sandboxing, tool orchestration, or persistence.

## Planned workspace

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

Only Phase 0 documents and quality configuration exist initially. The planned workspace directories will be created by reviewed substantive pull requests.

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

The values above are policy identifiers, not commands. The runtime policy owns the exact executable and arguments.

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

## Language boundary

All owned source and generated project artifacts use English. A dependency-free repository check scans supported text formats, while CI and review prevent unchecked content from merging. Vendored dependencies and generated outputs are excluded and remain outside owned-language claims.

