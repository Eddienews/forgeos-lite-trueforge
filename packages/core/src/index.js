import {
  MISSION_STATES,
  approvalMatchesCandidate,
  assertNoForbiddenFields,
  assertSha256,
  canonicalJson,
  hashesEqual,
  sha256,
  validateApplicationEvidence,
  validateApprovalRecord,
  validateCandidatePatch
} from "../../contracts/src/index.js";

const ZERO_HASH = "0".repeat(64);
const stateSet = new Set(MISSION_STATES);
const actorSet = new Set(["human", "system", "coordinator", "builder", "reviewer"]);
const terminalStates = new Set(["completed", "cancelled"]);

export const MISSION_TRANSITIONS = Object.freeze({
  draft: Object.freeze(["planned", "blocked", "cancelled"]),
  planned: Object.freeze(["approved", "blocked", "cancelled"]),
  approved: Object.freeze(["building", "blocked", "cancelled"]),
  building: Object.freeze(["reviewing", "blocked", "cancelled"]),
  reviewing: Object.freeze(["building", "awaiting_approval", "blocked", "cancelled"]),
  awaiting_approval: Object.freeze(["applying", "blocked", "cancelled"]),
  applying: Object.freeze(["completed", "blocked"]),
  completed: Object.freeze([]),
  blocked: Object.freeze(["cancelled"]),
  cancelled: Object.freeze([])
});

function fail(message) {
  throw new TypeError(message);
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
}

function assertExactKeys(value, required, optional, label) {
  assertPlainObject(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(`${label} contains unknown field: ${key}.`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail(`${label} is missing required field: ${key}.`);
    }
  }
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(value)) {
    fail(`${label} must be a stable identifier.`);
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
  }
  return value;
}

function assertTimestamp(value, label) {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) {
    fail(`${label} must be a canonical ISO 8601 timestamp.`);
  }
}

function candidateBindingHash(candidate) {
  return sha256(candidate);
}

function assertEvidenceMission(value, missionId, label) {
  if (missionId === undefined) {
    fail(`${label} requires the enclosing mission identifier.`);
  }
  if (value.missionId !== missionId) {
    fail(`${label} belongs to a different mission.`);
  }
}

function assertTransitionEvidence(payload, context) {
  if (payload.toState === "awaiting_approval") {
    if (!Object.hasOwn(payload, "candidate")) {
      fail("awaiting_approval requires an exact reviewed candidate.");
    }
    validateCandidatePatch(payload.candidate);
    if (payload.candidate.reviewerVerdict.decision !== "approved") {
      fail("awaiting_approval requires reviewer approval.");
    }
    assertEvidenceMission(payload.candidate, context.missionId, "awaiting_approval candidate");
  }
  if (payload.toState === "applying") {
    if (!Object.hasOwn(payload, "candidate") || !Object.hasOwn(payload, "approval")) {
      fail("applying requires a candidate and explicit human approval.");
    }
    validateCandidatePatch(payload.candidate);
    validateApprovalRecord(payload.approval);
    if (!approvalMatchesCandidate(payload.approval, payload.candidate)) {
      fail("applying approval does not match the exact reviewed candidate.");
    }
    assertEvidenceMission(payload.candidate, context.missionId, "applying candidate");
    assertEvidenceMission(payload.approval, context.missionId, "applying approval");
  }
  if (payload.toState === "completed") {
    validateApplicationEvidence(payload.applicationEvidence);
    assertEvidenceMission(payload.applicationEvidence, context.missionId, "applicationEvidence");
  }
  if (payload.toState === "blocked") {
    assertExactKeys(payload.blocked, ["code", "summary", "nextActor"], [], "blocked");
    assertIdentifier(payload.blocked.code, "blocked.code");
    if (typeof payload.blocked.summary !== "string" || payload.blocked.summary.length === 0) {
      fail("blocked.summary must be non-empty.");
    }
    if (!actorSet.has(payload.blocked.nextActor)) {
      fail("blocked.nextActor is unknown.");
    }
  }
}

function validateTransitionPayload(currentState, payload, context, enforceContinuity) {
  if (!stateSet.has(currentState)) {
    fail(`Unknown current mission state: ${currentState}.`);
  }
  assertExactKeys(
    payload,
    ["fromState", "toState"],
    ["candidate", "approval", "applicationEvidence", "blocked"],
    "transition payload"
  );
  if (!stateSet.has(payload.fromState) || !stateSet.has(payload.toState)) {
    fail("Transition contains an unknown mission state.");
  }
  if (payload.fromState !== currentState) {
    fail(`Transition expected ${currentState} but declared ${payload.fromState}.`);
  }
  if (terminalStates.has(currentState)) {
    fail(`Terminal state ${currentState} cannot transition.`);
  }
  if (!MISSION_TRANSITIONS[currentState].includes(payload.toState)) {
    fail(`Illegal mission transition: ${currentState} -> ${payload.toState}.`);
  }
  const allowedEvidence = new Set(["fromState", "toState"]);
  if (payload.toState === "awaiting_approval") allowedEvidence.add("candidate");
  if (payload.toState === "applying") {
    allowedEvidence.add("candidate");
    allowedEvidence.add("approval");
  }
  if (payload.toState === "completed") allowedEvidence.add("applicationEvidence");
  if (payload.toState === "blocked") allowedEvidence.add("blocked");
  for (const key of Object.keys(payload)) {
    if (!allowedEvidence.has(key)) {
      fail(`Transition includes irrelevant evidence for ${payload.toState}: ${key}.`);
    }
  }
  assertTransitionEvidence(payload, context);
  if (enforceContinuity && payload.toState === "applying") {
    if (context.expectedCandidateBinding === undefined) {
      fail("applying requires the candidate previously recorded for approval.");
    }
    if (!hashesEqual(candidateBindingHash(payload.candidate), context.expectedCandidateBinding)) {
      fail("applying candidate differs from the candidate awaiting approval.");
    }
  }
  if (enforceContinuity && payload.toState === "completed") {
    if (context.expectedCandidateSha256 === undefined) {
      fail("completed requires the candidate previously authorized for application.");
    }
    if (
      !hashesEqual(
        payload.applicationEvidence.candidateSha256,
        context.expectedCandidateSha256
      )
    ) {
      fail("completion evidence does not match the applied candidate hash.");
    }
    if (context.expectedCandidate !== undefined) {
      const expected = context.expectedCandidate;
      if (
        payload.applicationEvidence.candidateId !== expected.candidateId ||
        payload.applicationEvidence.projectId !== expected.projectId ||
        payload.applicationEvidence.baseRevision !== expected.baseRevision
      ) {
        fail("completion evidence does not match the authorized candidate context.");
      }
    }
  }
  assertNoForbiddenFields(payload, "transition payload");
  return payload.toState;
}

/** Validate one deterministic state transition and its contextual continuity evidence. */
export function validateMissionTransition(currentState, payload, context = {}) {
  return validateTransitionPayload(currentState, payload, context, true);
}

function eventHashInput(event) {
  return {
    actor: event.actor,
    eventId: event.eventId,
    eventType: event.eventType,
    missionId: event.missionId,
    payload: event.payload,
    previousHash: event.previousHash,
    sequence: event.sequence,
    timestamp: event.timestamp
  };
}

function inputFromEvent(event) {
  return {
    actor: event.actor,
    eventId: event.eventId,
    eventType: event.eventType,
    missionId: event.missionId,
    payload: event.payload,
    timestamp: event.timestamp
  };
}

function validateEventInput(input) {
  assertExactKeys(
    input,
    ["eventId", "missionId", "eventType", "actor", "timestamp", "payload"],
    [],
    "MissionEvent input"
  );
  assertIdentifier(input.eventId, "MissionEvent.eventId");
  assertIdentifier(input.missionId, "MissionEvent.missionId");
  if (!new Set(["mission.created", "mission.transitioned"]).has(input.eventType)) {
    fail(`Unknown mission event type: ${input.eventType}.`);
  }
  if (!actorSet.has(input.actor)) {
    fail(`Unknown mission event actor: ${input.actor}.`);
  }
  assertTimestamp(input.timestamp, "MissionEvent.timestamp");
  assertPlainObject(input.payload, "MissionEvent.payload");
  assertNoForbiddenFields(input.payload, "MissionEvent.payload");
  if (input.eventType === "mission.created") {
    assertExactKeys(input.payload, ["state"], [], "mission.created payload");
    if (input.payload.state !== "draft") {
      fail("A mission journal must begin in draft state.");
    }
  } else {
    validateTransitionPayload(
      input.payload.fromState,
      input.payload,
      { missionId: input.missionId },
      false
    );
  }
}

/** Create a hash-chained event from validated input and the prior journal entry. */
export function createMissionEvent(input, previousEvent = null) {
  validateEventInput(input);
  if (previousEvent !== null) {
    validateMissionEvent(previousEvent);
    if (previousEvent.missionId !== input.missionId) {
      fail("A journal cannot mix mission identifiers.");
    }
  }
  const event = {
    eventId: input.eventId,
    missionId: input.missionId,
    sequence: previousEvent === null ? 1 : previousEvent.sequence + 1,
    previousHash: previousEvent === null ? ZERO_HASH : previousEvent.eventHash,
    eventHash: "",
    eventType: input.eventType,
    actor: input.actor,
    timestamp: input.timestamp,
    payload: structuredClone(input.payload)
  };
  event.eventHash = sha256(canonicalJson(eventHashInput(event)));
  return deepFreeze(event);
}

/** Validate the shape and self-hash of one mission event. */
export function validateMissionEvent(event) {
  assertExactKeys(
    event,
    [
      "eventId",
      "missionId",
      "sequence",
      "previousHash",
      "eventHash",
      "eventType",
      "actor",
      "timestamp",
      "payload"
    ],
    [],
    "MissionEvent"
  );
  validateEventInput(inputFromEvent(event));
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    fail("MissionEvent.sequence must be a positive safe integer.");
  }
  assertSha256(event.previousHash, "MissionEvent.previousHash");
  assertSha256(event.eventHash, "MissionEvent.eventHash");
  const expected = sha256(canonicalJson(eventHashInput(event)));
  if (!hashesEqual(event.eventHash, expected)) {
    fail(`MissionEvent ${event.eventId} has an invalid event hash.`);
  }
  return event;
}

/** Verify continuity, ordering, hashes, and an optional trusted journal anchor. */
export function verifyMissionJournal(events, expectedAnchor = null) {
  if (!Array.isArray(events) || events.length === 0) {
    fail("Mission journal must contain at least one event.");
  }
  const eventIds = new Set();
  let previous = null;
  for (const event of events) {
    validateMissionEvent(event);
    if (eventIds.has(event.eventId)) {
      fail(`Mission journal contains duplicate event identifier: ${event.eventId}.`);
    }
    eventIds.add(event.eventId);
    const expectedSequence = previous === null ? 1 : previous.sequence + 1;
    const expectedPreviousHash = previous === null ? ZERO_HASH : previous.eventHash;
    if (event.sequence !== expectedSequence) {
      fail(`Mission journal sequence is discontinuous at event ${event.eventId}.`);
    }
    if (!hashesEqual(event.previousHash, expectedPreviousHash)) {
      fail(`Mission journal chain is broken at event ${event.eventId}.`);
    }
    if (previous !== null && previous.missionId !== event.missionId) {
      fail("Mission journal mixes mission identifiers.");
    }
    previous = event;
  }
  const anchor = Object.freeze({ eventCount: events.length, headHash: previous.eventHash });
  if (expectedAnchor !== null) {
    assertExactKeys(expectedAnchor, ["eventCount", "headHash"], [], "expectedAnchor");
    assertSha256(expectedAnchor.headHash, "expectedAnchor.headHash");
    if (
      expectedAnchor.eventCount !== anchor.eventCount ||
      !hashesEqual(expectedAnchor.headHash, anchor.headHash)
    ) {
      fail("Mission journal does not match its trusted anchor.");
    }
  }
  return anchor;
}

/** Replay the journal to derive state and explicitly report cache divergence. */
export function replayMissionJournal(events, options = {}) {
  const anchor = verifyMissionJournal(events, options.expectedAnchor ?? null);
  const first = events[0];
  if (first.eventType !== "mission.created") {
    fail("Mission journal must begin with mission.created.");
  }
  assertExactKeys(first.payload, ["state"], [], "mission.created payload");
  if (first.payload.state !== "draft") {
    fail("A mission journal must begin in draft state.");
  }
  let state = "draft";
  let pendingCandidateBinding = null;
  let applyingCandidate = null;
  for (const event of events.slice(1)) {
    if (event.eventType !== "mission.transitioned") {
      fail(`Unexpected event after mission creation: ${event.eventType}.`);
    }
    const context = { missionId: event.missionId };
    if (event.payload.toState === "applying") {
      context.expectedCandidateBinding = pendingCandidateBinding ?? undefined;
    }
    if (event.payload.toState === "completed") {
      context.expectedCandidateSha256 = applyingCandidate?.patchSha256;
      context.expectedCandidate = applyingCandidate ?? undefined;
    }
    state = validateMissionTransition(state, event.payload, context);
    if (event.payload.toState === "awaiting_approval") {
      pendingCandidateBinding = candidateBindingHash(event.payload.candidate);
    }
    if (event.payload.toState === "applying") {
      applyingCandidate = structuredClone(event.payload.candidate);
      pendingCandidateBinding = null;
    }
  }
  const cachedState = options.cachedState;
  const cacheStatus =
    cachedState === undefined ? "not_provided" : cachedState === state ? "match" : "diverged";
  return Object.freeze({ state, cacheStatus, anchor });
}

/** In-memory append-only journal with idempotent duplicate delivery handling. */
export class InMemoryMissionJournal {
  #events = [];

  append(input) {
    validateEventInput(input);
    const duplicate = this.#events.find((event) => event.eventId === input.eventId);
    if (duplicate) {
      if (canonicalJson(inputFromEvent(duplicate)) === canonicalJson(input)) {
        return Object.freeze({ event: duplicate, appended: false });
      }
      fail(`Event identifier collision: ${input.eventId}.`);
    }
    const event = createMissionEvent(input, this.#events.at(-1) ?? null);
    const candidateEvents = [...this.#events, event];
    replayMissionJournal(candidateEvents);
    this.#events.push(event);
    return Object.freeze({ event, appended: true });
  }

  events() {
    return structuredClone(this.#events);
  }

  anchor() {
    return verifyMissionJournal(this.#events);
  }

  replay(options = {}) {
    return replayMissionJournal(this.#events, options);
  }
}
