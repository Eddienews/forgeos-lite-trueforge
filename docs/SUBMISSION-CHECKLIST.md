# Submission Checklist

Local evidence may be checked only after it has been verified. Video, platform, deadline, and final submission actions remain unchecked until a human completes or confirms them.

## Repository and documentation

- [x] Public repository is available.
- [x] MIT license is present.
- [x] README explains the product, safety model, quickstart, TrueForge role, and limitations.
- [x] TrueForge use is documented as real session, sandbox, validation, and approval infrastructure.
- [x] Qodo evidence for substantive Phase 1 through Phase 5 pull requests is documented.
- [x] Three-minute demo narration is present.
- [x] No known credentials are tracked.
- [ ] Public repository links have been manually opened and verified before submission.

## Demo and verification

- [x] `npm run verify` passes on the reviewed Phase 5 implementation commit.
- [x] `npm run demo:check` passes on the proof machine.
- [x] Primary `npm run demo` allow flow succeeds from a clean checkout.
- [x] Real denial proof succeeds.
- [x] Exact demo runtime, TrueForge version, and model are recorded in repository evidence.
- [ ] Demo video is recorded.
- [ ] Final video is below the submission platform's expected duration.
- [ ] Video audio and terminal text are clear at normal playback size.

## Review gate

- [ ] CI is green on the final Phase 5 head.
- [ ] Qodo reviewed the final Phase 5 head.
- [ ] Every valid Qodo finding has regression coverage or a documented resolution.
- [ ] Unresolved review threads are zero.
- [ ] Pull request remains open for explicit human merge approval.
- [ ] Latest `main` tests pass after the human-approved merge.

## Submission

- [ ] Hackathon deadline and timezone are confirmed from the current official page.
- [ ] Submission URL is ready.
- [ ] Repository URL is included in the submission.
- [ ] Demo video URL is included in the submission.
- [ ] Sponsor technology usage is described accurately.
- [ ] Final submission has been reviewed and submitted by a human.
