# Threat Model

## Protected assets

- Integrity and confidentiality of the selected real project.
- Integrity of the reviewed candidate patch and its evidence.
- TrueForge, provider, and local integration credentials.
- Session and approval records.
- Host files outside the approved project and sandbox.

## Trust boundaries

1. User input, project files, dependency output, and model output are untrusted.
2. TrueForge controls agent sessions, tool calls, sandbox execution, approval state, and persistence.
3. The project MCP server mediates all project access.
4. The sandbox copy is writable; the real project is read-only except during an approved patch application.
5. Provider credentials never enter tool arguments, model-visible project data, logs, or repository state.

## Primary threats and controls

| Threat | Required control | Evidence |
| --- | --- | --- |
| Prompt injection in project content | Mark project content as untrusted and keep policy outside retrieved content | Adversarial fixture and event trace |
| Path traversal | Canonicalize paths and require containment | Unit and integration tests |
| Symlink escape | Resolve every path component and reject escape | Boundary test |
| Arbitrary manifest commands | Exact schema, runtime policy allowlist, and structured token validation | Phase 1 adversarial contract tests |
| Patch substitution after review | Content-addressed patch and approval binding | Hash mismatch test |
| Authority expansion | Known capability allowlist plus subset validation | Profile and handoff escalation tests |
| Journal tampering | Canonical JSON, SHA-256 chain, continuous sequence, and trusted anchor | Deletion, insertion, reordering, and mutation tests |
| Private reasoning persistence | Recursive forbidden-field validation | Nested-field adversarial tests |
| Duplicate or replayed application | Sealed context and single-use in-process approval record | Replay test |
| Unauthorized real-project write | Read-only access plus one approval-required tool | Deny and allow traces |
| Credential leakage | Secret isolation and redacted structured logs | Repository and log scan |
| Tool repetition after reconnect | Durable operation identity and terminal event state | Deferred beyond Phase 3 |
| Sandbox escape | Canonical workspace checks and host marker test | Confinement probe |

## Approval semantics

Internal reversible writes within the approved sandbox copy do not require repeated approval. Applying a candidate patch to the real project is an external, durable mutation and always requires explicit approval. Approval binds to one patch hash and one target project state. Any change invalidates approval.

## Implemented Phase 1 controls

- Exact-key contract validation rejects unknown schema fields.
- Runtime commands are policy identifiers with structured tokens; free shell strings and shell metacharacters are rejected.
- Environment values are absent from manifests, while key names are restricted by runtime and secret-bearing names are denied.
- Coordinator, Builder, and Reviewer profiles are fixed and cannot expand their own authority.
- Paths must be normalized relative POSIX paths without traversal, backslashes, empty segments, or null bytes.
- Candidate review and human approval are bound to complete SHA-256 values.
- Mission events use deterministic canonical JSON and a continuous SHA-256 hash chain.
- Replay derives current state and explicitly reports cache divergence.

## Implemented Phase 2 controls

- The TrueForge adapter accepts only exact-key lifecycle execution requests and rejects unknown actions or fields.
- The adapter selects one command already declared in a validated Phase 1 manifest and derives fixed Node.js argv internally. It exposes no public shell-string API.
- The configured workspace root must be an absolute, canonical, non-root host directory and cannot be a symlink.
- The TrueForge-created session workspace must equal or descend from that configured root.
- Working directories remain normalized Phase 1 relative paths. Every existing component is checked, symlinks are rejected, and the canonical result must remain inside the bound workspace.
- Execution environment keys must be declared by the project manifest; malformed, undeclared, and secret-bearing keys fail closed. Environment values are not included in public evidence.
- Runtime evidence uses an exact public shape and recursively rejects private reasoning, conversation history, secrets, and unknown fields.
- Driver startup cleanup, execution, deadline propagation, failed timeout cancellation, retryable shutdown, and execution-after-close behavior have separate tests.
- The TrueForge HTTP driver accepts only a loopback endpoint and checks the merged sandbox tool call against the exact derived command, working directory, and environment.
- The runtime passes the canonical confined working-directory path to the driver while retaining only its relative form in public evidence.
- Node.js policy arguments fail closed in Phase 2, preventing npm options such as external prefixes, configuration files, or script-shell overrides from redirecting execution.
- A live TrueForge 0.1.4 proof runs `npm test` in a disposable local sandbox, creates one fixture result file, captures exit and output evidence, verifies containment, and closes the session.

## Implemented Phase 3 controls

- Candidate generation reads a clean original repository at one complete commit and compares it with a separate Builder repository at that same commit. The original remains unchanged until approved application.
- Candidate operations are exact-key, sorted, unique, content-addressed add, modify, or delete records for bounded canonical UTF-8 text. Traversal, absolute paths, null bytes, Git internals, shell-like metadata, binary data, symlinks, submodules, executable modes, and unsupported Git objects fail closed.
- The reviewer verdict identifies the Reviewer role, uses a closed approved/rejected decision, and binds both the candidate artifact hash and canonical test-evidence hash. Unknown, reasoning, conversation, and secret fields are rejected.
- The human `ApprovalRecord` binds mission, candidate, project, base revision, candidate hash, complete reviewer-verdict hash, actor identity, decision, time, and the exact TrueForge session, thread, tool-call, and approval-event identifiers. The MCP tool cannot create the record or accept actor-controlled arguments.
- The MCP server binds only to loopback, requires a connector-only bearer token, and exposes one destructive non-idempotent tool with a strict `{ contextId }` input. Candidate, root, artifact, and approval values remain sealed in the server registry.
- Recording an ApprovalRecord leaves it pending. The tool waits without mutating until the trusted control plane confirms the exact gate context after TrueForge accepts `user.tool_approval`; a failed resume never arms the record.
- The exact TrueForge 0.1.4 configuration names `apply_candidate_patch` in `require_approval_for_tools`. The positive live proof captures `tool.approval_required`, verifies no pre-approval write, resumes with `user.tool_approval`, and observes one successful application.
- Two complete preflight passes verify the candidate, reviewer, approval, hashes, configured canonical root, exact Git head, clean tree, safe paths, target content, and full operation plan. A base change between checks fails closed.
- Application preserves the Git head, verifies every result and the complete changed-file inventory, returns structured uncommitted working-tree evidence, and creates no commit or remote mutation.
- Approval is consumed on the first attempt. Replays, cross-candidate use, candidate or reviewer mutation, cross-project or cross-mission approval, nonhuman actors, rejected decisions, dirty targets, and stale revisions are covered by adversarial tests.
- The negative live proof passes a second candidate through its own real TrueForge approval event, advances the disposable target base, and observes rejection before the reviewed file changes.

## Deferred security controls

- Node.js install, test, and build policies are implemented; Python and static policy execution remain deferred.
- The journal is in memory only; durable storage and trusted anchor persistence are not implemented.
- Approval consumption and application context are in memory only; restart-safe replay protection is not implemented.
- Multi-file application uses full preflight and best-effort rollback but is not a portable atomic filesystem transaction. A hostile concurrent parent-directory swap after final preflight requires a stronger later isolation boundary.
- TrueForge 0.1.4 exposes combined sandbox command output rather than separate stdout and stderr fields. ForgeOS Lite preserves an empty stderr channel when no separate upstream value exists.
- HTTP command dispatch is model-mediated. Substitution is detected from merged events and reported, while TrueForge's local sandbox remains the pre-execution host-confinement control.
- No production security guarantee is made by the Phase 3 hackathon boundary.

## Language and supply-chain content

Owned files must remain English-only. Vendored dependencies and generated artifacts are excluded from the automated language scan because they are not owned content. Any unavoidable third-party non-English material must be reported separately and must not be copied into owned source, documentation, fixtures, interface text, or sample data.
