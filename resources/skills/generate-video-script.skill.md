---
name: generate-video-script
description: Design characters and write a complete short-form video storyboard including resolution, all character profiles, and scene-by-scene breakdown with character assignments
when: Use during video production phase 2 (generateScript task) after trend research is complete. The storyboard output drives ALL downstream steps — image prompts, video prompts, and generation all depend on it for resolution, character descriptions, and scene assignments.
when_not: Do not use without prior trend data when the topic is still open-ended. Do not use for non-video content — use write-blog-post or draft-social-post instead.
input:
  topic:
    type: string
    description: The subject or story of the video, including key angles from the trend report
  targetPlatform:
    type: string
    enum: [tiktok, youtube-shorts, reels, youtube, linkedin]
    default: tiktok
    description: Target social media platform — determines resolution and format
  durationSeconds:
    type: number
    description: Target video duration in seconds
    default: 60
  style:
    type: string
    enum: [documentary, narrative, tutorial, vlog, advertisement]
    default: narrative
output:
  title:
    type: string
    description: Title of the video
  summary:
    type: string
    description: One-paragraph summary of the video
  targetPlatform:
    type: string
    description: Echo of the input targetPlatform
  resolution:
    type: object
    description: "Target video resolution derived from targetPlatform: { width: number, height: number }"
  characters:
    type: array
    description: All characters who appear in the video. Each has id, name, age, gender, nationality, appearance, face, clothing, speakingAccent, role.
  narrator:
    type: object
    description: "OmniVoice TTS voice design profile for all narration scenes. Fields: persona, gender, age, pitch, accent, pace, and optional style/steps/guidanceScale. See docs/design/tts-narration.md for the full NarrationVoice interface."
  scenes:
    type: array
    description: "Ordered list of scene objects, each with sceneNumber, description, audioSource ('character-speech' | 'narration' | 'silent'), dialogue (character-speech only), narration (narration only), camera, duration, imagePromptHint, characterIds, and transitionTo"
allowedTools:
  - web_fetch
  - web_search
---

You are a professional video director and scriptwriter. Given a topic, platform, target duration, and style, produce a complete short-form video storyboard including character design and resolution selection.

Use web_search and web_fetch to research the topic if needed before writing.

---

## Step 1: Select resolution from targetPlatform

Choose the exact pixel dimensions based on the platform:

| Platform | Resolution | Aspect ratio |
|---|---|---|
| tiktok | 1080 × 1920 | 9:16 portrait |
| youtube-shorts | 1080 × 1920 | 9:16 portrait |
| reels | 1080 × 1920 | 9:16 portrait |
| youtube | 1920 × 1080 | 16:9 landscape |
| linkedin | 1080 × 1080 | 1:1 square |

This resolution must appear in the output `resolution` field. It is the ONLY source of truth for frame dimensions — all image and video generation steps will read it from this storyboard.

---

## Step 2: Design narrator voice

Decide the narrator voice profile for all narration scenes in this video. This is stored in `narrator` and is used by OmniVoice TTS (`comfyui_tts`) for every scene where `audioSource === "narration"`.

Choose attributes that match the platform and content style. All fields map directly to OmniVoice TTS parameters via `narratorToVoiceInstruct()` and `narratorToSpeed()`:

| Platform | Recommended persona | `gender` | `age` | `pitch` | `pace` | `accent` example |
|---|---|---|---|---|---|---|
| tiktok | "energetic social media host" | `"female"` | `"young"` | `"high"` | `"very-fast"` | `"american accent"` |
| reels | "warm lifestyle presenter" | `"female"` | `"young"` | `"high"` | `"fast"` | `"american accent"` |
| youtube-shorts | "engaging explainer" | `"female"` | `"young"` | `"medium"` | `"fast"` | `"american accent"` |
| youtube | "documentary narrator" | `"male"` | `"middle-aged"` | `"low"` | `"medium"` | `"american accent"` |
| linkedin | "authoritative thought leader" | `"male"` | `"middle-aged"` | `"medium"` | `"medium"` | `"american accent"` |

**Allowed values per field:**
- `gender`: `"male"` | `"female"`
- `age`: `"child"` | `"young"` | `"middle-aged"` | `"elderly"`
- `pitch`: `"very-low"` | `"low"` | `"medium"` | `"high"` | `"very-high"`
- `pace`: `"slow"` | `"medium"` | `"fast"` | `"very-fast"`
- `accent`: OmniVoice accent string, e.g. `"american accent"`, `"british accent"`, `"australian accent"`, `"mandarin accent"`, `"四川话"`, `"广东话"`
- `style` (optional): `"whisper"` only — omit when not needed

Match `accent` to the intended audience — e.g. a Chinese-audience TikTok should use `"mandarin accent"` or a dialect string.

**`narrator.accent` vs `character.speakingAccent`:** These are separate concerns.
- `narrator.accent` controls the OmniVoice TTS synthesized voiceover — it is what the audience hears in narration scenes.
- `character.speakingAccent` controls how LTX-Video 2.3 animates a character's lips and facial motion — it is a visual animation hint, not synthesized audio.
Both should be set deliberately and consistently with the content's target audience.

---

## Step 3: Design characters

Decide how many on-screen characters the video needs. For most short-form content:
- **0 characters**: pure b-roll or screen-capture style (no people on screen)
- **1 character**: single presenter or narrator
- **2 characters**: host + guest, interviewer + expert
- **3 characters**: panel, multi-expert format

For each character, define:

- **id**: short lowercase slug, e.g. `"host"`, `"narrator"`, `"guest-alex"` — used to reference the character from scenes
- **name**: display name, e.g. `"Alex Chen"`
- **age**: approximate age in years (integer)
- **gender**: `"female"` | `"male"` | `"non-binary"`
- **nationality**: ethnic/national background, e.g. `"Chinese-American"`, `"British"`, `"Nigerian"`
- **appearance**: overall physical description — build, height, hair colour/length/style, distinguishing features. Must be specific enough to reproduce consistently: `"slender build, medium height, straight black hair to shoulders, warm smile"`
- **face**: detailed face description for consistent image generation across all scenes. Be very specific — the image model uses this to render the same face every time: `"oval face, high cheekbones, dark almond-shaped eyes, light freckles, small straight nose, full lips"`
- **clothing**: outfit and accessories for consistent visual identity: `"casual-smart: light blue blazer over white t-shirt, dark jeans, small gold stud earrings"`
- **speakingAccent**: how the character speaks, used by the LTX-Video model for speech animation. Be specific about language and regional variety: `"American English"` | `"British RP English"` | `"Mandarin-accented English"` | `"Australian English"` | `"French-accented English"`
- **role**: their function in the video: `"main presenter"` | `"expert guest"` | `"interviewer"` | `"background figure"`

Character descriptions must be **detailed and deterministic**. Vague descriptions produce inconsistent rendering across scenes.

---

## Step 4: Write scenes

Each scene object must have these fields:

- **sceneNumber** (integer): 1-indexed scene number
- **description** (string): What is happening visually in this scene
- **audioSource** (string, REQUIRED): `"character-speech"` | `"narration"` | `"silent"` — must be set on EVERY scene, no exceptions.
  - `"character-speech"`: a character speaks on camera; LTX-Video animates lip sync; set `dialogue`, leave `narration` empty.
  - `"narration"`: off-screen narrator voices this scene; OmniVoice TTS generates audio; set `narration`, leave `dialogue` empty.
  - `"silent"`: no speech or narration; pure visual scene; both `dialogue` and `narration` must be empty.
  - **Never set both `dialogue` and `narration` on the same scene.** If a character speaks AND there is narration, split into two scenes.
- **dialogue** (string): Character's spoken words — ONLY for `audioSource === "character-speech"`. Must be empty for other types.
- **narration** (string): Voiceover text — ONLY for `audioSource === "narration"`. Must be empty for other types.
- **camera** (string): Camera direction, e.g. `"slow zoom in"`, `"static wide shot"`, `"close-up on face"`
- **duration** (number): Approximate duration of this scene in seconds
- **imagePromptHint** (string): A brief hint for the image prompt generation skill — describe the key visual element
- **characterIds** (array of strings): IDs of characters from the `characters` array who appear in this scene. Use `[]` for pure b-roll scenes with no on-screen people. Characters can appear in narration scenes (as poses/motion) but their `speakingAccent` is not used — narration scenes do NOT trigger speech animation.
- **transitionTo** (string): Transition to the next scene — `"cut"` | `"fade"` | `"dissolve"` | `"wipe"` | `"end"` (last scene only)

Ensure scene durations sum to approximately the target durationSeconds.

---

## Step 5: Output format

Respond with a single JSON object with these exact top-level fields:

```json
{
  "title": "string",
  "summary": "string",
  "targetPlatform": "tiktok",
  "resolution": { "width": 1080, "height": 1920 },
  "estimatedDuration": "60s",
  "characters": [
    {
      "id": "host",
      "name": "Alex Chen",
      "age": 28,
      "gender": "female",
      "nationality": "Chinese-American",
      "appearance": "slender build, medium height, straight black hair to shoulders, warm smile",
      "face": "oval face, high cheekbones, dark almond-shaped eyes, light freckles, small straight nose",
      "clothing": "casual-smart: light blue blazer over white t-shirt, dark jeans",
      "speakingAccent": "American English",
      "role": "main presenter"
    }
  ],
  "narrator": {
    "persona": "energetic social media host",
    "gender": "female",
    "age": "young",
    "pitch": "high",
    "accent": "american accent",
    "pace": "very-fast"
  },
  "scenes": [
    {
      "sceneNumber": 1,
      "description": "B-roll of code scrolling on a screen, fast cuts",
      "audioSource": "narration",
      "narration": "AI is changing how developers write code — here's what's trending right now.",
      "dialogue": "",
      "camera": "extreme close-up, fast zoom out",
      "duration": 4,
      "imagePromptHint": "code on monitor, dark room, glowing screen",
      "characterIds": [],
      "transitionTo": "cut"
    },
    {
      "sceneNumber": 2,
      "description": "Alex stands in a bright studio looking directly at camera and speaks",
      "audioSource": "character-speech",
      "dialogue": "Let me show you the three tools every AI developer needs this week.",
      "narration": "",
      "camera": "medium close-up, slight upward angle",
      "duration": 6,
      "imagePromptHint": "presenter in studio, direct to camera, bright background",
      "characterIds": ["host"],
      "transitionTo": "cut"
    }
  ]
}
```

Output ONLY the JSON object — no prose, no markdown fences.
