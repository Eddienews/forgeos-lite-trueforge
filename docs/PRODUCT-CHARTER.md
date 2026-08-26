# Product Charter

## Mission

ForgeOS Lite helps one local user produce a reviewed candidate patch for one real Git project while keeping the original project read-only until explicit human approval.

## User problem

Developers need useful agent automation without granting an autonomous model unrestricted access to their working tree. Existing workflows often blur the boundary between analysis, sandbox work, review, and irreversible mutation.

## Solution

ForgeOS Lite uses TrueForge as the visible central harness. A Coordinator plans work, a Builder operates on a sandbox copy, and a Reviewer evaluates the plan, diff, tests, build evidence, and boundary checks. The system produces a content-addressed candidate patch. A separate approval-required MCP tool may apply exactly that reviewed patch to the real project.

## Initial scope

- One local user.
- One Git project at a time.
- One Node.js application manifest with fixed build and test policies.
- Coordinator, Builder, and Reviewer profiles.
- Public mission milestones with state, agent, activity, and next action.
- In-memory mission and approval state for one process lifetime.
- Candidate patch generation and approved application.

## Non-goals

- Multi-tenant operation.
- Cloud deployment or remote project mutation.
- Arbitrary command execution from project manifests.
- Package publication, deployment, credential management, or production operations.
- Compatibility with proprietary ForgeOS components.
- Reimplementation of TrueForge model, session, sandbox, or persistence capabilities.

## Success criteria

1. TrueForge visibly manages the model, session, tools, and sandbox.
2. The real project receives no writes before one explicit approval.
3. Declared tests and builds run in the sandbox copy.
4. The Reviewer sees the exact patch and evidence later presented for approval.
5. A changed or replayed patch is rejected.
6. The terminal demo visibly separates candidate preparation, human approval, and application.
7. The public repository is reproducible and records Qodo review evidence for every substantive pull request.

## Repository language

All owned content and product-generated artifacts default to English. The repository accepts no Portuguese translations, bilingual content, comments, examples, interface strings, logs, fixtures, branch names, commit messages, pull-request text, Qodo responses, demo materials, or sample data.
