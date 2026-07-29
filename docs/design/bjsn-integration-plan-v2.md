# BJSN → Shaka Player Integration Plan (v2, restart)

**This document is the authority for the v2 integration.**

It supersedes v1's `bjsn-phase1-implementation-plan.md`, which was deliberately
**not** carried onto this branch — it survives only on `feature/bjsn-phase1` if
you need the history. `bjsn-support-spec.md` and `bjsn-knowledge-base.md` are
v1-era documents that still describe the *goal* well but contain claims since
measured to be wrong; each carries a banner listing them. Where they conflict
with the measurements here, this document wins.

### Housekeeping for the next doc pass

These three BJSN documents sit loose in `docs/design/`, but upstream Shaka sorts
designs into `docs/design/current/` (how shipped things work),
`future_work/` (proposals) and `outdated/` (superseded). All three BJSN docs
describe unshipped work, so `future_work/` is where they belong. Deliberately
**not** moved yet, because relocating them invalidates path references in:

- `demo/bjsn/README.md` (links to this plan)
- `tools/README.md`
- the banners in the other two BJSN docs, which name each other
- the internal cross-references in this file

Move all three together and fix those references in the same commit, or not at
all. A stale link is worse than an unconventional location.

## 0. Current status — start here

Branch `feature/bjsn-v2`, cut from `origin/main` at `9313a466d`
(`v4.15.6-main-6`). **Zero diff to `lib/`** — that is the central invariant of
this restart (see §1 and §3); check it before and after any change:

```bash
git diff origin/main --stat -- lib/   # must print nothing
```

Toolchain — **verified on this machine, 2026-07-29.** Do not reach for the usual
npm scripts: there is no `npm test` and no `npm run lint`, and `npm run build`
**fails here** because it shells out to `python`, which is not on PATH (only
`python3` is). Call the Python entry points directly:

```bash
python3 build/all.py                   # build  (NOT `npm run build` — see above)
python3 build/test.py --filter bjsn    # karma tests; --help for options
python3 build/check.py                 # Closure completeness + type check + lint
npx eslint demo/ lib/ test/            # linter alone
python3 -m http.server 8080            # serve repo root for demo/bjsn/ pages
```

If you would rather type `npm run build`, fix `package.json` to say `python3` —
but that is a change to a shared file, so decide deliberately rather than as a
drive-by.

`demo/bjsn/*.js` and `tools/*.js` are excluded from eslint in
`eslint.config.mjs` — they use syntax newer than the repo's `ecmaVersion: 2017`
and the CLI tools are Node, not browser, code. Anything ported into `lib/` gets
full lint coverage and must satisfy it.

Done:

- **Phase 0 — cleanup.** §5. Branch cut clean; only the proven reference player,
  tooling and docs carried across. No v1 core patches exist on this branch.
- **Phase 1 — spike.** §3.1. **Option A chosen**: a single SourceBuffer declaring
  both codecs decodes both tracks of an interleaved BJSN file. No demux, no
  transmuxer plugin, no per-track init synthesis.

What exists to build on:

| Thing | Where |
| --- | --- |
| Working standalone MSE player (the behavioural contract, §2) | `demo/bjsn/bjsn_player.html` + `bjsn_utils.js` + `bjsn_mse.js` |
| Architecture spike harness, takes any segment by `?url=` | `demo/bjsn/spike-muxed-buffer.html` |
| Real captured initial segment (77 KB) | `test/test/assets/bjsn-initial-segment.mp4` |
| Synthetic 5-segment set, seamless `tfdt` across files | `test/test/assets/bjsn/media_11905..11909.mp4` |
| Generator for longer/other runs | `tools/bjsn-make-test-asset.js` |
| Segment inspector / `bjsn` stripper | `tools/bjsn-stripper-cli.js` |
| Fixture provenance, quirks, how to run things | `demo/bjsn/README.md`, `tools/README.md` |

**Next: Phase 2** (§6) — port `bjsn_utils.js` into `lib/util/` as Closure modules
with unit tests, then repoint `demo/bjsn/` at them so the reference player and the
library cannot drift.

⚠️ **Three decisions in §8 are still unanswered and gate Phase 2** — most
importantly whether ABR must land this round, since that determines whether
Option A is even eligible. Resolve them before writing `lib/` code.

## 1. Why v1 did not work

The v1 attempt (branch `feature/bjsn-phase1`) patched Shaka's core pipeline in
four places to make BJSN fit:

| File | v1 change | Problem |
| --- | --- | --- |
| `lib/media/preload_manager.js` | config flag `manifest.bjsn.enabled` selects the parser | Bypasses `ManifestParser.registerParserByMime()`, the supported extension point |
| `lib/media/media_source_engine.js` | sniff + strip `bjsn` box inside `append_` | Every append of every stream type pays the cost; unconditional `shaka.log.info` in the hot path |
| `lib/media/streaming_engine.js` | muxed-audio behaviour change + ~15 debug log sites | Mixes a real fix with instrumentation; changes buffering-goal semantics for all content |
| `lib/util/mp4_box_parsers.js` | rewrote `parseHDLR` | Symptom fix; the real `hdlr` offset issue belongs in our own parser |

Two consequences: the change set is unreviewable and un-upstreamable, and — more
importantly — **no single place owns the BJSN contract**. The manifest parser
assumed one thing about segment layout, the stripper another, and MSE a third.
When playback failed there was no boundary at which to assert correctness.

The deeper cause is a structural mismatch that v1 never resolved explicitly:

> One BJSN HTTP response contains **ftyp + moov + bjsn + styp + N interleaved
> (moof+mdat) pairs for two tracks**, one `traf` per `moof`. Shaka's pipeline assumes one HTTP response
> → one contentType → one SourceBuffer, with the init segment addressed
> separately.

v1 tried to paper over this in `media_source_engine`. v2 resolves it at a
designed seam.

## 2. Ground truth: the contract the working player proves

`bjsn_player.html` + `bjsn_mse.js` + `bjsn_utils.js` works. Everything below is
observed behaviour of that player and is treated as the requirement set. Any v2
component that disagrees with this list is wrong.

**Initial file** (the URL the user loads). Box order as measured in
`test/test/assets/bjsn-initial-segment.mp4`:
1. `ftyp` (24 bytes)
2. `moov` (1080 bytes) — two `trak`s (`vide` + `soun`), each with its own
   timescale
3. `bjsn` (433 bytes, at offset 1104) — JSON: `type`, `gear_num`, `seq_num`,
   `template_path`, `gear_list`
4. repeated `moof`+`mdat` pairs, alternating between the two track IDs

`bjsn` follows `moov` in this capture, but **do not depend on that order**: the
working player's `ProgressiveMp4Parser` is box-type driven and handles either
arrangement, and only one origin/gear has been sampled so far. The parser must
stay order-agnostic and simply wait until it has both.

**Subsequent files**: `template_path.replace('${num}', seq_num + 1)` resolved
against the initial URL. Same layout minus `ftyp`/`moov`; may carry a fresh
`bjsn`.

**What the working player does with it** (`ProgressiveMp4Parser`):
- parses box-by-box as bytes arrive; fires `bjsn` as soon as that box completes,
  init as soon as `moov` completes, and each `moof`+`mdat` pair immediately
- synthesises **one init segment per track** = `ftyp` + `moov` filtered to that
  `trak` and its `trex` (`filterMoovForTrack`)
- detects codecs from `stsd`/`avcC`/`hvcC`/`esds` per track, with an
  `hvc1`↔`hev1` fallback when `isTypeSupported` rejects the first form
- routes each `moof`+`mdat` to the SourceBuffer for its `tfhd.track_ID`
- `sourceBuffer.mode = 'segments'`
- **does not set `timestampOffset`** — the assignment in
  `transitionToAppending` is commented out. Instead it sets
  `video.currentTime = buffered.start(0)` once. The media timeline is left
  untouched; playback starts at the segment's own `baseMediaDecodeTime`.
- serialises appends per buffer through a state machine; clones the buffer when
  deferring an append (avoids ArrayBuffer detachment)
- polls the next segment on a `segmentDuration`-minus-fetch-time cadence with
  100 ms retry and exponential backoff after 10 consecutive failures

Note the `TimestampManager` in `bjsn_mse.js` computes offsets that are then never
applied. It is effectively diagnostics. **In Shaka the equivalent job is real
and must be done properly** — see §3.4.

## 3. Target architecture

Design rule for v2: **zero diff to existing `lib/` files.** Everything lands in
new files plus registration calls. If a change to a core file seems necessary,
that is a signal the seam is wrong — stop and re-examine, or raise it as an
explicit, isolated, separately-reviewable commit with a test.

Three Shaka APIs make this achievable. All three are confirmed present in this
tree:

| API | Location | Use |
| --- | --- | --- |
| `ManifestParser.registerParserByMime()` | `lib/media/manifest_parser.js:44` | Register `BjsnManifestParser` under e.g. `application/bjsn`. Replaces the `preload_manager` hack. |
| `InitSegmentReference.setSegmentData()` / `SegmentReference.setSegmentData()` | `lib/media/segment_reference.js:125, 634` | Hand the synthesised per-track init segments and the already-downloaded first file to the streaming pipeline with **no second network request**. `streaming_engine.fetch_` checks `getSegmentData()` first. |
| `TransmuxerEngine.registerTransmuxer()` | `lib/transmuxer/transmuxer_engine.js:32` | `transmux(data, stream, reference, duration, contentType)` receives `contentType` — the exact hook for "strip `bjsn`, return only this track's `moof`+`mdat` pairs". Replaces the `media_source_engine` hack. |

### 3.1 Two candidate shapes — resolve by spike, not by argument

**Option A — single muxed SourceBuffer.** Publish one Shaka `Stream`
(`video/mp4; codecs="avc1.…, mp4a.40.2"`), one SourceBuffer, append the
`bjsn`-stripped file verbatim. MSE accepts a multiplexed CMAF file in one
SourceBuffer when the init segment declares both tracks. Shaka already models
this as `stream.isAudioMuxedInVideo` (used by the HLS parser).

- No demux, no per-track init synthesis, no shared-fetch problem. Smallest
  possible integration.
- Costs: no independent audio track selection, and audio-only ABR is
  impossible. Acceptable for Phase 1 (single gear).
- Risk: `isAudioMuxedInVideo` is currently only exercised by the HLS path; v1
  already hit one bug there (`streaming_engine.js` skipped the *video*
  mediaState too, not just audio). That fix may genuinely be needed — it would
  be the one justified core diff, and it is small, isolated and testable.

**Option B — demux via transmuxer plugin.** Two Streams (video + audio) whose
segment references point at the *same* URI. A `BjsnTransmuxer` returns only the
requested `contentType`'s `moof`+`mdat` pairs. Mirrors the working player
exactly.

- Faithful to proven behaviour; keeps the door open for per-track ABR.
- Costs: the same URL is fetched twice (once per mediaState) unless a
  short-TTL response cache is added — a `NetworkingEngine` response filter or a
  small in-memory cache keyed by URI with a 2–3 segment TTL. That cache is new
  surface area and a likely source of subtle bugs.

### Spike result (2026-07-28): **take Option A**

Run via `demo/bjsn/spike-muxed-buffer.html` against
`test/test/assets/bjsn-initial-segment.mp4` in Chrome. Three modes, all PASS,
where a pass requires no media error, non-zero video dimensions, the play head
advancing, **and both tracks reporting decoded bytes** (video-only success is the
failure mode being hunted — it looks fine on screen):

| Mode | Shape | Result |
| --- | --- | --- |
| A1 | one SourceBuffer, both codecs, single append of the whole stripped file | PASS |
| A2 | one SourceBuffer, both codecs, init appended separately from media | PASS |
| B | two SourceBuffers, per-track init, demuxed (reference player shape, control) | PASS |

All three decoded **identical byte counts** — 54281 video, 8582 audio — which is
the strong signal: the muxed buffer is not silently dropping a track. Rendered
270x480, play head advanced 2.007 s.

**Consequence:** no demux, no per-track init synthesis, no transmuxer plugin, no
shared-fetch cache. Publish one muxed Stream and append the stripped file
verbatim. `BjsnTransmuxer` is dropped from §3.2; the only remaining use for a
transmuxer plugin would be stripping the `bjsn` box, which the manifest parser
can do instead.

Facts established by the spike that change other sections:

- **`MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')`
  is `true`.** The two-codec string is not an obstacle.
- **A `styp` box** sits between `moov` and the first `moof`. §2 did not account
  for it. It must be kept with the media (MSE accepts it); do not let a box
  filter silently drop it.
- **Media time starts at ~2333.176 s, not 0**, and **both tracks use
  timescale 1000** — not the 90000/44100 the reference player falls back to.
  This is the §3.4 timeline-mapping problem made concrete: `t0` ≈ 2333.176.
- **A/V skew within the file is ~10 ms** (video buffered from 2333.176, audio
  from 2333.186). Fine, but it means the two tracks do not start on exactly the
  same tick — `t0` must be the *minimum* across tracks, as §3.4 says.
- **One file holds ~2.007 s of media** in 30 video + 86 audio `moof`/`mdat`
  pairs, interleaved as 1 video + 3 audio. Segment duration is therefore
  derivable from the first file and must not be hard-coded to 2000 ms the way
  the reference player does.

**Caveat on scope.** This tested one file from one gear. It does *not* establish
that appending *consecutive* stripped files to a single muxed SourceBuffer keeps
A/V in sync over time — that needs the consecutive-segment fixtures called for in
§7 and is the first thing Phase 5 must verify. Option A is also revisited before
Phase 7 (ABR), per §3.1.

### 3.2 Component layout (either option)

```
lib/util/bjsn_box_reader.js      MP4 box walk: top-level + child, 64-bit sizes, tfdt, tfhd.track_ID,
                                 mdhd.timescale, hdlr.handlerType, tkhd.track_ID
lib/util/bjsn_manifest_data.js   bjsn box extraction + JSON schema validation + URL templating
lib/util/bjsn_codec_detector.js  stsd/avcC/hvcC/esds → codec strings, hvc1↔hev1 fallback
lib/util/bjsn_stream_parser.js   progressive box parser: onBjsn / onInit / onMediaSegment callbacks
lib/media/bjsn_manifest_parser.js  shaka.extern.ManifestParser
```

Dropped by the Option A spike result: `bjsn_init_builder.js` (no per-track init
synthesis needed — `ftyp` + `moov` unchanged is the init segment) and
`lib/transmuxer/bjsn_transmuxer.js` (no demux). `filterMoovForTrack` stays in the
demo player only; if Phase 7 needs per-track separation for ABR, port it then.

Ports of proven code from `bjsn_utils.js`, not rewrites. v1's
`lib/util/bjsn_codec_detector.js` is 835 lines against ~300 in `bjsn_utils.js`
for the same job; port the smaller proven one and grow it only against real
failures.

### 3.3 Manifest parser flow

```
start(uri, playerInterface)
  ├─ fetch(uri) as a ReadableStream via NetworkingEngine
  ├─ feed BjsnStreamParser until bjsn AND moov are complete   ← resolve start() here
  │    ├─ bjsn → seq_num, template_path, gear_list, type (static|dynamic)
  │    └─ moov → tracks[] (id, handlerType, timescale), per-track init, codecs
  ├─ keep draining the rest of the file in the background; retain the bytes
  ├─ build Manifest:
  │    ├─ PresentationTimeline (dynamic if bjsn.type == 'dynamic')
  │    ├─ Variant + Stream(s), codecs from detection (Option A: one muxed Stream)
  │    ├─ InitSegmentReference with setSegmentData(synthesised init)   ← no fetch
  │    └─ SegmentIndex seeded with reference #seq_num,
  │         setSegmentData(retained first-file bytes)                 ← no refetch
  └─ live: update() adds the next reference and advances seq_num
```

Startup latency ≈ the working player's, because `start()` resolves on
`bjsn`+`moov` rather than on the whole file, and the retained bytes mean the
first segment is never downloaded twice.

### 3.4 Timeline mapping — the part the standalone player skipped

The working player sidesteps timeline mapping (`timestampOffset` disabled,
`currentTime = buffered.start(0)`). Shaka cannot: `PresentationTimeline` and
`SegmentReference.startTime/endTime` must agree with what lands in the buffer,
or seeking, the seek range, buffered-ahead calculations and the play head all
break.

Approach: keep the media timeline as-is and move the presentation timeline to
meet it.
- `t0` = `min(baseMediaDecodeTime / timescale)` across tracks in the first file
  (already computed by `TimestampManager`)
- reference `startTime`/`endTime` use real media times (`t0`-based, not 0-based)
- `presentationTimeline.setUserSeekStart(t0)` / offset the timeline so `t0` is
  the start of the seek range, leaving `timestampOffset` at 0
- segment duration: derive from the first file's `tfdt` deltas (or `trun` sample
  durations) rather than the working player's hard-coded 2000 ms

This is the single largest piece of genuinely new engineering in v2. Expect to
iterate on it; it is also where a wrong answer looks like "video decodes but
never plays", the failure mode v1 hit.

### 3.5 Live continuation

- `bjsn.type == 'dynamic'` → `presentationTimeline.setStatic(false)`, `isLive()`
- parser `update()` (Shaka calls it on `manifest.minBufferTime`-ish cadence, or
  self-schedule) appends the next `SegmentReference` for `seq_num + 1`
- a fresh `bjsn` in each downloaded segment refreshes `seq_num`/`template_path`;
  read it in the transmuxer (Option B) or via a response filter (Option A) and
  feed it back to the parser
- 404 on the next segment is normal (not yet published): rely on Shaka's
  `streaming.retryParameters` + `failureCallback` rather than porting
  `SegmentDownloadManager`. Only port the custom backoff if Shaka's retry proves
  insufficient.

## 4. Repository strategy

**Recommendation: fresh branch off `main`, not a fresh clone.** A new clone buys
nothing (`main` here is already `v4.15.6-main-6-g9313a466d` from
`harmonicinc-video/shaka-player`) and costs a fresh `npm install` plus loss of
local tooling. What matters is that **no `lib/` change from v1 is carried
forward**.

```bash
git fetch origin
git checkout -b feature/bjsn-v2 origin/main      # clean slate for lib/
# bring across only the proven, non-lib assets from feature/bjsn-phase1:
git checkout feature/bjsn-phase1 -- \
  bjsn_player.html bjsn_mse.js bjsn_utils.js \
  tools/bjsn-stripper-cli.js tools/README.md \
  docs/design/bjsn-support-spec.md \
  docs/design/bjsn-knowledge-base.md \
  docs/design/bjsn-integration-plan-v2.md
```

Keep `feature/bjsn-phase1` on the remote as a reference — it is where the
knowledge lives — but never merge it.

**Done (2026-07-28).** `feature/bjsn-v2` created from `origin/main`
(`9313a466d`, `v4.15.6-main-6`). The half-finished `bjsn_mse.js` /
`bjsn_utils.js` edits were not carried across; they are recoverable from the
stash `WIP bjsn_mse/bjsn_utils (untested, superseded by bjsn-v2 plan)` if ever
needed.

## 5. Phase 0 — cleanup — **DONE (2026-07-28)**

Kept as a record of what was removed and why. Because the branch was cut fresh
from `origin/main`, every deletion below happened by simply not carrying the file
across — there is no deletion commit to review.

**Keep, relocated to `demo/bjsn/`** (root-level HTML/JS will never be
upstreamable, and it keeps the reference harness obviously separate from the
library):
- `bjsn_player.html`, `bjsn_mse.js`, `bjsn_utils.js`

**Keep in place:**
- `tools/bjsn-stripper-cli.js`, `tools/README.md`
- `docs/design/bjsn-support-spec.md`, `bjsn-knowledge-base.md`, this file

**Delete — superseded scratch pages** (all predate the working player; each
encodes an obsolete understanding of the format, and their presence invites
someone to debug the wrong file):
- `bjsn-config-test.html`, `bjsn-debug.html`, `bjsn-live-test.html`,
  `bjsn-mse-debug.html`, `bjsn-stripper-direct-test.html`, `bjsn-test.html`
- `bjsn_player_original.html` (1995 lines; git history preserves it)
- `mse-mp4-player.html`, `mse.html`
- `BJSN-TEST-README.md` (documents the deleted pages; fold anything still true
  into `demo/bjsn/README.md`)

**Delete — unrelated leftovers** (not referenced by `bjsn_player.html`, which
only loads `bjsn_utils.js` and `bjsn_mse.js`):
- `debug-import.less`, `debug-less.js`, `download-font.js`, `material-icons.css`
- `extract_bjsn.py` (superseded by `tools/bjsn-stripper-cli.js`)

**Drop, do not port:**
- `lib/media/bjsn_manifest_parser.js`, `lib/util/bjsn_parser.js`,
  `lib/util/bjsn_codec_detector.js`, `lib/util/bjsn_box_stripper.js` and their
  four test files — rewritten in Phase 2/3 against the working player's
  behaviour
- every diff to `lib/media/media_source_engine.js`,
  `lib/media/streaming_engine.js`, `lib/media/preload_manager.js`,
  `lib/util/mp4_box_parsers.js`, `lib/util/player_configuration.js`,
  `shaka-player.uncompiled.js`, `build/types/*`, `project-words.txt`,
  `package.json` (re-add only what v2 actually needs)

**Untracked test media:** `media_first_hd.mp4`, `media_first_hd5.mp4` and
`media_first_md.mp4` turned out to be 9-byte files containing `Not Found` —
failed curl downloads, deleted. `media_first.mp4` (~75 KB) *is* a real capture
(`ftyp` + `moov` + `bjsn` with `template_path: "media_${num}.mp4"` + interleaved
`moof`/`mdat`); it was hidden by a `.gitignore` entry on the v1 branch.
Committed as `test/test/assets/bjsn-initial-segment.mp4`, following the repo
convention for binary test assets (105 fixtures already live there, the largest
1.4 MB), so Phase 2's unit tests can load it via
`/base/test/test/assets/bjsn-initial-segment.mp4`. `testdata/` stays
`.gitignore`d for ad-hoc captures and stripper output; promote a file only when a
test needs it. Provenance and re-capture recipe: `demo/bjsn/README.md`.

## 6. Phases

Each phase ends with a demonstrable, verifiable result. Do not start the next
phase until the current exit criterion is met.

**Phase 1 — Spike: muxed vs demux** — **DONE (2026-07-28)**. Option A chosen;
evidence and consequences in §3.1. Harness kept at
`demo/bjsn/spike-muxed-buffer.html` so the decision can be re-checked against
new fixtures or a new browser.

**Phase 2 — Shared BJSN core in `lib/util/`** (~2 days)
Port `bjsn_utils.js` into the files listed in §3.2, as `goog.provide`d Closure
classes with proper type annotations. Unit tests per module against the committed
fixtures (`test/test/assets/bjsn-initial-segment.mp4` for the real shape,
`test/test/assets/bjsn/` for multi-segment continuity):

- box walk, including the `styp` box and 64-bit box sizes
- `bjsn` extraction and schema validation
- codec detection → `avc1.42E01E` / `mp4a.40.2`, plus the `hvc1`↔`hev1` fallback
- per-track timescale reading — the fixtures deliberately differ here (real: 1000
  and 1000; synthetic: 1000 and 44100), so a test that assumes one value fails
- progressive parse with adversarial chunk boundaries: split mid-header,
  mid-`mdat`, and 1-byte chunks

Then **point `demo/bjsn/` at the new modules** for the shared parts, so the
reference player and the library cannot drift. Note the demo keeps its own
`filterMoovForTrack` — Option A means the library does not need per-track init
synthesis (§3.2), so that one function stays demo-only rather than being ported.

*Exit:* `python3 build/all.py` green; `python3 build/test.py --filter bjsn` green;
`demo/bjsn/bjsn_player.html` still plays, now running on `lib/util/` code.

> There is **no `npm test` script** in this repo — the runner is
> `python3 build/test.py` (`--help` for options; `--filter` selects specs,
> `--browsers Chrome`, `--no-build` to skip rebuilding). Note `python3`, not
> `python`, which is not on PATH here.

**Phase 3 — Manifest parser, first frame** (~3 days)
`BjsnManifestParser` registered by mime type; treat the stream as static/single
segment initially. Init and first-file bytes delivered via `setSegmentData()`.
*Exit:* `shaka.Player.load(url, undefined, 'application/bjsn')` renders and
plays the initial file to its end, with zero diff to pre-existing `lib/` files
(or exactly one justified, tested diff).

**Phase 4 — Timeline correctness** (~2 days)
Implement §3.4. *Exit:* `player.seekRange()` matches the buffered range;
seeking within the buffer works; `getBufferedInfo()` agrees with
`sourceBuffer.buffered`; no drift after 10 segments.

**Phase 5 — Live continuation** (~3 days)
`update()` loop, `seq_num` advance, in-band `bjsn` refresh, 404 handling via
Shaka retry. *Exit:* 30-minute unattended live playback with no stall and no
A/V drift; buffer health comparable to the standalone player.

**Phase 6 — Parity and hardening** (~2 days)
Port the standalone player's timing metrics into a comparison harness: time to
first byte / `bjsn` parsed / init appended / first media append / `playing`, for
Shaka vs standalone on the same asset. Then enable `lowLatencyMode` so
`streaming_engine`'s existing chunked-append path (`streaming_engine.js:1912`)
gives Shaka the same progressive behaviour the standalone player gets for free.
*Exit:* Shaka's time-to-playing within ~15% of the standalone player, and the
repo's own gates green: `python3 build/check.py` (Closure completeness, test type
checks, linter), `python3 build/all.py`, `python3 build/test.py`.

**Phase 7 — ABR / gear switching.** Out of scope for this round. Option A must
be revisited before this starts (see §3.1); expect to move to Option B or to
separate the tracks at that point. Flagging it now because Option A is a
deliberate one-way-ish door for multi-gear.

## 7. Risks

- **A/V sync in Option A.** A single SourceBuffer fed interleaved `moof`s per
  track is legal MSE but less travelled. Mitigated by the Phase 1 spike.
- **`isAudioMuxedInVideo` is HLS-shaped.** v1 already found one bug there. If
  Option A wins, budget for one or two small isolated core fixes with tests.
- **Timeline mapping (§3.4).** The genuinely novel work, and the likeliest
  source of "decodes but won't play". Phase 4 exists to isolate it rather than
  discover it during live testing.
- **In-band `bjsn` refresh.** Reading manifest state out of media segments
  inverts Shaka's parser→streamer data flow. Keep the write path narrow: one
  method on the parser, called from one place.
- **Fixtures.** Live TikTok origins rotate. One real initial segment is committed
  (`test/test/assets/bjsn-initial-segment.mp4`), plus a synthetic 5-segment set
  (`test/test/assets/bjsn/`) from `tools/bjsn-make-test-asset.js` which unblocks
  timeline and continuation work. The synthetic set is a stand-in, not a replica:
  audio timescale 44100 rather than 1000, ~0 A/V start skew rather than ~10 ms,
  one gear rather than nine, and a `bjsn` box in subsequent segments that is an
  assumption rather than an observation. **A run of consecutive *real* segments is
  still worth capturing** before the origin changes, and Phase 5 should not be
  signed off on synthetic data alone.

## 8. Decisions needed before Phase 2

Still open — both should be settled before any `lib/` code is written:

1. **Scope this round:** single gear only (recommended), or must ABR land too?
   Phase 1 chose Option A (single muxed SourceBuffer) on the assumption of single
   gear. Option A cannot do per-track ABR, so if ABR is in scope for *this* round,
   §3.1 must be reopened and the Option B / demux route taken instead. Answering
   this late is expensive; answering it now is free.
2. **Upstream intent:** is zero-core-diff a hard requirement (eventual upstream
   PR / easy rebase onto `main`), or is a maintained fork acceptable? v2 assumes
   the former; relaxing it makes Phase 3–5 noticeably cheaper.

Settled:

3. ~~**Does the standalone player stay?**~~ **Yes.** It lives at `demo/bjsn/` and
   §2 treats its behaviour as the contract the integration must match. Phase 2
   repoints it at the new `lib/util/` modules so the two cannot drift.
