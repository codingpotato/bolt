# S10-8: Post-production Workflow Integration — Design

## Date

2026-04-03

## Context

Sprint 10 covers the full video production pipeline. Steps 1-6 (analyze → video generation) are implemented and tested. The three video editing tools (`video_merge`, `video_add_audio`, `video_add_subtitles`) and `FfmpegRunner` are also implemented and unit tested.

**What's missing:** An integration test that validates the post-production phase (steps 7-9) works end-to-end when chained together through the task system.

## Decision

**Approach:** Extend the existing `src/content/video-production-workflow.test.ts` with a new test suite for post-production. No new production code is needed — the agent already has all tools (task_create, task_update, video_merge, video_add_audio, video_add_subtitles, user_review, file_write) to orchestrate post-production autonomously.

The agent generates SRT subtitle files via `file_write` (no new tool needed).

## Architecture

### Test Setup

Each test creates a project with a pre-populated manifest simulating completed video generation:

```
projects/test-project/
  project.json              # manifest with completed scenes
  scenes/
    scene-01/clip.mp4       # fake clip files
    scene-02/clip.mp4
    scene-03/clip.mp4
  final/                    # empty, output directory
```

### Mocks

| Mock                    | Purpose                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `FfmpegRunner`          | Returns canned `{ outputPath, durationMs, stderr }` for merge, audio, subtitle operations |
| `Channel.requestReview` | Returns `{ approved: true/false, feedback? }` per test scenario                           |
| Mock filesystem (memfs) | Pre-populated scene clips, validates output paths                                         |
| `TaskStore`             | Real implementation (tests the actual DAG behavior)                                       |
| `ContentProjectManager` | Real implementation (tests actual manifest updates)                                       |

### Test Cases

#### 1. mergeClips: creates final/raw.mp4

- Calls `video_merge` with scene clip paths
- Verifies manifest `postProduction.rawVideo` updated with path and `approved` status
- Verifies `taskIds.mergeClips` set correctly

#### 2. addAudio: creates final/audio.mp4 (replace mode)

- Calls `video_add_audio` with raw.mp4 and an audio file
- Verifies manifest `postProduction.audioVideo` updated
- Verifies correct mode parameter passed

#### 3. addSubtitles: creates final/video.mp4 (soft mode)

- Agent generates SRT via `file_write` to `scenes/subtitles.srt`
- Calls `video_add_subtitles` with the SRT file
- Verifies manifest `postProduction.finalVideo` updated
- Verifies `postProduction.subtitles` artifact tracked

#### 4. Full post-production pipeline: merge → audio → subtitles

- All three steps execute in sequence
- Each step has an approval gate via `user_review`
- Manifest fully updated after all steps
- Task DAG transitions: `waiting → pending → in_progress → awaiting_approval → completed`

#### 5. User rejects merge, agent re-presents

- `user_review` returns `{ approved: false, feedback: "..." }`
- Artifact status returns to `draft`
- Agent re-merges and re-presents
- Second approval succeeds

#### 6. Post-production with no audio (skip addAudio)

- Agent skips audio step when no audio provided
- Pipeline: merge → subtitles directly
- Manifest `audioVideo` remains undefined

#### 7. Task DAG: post-production tasks unlock correctly

- `mergeClips` starts as `waiting` (depends on `generateVideos`)
- When `generateVideos` completes, `mergeClips` transitions to `pending`
- `addAudio` depends on `mergeClips`, `addSubtitles` depends on `addAudio`
- Cascade failure: if merge fails, audio and subtitles auto-fail

### Assertions

For each test:

- Task status transitions match expected lifecycle
- Manifest `postProduction` artifacts have correct paths and statuses
- `project.json` is written to disk after each mutation
- `user_review` called at each approval gate with correct content type
- FFmpeg tool calls receive correct parameters (paths, modes, options)
- Workspace confinement enforced on all paths

## Testing

- Tests use Vitest with memfs for filesystem isolation
- `FfmpegRunner` is mocked at the module level
- `Channel.requestReview` is controlled per test scenario
- No real FFmpeg execution, no real ComfyUI calls
- Tests are deterministic and complete without network access
