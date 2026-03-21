# Agile Development Process

## Overview

bolt follows a lightweight agile process: work is expressed as user stories, broken into tasks, delivered in short iterations, and verified against a definition of done before merging.

---

## User Story Template

```
As a <role>,
I want <capability>,
so that <benefit>.

Acceptance Criteria:
- [ ] <testable criterion 1>
- [ ] <testable criterion 2>
- [ ] <testable criterion 3>
```

**Examples:**

```
As a CLI user,
I want to run bolt with my Anthropic subscription instead of an API key,
so that I don't need to manage separate credentials.

Acceptance Criteria:
- [ ] bolt starts successfully when only ANTHROPIC_SESSION_TOKEN is set
- [ ] bolt exits with a clear error when neither credential is set
- [ ] API key takes precedence when both are set, with a warning logged
- [ ] Credentials never appear in tool-audit.jsonl
```

```
As a developer,
I want bolt to compact its context before it hits the token limit,
so that long-running sessions don't lose information.

Acceptance Criteria:
- [ ] Compaction triggers when token usage exceeds 80% of the context window
- [ ] The 10 most recent messages are always retained after compaction
- [ ] The compacted summary is written to .bolt/memory/ before eviction
- [ ] The agent can retrieve compacted summaries via memory_search
```

---

## Backlog and Prioritization

- All work items live as GitHub Issues or a local `docs/backlog.md`
- Each item is a user story or a chore (no stories needed for dependency bumps, formatting fixes)
- Priority order: **P0** (blocking) → **P1** (high value) → **P2** (nice to have)
- Stories are refined before a sprint starts — acceptance criteria must be complete before work begins

---

## Sprint Workflow

```
Backlog refinement
      │
      ▼
Pick stories for the sprint (team agrees on scope)
      │
      ▼
For each story:
  1. Write failing tests (TDD — see unit-testing.md)
  2. Implement until tests pass
  3. Refactor
  4. Open PR with checklist complete
  5. Review + merge
      │
      ▼
Sprint review: demo working software
      │
      ▼
Retrospective: what to keep / change / try
```

---

## Definition of Done

A story is **done** when ALL of the following are true:

- [ ] All acceptance criteria pass (manually verified or automated)
- [ ] Unit tests written **before** the implementation (TDD)
- [ ] Coverage thresholds maintained (see `unit-testing.md`)
- [ ] `npm run typecheck` passes — no TypeScript errors
- [ ] `npm run lint` passes — no lint violations
- [ ] `npm test -- --coverage` passes — no regressions
- [ ] Relevant documentation updated (design doc, requirements, CLAUDE.md if needed)
- [ ] PR review checklist complete (see below)
- [ ] No `any` types introduced
- [ ] No credentials, secrets, or PII in code or tests

---

## PR Review Checklist

Every PR must include this checklist in the description:

```markdown
## PR Checklist

### Tests
- [ ] Tests written before implementation (TDD)
- [ ] New behavior covered by unit tests
- [ ] Coverage did not decrease (`npm run test:coverage`)
- [ ] No tests deleted without justification

### Code Quality
- [ ] No `any` types
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] No credentials or secrets in code or tests

### Design
- [ ] Follows existing patterns (Tool interface, Channel interface, etc.)
- [ ] No shared state introduced between agent scopes
- [ ] Error cases handled (ToolError thrown on failure)

### Documentation
- [ ] Relevant design doc updated if interface/behavior changed
- [ ] Requirements updated if scope changed
- [ ] CLAUDE.md doc index updated if a new doc was added

### Compatibility
- [ ] Task/memory state remains deserializable from previous format
- [ ] No breaking changes to Tool interface or Channel interface without doc update
```

---

## How Requirements Flow to Implementation

```
User need identified
        │
        ▼
Write user story with acceptance criteria
(docs/requirements/overview.md or GitHub Issue)
        │
        ▼
Design doc updated or created if needed
(docs/design/<area>.md)
        │
        ▼
Story added to backlog + prioritized
        │
        ▼
Sprint: TDD cycle (red → green → refactor)
        │
        ▼
PR opened with checklist
        │
        ▼
Review + merge → Definition of Done verified
```

---

## Branching and Story Mapping

| Branch prefix | Use |
|---------------|-----|
| `feat/<story-id>-<slug>` | New feature or user story |
| `fix/<issue-id>-<slug>` | Bug fix |
| `chore/<slug>` | Dependency, tooling, docs, refactor |
| `test/<slug>` | Test-only changes |

One branch per story. Stories should be small enough to merge within one or two days.
