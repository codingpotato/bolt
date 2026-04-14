# TTS Narration Design

## Overview

bolt uses **OmniVoice TTS running on ComfyUI** (`comfyui_tts` tool) to synthesize narration voiceover audio for scenes where no character speaks on screen. This is distinct from character speech, which is animated by the LTX-Video 2.3 model (lip sync, facial motion, and character audio all generated from the video clip).

The two audio sources are mutually exclusive per scene and are controlled by `Scene.audioSource` in the storyboard:

| `audioSource`        | Audio generation                              | LTX 2.3 behaviour                           |
| -------------------- | --------------------------------------------- | -------------------------------------------- |
| `"character-speech"` | LTX 2.3 generates audio from `dialogue`       | Speech-animated clip with lip sync           |
| `"narration"`        | `comfyui_tts` synthesizes `narration` text    | Silent b-roll clip; narration audio mixed in |
| `"silent"`           | No audio generated                            | Silent clip; background music added post-merge |

---

## `NarrationVoice` Interface

`NarrationVoice` is the narrator's voice design profile. It lives at `Storyboard.narrator` and applies to every narration scene. The attributes map directly to `comfyui_tts` parameters.

```ts
interface NarrationVoice {
  /** Narrator archetype for scriptwriting guidance, e.g. "documentary narrator" */
  persona: string;

  /** Voice gender — first term of the voiceInstruct string */
  gender: 'male' | 'female';

  /**
   * Vocal age group — second term of voiceInstruct.
   * Affects timbre and resonance: child < young < middle-aged < elderly.
   */
  age: 'child' | 'young' | 'middle-aged' | 'elderly';

  /**
   * Pitch register — third term of voiceInstruct.
   *   very-low  → "very low pitch"   — bass/baritone, gravitas
   *   low       → "low pitch"        — calm, grounded
   *   medium    → "medium pitch"     — neutral, broadly accessible
   *   high      → "high pitch"       — bright, youthful, energetic
   *   very-high → "very high pitch"  — distinctive, animated
   */
  pitch: 'very-low' | 'low' | 'medium' | 'high' | 'very-high';

  /**
   * Regional accent — fourth term of voiceInstruct, passed verbatim.
   * English: "american accent", "british accent", "australian accent",
   *          "indian accent", "canadian accent", "irish accent"
   * Other:   "french accent", "german accent", "japanese accent",
   *          "mandarin accent", "spanish accent"
   * Chinese dialects: "四川话", "广东话", "东北话", "上海话"
   */
  accent: string;

  /**
   * Speaking pace — maps to comfyui_tts `speed` parameter.
   *   slow      → 0.8  — contemplative, lets key points land
   *   medium    → 1.0  — natural, balanced (default)
   *   fast      → 1.2  — urgent, engaged; good for short-form hooks
   *   very-fast → 1.4  — TikTok/Reels energetic style; no dead air
   */
  pace: 'slow' | 'medium' | 'fast' | 'very-fast';

  /**
   * Vocal style modifier — appended to voiceInstruct when set.
   * "whisper" is the only OmniVoice style modifier currently supported.
   */
  style?: 'whisper';

  /**
   * Diffusion steps for comfyui_tts. Default: 32 (balanced).
   * 16 = faster generation, 64 = best quality.
   */
  steps?: number;

  /**
   * Classifier-free guidance scale for comfyui_tts. Default: 2.0.
   * Higher = more faithful to voiceInstruct; less tonal variation.
   */
  guidanceScale?: number;
}
```

### Deriving `comfyui_tts` parameters from `NarrationVoice`

At synthesis time, the agent calls `narratorToVoiceInstruct()` and `narratorToSpeed()` (exported from `src/content/content-project.ts`) to derive the tool parameters:

```ts
// voiceInstruct = "<gender>, <age>, <pitch> pitch, <accent>[, <style>]"
narratorToVoiceInstruct(narrator)
// → e.g. "female, young, high pitch, british accent"
// → e.g. "male, middle-aged, low pitch, american accent, whisper"

narratorToSpeed(narrator)
// → 0.8 | 1.0 | 1.2 | 1.4
```

Full `comfyui_tts` call for a narration scene:

```ts
comfyui_tts({
  text: scene.narration,
  voiceInstruct: narratorToVoiceInstruct(storyboard.narrator),
  speed: narratorToSpeed(storyboard.narrator),
  steps: storyboard.narrator.steps ?? 32,
  guidanceScale: storyboard.narrator.guidanceScale ?? 2.0,
  outputPath: `projects/<id>/scenes/scene-<NN>/narration.wav`,
})
// → { outputPath, durationMs }
```

---

## Character Speech vs Narration: The Pivot Rule

The `generate-video-script` skill must assign `audioSource` to every scene.

### Decision guide for the scriptwriter

| Scene type | `audioSource` | Set `dialogue` | Set `narration` | `characterIds` |
|---|---|---|---|---|
| Character talks on camera | `"character-speech"` | yes | no | non-empty |
| B-roll with voiceover | `"narration"` | no | yes | `[]` |
| B-roll without voiceover | `"silent"` | no | no | `[]` |
| Character on screen, narrator speaks | `"narration"` | no | yes | non-empty (poses, no lip sync) |

**Never** set both `dialogue` and `narration` on the same scene. Split into two consecutive scenes if needed.

### What each value produces downstream

**`"character-speech"`:**
1. `generate-video-prompt` injects `scene.dialogue` + `character.speakingAccent` into the LTX 2.3 motion prompt
2. LTX 2.3 generates a speech-animated clip (lip sync + baked audio)
3. `synthesizeNarration` skips this scene
4. `video_merge` uses `scenes/scene-<NN>/clip.mp4` directly

**`"narration"`:**
1. `generate-video-prompt` generates a **motion-only** prompt — no speech animation, no lip sync
2. LTX 2.3 generates a silent b-roll or pose clip
3. `synthesizeNarration` calls `comfyui_tts` → `scenes/scene-<NN>/narration.wav`
4. `video_add_audio(mode: "replace")` → `scenes/scene-<NN>/narrated.mp4`
5. `video_merge` uses `narrated.mp4` for this scene

**`"silent"`:**
1. `generate-video-prompt` generates a motion-only prompt
2. LTX 2.3 generates a clean silent clip
3. `synthesizeNarration` skips this scene
4. `video_merge` uses `clip.mp4`; background music added post-merge

---

## Character Speech Design Attributes

Character speech is animated by LTX 2.3, not comfyui_tts. The only voice-design knob is `Character.speakingAccent`, injected into the video prompt to guide lip sync cadence and facial animation.

### Contrast: `Character.speakingAccent` vs `NarrationVoice`

| Attribute | `Character.speakingAccent` | `NarrationVoice` |
|---|---|---|
| Applies to | On-screen speaking characters | Off-screen narrator |
| Generation engine | LTX-Video 2.3 (ComfyUI, `comfyui_img2video`) | OmniVoice (ComfyUI, `comfyui_tts`) |
| Controls | Lip sync style, facial animation cadence | Full voice synthesis: gender, age, pitch, accent, pace |
| Format | Plain string (language + regional variety) | Structured interface, serialized to `voiceInstruct` |
| Granularity | Per-character | One narrator profile per video |
| Audio source | Baked into video clip (LTX 2.3 audio VAE) | Separate `.wav` file, mixed into clip via `video_add_audio` |

---

## `synthesizeNarration` Pipeline Step

Step 7 in the task DAG — runs after all video clips are approved and before `mergeClips`.

For each scene where `audioSource === "narration"` and `narration` text is non-empty:

1. Call `comfyui_tts`:
   ```ts
   comfyui_tts({
     text: scene.narration,
     voiceInstruct: narratorToVoiceInstruct(storyboard.narrator),
     speed: narratorToSpeed(storyboard.narrator),
     steps: storyboard.narrator.steps ?? 32,
     guidanceScale: storyboard.narrator.guidanceScale ?? 2.0,
     outputPath: `projects/<id>/scenes/scene-<NN>/narration.wav`,
   })
   // → { outputPath, durationMs }
   ```

2. Mix narration audio into the scene clip:
   ```ts
   video_add_audio({
     videoPath: `projects/<id>/scenes/scene-<NN>/clip.mp4`,
     audioPath: `projects/<id>/scenes/scene-<NN>/narration.wav`,
     mode: "replace",
     audioVolume: 1.0,
     fitToVideo: true,
     outputPath: `projects/<id>/scenes/scene-<NN>/narrated.mp4`,
   })
   ```

3. Update project manifest:
   - `scenes[N].narrationAudio` → `{ path: "scenes/scene-<NN>/narration.wav", status: "draft" }`
   - `scenes[N].narratedClip`  → `{ path: "scenes/scene-<NN>/narrated.mp4",  status: "draft" }`

### Clip selection at `mergeClips`

- Scene has approved `narratedClip` → use `narrated.mp4`
- Otherwise → use `clip.mp4`

### Subtitle timing from narration audio

The agent generates a `.ass` subtitle file — not SRT — so font size and safe margins can be precisely calculated from the video resolution. See **Subtitle Layout Calculation** in `docs/design/video-editing.md`.

**Timing rule per scene:**
- `character-speech` → subtitle duration = `parseDurationMs(scene.duration)`
- `narration` → subtitle duration = `durationMs` returned by `comfyui_tts`
- `silent` → no subtitle entry

---

## Narrator Persona Selection Guide

The `generate-video-script` skill uses this to choose `narrator` attributes.

### By platform

| Platform | `gender` | `age` | `pitch` | `pace` | `accent` example |
|---|---|---|---|---|---|
| TikTok | female | young | high | very-fast | american accent |
| Instagram Reels | female | young | high | fast | american accent |
| YouTube Shorts | male/female | young | medium | fast | american accent |
| YouTube (long) | male | middle-aged | low | medium | american accent |
| LinkedIn | male | middle-aged | medium | medium | american accent |

### By content type

| Content type | `gender` | `age` | `pitch` | `pace` |
|---|---|---|---|---|
| Tech explainer | male | young | medium | fast |
| Travel / lifestyle | female | young | high | fast |
| Finance | male | middle-aged | low | medium |
| Fitness / wellness | female | young | high | very-fast |
| History / science | male | middle-aged | low | slow |
| Comedy / entertainment | female | young | high | fast |
| Personal vlog | female | young | medium | medium |

---

## Configuration

`comfyui_tts` uses the existing `config.comfyui` servers — no separate OmniVoice configuration is needed. The OmniVoice workflow (`tts_omnivoice`) is shipped with bolt at `src/workflows/tts_omnivoice.json` and resolved by `ComfyUIPool.loadWorkflow('tts_omnivoice')`.

To override with a custom workflow, place your workflow at `.bolt/workflows/tts_omnivoice.json`.
