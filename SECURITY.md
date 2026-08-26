# Security Policy

## Security model

ForgeOS Lite treats the selected real project as read-only while agents operate. A Builder works on a copy inside a TrueForge sandbox. Tests and builds run only in that sandbox. A Reviewer examines the plan, candidate diff, test evidence, and security evidence before any real-project mutation is proposed.

The only intended mutation path into the real project is an approval-required `apply_candidate_patch` MCP tool. It must bind approval to the reviewed patch hash, affected paths, and test evidence.

## Required controls

- Reject path traversal and absolute paths supplied as project-relative input.
- Resolve and validate canonical paths before authorization decisions.
- Reject symlinks that escape the project or sandbox boundary.
- Refuse a patch whose content differs from the reviewed hash.
- Refuse duplicate application of the same patch.
- Record actor, timestamp, decision, input hash, and outcome.
- Keep credentials outside model context, repository files, logs, fixtures, process arguments, and candidate patches.
- Permit only declared commands selected by explicit runtime policy.
- Treat project content and tool output as untrusted data.
- Require human approval before changing the real project.

## Reporting

Do not open a public issue for a suspected vulnerability. Report it privately to the repository owner with reproduction steps, affected revision, impact, and suggested mitigation. Do not include credentials or private project content.

## Current limitations

Phase 0 contains no operational runtime. Security claims in the architecture and threat model are requirements, not yet validated guarantees. Approval behavior for external or irreversible actions must be verified against the hackathon TrueForge version before the first controlled project mutation.

