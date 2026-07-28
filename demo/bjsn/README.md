# BJSN reference player

A standalone MSE player for TikTok's BJSN (Bytedance JSON) CMAF format, written
directly against Media Source Extensions and **not** using Shaka Player.

This is the working reference implementation. Its behaviour is the contract that
the Shaka integration must match — see
[`docs/design/bjsn-integration-plan-v2.md`](../../docs/design/bjsn-integration-plan-v2.md),
§2 ("Ground truth"). When the integration and this player disagree, this player
is right until proven otherwise.

## Files

| File | Contents |
| --- | --- |
| `bjsn_player.html` | UI, controls, log pane, timing-metrics panel |
| `bjsn_utils.js` | `BjsnParser`, `BjsnCodecDetector`, `Mp4BoxUtils`, `BjsnMp4Processor`, `ProgressiveMp4Parser` |
| `bjsn_mse.js` | `SegmentDownloadManager`, `SourceBufferStateMachine`, `MediaSourceOrchestrator`, `TimestampManager`, `PlaybackSession` |

Self-contained: `bjsn_player.html` loads only the two sibling scripts. No build
step, no Shaka dependency.

## Running

Serve the repo root over HTTP (the player uses `fetch` + `ReadableStream`, so
`file://` will not work) and open the page:

```bash
python3 -m http.server 8080
# → http://localhost:8080/demo/bjsn/bjsn_player.html
```

Paste the URL of a BJSN initial segment into the input and press Load. The
player fetches that file progressively, then polls
`template_path` with `seq_num + 1` for subsequent segments.

## Test fixtures

Two tiers:

**Committed** — `test/test/assets/bjsn-initial-segment.mp4` (77 KB) is the
canonical fixture, following the repo convention for binary test assets. It is a
captured initial segment: `ftyp` (24 B) + `moov` (1080 B, video + audio `trak`) +
`bjsn` (433 B at offset 1104, `type: dynamic`, `gear_num: 9`, `seq_num: 11905`,
`template_path: "media_${num}.mp4"`) + interleaved `moof`/`mdat` pairs. Unit
tests load it the standard way:

```js
const uri = '/base/test/test/assets/bjsn-initial-segment.mp4';
```

**Local scratch** — `testdata/` at the repo root is `.gitignore`d. Put ad-hoc
captures, other gears, and stripper output there. Only promote a file to
`test/test/assets/` when a test actually needs it, and keep it small.

Fixtures come from a live origin, so URLs expire when it rotates. Re-capture with
`curl -o` and check you got media rather than an error body:

```bash
xxd testdata/bjsn/<file>.mp4 | head -1   # must start with a valid ftyp box
```

Three 9-byte files containing the string `Not Found` were removed from this repo
during the v2 cleanup — check for that failure mode before assuming a capture
worked.

## Inspecting segments

`tools/bjsn-stripper-cli.js` reads and strips `bjsn` boxes offline:

```bash
node tools/bjsn-stripper-cli.js --info testdata/bjsn/media_first.mp4
```

See [`tools/README.md`](../../tools/README.md).

## Known quirks

Worth knowing before you use this player as a behavioural reference:

- **`timestampOffset` is never applied.** The assignment in
  `SourceBufferStateMachine.transitionToAppending` is commented out.
  `TimestampManager` computes offsets that are only ever logged. Playback works
  because `MediaSourceOrchestrator.onBufferUpdated` sets
  `video.currentTime = buffered.start(0)` once, leaving the media timeline
  untouched. The Shaka integration cannot take this shortcut — see plan §3.4.
- **Segment duration is hard-coded** to 2000 ms in
  `PlaybackSession.scheduleNextSegmentFetch`.
- **Two tracks assumed**: exactly one `vide` and one `soun` track; anything else
  throws in `onInitSegmentsAvailable`.
- **Single gear**: `gear_list` is parsed and displayed but no ABR or gear
  switching is implemented.
