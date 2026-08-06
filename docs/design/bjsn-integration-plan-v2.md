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

Toolchain. Do not reach for the usual npm scripts: there is no `npm test` and no
`npm run lint`, and `npm run build` **fails here** because it shells out to
`python`, which is not on PATH (only `python3` is). Call the Python entry points
directly:

```bash
python3 build/gendeps.py               # dist/deps.js, for uncompiled mode
python3 build/check.py                 # Closure completeness + type check + lint + cspell
python3 build/all.py                   # full build (needs Java, see below)
python3 build/test.py --filter bjsn    # karma tests; --help for options
npx eslint demo/ lib/ test/            # linter alone
python3 -m http.server 8080            # serve repo root for demo/bjsn/ pages
```

### Java is required, and is now installed (2026-07-29)

The Closure compiler is invoked as `java -jar compiler.jar`
(`build/compiler.py:163`), so anything that compiles — `build/all.py`,
`build/check.py`, `build/test.py` without `--no-build` — needs a JDK. There was
none on this machine; an earlier revision of this section wrongly claimed
`build/all.py` was verified. Installed with:

```bash
brew install openjdk@21     # keg-only, so no sudo needed
export PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH"
```

`openjdk@21` is keg-only, so **`java` is only on PATH if you put it there.**
Either add that `export` to your shell profile, or symlink the JDK where the
system wrappers look (this one does need sudo):

```bash
sudo ln -sfn /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk \
  /Library/Java/JavaVirtualMachines/openjdk-21.jdk
```

Closure 20240317 wants Java 11+; 21 is the current LTS.

**`python3 build/all.py` is now green** (exit 0) — all twelve compile steps: the
four library variants (`ui`, `compiled`, `dash`, `hls`) in both debug and release,
plus the demo app and the cast receiver in both. `build/check.py` passes
end-to-end too, including its Closure type-check pass over the tests. Getting
there took three separate fixes, below.

### The build was already red before this branch touched it

Once Java made `build/check.py` runnable, it failed — on files committed *earlier*
in this branch, not on the new ones: `demo/bjsn/bjsn_mse.js`,
`demo/bjsn/bjsn_utils.js` and `eslint.config.mjs` all tripped the `cspell` step,
which nobody could have seen while the build died at the Java step first. §5
listed `project-words.txt` under "drop, do not port", which is how the BJSN
vocabulary went missing.

Fixed by adding the vocabulary back (`bjsn`, `styp`, `demux`, `moofs`,
`Bytedance`, `TikTok`, `ffprobe`, `QUIC`/`CCTK`, …) to `project-words.txt`.
`cspell` matches case-insensitively, so one lowercase entry covers
`bjsn`/`Bjsn`/`BJSN`. Note it checks three separate file sets — `js`, then
`docs/**/*.md`, then `build/**/*.py` — and stops at the first failure, so a green
js pass does not mean the md pass will pass.

Writing docs *about* this work then trips it again, since words like `libexec`
and `ETIMEDOUT` are themselves unknown. Do not discover that one word per full
build — check the files you touched directly, which takes seconds:

```bash
./node_modules/.bin/cspell --config=cspell.config.yaml --no-progress \
  docs/design/bjsn-integration-plan-v2.md demo/bjsn/README.md
```

(`npx cspell` does **not** work — npm resolves it as a package script and fails
with `Missing script: "cspell"`. Call the binary in `node_modules/.bin`.)

**And the demo app build was broken too.** Past `check.py`, all four library
variants compiled — then `Compiling the demo app` failed. `build/apps.py` globs
**everything** under `demo/` into one Closure compilation, so it pulled in
`demo/bjsn/bjsn_utils.js`, whose `static Foo = class {…}` public class fields
Closure rejects at this language level (`JSC_LANGUAGE_FEATURE`, 7 errors).

Phase 0 moved those files into `demo/` and excluded them from **eslint**
(`eslint.config.mjs`) but not from the demo app compile — the two exclusions are
unrelated, and the compile one was invisible without Java.

Fixed in `build/apps.py` by subtracting `demo/bjsn/` from the demo app's file
set, exactly as `demo/cast_receiver/` already is. That is correct rather than
merely expedient: the BJSN pages load their own scripts directly and never go
through the demo bundle. **Note this is a diff to a shared build file** — the
first on this branch — but it is not `lib/`, so the §3 invariant still holds. The
alternative was rewriting proven reference code to satisfy a compiler that never
needed to see it.

**And the test runner needed a third fix, unrelated to Java.**
`build/test.py` died with `Cannot find plugin "karma-local-wd-launcher"` even
though the package is installed. The real error is one level down: `wd` requires
`../build/safe-execute`, and `node_modules/wd/build/` did not exist.

Cause: this machine's `~/.npmrc` sets **`ignore-scripts=true`** (a deliberate
security posture — it stops packages executing arbitrary code at install time),
so `wd`'s `install` script, which generates that `build/` directory from
`browser-scripts/`, never ran.

Fixed surgically, without weakening the setting, by running that one script —
whose whole job is to read three local files and write three:

```bash
node node_modules/wd/scripts/build-browser-scripts.js
```

#### The `wd` note, in full — read this before debugging karma

**This fix lives in `node_modules/`, so it is in no commit and cannot be.** Any
`npm install`, `npm ci` or dependency bump silently reverts it, and the symptom
that comes back names the wrong package (`karma-local-wd-launcher`) rather than
the one at fault (`wd`). Expect to hit it more than once.

How to recognise it in one command — if this prints `MODULE_NOT_FOUND` for
`../build/safe-execute`, it is this and nothing else:

```bash
node -e "require('./node_modules/karma-local-wd-launcher')"
```

Then re-run the fix above. Confirm with:

```bash
test -f node_modules/wd/build/safe-execute.js && echo present || echo MISSING
```

Two durable alternatives, both deliberate choices rather than drive-bys:

- **A project-local `.npmrc` with `ignore-scripts=false`** — the remedy this
  machine's own `~/.npmrc` comment suggests. It re-enables install scripts for
  *every* dependency, not just `wd`, and being committed it makes that choice for
  everyone who clones the repo. That is a security decision; make it consciously.
- **A `postinstall` script in `package.json`** running the `wd` build. Narrower
  in what it executes, but it is itself an install script, so it does nothing
  while `ignore-scripts=true` is set — self-defeating here.

Neither is applied. The manual command is the honest minimum: it changes nothing
shared, and this note is why the next person will not have to re-derive it.

**`build/test.py` is still blocked, one step further on: no ChromeDriver.** Karma
now loads its plugins and gets as far as launching a browser, then fails with
`Could not connect to Chrome WebDriver / ECONNREFUSED 127.0.0.1:4286`. Shaka
drives browsers exclusively over WebDriver (there is no plain
`karma-chrome-launcher` in `package.json` — only the `webdriver` and `local-wd`
launchers), so a `chromedriver` matching the installed Chrome is required and
none is present. `webdriver-installer` is supposed to fetch it, and did not —
plausibly the same `ignore-scripts` story. **This is the remaining gap before
Phase 2's test gate can run**, and it is independent of Java.

**Three lessons for Phase 2:** run `python3 build/check.py` before committing,
not after; remember that anything dropped into `demo/` is compiled by
`build/apps.py` whether you intended it or not; and when a karma plugin "cannot
be found" though it is plainly installed, `require()` it directly to get the real
error.

### `build/all.py` needs network, and will fail spuriously without it

`build/all.py` compiles `ui/controls.less`, which does
`@import (css, inline) "https://fonts.googleapis.com/icon?family=..."` at build
time (`ui/controls.less:18`). That step runs *before* the library compile, so a
network hiccup stops the whole build with `CSS compilation failed` and an
`AggregateError` — before a single line is compiled, and with no hint that the
cause was the network. Nothing to do with Java or with BJSN.

Measured here: that one request fails roughly **1 time in 6** with `ETIMEDOUT`
(often after only ~250 ms, so it is a flaky path rather than a real timeout).
`build/all.py` compiles LESS twice — `ui/controls` and `demo/demo` — so a given
build has a **~30% chance** of dying on it. That matched observation: 4 of 7
runs. It always succeeded unchanged on retry.

So: **retry before investigating**, and do not read a `CSS compilation failed`
as evidence that your change broke something — it fails *before* anything is
compiled. If it persists across several retries, test Node's connectivity
specifically; `curl` succeeding proves nothing, since the two use different
resolvers, CA stores and proxy conventions:

```bash
node -e "fetch('https://fonts.googleapis.com/icon?family=Material+Icons+Round').\
then(r=>console.log(r.status)).catch(e=>console.log('FAIL',e.cause&&e.cause.code))"
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
- **Customer spec received and reconciled** (2026-07-29). §2b. Confirmed four
  previously-unverified assumptions, added the `Last-Segment-Duration` header /
  `Range: bytes=0-0` pre-warm / `Old-Gear-Path` fallback / per-gear DRM to this
  plan, and settled the segment-layout question below.
- **Segment layout settled.** §2, §2b. **Every** segment carries
  `ftyp`+`moov`+`bjsn`+`styp` and begins with an IDR, so any segment starts
  playback cold. Fixtures regenerated to match and verified to decode standalone.
- **Shaka playback proven end-to-end, still zero `lib/` diff** (2026-07-29).
  §3.6. `demo/bjsn/bjsn_shaka_player.html` plays the fixtures through
  `shaka.Player` using a demo-level manifest parser plugin, with the same startup
  metrics as the standalone player. This is a working prototype of Phase 3 and it
  settles decision 2 in §8 in the affirmative: zero-core-diff is achievable.

What exists to build on:

| Thing | Where |
| --- | --- |
| Working standalone MSE player (the behavioural contract, §2) | `demo/bjsn/bjsn_player.html` + `bjsn_utils.js` + `bjsn_mse.js` |
| Working **Shaka** player for BJSN, prototype of Phase 3 (§3.6) | `demo/bjsn/bjsn_shaka_player.html` + `bjsn_shaka_parser.js` |
| Player-agnostic MSE startup instrumentation, measures both players identically | `demo/bjsn/bjsn_timing_probe.js` |
| Architecture spike harness, takes any segment by `?url=` | `demo/bjsn/spike-muxed-buffer.html` |
| Real captured initial segment (77 KB) | `test/test/assets/bjsn-initial-segment.mp4` |
| Synthetic 5-segment set: every segment self-initialising and cold-startable, seamless `tfdt` across files | `test/test/assets/bjsn/media_11905..11909.mp4` |
| Generator for longer/other runs | `tools/bjsn-make-test-asset.js` |
| Segment inspector / `bjsn` stripper | `tools/bjsn-stripper-cli.js` |
| Fixture provenance, quirks, how to run things | `demo/bjsn/README.md`, `tools/README.md` |

**Next: Phase 2** (§6) — port `bjsn_utils.js` into `lib/util/` as Closure modules
with unit tests, then repoint `demo/bjsn/` at them so the reference player and the
library cannot drift.

⚠️ **One decision in §8 still gates Phase 2:** whether ABR must land this round.
Option A cannot do per-track ABR, so if it must, §3.1 reopens and the demux route
is needed instead. Resolve it before writing `lib/` code. (Decision 2,
zero-core-diff, is settled — see §3.6.)

✅ **The toolchain is now working.** A JDK is installed and
`python3 build/all.py` is green. Getting there fixed three things that were
already broken on this branch and invisible without Java: missing `cspell`
vocabulary, and the BJSN demo files breaking the demo app compile. See the
toolchain section below — including the ~30%-per-run flaky CSS step, which is
not your change failing.

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
against the initial URL.

**Every segment is identical in structure to the first** — `ftyp` + `moov` +
`bjsn` + `styp` + fragments. Confirmed by the customer 2026-07-29, and consistent
with the spec's "now identical in content" (§2b). There is no such thing as a
media-only BJSN segment: any segment can start playback cold, which is what lets
the CDN hand a starting client whichever segment `abr_pts` selects.

Consequences for the integration:

- **Every segment carries init.** The parser must tolerate `moov` arriving
  repeatedly and skip redundant init appends rather than re-initialising the
  SourceBuffer on each segment.
- **Each segment begins with an IDR.** It must, or it could not decode cold. Our
  own generator got this wrong at first (see §2b) — worth remembering when
  diagnosing a stall that looks like a timeline bug but is a missing keyframe.

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

## 2b. Customer specification (authoritative)

Source: *"[TikTok] Expected Mode of CDN Distribution for CMAF Files v2 — Support
CMAF ABR and Without MPD"*, draft V2.0, 16 May, TikTok Shanghai Live Streaming
Department, Player Development Team (Confluence export, supplied by the customer;
supersedes a V1 doc). This is the **format authority**; §2 remains the authority
on what the working player actually does with real bytes. Where the spec and a
measurement disagree, that is a finding to chase, not a choice to make.

### Confirmed — previously listed as unverified

The `bjsn` box is exactly as we have it: 4-byte size, `'bjsn'`, then JSON with
`type` (`"dynamic"`/`"static"`), `gear_num`, `seq_num`, `template_path`,
`gear_list`. Also confirmed:

- **`${num}` templating** is real; the spec's example is
  `"template_path": "123-media-first-${num}.mp4"`.
- **Every segment carries a `bjsn` box.** "The new solution requires all
  `media_segment.mp4` files generated by the Origin server to include this
  information at the beginning." Our synthetic generator assumed this and was
  right.
- **`abr_pts`** is a real client→CDN query parameter for startup-latency control,
  used by the CDN to choose *which* segment to return.
- **Gear switching is a path-suffix swap**, spelled `suffix_old/segment_N` →
  `suffix_new/segment_N+1` in the spec — consistent with the knowledge base's
  "replace the component after the last dash".

### New to *this plan* — though the knowledge base already had most of them

Credit where due: `bjsn-knowledge-base.md` already documented the
`Last-Segment-Duration` header, the `Range: bytes=0-0` pre-warm, the
`Old-Gear-Path` fallback and per-gear DRM, under "Gear Management System" and
"Network Integration Considerations". They were missing from *this* document.

- **Per-gear DRM.** Each `gear_list` entry may carry a `drm` object
  (`{"uhd5": {"realtime_bitrate": …, "drm": {…}}}`), marked "only for drm". Our
  schema validation ignores it. Harmless today, but the field exists and Phase 3
  should carry it through rather than drop it.
- **`Last-Segment-Duration: 1500`** (ms) response header, returned on segment
  N+1 to state the *actual* duration of segment N. **Directly relevant to §3.4**,
  where we planned to derive segment duration from `tfdt` deltas. This is an
  authoritative source and worth preferring when present, with the `tfdt`
  derivation as the fallback. Note it describes the *previous* segment, so it
  arrives one segment late.
- **Range pre-warm for gear switches.** Before switching bitrate the client is
  expected to issue `Range: bytes=0-0` against the *new* gear's next segment to
  trigger a CDN origin-pull and prefetch, then follow with the real `GET`. The
  CDN must return no media body. Phase 7.
- **ABR fallback handshake.** On a gear switch the client sends
  `Old-Gear-Path: suffix_old/segment_N+1`; if the CDN cannot serve the new gear it
  serves that fallback and sets **`Abr-Downgrade: 1`**. So the client must read a
  response header to discover it did *not* get the bitrate it asked for. Phase 7,
  and it means gear selection cannot be assumed to have succeeded.
- **CDN cache floor** of 10 s per segment, with whole-stream eviction if
  prefetching stalls. CDN-side, but it bounds how far back a client may seek.
- **QUIC CCTK congestion feedback** — explicitly deferred to a separate
  discussion in the spec. Out of scope.

### RESOLVED: every segment carries `ftyp` + `moov`

**Confirmed by the customer, 2026-07-29:** initial and subsequent segments are
identical in content. Every segment is self-initialising. This matches the spec's
own reasoning — CDNs stopped assembling `media_first.mp4` precisely because there
is no longer anything special about it, the `abr_pts` flow needs the CDN to be
able to hand *any* cached segment to a cold-starting client, and the spec's
`template_path` example is itself `123-media-first-${num}.mp4`.

What changed as a result:

- `tools/bjsn-make-test-asset.js` now emits `ftyp`+`moov`+`bjsn`+`styp`+fragments
  in **every** segment (the default; `--init-once` keeps the old shape only for
  A/B testing a player against init-once delivery).
- `test/test/assets/bjsn/media_11905..11909.mp4` regenerated. All five are now
  self-initialising and verified to decode standalone.
- The "initial vs subsequent" distinction largely collapses. Real traffic has one
  kind of segment. `tools/bjsn-stripper-cli.js` keeps the distinction because it
  is still useful when handed an arbitrary file, but it should report every real
  BJSN segment as "initial".

**A trap this exposed, worth carrying into the integration.** Making every
segment carry `moov` is necessary but *not sufficient* for cold start: each
segment must also **begin with an IDR keyframe**. The first regeneration attempt
satisfied the box structure and passed structural verification, yet segments 2–5
still could not decode — `ffprobe` reported "Missing reference picture" and zero
video frames, because the encoder had placed a single keyframe at the start of the
whole timeline (`-g 9999`) so every later segment began mid-GOP. Audio was
unaffected, every AAC frame being independently decodable, which is exactly what
makes this failure easy to miss.

Two lessons:

1. Structural validation is not decode validation. The verifier now runs
   alongside a standalone-decode check per segment.
2. When a BJSN stall looks like a timeline bug, check for a keyframe at the
   segment start first. The real capture corroborates that real content does this:
   its first video `mdat` is 7448 B against ~1.4–2.3 kB for the rest.

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
- segment duration: prefer the `Last-Segment-Duration` response header the
  customer spec defines (§2b) when present — but note it reports the
  *previous* segment, so it lands one segment late and cannot size the first
  one. Fall back to deriving from `tfdt` deltas (or `trun` sample durations).
  Either way, not the working player's hard-coded 2000 ms.

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
  insufficient. **Resolved 2026-08-06: it did prove insufficient, and the
  backoff was ported.** Shaka's `retryParameters` cover the fetch, but its
  *default* `failureCallback` gives up outright on a static stream, so the
  prototype supplies its own. See §3.6.

### 3.6 Prototype result (2026-07-29): Option A works in Shaka, no core diff

`demo/bjsn/bjsn_shaka_player.html` + `bjsn_shaka_parser.js` play the synthetic
fixture set through `shaka.Player` with **zero diff to `lib/`**, using exactly
the three extension points in §3 and nothing else. Details and reproduction in
`demo/bjsn/README.md`. What it establishes:

**`isAudioMuxedInVideo` is the wrong flag — do not use it.** §3.1 flagged it as
the risk in Option A ("HLS-shaped, v1 already hit one bug there") and budgeted for
core fixes. That budget is not needed, because the flag should not be set at all:
`media_source_engine.js:551` turns it into `needSplitMuxedContent_ = true`, which
makes Shaka **demux into two SourceBuffers** — Option B's shape, not Option A's.

What actually carries Option A is `stream_utils.js` `getDecodingConfigs_()`
(~lines 806–831): when a video stream's codec list contains a comma **and there
is no separate audio stream**, it already splits the list and builds both an
`AudioConfiguration` and a `VideoConfiguration` for MediaCapabilities. So the
correct shape is a **video-only variant** — one `Stream`, `type: 'video'`,
`codecs: 'avc1.…,mp4a.…'`, `variant.audio = null`, `isAudioMuxedInVideo: false`.
A muxed video-only variant is a first-class shape in Shaka. **The one core diff
§3.1 and §7 expected to need is not needed**, and the `isAudioMuxedInVideo` risk
in §7 can be struck.

**Confirmed by the running prototype:** exactly one SourceBuffer
(`video/mp4; codecs="avc1.42E01E,mp4a.40.2"`), init append classified
`ftyp+moov`, media appends `styp+moof+mdat…` (so `styp` survives, per §3.1),
both tracks decoding, 270x480, playback from `t0` = 2333.176 s through all five
fixtures.

**Timeline mapping (§3.4) works as designed, and live needs less than expected.**
`timestampOffset` stays 0, references carry real media times, and
`setUserSeekStart(t0)` floors the seek range. For live, `notifySegments()` does
the rest by itself: with a non-null `presentationStartTime` and
`autoCorrectDrift`, it recomputes the start time from segment end times on every
call (`presentation_timeline.js:327–333`), which lands the live edge exactly on
the end of the last known segment — in BJSN's media-clock coordinates, with no
arithmetic of our own.

**Three failure modes the prototype hit, all of which Phase 3/5 must handle:**

1. **Shaka starts a live stream at the live edge, so it skipped the first
   segment.** At manifest time the index holds one reference, so the live edge
   *is* that segment's end, and playback began at `seq_num + 1` — throwing away
   the bytes retained for `setSegmentData()` and making startup slower than the
   standalone player. Fix: set `manifest.startTime = t0`. Cheap, but it silently
   negates §3.3's "no refetch" benefit if missed, and it looks like a timeline
   bug rather than a start-position one.
2. **Publishing references on a timer lets the presentation run away from the
   content.** Adding one reference per segment duration regardless of what exists
   means every `notifySegments()` pushes the live edge further out; in the first
   run the index advertised out to `seq 12006` (media time 2539 s) while the
   origin was stuck at 11909, so the play head chased an edge with no media
   behind it and every fetch 404'd. **A real origin that pauses publication
   produces exactly this.** §3.5's "404 on the next segment is normal, rely on
   Shaka's retry" is necessary but not sufficient — retry handles the *fetch*,
   not the runaway *timeline*. The parser now keeps at most one unconfirmed
   reference outstanding, gated on the `seq_num` read from the in-band `bjsn` box,
   and anchors each new reference to the real media end time of the segment that
   arrived rather than accumulating duration estimates (which also removes the
   drift Phase 4 would otherwise have to chase).
3. **`segmentPrefetchLimit` defaults to 1, and against a lazily-grown index that
   downloads every segment twice.** `SegmentPrefetch` builds its `SegmentIterator`
   on its first call and *ignores the `currTime` of every later one*
   (`segment_prefetch.js:90–93`), while `SegmentIterator.next()` increments its
   position even when it runs off the end of the index
   (`segment_index.js:658`). Because a BJSN index grows one reference at a time,
   published only after the previous segment has arrived (failure mode 2's gate),
   the post-append prefetch call at `streaming_engine.js:1913` fires when the next
   reference does not exist yet: `next()` returns nothing but still advances. The
   iterator is then permanently out of step with the playhead and nothing
   re-syncs it — the prefetcher fetches a segment that was already appended, that
   stale entry occupies the single prefetch slot, `getPrefetchedSegment()` misses
   for the segment actually needed, and `StreamingEngine` downloads it itself.
   **One wasted download plus one real one, for every segment.** Measured
   2026-08-04: `media_11907`/`11908` each fetched twice, one segment out of step.
   `evict()` compounds it — it drops entries only when `time > ref.endTime`, and
   consecutive BJSN references slightly *overlap* (a reference ends at
   `startTime + segmentDuration_` ≈ 2.000 s while the next starts at the real
   `tfdt`-derived end ≈ 1.980 s later), so the stale entry survives an extra round.
   The prototype sets `streaming.segmentPrefetchLimit = 0`, which is also correct
   for §6 metric parity — the standalone player has no prefetch either, and
   segments do not exist until the origin publishes them, so there is nothing
   genuinely useful to fetch ahead. **Phase 3 cannot rely on the default**, and
   the underlying behaviour is arguably an upstream bug: any parser that appends
   references lazily hits it, and the fix is for `prefetchSegmentsByTime()` to
   re-seek when `currTime` disagrees with the iterator's position.

**Failed downloads: §3.5's bet was wrong, and `SegmentDownloadManager` had to be
ported after all (2026-08-06).** Shaka's `retryParameters` do handle the *fetch*,
but its default `failureCallback` (`defaultStreamingFailureCallback_`,
lib/player.js) is not enough on two counts:

- it opens with `if (!this.isLive()) return;`, so **every download failure on a
  static stream is fatal**. A BJSN 404 is just as normal there — the capture has
  simply not reached that segment — and the standalone player draws no such
  distinction;
- it retries on a flat 1 s, where `SegmentDownloadManager` retries at 100 ms and
  only backs off once a failure looks persistent.

The prototype therefore supplies its own `streaming.failureCallback` carrying
`SegmentDownloadManager`'s policy verbatim: 100 ms per retry, exponential backoff
past 10 consecutive failures, 5 s ceiling, never fatal, counter reset by the
in-band segment response the parser already sees. RECOVERING is deliberately not
ported — it only spaces out the *next* fetch, which under Shaka belongs to
StreamingEngine. Measured over a permanent 404: retry 1 at 100 ms, retry 10 at
100 ms, retry 20 at the 5 s ceiling, then `download recovered ... after 21 failed
attempts` when the segment appeared.

Two things Phase 3/5 should carry forward from this:

1. **The delay handed to `retryStreaming()` is a floor, not a cadence.**
   StreamingEngine re-fetches only when it wants more data, so with a healthy
   buffer the observed spacing was ~2.9 s per attempt against a requested 100 ms.
   That is better behaviour than the standalone player's unconditional 100 ms
   hammering, but it means the two players' retry *rates* are not comparable even
   though their policies now match.
2. **A recoverable streaming error still reaches the `error` event as CRITICAL.**
   `handleStreamingError_()` fires `onError` *before* calling the
   `failureCallback` that downgrades severity, so severity cannot be used to tell
   a transient 404 from a real fault. Consumers must classify from
   `error.code` + the request type instead — the prototype's page does, and
   without it a normal live 404 raises a fatal-looking banner that nothing ever
   lowers.

Not done, and blocked rather than skipped: **skipping a segment the origin never
publishes.** `markAsUnavailable()` exists but nothing in `streaming_engine.js`
consults `Status.UNAVAILABLE` (only `MISSING`, and only from the HLS parser), and
`SegmentIndex` has no public single-reference removal — `evict(time)` would take
the seek history with it. So a permanently-missing segment stalls both players
alike, and moving past one needs either an upstream change or an eviction policy
that gives up on seeking backwards. Phase 5 decision.

**Caveats.** This is demo-level plain JS, not Closure modules, and it is not a
substitute for Phase 2/3: no unit tests, no lint coverage, single gear, no DRM,
and it reuses `ProgressiveMp4Parser`'s per-track init synthesis only to discard
it. It also runs the library uncompiled, so it needs `python3 build/gendeps.py`
(`build/all.py` cannot run here — the Closure compiler needs a Java runtime that
is not installed on this machine, which contradicts §0's earlier claim that
`build/all.py` was verified; `gendeps.py` is Node-based and does work).

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

> **A working prototype already exists** at `demo/bjsn/bjsn_shaka_parser.js`
> (§3.6). Phase 3 is now largely a port of it into `lib/` as Closure modules with
> tests, rather than a design exercise — but read §3.6's two failure modes first,
> because both are easy to reintroduce.
*Exit:* `shaka.Player.load(url, undefined, 'application/bjsn')` renders and
plays the initial file to its end, with zero diff to pre-existing `lib/` files
(or exactly one justified, tested diff).

**Phase 4 — Timeline correctness** (~2 days)
Implement §3.4. *Exit:* `player.seekRange()` matches the buffered range;
seeking within the buffer works; `getBufferedInfo()` agrees with
`sourceBuffer.buffered`; no drift after 10 segments.

**Phase 5 — Live continuation** (~3 days)
`update()` loop, `seq_num` advance, in-band `bjsn` refresh, 404 handling via
Shaka retry **plus a ported `SegmentDownloadManager` policy in
`streaming.failureCallback`** — the default callback is fatal on static streams,
per §3.5/§3.6. *Exit:* 30-minute unattended live playback with no stall and no
A/V drift; buffer health comparable to the standalone player; a paused origin
produces retries and no error banner, and playback resumes when it comes back.

**Phase 6 — Parity and hardening** (~2 days)
The measurement half of this is **already built**: `demo/bjsn/bjsn_timing_probe.js`
records time to first byte / `bjsn` parsed / init appended / first media append /
`playing` by hooking the MSE entry points, so it measures either player on
identical axes (§3.6). What remains is to run it against the standalone player
too and put the two columns side by side. Note that Option A's single
SourceBuffer collapses the separate video/audio init-append numbers into one, and
that Chrome pauses muted media in a hidden tab — read startup timings with the
window in front or they are meaningless. Then enable `lowLatencyMode` so
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
- ~~**`isAudioMuxedInVideo` is HLS-shaped.**~~ **Retired (2026-07-29, §3.6.)**
  The flag should never be set for BJSN — it triggers Shaka's *demux* path. Option
  A rides on `stream_utils.js`'s existing multiplexed-codec handling for a
  video-only variant instead, and the prototype needed no core fix at all.
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
Settled:

2. ~~**Upstream intent:** is zero-core-diff a hard requirement?~~ **Moot for
   Phases 3–5 (2026-07-29).** The question mattered because a hard requirement
   was assumed to cost extra work. §3.6 shows it costs nothing: a working Shaka
   BJSN player exists with zero `lib/` diff, so keep the constraint. It may
   reopen at Phase 7 (ABR), where Option A has to be revisited anyway.

3. ~~**Does the standalone player stay?**~~ **Yes.** It lives at `demo/bjsn/` and
   §2 treats its behaviour as the contract the integration must match. Phase 2
   repoints it at the new `lib/util/` modules so the two cannot drift.
