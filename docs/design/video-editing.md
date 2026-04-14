# Video Editing Design

## Overview

bolt uses FFmpeg to perform local post-production on video content: merging scene clips into a final video, mixing in audio (background music, voiceover), and burning or attaching subtitle tracks. These operations run on the machine where bolt is installed — no external server required.

FFmpeg is a system-level dependency. bolt checks for its availability at startup and warns if it is missing. Video editing tools return a non-retryable `ToolError` if FFmpeg is not found when invoked.

## FFmpeg Runner

`FfmpegRunner` is a low-level wrapper around the `ffmpeg` CLI. All video editing tools delegate to it. It is not a registered Tool Bus tool — it is an internal module used by the video tool implementations.

```ts
interface FfmpegProgress {
  /** Frames processed so far */
  frame?: number;
  /** Estimated total frames */
  totalFrames?: number;
  /** Current processing speed (e.g. "2.5x") */
  speed?: string;
  /** Elapsed time string from ffmpeg output */
  time?: string;
}

interface FfmpegResult {
  /** Absolute path to the output file */
  outputPath: string;
  /** Wall-clock duration in milliseconds */
  durationMs: number;
  /** FFmpeg stderr output (includes encoding summary) */
  stderr: string;
}

class FfmpegRunner {
  /**
   * Returns the resolved path to the ffmpeg binary, or null if not found.
   * Result is cached after the first call.
   */
  static async detect(): Promise<string | null>;

  /**
   * Execute an ffmpeg command with the given argument array.
   * Streams stderr to the provided progress callback as frames are processed.
   * Rejects with FfmpegError on non-zero exit code.
   */
  async run(
    args: string[],
    opts: {
      onProgress?: (p: FfmpegProgress) => void;
      timeoutMs?: number;       // default: no timeout (operations can be slow)
    }
  ): Promise<FfmpegResult>;
}

class FfmpegError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly exitCode: number
  ) { super(message); }
}
```

### Binary Detection

`FfmpegRunner.detect()` resolves the ffmpeg binary path:

1. `config.ffmpeg.path` — explicit path from `.bolt/config.json`
2. `which ffmpeg` — system PATH lookup
3. Returns `null` if neither succeeds; bolt logs a startup warning

### Progress Parsing

FFmpeg writes progress lines to stderr in the format:
```
frame=  120 fps= 24 q=28.0 size=    1024kB time=00:00:05.00 bitrate=1677.7kbits/s speed=2.5x
```

`FfmpegRunner` parses these lines to emit `FfmpegProgress` events, which are forwarded to the `ProgressReporter` so the user sees real-time feedback in the CLI or WebChannel.

### Workspace Safety

All input and output paths passed to `FfmpegRunner` must be **within the current workspace root**. The tool implementations enforce this by resolving paths against `context.cwd` and rejecting any path that escapes the workspace with a non-retryable `ToolError`. This is consistent with the workspace confinement policy in `docs/design/workspace.md`.

---

## Tools

### `video_merge`

Concatenate multiple video clips into a single output file, preserving audio tracks from each clip.

**Implementation:** Uses the FFmpeg concat demuxer (a temporary `list.txt` file listing all inputs). This approach is lossless for clips with matching codec/resolution; if clips differ, a re-encode pass is triggered automatically using `-vf scale` and `-filter_complex concat`.

```ts
interface VideoMergeInput {
  /**
   * Ordered list of clip paths to concatenate.
   * All paths must be within the workspace root.
   * Minimum 2 clips.
   */
  clips: string[];
  /**
   * Output file path (within workspace root).
   * Extension determines container format; defaults to .mp4
   */
  outputPath: string;
  /**
   * Re-encode output instead of stream-copy.
   * Set to true when source clips have different resolutions or codecs.
   * Default: false (stream-copy for speed; falls back to re-encode on failure).
   */
  reencode?: boolean;
}

interface VideoMergeOutput {
  /** Absolute path of the merged output file */
  outputPath: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Duration of the merged video in seconds */
  videoDurationSec: number;
}
```

**FFmpeg command (stream-copy path):**
```
ffmpeg -f concat -safe 0 -i list.txt -c copy <outputPath>
```

**FFmpeg command (re-encode path):**
```
ffmpeg -f concat -safe 0 -i list.txt \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2" \
  -c:v libx264 -crf 23 -preset fast -c:a aac -b:a 128k <outputPath>
```

**Error cases:**
- Fewer than 2 clips → non-retryable `ToolError`
- Any clip path outside workspace root → non-retryable `ToolError`
- Clip file not found → non-retryable `ToolError`
- FFmpeg non-zero exit → `ToolError` with stderr; retryable only if exit code is 255 (signal)

---

### `video_add_audio`

Add or replace an audio track in a video file. Supports mixing a background track with existing audio or replacing audio entirely.

```ts
interface VideoAddAudioInput {
  /** Input video file path (within workspace root) */
  videoPath: string;
  /** Audio file path to add (within workspace root). Supports mp3, aac, wav, ogg. */
  audioPath: string;
  /** Output file path (within workspace root) */
  outputPath: string;
  /**
   * How to handle audio:
   * - "replace": discard existing audio, use provided audio only
   * - "mix": mix provided audio with the existing video audio
   * Default: "replace"
   */
  mode?: 'replace' | 'mix';
  /**
   * Volume of the added audio track (0.0 – 2.0).
   * Default: 1.0
   */
  audioVolume?: number;
  /**
   * Volume of the original video audio when mode is "mix" (0.0 – 2.0).
   * Default: 1.0
   */
  originalVolume?: number;
  /**
   * Trim added audio to match video duration if audio is longer.
   * Loop added audio if it is shorter than the video.
   * Default: true
   */
  fitToVideo?: boolean;
}

interface VideoAddAudioOutput {
  outputPath: string;
  durationMs: number;
}
```

**FFmpeg command (replace mode):**
```
ffmpeg -i <videoPath> -i <audioPath> \
  -map 0:v:0 -map 1:a:0 \
  -c:v copy -c:a aac -b:a 128k \
  -shortest \
  <outputPath>
```

**FFmpeg command (mix mode with volume + loop):**
```
ffmpeg -i <videoPath> -stream_loop -1 -i <audioPath> \
  -filter_complex "[0:a]volume=<originalVolume>[orig];[1:a]volume=<audioVolume>[added];[orig][added]amix=inputs=2:duration=first[aout]" \
  -map 0:v:0 -map "[aout]" \
  -c:v copy -c:a aac -b:a 128k \
  -shortest \
  <outputPath>
```

**Error cases:**
- `audioVolume` or `originalVolume` outside [0.0, 2.0] → non-retryable `ToolError`
- Video or audio file not found → non-retryable `ToolError`
- Either path outside workspace root → non-retryable `ToolError`

---

### `video_add_subtitles`

Attach a subtitle track to a video. Supports two modes:

- **Soft subtitles** (default): Subtitle data is embedded in the container as a selectable track. The subtitle file is not re-encoded into the picture; viewers can toggle them on/off. Requires an MP4/MKV container.
- **Hard subtitles**: Subtitles are rendered ("burned") into the video frames. Output is compatible with any player regardless of subtitle support.

```ts
interface VideoAddSubtitlesInput {
  /** Input video file path (within workspace root) */
  videoPath: string;
  /**
   * Subtitle file path (within workspace root).
   * Supported formats: .srt (SubRip), .vtt (WebVTT), .ass (Advanced SubStation Alpha)
   *
   * For hard-burned subtitles: ALWAYS provide a .ass file, not .srt.
   * The .ass file must be generated by the agent using the Subtitle Layout Calculation
   * algorithm (see below). This ensures font size and margins are correct for the
   * video's actual resolution. An SRT file with force_style cannot guarantee safe
   * margins because FFmpeg's virtual coordinate scaling is version-dependent.
   *
   * For soft subtitles: .srt is sufficient (the player controls rendering).
   */
  subtitlesPath: string;
  /** Output file path (within workspace root) */
  outputPath: string;
  /**
   * "soft": embed subtitles as a selectable track (default, lossless)
   * "hard": burn subtitles into video frames (re-encode required, universally compatible)
   *
   * Social media platforms (TikTok, Reels, Shorts) strip soft subtitle tracks on upload.
   * Use "hard" for all social content. Use "soft" only for archival or desktop playback.
   */
  mode?: 'soft' | 'hard';
  /**
   * Language code for the subtitle track (soft mode only), e.g. "en", "zh", "ja"
   * Default: "und" (undetermined)
   */
  language?: string;
  /**
   * Font size for hard-burned subtitles (hard mode only), in pixels.
   * IGNORED when subtitlesPath is a .ass file — the ASS style definition controls
   * font size. Only applied when subtitlesPath is .srt or .vtt via force_style.
   * Default: 24 (too small for most social video — use ASS instead)
   */
  fontSize?: number;
  /**
   * Font color for hard-burned subtitles (hard mode only), CSS hex format.
   * IGNORED when subtitlesPath is a .ass file.
   * Default: "#ffffff" (white)
   */
  fontColor?: string;
}

interface VideoAddSubtitlesOutput {
  outputPath: string;
  durationMs: number;
  /** Number of subtitle entries parsed from the input file */
  subtitleCount: number;
}
```

**FFmpeg command (soft mode, SRT → MP4):**
```
ffmpeg -i <videoPath> -i <subtitlesPath> \
  -c:v copy -c:a copy -c:s mov_text \
  -metadata:s:s:0 language=<language> \
  <outputPath>
```

**FFmpeg command (hard mode, ASS input — recommended):**
```
ffmpeg -i <videoPath> \
  -vf "ass=<subtitlesPath>" \
  -c:a copy \
  <outputPath>
```

The `ass` filter renders an ASS file directly onto video frames. All styling (font size, color, margins, outline) is defined inside the ASS file itself.

**FFmpeg command (hard mode, SRT/VTT input — fallback only):**
```
ffmpeg -i <videoPath> \
  -vf "subtitles=<subtitlesPath>:force_style='FontSize=<fontSize>,PrimaryColour=&H<abgrColor>&'" \
  -c:a copy \
  <outputPath>
```

Only use the SRT path when the agent does not have resolution information. Prefer ASS.

**Subtitle format handling:**
- `.ass` files are rendered with the `ass` filter (hard mode) or embedded as a track (soft mode); style definitions inside the file are authoritative — no `force_style` override
- `.srt` files are rendered with the `subtitles` filter and `force_style` (hard mode) or embedded as `mov_text` (soft mode)
- `.vtt` files are converted to `.srt` in a temp file before passing to FFmpeg (VTT passthrough is unreliable across FFmpeg versions)

**Error cases:**
- Unsupported subtitle format → non-retryable `ToolError`
- Subtitle file not found → non-retryable `ToolError`
- Either path outside workspace root → non-retryable `ToolError`
- Hard mode with a container that does not support subtitle streams → `ToolError` with a hint to use `.mp4` or `.mkv`

---

## Integration with the Content Project Workflow

After all scene clips are generated and approved (S10-3), the post-production workflow adds three further steps:

```
  ...approved scene clips...
        │
  ┌─────▼───────────────────────────────┐
  │  7. video_merge                     │
  │     Concatenate all scene clips     │
  │     → projects/<id>/final/raw.mp4   │
  │     user_review → approve/redo      │
  └─────────────┬───────────────────────┘
               │
  ┌────────────▼────────────────────────┐
  │  8. video_add_audio (optional)      │
  │     Add background music/voiceover  │
  │     → projects/<id>/final/audio.mp4 │
  │     user_review → approve/redo      │
  └────────────┬────────────────────────┘
               │
  ┌────────────▼────────────────────────┐
  │  9. video_add_subtitles (optional)  │
  │     Embed subtitles from storyboard │
  │     → projects/<id>/final/video.mp4 │
  │     user_review → approve           │
  └────────────┬────────────────────────┘
               │
               ▼
         Final video saved
         Channel completion message sent (S10-4)
```

Steps 8 and 9 are **optional**: if the user did not provide an audio file or does not want subtitles, those tasks are skipped and the previous step's output becomes the final video.

### Subtitle Generation from Storyboard

When the user requests subtitles, the agent generates a `.ass` subtitle file from the storyboard's `dialogue` and `narration` fields. For hard-burned social content, ASS format is required — it gives precise per-pixel control over font size and safe margins. The agent writes the ASS file to `scenes/subtitles.ass` and passes it to `video_add_subtitles(mode: "hard")`.

**Important:** Apply the Subtitle Layout Calculation (see section below) before writing the ASS file. Never use a fixed font size — always calculate from the video resolution and the length of each subtitle entry.

See also `docs/design/tts-narration.md` for how subtitle timing is derived from TTS audio duration for narration scenes.

### Content Project Manifest Extensions

The `ContentProject` manifest (`project.json`) is extended to track post-production artifacts:

```ts
interface ContentProject {
  // ... existing fields ...
  taskIds: {
    // ... existing fields ...
    mergeClips?: string;
    addAudio?: string;
    addSubtitles?: string;
  };
  artifacts: {
    // ... existing fields ...
    postProduction?: PostProductionArtifacts;
  };
}

interface PostProductionArtifacts {
  subtitles?: Artifact;         // scenes/subtitles.ass  (ASS for hard-burned social content)
  rawVideo?: Artifact;          // final/raw.mp4  (merged clips, no audio/subs)
  audioVideo?: Artifact;        // final/audio.mp4 (merged + audio)
  finalVideo?: Artifact;        // final/video.mp4 (merged + audio + subtitles)
}
```

### File Naming Conventions (additions)

| Artifact | Path | Notes |
|----------|------|-------|
| Auto-generated subtitles | `scenes/subtitles.ass` | ASS with calculated font size and safe margins |
| User-supplied audio | `audio/<filename>` | Copied to project dir from user-provided path |
| Merged raw video | `final/raw.mp4` | Clips concatenated, no extra audio/subs |
| Video + audio | `final/audio.mp4` | After `video_add_audio` step |
| Final video | `final/video.mp4` | After `video_add_subtitles` (or the last completed step) |

---

## Subtitle Layout Calculation

Before writing the `.ass` file, the agent calculates font size and safe-zone margins for each subtitle entry. The goal is text that is:
- **Readable** — never smaller than 3% of the video height
- **Proportionate** — never larger than 6.5% of the video height (avoids blocking the image)
- **Safe from cropping** — horizontal and vertical margins keep text inside the frame on every platform/player
- **Self-wrapping** — longer text uses a smaller font so it still wraps within 2 lines; entries that exceed the 2-line limit at minimum font size are split at word boundaries

### Constants

```
CHAR_ASPECT_RATIO  = 0.55   // average char_width / fontSize for Arial/sans-serif (unitless)
MAX_LINES          = 2      // maximum subtitle lines per entry (readability limit)
MIN_FONT_SIZE_PCT  = 0.030  // minimum font size as fraction of video height
MAX_FONT_SIZE_PCT  = 0.065  // maximum font size as fraction of video height
MARGIN_X_PCT       = 0.05   // horizontal safe-zone as fraction of video width (each side)

// Vertical margin from the bottom edge — larger on portrait to clear gesture/nav bars
MARGIN_BOTTOM_PCT_PORTRAIT  = 0.12   // 9:16 portrait (TikTok, Reels, Shorts)
MARGIN_BOTTOM_PCT_LANDSCAPE = 0.08   // 16:9 landscape (YouTube)
MARGIN_BOTTOM_PCT_SQUARE    = 0.08   // 1:1 square (LinkedIn)
```

### Per-resolution derived values

```
marginX      = round(width  × MARGIN_X_PCT)
marginBottom = round(height × MARGIN_BOTTOM_PCT_<aspect>)
usableWidth  = width - 2 × marginX
minFontSize  = round(height × MIN_FONT_SIZE_PCT)
maxFontSize  = round(height × MAX_FONT_SIZE_PCT)
```

**Lookup table for the three canonical resolutions:**

| Platform | width | height | marginX | marginBottom | usableWidth | minFont | maxFont |
|---|---|---|---|---|---|---|---|
| TikTok / Reels / Shorts | 1080 | 1920 | 54 | 230 | 972 | 58 | 125 |
| YouTube | 1920 | 1080 | 96 | 87 | 1728 | 32 | 70 |
| LinkedIn | 1080 | 1080 | 54 | 87 | 972 | 32 | 70 |

### Per-entry font size formula

For each subtitle entry with text `T` (after whitespace normalisation):

```
charCount         = T.length
fontSizeForFit    = floor( (usableWidth × MAX_LINES) / (charCount × CHAR_ASPECT_RATIO) )
fontSize          = clamp(fontSizeForFit, minFontSize, maxFontSize)
```

**Intuition:** `usableWidth / (fontSize × CHAR_ASPECT_RATIO)` gives characters per line at that font size. Multiplied by `MAX_LINES = 2`, that is the maximum characters that fit at that size. Inverting gives the largest font where all characters still wrap within 2 lines.

**Worked examples — TikTok portrait (1080 × 1920):**

| Text | chars | fontSizeForFit | clamped fontSize | lines at result |
|---|---|---|---|---|
| "AI is changing code" | 20 | floor(972×2 / (20×0.55)) = floor(176.7) = 176 | **125** (capped) | 2 lines — large, prominent |
| "Here are 3 tools every AI developer needs this week" | 52 | floor(972×2 / (52×0.55)) = floor(67.9) = 67 | **67** | 2 lines |
| "LTX-Video 2.3 generates speech-animated clips from a single source image using a 22B parameter model" | 97 | floor(972×2 / (97×0.55)) = floor(36.4) = 36 | **58** (floored to min) | ~3.6 lines → **split required** |

**Split rule:** if `charCount > floor(usableWidth × MAX_LINES / (minFontSize × CHAR_ASPECT_RATIO))`, the entry exceeds the 2-line limit at minimum font size and must be split. For TikTok, split threshold = `floor(972 × 2 / (58 × 0.55)) = floor(60.8) = 60 chars`. Split at the nearest word boundary at or before that character position.

### ASS file structure

The agent writes the entire subtitle file in ASS format. `PlayResX` and `PlayResY` are set to the exact video dimensions so all pixel values are 1:1:

```
[Script Info]
ScriptType: v4.00+
PlayResX: <width>
PlayResY: <height>
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,<fontSize>,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,<marginX>,<marginX>,<marginBottom>,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,<start>,<end>,Default,,0,0,0,,<text>
```

**Style field meanings:**
- `PrimaryColour=&H00FFFFFF` — white text (ABGR format: A=00, B=FF, G=FF, R=FF)
- `BorderStyle=1` — outline + shadow (most readable over varied backgrounds)
- `Outline=2` — 2px black outline (legible over both light and dark content)
- `Shadow=1` — 1px drop shadow (extra depth on uniform-color backgrounds)
- `Alignment=2` — bottom-center (ASS numpad alignment: 2 = bottom center)
- `MarginL=<marginX>, MarginR=<marginX>` — horizontal safe zone in pixels
- `MarginV=<marginBottom>` — minimum distance from the bottom frame edge in pixels
- `WrapStyle=0` — smart wrap: break at word boundaries, never mid-word

**Per-entry override for font size:**
Each subtitle entry can override the style's `FontSize` by using an inline ASS tag if its `fontSize` differs from the Default style's value. In practice, write a new named style for each distinct font size and reference it in the `Dialogue` line:

```
Style: Large,Arial,125,&H00FFFFFF,...
Style: Medium,Arial,68,&H00FFFFFF,...
Style: Small,Arial,58,&H00FFFFFF,...
...
Dialogue: 0,0:00:00.00,0:00:03.00,Large,,0,0,0,,AI is changing code
Dialogue: 0,0:00:03.50,0:00:08.50,Medium,,0,0,0,,Here are 3 tools every AI developer needs this week
```

All styles share the same `MarginL`, `MarginR`, `MarginV` values — only `Fontsize` varies.

### Time format

ASS uses `H:MM:SS.cs` (centiseconds, not milliseconds):

```
// Convert durationMs to ASS timecode
function toAssTime(ms: number): string {
  const cs = Math.round(ms / 10)
  const h  = Math.floor(cs / 360000);      cs %= 360000
  const m  = Math.floor(cs / 6000);        cs %= 6000
  const s  = Math.floor(cs / 100);         cs %= 100
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`
}
```

### Full algorithm (pseudocode)

```
function buildSubtitleAss(storyboard, narrationDurations, resolution):
  aspect = getAspect(resolution)  // "portrait" | "landscape" | "square"
  marginX      = round(resolution.width  × MARGIN_X_PCT)
  marginBottom = round(resolution.height × MARGIN_BOTTOM_PCT[aspect])
  usableWidth  = resolution.width - 2 × marginX
  minFontSize  = round(resolution.height × MIN_FONT_SIZE_PCT)
  maxFontSize  = round(resolution.height × MAX_FONT_SIZE_PCT)
  splitLimit   = floor(usableWidth × MAX_LINES / (minFontSize × CHAR_ASPECT_RATIO))

  entries = []
  timecursorMs = 0

  for scene in storyboard.scenes:
    sceneDurationMs = parseDurationMs(scene.duration)
    text = null
    displayDurationMs = null

    if scene.audioSource == "character-speech" && scene.dialogue:
      text = scene.dialogue
      displayDurationMs = sceneDurationMs    // show full scene duration
    else if scene.audioSource == "narration" && scene.narration:
      text = scene.narration
      displayDurationMs = narrationDurations[scene.sceneNumber]  // TTS audio length
    // else: silent — no subtitle entry

    if text:
      // Split if text exceeds 2-line limit at minimum font size
      chunks = splitAtWordBoundary(text, splitLimit)
      chunkDurationMs = floor(displayDurationMs / chunks.length)

      for i, chunk in enumerate(chunks):
        startMs = timecursorMs + i * chunkDurationMs
        endMs   = timecursorMs + (i+1) * chunkDurationMs
        charCount = chunk.length
        fontSize  = clamp(floor((usableWidth×MAX_LINES)/(charCount×CHAR_ASPECT_RATIO)),
                          minFontSize, maxFontSize)
        entries.push({ start: startMs, end: endMs, text: chunk, fontSize })

    timecursorMs += sceneDurationMs

  uniqueFontSizes = deduplicate(entries.map(e => e.fontSize))
  styles = uniqueFontSizes.map(s => buildAssStyle(s, marginX, marginBottom))
  dialogues = entries.map(e => buildAssDialogue(e, styles))

  return assFileContent(resolution, styles, dialogues)
```

---

```jsonc
// .bolt/config.json (additions)
{
  "ffmpeg": {
    // Explicit path to ffmpeg binary. If omitted, resolved via PATH.
    "path": "/usr/local/bin/ffmpeg",
    // Default output video codec for re-encode operations.
    "videoCodec": "libx264",         // default
    // Default CRF quality (lower = better quality, larger file). Range 0-51.
    "crf": 23,                       // default
    // Default encoding preset (ultrafast..veryslow). Affects speed vs file size.
    "preset": "fast",                // default
    // Default audio codec for operations that re-encode audio.
    "audioCodec": "aac",             // default
    // Default audio bitrate.
    "audioBitrate": "128k"           // default
  }
}
```

---

## Error Handling Summary

| Condition | Error type | Retryable |
|-----------|-----------|-----------|
| `ffmpeg` not found | `ToolError` | No |
| Input file not in workspace | `ToolError` | No |
| Input file not found | `ToolError` | No |
| FFmpeg exits non-zero (encoding error) | `ToolError` with stderr | No |
| FFmpeg killed by signal (SIGKILL/SIGTERM) | `ToolError` | Yes |
| Timeout (if configured) | `ToolError` | Yes |
