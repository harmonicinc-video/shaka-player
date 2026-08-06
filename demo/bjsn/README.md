# BJSN players

Two players for TikTok's BJSN (Bytedance JSON) CMAF format, on the same test
harness and reporting the same startup metrics:

- **`bjsn_player.html`** — standalone, written directly against Media Source
  Extensions, **no** Shaka Player. The working reference implementation.
- **`bjsn_shaka_player.html`** — the same format played through `shaka.Player`,
  via a manifest parser plugin registered from this directory. Zero changes to
  `lib/`.

The standalone player's behaviour is the contract the Shaka integration must
match — see
[`docs/design/bjsn-integration-plan-v2.md`](../../docs/design/bjsn-integration-plan-v2.md),
§2 ("Ground truth"). When the two disagree, the standalone player is right until
proven otherwise.

## Files

| File | Contents |
| --- | --- |
| `bjsn_player.html` | Standalone player: UI, controls, log pane, timing-metrics panel |
| `bjsn_utils.js` | `BjsnParser`, `BjsnCodecDetector`, `Mp4BoxUtils`, `BjsnMp4Processor`, `ProgressiveMp4Parser` — shared by both players |
| `bjsn_mse.js` | `SegmentDownloadManager`, `SourceBufferStateMachine`, `MediaSourceOrchestrator`, `TimestampManager`, `PlaybackSession` |
| `bjsn_shaka_player.html` | Shaka player: same panels, plus a timeline/buffer pane and Shaka's own stats |
| `bjsn_shaka_parser.js` | `BjsnShakaParser` (a `shaka.extern.ManifestParser`), `BjsnSegmentBytes` |
| `bjsn_timing_probe.js` | `BjsnTimingProbe` — player-agnostic MSE instrumentation |
| `spike-muxed-buffer.html` | Phase 1 architecture spike (see below) |

`bjsn_player.html` is self-contained: it loads only the two sibling scripts, with
no build step and no Shaka dependency.

## Running

Serve the repo root over HTTP (both players use `fetch` + `ReadableStream`, so
`file://` will not work):

```bash
python3 -m http.server 8080
# standalone → http://localhost:8080/demo/bjsn/bjsn_player.html
# shaka      → http://localhost:8080/demo/bjsn/bjsn_shaka_player.html
```

Paste the URL of a BJSN segment into the input and press Load. The standalone
player fetches that file progressively, then polls `template_path` with
`seq_num + 1` for subsequent segments.

The Shaka page needs `dist/deps.js` first, because it runs the library
uncompiled through the Closure debug loader:

```bash
python3 build/gendeps.py     # writes dist/deps.js; no Java needed
```

That is the only build step the page needs, and it is far cheaper than a full
`build/all.py`. If the page reports that the library never finished loading, a
missing or stale `dist/deps.js` is the first thing to check.

## Running the tests

`python3 build/test.py` and `python3 build/all.py` need two things that are easy
to lose:

1. **Java on PATH.** The Closure compiler runs as `java -jar`, and the JDK
   installed here is keg-only, so it is on PATH only if you put it there:

   ```bash
   export PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH"
   ```

2. **`node_modules/wd/build/`**, which `npm install` does *not* create on this
   machine because `~/.npmrc` sets `ignore-scripts=true`. Without it karma dies
   with `Cannot find plugin "karma-local-wd-launcher"` — which names the wrong
   package; the one at fault is `wd`. Fix:

   ```bash
   node node_modules/wd/scripts/build-browser-scripts.js
   ```

   **Re-run this after every `npm install`.** It writes only inside
   `node_modules/`, so no commit can carry it for you.

A `chromedriver` matching your Chrome is required too, and is not currently
installed — Shaka drives browsers only over WebDriver. See the plan's toolchain
section for the full story on all three.

## The Shaka player

`bjsn_shaka_player.html` is the demo-level prototype of **Phase 3** of the
integration plan, built to answer one question early: can `shaka.Player` play
BJSN without touching `lib/`? It can. Three public extension points do it:

| Extension point | Used for |
| --- | --- |
| `ManifestParser.registerParserByMime('application/bjsn', …)` | Registering the parser. Pass the mime type as `load()`'s third argument — a `.mp4` URL would otherwise be treated as progressive `src=` content. |
| `InitSegmentReference.setSegmentData()` / `SegmentReference.setSegmentData()` | Handing over the already-downloaded first file, so it is never fetched twice. |
| `NetworkingEngine.registerResponseFilter()` | Stripping `bjsn` out of subsequent segments and reading the in-band `seq_num` back out of them. |

### Shape: Option A, and why *not* `isAudioMuxedInVideo`

Per the Phase 1 spike the parser publishes a **single** video `Stream` whose
codec string carries both codecs (`video/mp4; codecs="avc1.42E01E,mp4a.40.2"`)
and leaves `variant.audio` null. One SourceBuffer, file appended as-is, browser
decodes both tracks.

`stream.isAudioMuxedInVideo` looks like the obvious flag for this and is the
wrong one: it sets `needSplitMuxedContent_` in `media_source_engine.js`, which
makes Shaka *demux* into two buffers — the opposite of Option A, and the
HLS-shaped path where v1 already hit a bug. What actually makes Option A work is
`stream_utils.js` `getDecodingConfigs_()` (lines ~806–831), which already handles
a comma-separated video codec list with no separate audio stream by building both
an `AudioConfiguration` and a `VideoConfiguration` for MediaCapabilities. A muxed
video-only variant is therefore a first-class shape in Shaka and needs no core
diff.

The cost is Option A's usual one: no independent audio track selection and no
per-track ABR. `player.getVariantTracks()` reports one video-only variant.

### Verified behaviour (2026-07-29, Chrome, synthetic fixture set)

Loading `test/test/assets/bjsn/media_11905.mp4`:

- **one** SourceBuffer, `video/mp4; codecs="avc1.42E01E,mp4a.40.2"`
- init append classified `ftyp+moov`, media appends `styp+moof+mdat…` — so
  `styp` survives the strip, which §3.1 warns about
- both tracks decode (video *and* non-zero audio bytes), rendered 270x480
- playback starts at `t0` = 2333.176 s, the first segment, and runs through all
  five fixtures to 2343.176 s
- 6 appends total: 1 init + 5 media, 827731 bytes

Startup marks from a representative run: source open 16 ms, first byte 38 ms,
`bjsn` parsed 50 ms, `moov` parsed 47 ms, manifest ready 54 ms, `player.load()`
resolved 101 ms, init append 112 ms, first media append 147 ms, `canplay`
118–148 ms, playing 191 ms.

### Three things this prototype got wrong first, worth not repeating

All three are Shaka defaults that fight the shape of a BJSN manifest, and all
three look like something other than what they are.

- **Shaka starts a live stream at the live edge.** At manifest time the index
  holds exactly one reference, so the live edge *is* that segment's end — and
  Shaka began at `seq_num + 1`, skipping the file the user asked for and
  discarding the bytes retained for `setSegmentData()`. Fixed by setting
  `manifest.startTime = t0`, which the extern documents as overriding the load
  start time when that is not defined.
- **Never publish references on a timer alone.** Adding one reference per segment
  duration regardless of what exists lets `notifySegments()` drag the live edge
  away from the content: in a first run the index advertised out to `seq 12006`
  (media time 2539 s) while the origin was stuck at 11909, so the play head
  chased an edge with no media behind it and every fetch 404'd. A real origin
  that pauses publication produces the same failure. The parser now keeps at most
  **one** unconfirmed reference outstanding, gated on the `seq_num` read from the
  in-band `bjsn` box, and anchors each new reference to the *real* media end time
  of the segment that arrived rather than accumulating duration estimates.
- **Segment prefetch must be switched off, or every segment downloads twice.**
  `streaming.segmentPrefetchLimit` defaults to **1**. `SegmentPrefetch` builds its
  `SegmentIterator` once and ignores the `currTime` of every later call
  (`segment_prefetch.js:90–93`), and `SegmentIterator.next()` advances its position
  even when it runs off the end of the index (`segment_index.js:658`). Since the
  gate above means the next reference often does not exist yet, the post-append
  prefetch call comes back empty *and still advances* — after which the iterator
  is permanently one behind and nothing re-syncs it. The prefetcher then fetches a
  segment that was already appended, that stale entry fills the single prefetch
  slot, and the lookup for the segment actually needed misses, so Shaka downloads
  it separately. Measured 2026-08-04: `media_11907` and `media_11908` each fetched
  twice, one segment out of step. Fixed with `segmentPrefetchLimit: 0`, which is
  also what makes the startup metrics comparable — the standalone player has no
  prefetch either. Nothing is lost: segments do not exist until the origin
  publishes them, so there was never anything useful to fetch ahead.

### The timing probe

`bjsn_timing_probe.js` measures startup by wrapping the MSE entry points any MSE
player must go through — the `MediaSource` constructor (for `sourceopen`),
`addSourceBuffer()`, and `appendBuffer()` — classifying each append as init or
media by sniffing its box types. Because it hooks the platform rather than the
player, it measures both players on identical axes, which is what makes them
comparable for Phase 6. Steps the platform cannot see (first byte, `bjsn`
parsed, `moov` parsed) are marked explicitly by the page.

The patches are global but scoped to a session and fully restored on stop. It is
a test-harness technique and has no business anywhere near `lib/`.

Option A means there is a single SourceBuffer, so the standalone player's
separate "video init append" and "audio init append" numbers collapse into one
init append. The panel says so rather than inventing two values.

## Test fixtures

Two tiers:

**Committed, real** — `test/test/assets/bjsn-initial-segment.mp4` (77 KB), the
one genuine capture, following the repo convention for binary test assets. An
initial segment: `ftyp` (24 B) + `moov` (1080 B, video + audio `trak`) + `bjsn`
(433 B at offset 1104, `type: dynamic`, `gear_num: 9`, `seq_num: 11905`,
`template_path: "media_${num}.mp4"`) + 116 interleaved `moof`/`mdat` pairs
(30 video, 86 audio). Codecs `avc1.42E01E` / `mp4a.40.2`, both tracks timescale
1000, media time starting at 2333.176 s.

```js
const uri = '/base/test/test/assets/bjsn-initial-segment.mp4';
```

**Committed, synthetic** — `test/test/assets/bjsn/media_11905.mp4` …
`media_11909.mp4` (5 segments, 788 KB), generated by
`tools/bjsn-make-test-asset.js`. These exist because the real capture is a single
segment and cannot exercise timeline continuation. They live in their own
directory because `template_path` resolution requires the segments to be
siblings.

**All five are self-initialising** — `ftyp`+`moov`+`bjsn`+`styp`+fragments, each
beginning with an IDR keyframe, so any one of them decodes and starts playback
cold. That matches real BJSN traffic (confirmed by the customer 2026-07-29); see
plan §2b. Verified by decoding each standalone: 60 video frames and no errors,
for every segment.

`tfdt` continues seamlessly across all five — each file's video ends 67 ticks
(one cadence step) before the next begins, and audio exactly one 1024-sample AAC
frame:

```
media_11905: track1 2333176→2335109 (n=30) | track2 102893062→102981126 (n=87)
media_11906: track1 2335176→2337109 (n=30) | track2 102982150→103069190 (n=86)
media_11907: track1 2337176→2339109 (n=30) | track2 103070214→103157254 (n=86)
media_11908: track1 2339176→2341109 (n=30) | track2 103158278→103245318 (n=86)
media_11909: track1 2341176→2343109 (n=30) | track2 103246342→103333382 (n=86)
```

Note the committed set stops at 11909, but `media_11909.mp4`'s `bjsn` box still
advertises `seq_num: 11909`, so a player following `template_path` will request
`media_11910.mp4` and get a 404. That is expected, and useful for exercising
retry behaviour. Regenerate a longer run into gitignored scratch space if you
need more:

```bash
node tools/bjsn-make-test-asset.js --segments 30
```

See `tools/README.md` for how the synthetic asset diverges from the real capture
— notably audio timescale 44100 rather than 1000, and ~0 A/V start skew rather
than ~10 ms.

Because every segment is self-initialising, each one can be loaded directly in the
spike harness or the player — useful for testing mid-stream joins:

```
/demo/bjsn/spike-muxed-buffer.html?url=/test/test/assets/bjsn/media_11907.mp4
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

## Phase 1 spike: `spike-muxed-buffer.html`

Decides §3.1 of the integration plan — whether a single SourceBuffer declaring
both codecs can take the interleaved BJSN file, or whether the tracks must be
demuxed. Runs three shapes against the committed fixture and judges each on
decoded bytes for *both* tracks, not just whether a picture appears:

- **A1** one SourceBuffer, both codecs, single append of the whole stripped file
- **A2** one SourceBuffer, both codecs, init appended separately from media
- **B** two SourceBuffers, per-track init, demuxed — the shape this player uses,
  included as a control so a broken harness cannot be mistaken for a real result

Result (2026-07-28): **all three PASS**, with identical decoded byte counts
(54281 video / 8582 audio). Option A chosen. Details in the plan, §3.1.

The segment under test defaults to the committed fixture and can be pointed
anywhere via the URL field or a `?url=` query parameter, so a run is shareable
and reproducible:

```
/demo/bjsn/spike-muxed-buffer.html?url=/test/test/assets/bjsn/media_11905.mp4
```

It must be a segment containing `moov`. Every real BJSN segment does, so any of
them work; a media-only file is rejected with an explanatory message.
Cross-origin URLs need CORS on the serving origin.

Re-run on the generated asset (2026-07-29): all three PASS, buffered
`[2333.176–2335.196]`, 142118 video / 5081 audio bytes decoded, with mode B
reporting `video ts=1000, audio ts=44100` — confirming per-track timescales are
read rather than assumed.

> **Chrome gates media on tab visibility, not focus.** In a hidden or
> backgrounded tab, a MediaSource never attaches and muted elements get paused
> as "video-only background media" — so the page reports **INCONCLUSIVE**, not
> FAIL. Bring the window to the front before reading any verdict.

## Inspecting segments

`tools/bjsn-stripper-cli.js` reads and strips `bjsn` boxes offline:

```bash
node tools/bjsn-stripper-cli.js --info test/test/assets/bjsn-initial-segment.mp4
```

See [`tools/README.md`](../../tools/README.md).

## Known quirks

### Both players

- **Chrome gates media on tab visibility, not focus.** A muted element in a
  hidden or backgrounded tab gets paused as "video-only background media", which
  looks exactly like a player stall and makes "Time to Playing" meaningless. The
  Shaka page detects this case and says so in the log and the metrics panel
  rather than letting the number mislead; read any startup timing with the window
  in front.

### The Shaka player

- **`update()` is wired to the live loop.** Shaka only calls a parser's
  `update()` when an `emsg` box asks for it, which BJSN does not use, so the
  parser drives its own timer. `update()` is left connected anyway so an `emsg`
  cannot be silently ignored.
- **Gear switching is not implemented.** `gear_list` is parsed and the first
  gear's `realtime_bitrate` becomes the variant bandwidth; nothing switches. The
  `Range: bytes=0-0` pre-warm and the `Old-Gear-Path`/`Abr-Downgrade` handshake
  from plan §2b are not implemented either — that is Phase 7.
- **`Last-Segment-Duration` is read but lags.** It describes the *previous*
  segment, so it cannot size the first one; the parser derives the first
  duration from `tfdt` deltas and prefers the header afterwards.
- **BJSN-specific parse failures reuse `UNABLE_TO_GUESS_MANIFEST_TYPE`.** There
  is no BJSN error code, and inventing one would mean editing `lib/util/error.js`.
  The message carries the real reason.

### The standalone player

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
