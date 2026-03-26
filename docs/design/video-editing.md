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
   */
  subtitlesPath: string;
  /** Output file path (within workspace root) */
  outputPath: string;
  /**
   * "soft": embed subtitles as a selectable track (default, lossless)
   * "hard": burn subtitles into video frames (re-encode required, universally compatible)
   */
  mode?: 'soft' | 'hard';
  /**
   * Language code for the subtitle track (soft mode only), e.g. "en", "zh", "ja"
   * Default: "und" (undetermined)
   */
  language?: string;
  /**
   * Font size for hard-burned subtitles (hard mode only).
   * Default: 24
   */
  fontSize?: number;
  /**
   * Font color for hard-burned subtitles (hard mode only), CSS hex format.
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

**FFmpeg command (hard mode):**
```
ffmpeg -i <videoPath> \
  -vf "subtitles=<subtitlesPath>:force_style='FontSize=<fontSize>,PrimaryColour=&H<abgrColor>&'" \
  -c:a copy \
  <outputPath>
```

**Subtitle format handling:**
- `.vtt` files are converted to `.srt` in a temp file before passing to FFmpeg (FFmpeg's `subtitles` filter requires local SRT/ASS; VTT passthrough is unreliable across versions)
- `.ass` files are used as-is; `force_style` overrides are not applied to ASS files (they carry their own style definitions)

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

When the user requests subtitles, the agent can auto-generate an SRT file from the storyboard `dialogue` fields. The agent calculates timing based on each scene's `duration` field and writes a `scenes/subtitles.srt` file to the project directory before calling `video_add_subtitles`.

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
  subtitles?: Artifact;         // scenes/subtitles.srt
  rawVideo?: Artifact;          // final/raw.mp4  (merged clips, no audio/subs)
  audioVideo?: Artifact;        // final/audio.mp4 (merged + audio)
  finalVideo?: Artifact;        // final/video.mp4 (merged + audio + subtitles)
}
```

### File Naming Conventions (additions)

| Artifact | Path | Notes |
|----------|------|-------|
| Auto-generated subtitles | `scenes/subtitles.srt` | SRT derived from storyboard dialogue |
| User-supplied audio | `audio/<filename>` | Copied to project dir from user-provided path |
| Merged raw video | `final/raw.mp4` | Clips concatenated, no extra audio/subs |
| Video + audio | `final/audio.mp4` | After `video_add_audio` step |
| Final video | `final/video.mp4` | After `video_add_subtitles` (or the last completed step) |

---

## Configuration

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
