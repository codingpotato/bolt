## Summary

<!-- What does this PR do? Link the user story or issue. -->

## Changes

<!-- Bullet list of what changed -->

---

## PR Checklist

### Tests
- [ ] Tests written **before** implementation (TDD — red → green → refactor)
- [ ] New behavior covered by co-located unit tests (`*.test.ts`)
- [ ] `npm run test:coverage` passes — coverage did not decrease
- [ ] No tests deleted without justification

### Code Quality
- [ ] No `any` types
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] No credentials or secrets in code or tests

### Design
- [ ] Follows existing patterns (Tool interface, Channel interface, etc.)
- [ ] No shared state introduced between agent scopes
- [ ] Error cases handled (`ToolError` thrown on failure)

### Documentation
- [ ] Relevant design doc updated if interface or behavior changed
- [ ] Requirements updated if scope changed
- [ ] `CLAUDE.md` doc index updated if a new doc was added
- [ ] `docs/design/configuration.md` updated if new config keys were added

### Compatibility
- [ ] Task/memory state remains deserializable from previous format
- [ ] No breaking changes to `Tool` or `Channel` interface without a doc update
