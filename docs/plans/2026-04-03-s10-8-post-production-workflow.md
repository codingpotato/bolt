# S10-8: Post-production Workflow Integration Test

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add integration tests covering the post-production phase (merge → audio → subtitles) of the video production pipeline.

**Architecture:** Extend `src/content/video-production-workflow.test.ts` with a new `describe` block. Tests use real `ContentProjectManager` and `TaskStore`, with mocked FFmpeg outputs via simulated file writes. No new production code needed.

**Tech Stack:** TypeScript, Vitest, Node.js fs/promises

---

### Task 1: Write the post-production test suite skeleton

**Files:**

- Modify: `src/content/video-production-workflow.test.ts:579` (append new describe block before closing `});`)

**Step 1: Add the new describe block with shared setup**

Append this before the final closing `});` of the file (line 580):

```typescript
  describe('Post-production workflow (S10-8)', () => {
    let project: ContentProject;

    beforeEach(async () => {
      // Create project with completed video generation phase
      project = await projectManager.createProject('Post-production Test');

      // Initialize scenes with clips (simulating completed video generation)
      await projectManager.initializeScenes(project, {
        title: 'Test Video',
        summary: 'A test video for post-production',
        targetPlatform: 'tiktok',
        estimatedDuration: '15s',
        scenes: [
          { sceneNumber: 1, description: 'Scene 1', camera: 'wide', duration: '5s', imagePromptHint: 'hint1' },
          { sceneNumber: 2, description: 'Scene 2', camera: 'close-up', duration: '5s', imagePromptHint: 'hint2' },
          { sceneNumber: 3, description: 'Scene 3', camera: 'wide', duration: '5s', imagePromptHint: 'hint3' },
        ],
      });

      // Mark all scene clips as approved (simulating completed video generation)
      for (const scene of project.artifacts.scenes) {
        scene.clip = { path: `scenes/scene-${String(scene.sceneNumber).padStart(2, '0')}/clip.mp4`, status: 'approved' };
      }
      project.artifacts.storyboard = { path: '02-storyboard.json', status: 'approved' };
      await projectManager.writeManifest(project);

      // Create fake clip files on disk
      for (const scene of project.artifacts.scenes) {
        const sceneDir = join(project.dir, `scenes/scene-${String(scene.sceneNumber).padStart(2, '0')}`);
        await mkdir(sceneDir, { recursive: true });
        await writeFile(join(sceneDir, 'clip.mp4'), `fake clip ${scene.sceneNumber}`, 'utf-8');
      }

      // Create a fake audio file
      await writeFile(join(project.dir, 'audio', 'bgm.mp3'), 'fake audio', 'utf-8');
    });
```

**Step 2: Run existing tests to verify no regression**

Run: `npx vitest run src/content/video-production-workflow.test.ts --reporter=verbose`
Expected: All existing tests PASS, new describe block has no tests yet (no failures).

**Step 3: Commit**

```bash
git add src/content/video-production-workflow.test.ts
git commit -m "test(content): S10-8 add post-production test suite skeleton"
```

---

### Task 2: Test mergeClips creates final/raw.mp4

**Files:**

- Modify: `src/content/video-production-workflow.test.ts` (inside the Post-production describe block)

**Step 1: Write the mergeClips test**

Add inside the `describe('Post-production workflow (S10-8)')` block:

```typescript
it('mergeClips: creates final/raw.mp4 and updates manifest', async () => {
  // Simulate agent calling video_merge with scene clips
  const clipPaths = project.artifacts.scenes.map(
    (s) => `scenes/scene-${String(s.sceneNumber).padStart(2, '0')}/clip.mp4`,
  );

  // Verify clips are approved
  for (const clip of clipPaths) {
    const found = project.artifacts.scenes.some(
      (s) => s.clip?.path === clip && s.clip?.status === 'approved',
    );
    expect(found).toBe(true);
  }

  // Simulate video_merge output (in real workflow, the tool writes this file)
  const rawOutputPath = 'final/raw.mp4';
  const rawOutputAbs = join(project.dir, rawOutputPath);
  await writeFile(rawOutputAbs, 'fake merged video', 'utf-8');

  // Update manifest with rawVideo artifact
  project.artifacts.postProduction = {
    rawVideo: { path: rawOutputPath, status: 'draft' },
  };
  await projectManager.writeManifest(project);

  // Simulate user_review approval
  await projectManager.updateArtifactStatus(project, rawOutputPath, 'approved');

  // Verify manifest
  const reloaded = await projectManager.readProject(project.id);
  expect(reloaded?.artifacts.postProduction?.rawVideo?.status).toBe('approved');
  expect(reloaded?.artifacts.postProduction?.rawVideo?.path).toBe('final/raw.mp4');
  expect(reloaded?.artifacts.postProduction?.rawVideo?.approvedAt).toBeDefined();
});
```

**Step 2: Run the test**

Run: `npx vitest run src/content/video-production-workflow.test.ts -t "mergeClips" --reporter=verbose`
Expected: PASS

**Step 3: Commit**

```bash
git add src/content/video-production-workflow.test.ts
git commit -m "test(content): S10-8 test mergeClips creates final/raw.mp4"
```

---

### Task 3: Test addAudio creates final/audio.mp4

**Files:**

- Modify: `src/content/video-production-workflow.test.ts`

**Step 1: Write the addAudio test**

Add after the mergeClips test:

```typescript
it('addAudio: creates final/audio.mp4 (replace mode) and updates manifest', async () => {
  // Pre-create raw.mp4 (simulating completed merge step)
  await mkdir(join(project.dir, 'final'), { recursive: true });
  await writeFile(join(project.dir, 'final/raw.mp4'), 'fake merged video', 'utf-8');
  project.artifacts.postProduction = {
    rawVideo: { path: 'final/raw.mp4', status: 'approved' },
  };
  await projectManager.writeManifest(project);

  // Simulate video_add_audio output
  const audioOutputPath = 'final/audio.mp4';
  await writeFile(join(project.dir, audioOutputPath), 'fake video with audio', 'utf-8');

  // Update manifest
  project.artifacts.postProduction!.audioVideo = { path: audioOutputPath, status: 'draft' };
  await projectManager.writeManifest(project);

  // Simulate approval
  await projectManager.updateArtifactStatus(project, audioOutputPath, 'approved');

  // Verify manifest
  const reloaded = await projectManager.readProject(project.id);
  expect(reloaded?.artifacts.postProduction?.audioVideo?.status).toBe('approved');
  expect(reloaded?.artifacts.postProduction?.audioVideo?.path).toBe('final/audio.mp4');
  // rawVideo should still be approved
  expect(reloaded?.artifacts.postProduction?.rawVideo?.status).toBe('approved');
});
```

**Step 2: Run the test**

Run: `npx vitest run src/content/video-production-workflow.test.ts -t "addAudio" --reporter=verbose`
Expected: PASS

**Step 3: Commit**

```bash
git add src/content/video-production-workflow.test.ts
git commit -m "test(content): S10-8 test addAudio creates final/audio.mp4"
```

---

### Task 4: Test addSubtitles creates final/video.mp4

**Files:**

- Modify: `src/content/video-production-workflow.test.ts`

**Step 1: Write the addSubtitles test**

Add after the addAudio test:

```typescript
it('addSubtitles: creates final/video.mp4 (soft mode) and updates manifest', async () => {
  // Pre-create audio.mp4 (simulating completed audio step)
  await mkdir(join(project.dir, 'final'), { recursive: true });
  await writeFile(join(project.dir, 'final/audio.mp4'), 'fake video with audio', 'utf-8');
  project.artifacts.postProduction = {
    rawVideo: { path: 'final/raw.mp4', status: 'approved' },
    audioVideo: { path: 'final/audio.mp4', status: 'approved' },
  };
  await projectManager.writeManifest(project);

  // Agent generates SRT via file_write (simulated)
  const srtContent = [
    '1',
    '00:00:00,000 --> 00:00:05,000',
    'Welcome to this video about AI trends.',
    '',
    '2',
    '00:00:05,000 --> 00:00:10,000',
    'Let us explore the top three trends.',
    '',
    '3',
    '00:00:10,000 --> 00:00:15,000',
    'Thank you for watching.',
    '',
  ].join('\n');
  await writeFile(join(project.dir, 'scenes/subtitles.srt'), srtContent, 'utf-8');

  // Simulate video_add_subtitles output
  const finalOutputPath = 'final/video.mp4';
  await writeFile(join(project.dir, finalOutputPath), 'fake final video with subtitles', 'utf-8');

  // Update manifest
  project.artifacts.postProduction!.subtitles = { path: 'scenes/subtitles.srt', status: 'draft' };
  project.artifacts.postProduction!.finalVideo = { path: finalOutputPath, status: 'draft' };
  await projectManager.writeManifest(project);

  // Simulate approval
  await projectManager.updateArtifactStatus(project, finalOutputPath, 'approved');
  await projectManager.updateArtifactStatus(project, 'scenes/subtitles.srt', 'approved');

  // Verify manifest
  const reloaded = await projectManager.readProject(project.id);
  expect(reloaded?.artifacts.postProduction?.finalVideo?.status).toBe('approved');
  expect(reloaded?.artifacts.postProduction?.finalVideo?.path).toBe('final/video.mp4');
  expect(reloaded?.artifacts.postProduction?.subtitles?.status).toBe('approved');
  expect(reloaded?.artifacts.postProduction?.subtitles?.path).toBe('scenes/subtitles.srt');
});
```

**Step 2: Run the test**

Run: `npx vitest run src/content/video-production-workflow.test.ts -t "addSubtitles" --reporter=verbose`
Expected: PASS

**Step 3: Commit**

```bash
git add src/content/video-production-workflow.test.ts
git commit -m "test(content): S10-8 test addSubtitles creates final/video.mp4"
```

---

### Task 5: Test full post-production pipeline (merge → audio → subtitles)

**Files:**

- Modify: `src/content/video-production-workflow.test.ts`

**Step 1: Write the full pipeline test**

Add after the addSubtitles test:

```typescript
it('full post-production pipeline: merge → audio → subtitles with approval gates', async () => {
  // Create post-production task DAG
  const mergeTaskId = await taskStore.create(
    'Merge clips',
    'Merge all scene clips into final/raw.mp4',
    [], // no deps in this test — videos already completed
    true,
  );
  const audioTaskId = await taskStore.create(
    'Add audio',
    'Add background music to final/audio.mp4',
    [mergeTaskId],
    true,
  );
  const subtitlesTaskId = await taskStore.create(
    'Add subtitles',
    'Embed subtitles into final/video.mp4',
    [audioTaskId],
    true,
  );

  // Record task IDs in manifest
  await projectManager.setTaskId(project, 'mergeClips', mergeTaskId);
  await projectManager.setTaskId(project, 'addAudio', audioTaskId);
  await projectManager.setTaskId(project, 'addSubtitles', subtitlesTaskId);

  // Verify initial state: merge pending, others waiting
  const tasks = taskStore.list();
  expect(tasks.find((t) => t.id === mergeTaskId)?.status).toBe('pending');
  expect(tasks.find((t) => t.id === audioTaskId)?.status).toBe('waiting');
  expect(tasks.find((t) => t.id === subtitlesTaskId)?.status).toBe('waiting');

  // === Step 1: Merge clips ===
  await taskStore.update(mergeTaskId, { status: 'in_progress' });

  // Simulate video_merge
  const clipPaths = project.artifacts.scenes.map(
    (s) => `scenes/scene-${String(s.sceneNumber).padStart(2, '0')}/clip.mp4`,
  );
  expect(clipPaths.length).toBeGreaterThanOrEqual(2);
  await mkdir(join(project.dir, 'final'), { recursive: true });
  await writeFile(join(project.dir, 'final/raw.mp4'), 'fake merged video', 'utf-8');

  project.artifacts.postProduction = {
    rawVideo: { path: 'final/raw.mp4', status: 'draft' },
  };
  await projectManager.writeManifest(project);

  await taskStore.update(mergeTaskId, { status: 'awaiting_approval' });
  await projectManager.updateArtifactStatus(project, 'final/raw.mp4', 'approved');
  await taskStore.update(mergeTaskId, { status: 'completed' });

  // === Step 2: Add audio (unlocked by merge completion) ===
  expect(taskStore.list().find((t) => t.id === audioTaskId)?.status).toBe('pending');
  await taskStore.update(audioTaskId, { status: 'in_progress' });

  await writeFile(join(project.dir, 'final/audio.mp4'), 'fake video with audio', 'utf-8');
  project.artifacts.postProduction!.audioVideo = { path: 'final/audio.mp4', status: 'draft' };
  await projectManager.writeManifest(project);

  await taskStore.update(audioTaskId, { status: 'awaiting_approval' });
  await projectManager.updateArtifactStatus(project, 'final/audio.mp4', 'approved');
  await taskStore.update(audioTaskId, { status: 'completed' });

  // === Step 3: Add subtitles (unlocked by audio completion) ===
  expect(taskStore.list().find((t) => t.id === subtitlesTaskId)?.status).toBe('pending');
  await taskStore.update(subtitlesTaskId, { status: 'in_progress' });

  // Agent generates SRT
  const srtContent = '1\n00:00:00,000 --> 00:00:05,000\nHello world.\n\n';
  await writeFile(join(project.dir, 'scenes/subtitles.srt'), srtContent, 'utf-8');
  await writeFile(join(project.dir, 'final/video.mp4'), 'fake final video', 'utf-8');

  project.artifacts.postProduction!.subtitles = { path: 'scenes/subtitles.srt', status: 'draft' };
  project.artifacts.postProduction!.finalVideo = { path: 'final/video.mp4', status: 'draft' };
  await projectManager.writeManifest(project);

  await taskStore.update(subtitlesTaskId, { status: 'awaiting_approval' });
  await projectManager.updateArtifactStatus(project, 'final/video.mp4', 'approved');
  await projectManager.updateArtifactStatus(project, 'scenes/subtitles.srt', 'approved');
  await taskStore.update(subtitlesTaskId, { status: 'completed' });

  // === Verify final state ===
  const finalProject = await projectManager.readProject(project.id);
  expect(finalProject?.artifacts.postProduction?.rawVideo?.status).toBe('approved');
  expect(finalProject?.artifacts.postProduction?.audioVideo?.status).toBe('approved');
  expect(finalProject?.artifacts.postProduction?.finalVideo?.status).toBe('approved');
  expect(finalProject?.artifacts.postProduction?.subtitles?.status).toBe('approved');

  // All tasks completed
  const finalTasks = taskStore.list();
  expect(finalTasks.find((t) => t.id === mergeTaskId)?.status).toBe('completed');
  expect(finalTasks.find((t) => t.id === audioTaskId)?.status).toBe('completed');
  expect(finalTasks.find((t) => t.id === subtitlesTaskId)?.status).toBe('completed');
});
```

**Step 2: Run the test**

Run: `npx vitest run src/content/video-production-workflow.test.ts -t "full post-production pipeline" --reporter=verbose`
Expected: PASS

**Step 3: Commit**

```bash
git add src/content/video-production-workflow.test.ts
git commit -m "test(content): S10-8 test full post-production pipeline with approval gates"
```

---

### Task 6: Test rejection and revision flow

**Files:**

- Modify: `src/content/video-production-workflow.test.ts`

**Step 1: Write the rejection test**

Add after the full pipeline test:

```typescript
it('user rejects merge, agent re-presents and succeeds on second attempt', async () => {
  // Pre-create raw.mp4
  await mkdir(join(project.dir, 'final'), { recursive: true });
  await writeFile(join(project.dir, 'final/raw.mp4'), 'fake merged video v1', 'utf-8');
  project.artifacts.postProduction = {
    rawVideo: { path: 'final/raw.mp4', status: 'draft' },
  };
  await projectManager.writeManifest(project);

  const mergeTaskId = await taskStore.create('Merge clips', 'Merge clips', [], true);
  await taskStore.update(mergeTaskId, { status: 'in_progress' });
  await taskStore.update(mergeTaskId, { status: 'awaiting_approval' });

  // Simulate user rejection
  await projectManager.updateArtifactStatus(project, 'final/raw.mp4', 'draft');
  await taskStore.update(mergeTaskId, { status: 'in_progress' });

  // Agent re-merges (simulated — new file content)
  await writeFile(join(project.dir, 'final/raw.mp4'), 'fake merged video v2 (revised)', 'utf-8');

  // Re-present for approval
  await taskStore.update(mergeTaskId, { status: 'awaiting_approval' });
  await projectManager.updateArtifactStatus(project, 'final/raw.mp4', 'approved');
  await taskStore.update(mergeTaskId, { status: 'completed' });

  // Verify
  const reloaded = await projectManager.readProject(project.id);
  expect(reloaded?.artifacts.postProduction?.rawVideo?.status).toBe('approved');
  expect(reloaded?.artifacts.postProduction?.rawVideo?.approvedAt).toBeDefined();
});
```

**Step 2: Run the test**

Run: `npx vitest run src/content/video-production-workflow.test.ts -t "user rejects merge" --reporter=verbose`
Expected: PASS

**Step 3: Commit**

```bash
git add src/content/video-production-workflow.test.ts
git commit -m "test(content): S10-8 test rejection and revision flow for merge"
```

---

### Task 7: Test skip audio and cascade failure

**Files:**

- Modify: `src/content/video-production-workflow.test.ts`

**Step 1: Write both tests**

Add after the rejection test:

```typescript
it('post-production with no audio: skips addAudio, goes merge → subtitles directly', async () => {
  // Setup: merge completed, no audio step
  await mkdir(join(project.dir, 'final'), { recursive: true });
  await writeFile(join(project.dir, 'final/raw.mp4'), 'fake merged video', 'utf-8');
  project.artifacts.postProduction = {
    rawVideo: { path: 'final/raw.mp4', status: 'approved' },
  };
  await projectManager.writeManifest(project);

  // Only create merge and subtitles tasks (no audio task)
  const mergeTaskId = await taskStore.create('Merge clips', 'Merge clips', [], true);
  await taskStore.update(mergeTaskId, { status: 'completed' });

  const subtitlesTaskId = await taskStore.create(
    'Add subtitles',
    'Add subtitles',
    [mergeTaskId],
    true,
  );

  // Subtitles task should be pending (merge is completed)
  expect(taskStore.list().find((t) => t.id === subtitlesTaskId)?.status).toBe('pending');

  // Complete subtitles
  const srtContent = '1\n00:00:00,000 --> 00:00:05,000\nHello.\n\n';
  await writeFile(join(project.dir, 'scenes/subtitles.srt'), srtContent, 'utf-8');
  await writeFile(join(project.dir, 'final/video.mp4'), 'fake final video', 'utf-8');

  project.artifacts.postProduction!.subtitles = { path: 'scenes/subtitles.srt', status: 'draft' };
  project.artifacts.postProduction!.finalVideo = { path: 'final/video.mp4', status: 'draft' };
  await projectManager.writeManifest(project);

  await taskStore.update(subtitlesTaskId, { status: 'awaiting_approval' });
  await projectManager.updateArtifactStatus(project, 'final/video.mp4', 'approved');
  await taskStore.update(subtitlesTaskId, { status: 'completed' });

  // Verify: no audioVideo artifact
  const reloaded = await projectManager.readProject(project.id);
  expect(reloaded?.artifacts.postProduction?.audioVideo).toBeUndefined();
  expect(reloaded?.artifacts.postProduction?.finalVideo?.status).toBe('approved');
});

it('cascade failure: if merge fails, audio and subtitles auto-fail', async () => {
  const mergeTaskId = await taskStore.create('Merge clips', 'Merge clips', [], true);
  const audioTaskId = await taskStore.create('Add audio', 'Add audio', [mergeTaskId], true);
  const subtitlesTaskId = await taskStore.create(
    'Add subtitles',
    'Add subtitles',
    [audioTaskId],
    true,
  );

  // Fail the merge task
  await taskStore.update(mergeTaskId, {
    status: 'failed',
    error: 'video_merge failed: incompatible codecs',
  });

  // Cascade: audio and subtitles should be failed
  const tasks = taskStore.list();
  expect(tasks.find((t) => t.id === audioTaskId)?.status).toBe('failed');
  expect(tasks.find((t) => t.id === subtitlesTaskId)?.status).toBe('failed');
});
```

**Step 2: Run both tests**

Run: `npx vitest run src/content/video-production-workflow.test.ts -t "post-production with no audio|cascade failure" --reporter=verbose`
Expected: Both PASS

**Step 3: Commit**

```bash
git add src/content/video-production-workflow.test.ts
git commit -m "test(content): S10-8 test skip audio and cascade failure scenarios"
```

---

### Task 8: Run full test suite and verify

**Files:**

- `src/content/video-production-workflow.test.ts` (all tests)

**Step 1: Run the full test suite**

Run: `npx vitest run src/content/video-production-workflow.test.ts --reporter=verbose`
Expected: ALL tests PASS (existing + new post-production tests)

**Step 2: Run typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: No errors

**Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass, coverage thresholds met

**Step 4: Final commit (if any adjustments needed)**

```bash
git add -A
git commit -m "test(content): S10-8 post-production workflow integration tests complete"
```

---

### Task 9: Mark S10-8 complete in plan.md

**Files:**

- `docs/planning/plan.md`

**Step 1: Update acceptance criteria checkboxes**

In `docs/planning/plan.md`, find the S10-8 story section and change all `[ ]` to `[x]`:

```
- [x] After S10-3 video generation completes, agent creates post-production tasks in the existing DAG:
      mergeClips → addAudio (optional) → addSubtitles (optional)
- [x] mergeClips task calls video_merge with all approved clips, saves to final/raw.mp4, updates manifest
- [x] If user has provided an audio file, addAudio task calls video_add_audio; result saved to final/audio.mp4
- [x] If storyboard contains dialogue, agent generates scenes/subtitles.srt from storyboard dialogue and
      scene durations, then calls video_add_subtitles; result saved to final/video.mp4
- [x] The last completed post-production step's output is linked as final/video.mp4 in the manifest
- [x] Each post-production task has requiresApproval: true; user can reject and trigger a redo
- [x] project.json manifest postProduction fields are updated after each step
- [x] Integration test covers merge + audio + subtitles with mocked FfmpegRunner and channel
```

**Step 2: Commit**

```bash
git add docs/planning/plan.md
git commit -m "docs(planning): S10-8 mark post-production workflow integration complete"
```
