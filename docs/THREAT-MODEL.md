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
| Duplicate or replayed application | Idempotency key and durable application record | Replay test |
| Unauthorized real-project write | Read-only access plus one approval-required tool | Deny and allow traces |
| Credential leakage | Secret isolation and redacted structured logs | Repository and log scan |
| Tool repetition after reconnect | Persistent operation identity and terminal event state | Restart test |
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

## Deferred security controls

- The hackathon TrueForge version has not yet demonstrated the approval-required MCP path for this project.
- Sandbox confinement and persistence have not yet been tested with ForgeOS Lite code.
- Runtime policies are validated but not executed.
- Symlink-aware filesystem containment and durable replay protection require later implementation.
- The journal is in memory only; durable storage and trusted anchor persistence are not implemented.
- No production security guarantee is made by the Phase 1 foundation.

## Language and supply-chain content

Owned files must remain English-only. Vendored dependencies and generated artifacts are excluded from the automated language scan because they are not owned content. Any unavoidable third-party non-English material must be reported separately and must not be copied into owned source, documentation, fixtures, interface text, or sample data.
