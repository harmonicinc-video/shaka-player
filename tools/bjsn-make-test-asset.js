#!/usr/bin/env node

/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Generates a synthetic multi-segment BJSN test asset with
 * real, decodable H.264 video and AAC audio, so live-continuation and
 * timeline-math tests are not limited to the single real capture at
 * test/test/assets/bjsn-initial-segment.mp4.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * The one real BJSN capture we have is a single initial segment. It is
 * enough to unit-test box parsing, but not enough to test:
 *   - live continuation across N segment files (seq_num chaining),
 *   - tfdt continuity for both tracks across file boundaries,
 *   - A/V sync over time in a muxed SourceBuffer.
 * This script builds a whole synthetic timeline (N files) with the exact
 * box shape BJSN uses, so those cases have something to run against.
 *
 * ── The core structural requirement ─────────────────────────────────────
 * Real BJSN files have EXACTLY ONE traf per moof (a single track), with
 * moofs for the two tracks interleaved roughly 1 video : 3 audio. Plain
 * `ffmpeg -movflags frag_keyframe+empty_moov+default_base_is_moof` (both
 * tracks muxed together) produces ONE moof per fragment holding a traf
 * PER TRACK -- the wrong shape.
 *
 * ── How this script gets the right shape ────────────────────────────────
 * Instead of muxing both tracks together and then splitting each
 * multi-traf moof back apart (the "post-process a combined file" approach
 * this task suggested as a default), this script sidesteps the problem
 * at the source: it asks ffmpeg to encode video and audio as two SEPARATE
 * single-track fragmented MP4s, each independently tuned so its own
 * fragmenter naturally emits one traf per moof (because there is only one
 * track in that file, there is nothing else it could emit). A third, tiny
 * combined render (muxing both codecs together, unfragmented) is used only
 * to harvest a `moov` that declares both `trak`s + `mvex`/`trex` -- the
 * only thing that genuinely requires both tracks to be known at once.
 *
 * The three outputs are then stitched together in Node:
 *   1. Take `ftyp`+`moov` from the harvest render.
 *   2. Take every moof/mdat pair from the video-only render (track_id
 *      already 1, matching the harvested moov's video trak) and from the
 *      audio-only render (track_id patched from 1 to 2 in each `tfhd`,
 *      since in its own single-track file ffmpeg naturally numbered it 1).
 *   3. Rewrite each fragment's `tfdt` to add the configured start time
 *      (converted to that track's own timescale), so both tracks' media
 *      time is continuous across the whole synthetic timeline, not
 *      0-based.
 *   4. Sort all fragments (both tracks, whole timeline) by absolute start
 *      time, bucket them into --segments windows of --duration seconds,
 *      and write each bucket as one output file.
 *
 * This works with NO recomputation of `trun.data_offset`, because both
 * per-track renders use `-movflags default_base_moof`, which makes
 * `trun.data_offset` relative to the START OF ITS OWN MOOF (verified
 * empirically: data_offset == moof.size + 8, i.e. "right after my own
 * mdat header", in both renders). Each moof+mdat pair is therefore fully
 * self-contained and can be relocated anywhere in any output file byte-
 * for-byte, as long as the mdat immediately follows its own moof -- which
 * this script preserves throughout.
 *
 * ── Environment note ─────────────────────────────────────────────────────
 * The project's default Homebrew `ffmpeg` (8.1.1) is built WITHOUT
 * libfreetype, so it has no `drawtext` filter, which the content
 * requirements need (burned-in timecode + frame counter). This script
 * looks for a `drawtext`-capable ffmpeg and, if the default one lacks it,
 * falls back to the `ffmpeg-full` Homebrew formula (keg-only, does not
 * touch the linked `ffmpeg`). See resolveFfmpeg() below.
 *
 * Usage:
 *   node tools/bjsn-make-test-asset.js [options]
 *   node tools/bjsn-make-test-asset.js --verify <dir>
 *   node tools/bjsn-make-test-asset.js --help
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');

// ───────────────────────────── constants ──────────────────────────────

/** Fixed content shape (not exposed as flags; the spec pins these). */
const WIDTH = 270;
const HEIGHT = 480;
const FPS = 30;
const VIDEO_TIMESCALE = 1000; // matches the real capture
const AUDIO_SAMPLE_RATE = 44100;
// Real capture uses audio mdhd timescale 1000. ffmpeg's mov muxer always
// uses the sample rate as the audio track timescale; there is no
// documented option to override that. Divergence #1 (see report).
const AUDIO_TIMESCALE = AUDIO_SAMPLE_RATE;
const AAC_SAMPLES_PER_FRAME = 1024;

// The real capture's styp box, byte for byte: major_brand 'msdh',
// minor_version 0, compatible_brands ['msdh','msix'].
const STYP_BOX = Buffer.from(
    '00000018' + '73747970' + '6d736468' + '00000000' + '6d736468' +
    '6d736978', 'hex');

// ─────────────────────────── CLI handling ─────────────────────────────

function printHelp() {
  console.log(`
BJSN synthetic test asset generator
====================================

Generates a multi-segment BJSN CMAF test asset (real H.264 + AAC media,
correct one-traf-per-moof box shape, interleaved tracks, continuous tfdt
across files) for testing timeline math and live segment continuation.

Usage:
  node tools/bjsn-make-test-asset.js [options]
  node tools/bjsn-make-test-asset.js --verify <dir>

Generation options:
  --out <dir>          Output directory (default: testdata/bjsn/generated)
  --segments <n>        Number of segment files (default: 10)
  --duration <sec>       Duration per segment, seconds (default: 2.0)
  --start-time <sec>     Media start time, seconds (default: 2333.176)
  --seq-num <n>          Initial bjsn seq_num (default: 11905, matches the
                         real capture)
  --template <str>       template_path, must contain \${num} (default:
                         "media_\${num}.mp4")
  --gear-num <n>         bjsn gear_num to report (default: 1)
  --keep-tmp             Keep intermediate ffmpeg renders for inspection
  --ffmpeg <path>        Force a specific ffmpeg binary

Verification:
  --verify <dir>         Structurally verify a previously generated asset
                         and print a full report (no ffmpeg required)

  -h, --help             Show this help
`);
}

function parseArgs(argv) {
  const opts = {
    out: 'testdata/bjsn/generated',
    segments: 10,
    duration: 2.0,
    startTime: 2333.176,
    seqNum: 11905,
    template: 'media_${num}.mp4',
    gearNum: 1,
    keepTmp: false,
    ffmpeg: null,
    verify: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      opts.help = true;
    } else if (a === '--verify') {
      opts.verify = argv[++i];
    } else if (a === '--out') {
      opts.out = argv[++i];
    } else if (a === '--segments') {
      opts.segments = parseInt(argv[++i], 10);
    } else if (a === '--duration') {
      opts.duration = parseFloat(argv[++i]);
    } else if (a === '--start-time') {
      opts.startTime = parseFloat(argv[++i]);
    } else if (a === '--seq-num') {
      opts.seqNum = parseInt(argv[++i], 10);
    } else if (a === '--template') {
      opts.template = argv[++i];
    } else if (a === '--gear-num') {
      opts.gearNum = parseInt(argv[++i], 10);
    } else if (a === '--keep-tmp') {
      opts.keepTmp = true;
    } else if (a === '--ffmpeg') {
      opts.ffmpeg = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

// ─────────────────────────── box utilities ────────────────────────────

/**
 * Minimal MP4 box walker. Assumes 32-bit box sizes only (true for every
 * box this tool reads or writes; the real capture and our renders never
 * use 64-bit box sizes).
 */
const Box = {
  u32(buf, o) {
    return buf.readUInt32BE(o);
  },
  type(buf, o) {
    return buf.toString('latin1', o + 4, o + 8);
  },
  /** Top-level boxes in [start, end). */
  topLevel(buf, start = 0, end = buf.length) {
    const out = [];
    let o = start;
    while (o + 8 <= end) {
      const size = Box.u32(buf, o);
      if (!size || o + size > end) break;
      out.push({type: Box.type(buf, o), offset: o, size});
      o += size;
    }
    return out;
  },
  /** Child boxes of a container whose payload spans [start+8, start+size). */
  children(buf, start, size) {
    return Box.topLevel(buf, start + 8, start + size);
  },
  /** Recursively find the first box of `type` under [start, start+size). */
  findRecursive(buf, start, size, type, skipFixedHeader = 0) {
    const kids = Box.topLevel(buf, start + 8 + skipFixedHeader, start + size);
    for (const k of kids) {
      if (k.type === type) return k;
    }
    for (const k of kids) {
      const found = Box.findRecursive(buf, k.offset, k.size, type);
      if (found) return found;
    }
    return null;
  },
  makeBox(type, payload) {
    const box = Buffer.alloc(8 + payload.length);
    box.writeUInt32BE(8 + payload.length, 0);
    box.write(type, 4, 'latin1');
    payload.copy(box, 8);
    return box;
  },
};

/**
 * Locates every avcC box under a moov (there will be exactly one, in the
 * video trak's stsd). Generic box-children traversal does not work inside
 * a stsd sample entry because VisualSampleEntry has a 78-byte fixed header
 * before its child boxes (avcC, etc.) begin -- this walks that explicitly.
 */
function findAvcCBoxes(buf, moov) {
  const found = [];
  for (const trak of Box.children(buf, moov.offset, moov.size)
      .filter((c) => c.type === 'trak')) {
    const mdia = Box.children(buf, trak.offset, trak.size)
        .find((c) => c.type === 'mdia');
    if (!mdia) continue;
    const minf = Box.children(buf, mdia.offset, mdia.size)
        .find((c) => c.type === 'minf');
    const stbl = minf && Box.children(buf, minf.offset, minf.size)
        .find((c) => c.type === 'stbl');
    const stsd = stbl && Box.children(buf, stbl.offset, stbl.size)
        .find((c) => c.type === 'stsd');
    if (!stsd) continue;
    // stsd payload: version/flags(4) + entry_count(4), then sample entries.
    const entryOffset = stsd.offset + 16;
    const entryType = Box.type(buf, entryOffset);
    if (entryType !== 'avc1' && entryType !== 'avc3') continue;
    const entrySize = Box.u32(buf, entryOffset);
    // VisualSampleEntry fixed fields: 78 bytes after the 8-byte box header.
    const childStart = entryOffset + 8 + 78;
    const avcC = Box.topLevel(buf, childStart, entryOffset + entrySize)
        .find((c) => c.type === 'avcC');
    if (avcC) found.push(avcC);
  }
  return found;
}

/**
 * x264's `-profile baseline` on this ffmpeg build writes
 * profile_compatibility / SPS constraint-flags byte 0xC0 (constraint_set0
 * + constraint_set1), giving codec string avc1.42C01E. The near-universal
 * CMAF/DASH-IF convention for "AVC Baseline, Level 3.0" -- and what this
 * task's content requirements ask for -- is avc1.42E01E (0xE0:
 * constraint_set0+1+2). The extra bit (constraint_set2, "Extended profile
 * compatible") does not change bitstream decodability for content that
 * only uses Baseline features to begin with (true here: no B-frames, no
 * slice data partitioning), so this patches that one bit in both places
 * it's duplicated (the avcC header field and the embedded SPS NAL) to
 * match the expected codec string. This is metadata-only; it does not
 * touch encoded sample data.
 */
function patchAvcConstraintFlags(buf, moov) {
  for (const avcC of findAvcCBoxes(buf, moov)) {
    const payloadOffset = avcC.offset + 8;
    const before = buf[payloadOffset + 2].toString(16);
    buf[payloadOffset + 2] |= 0x20; // avcC.profile_compatibility
    buf[payloadOffset + 8 + 2] |= 0x20; // SPS NAL constraint-flags byte
    const after = buf[payloadOffset + 2].toString(16);
    console.log(
        `Patched avcC profile_compatibility 0x${before} -> 0x${after} ` +
        `(constraint_set2_flag) so the codec string reads avc1.42E01E`);
  }
}

/** Build the bjsn box: 4-byte size + 'bjsn' + compact UTF-8 JSON payload. */
function buildBjsnBox(json) {
  const payload = Buffer.from(JSON.stringify(json), 'utf8');
  return Box.makeBox('bjsn', payload);
}

/** The gear_list shape mirrored from the real capture's bjsn box. */
function makeGearList(gearNum) {
  const names = ['sd', 'sd5', 'ld', 'ld5', 'md', 'hd', 'hd5', 'uhd', 'uhd5'];
  const list = [];
  for (let i = 0; i < gearNum; i++) {
    const name = names[i % names.length];
    list.push({[name]: {realtime_bitrate: 1000000}});
  }
  return list;
}

// ─────────────────────────── ffmpeg plumbing ───────────────────────────

/**
 * Finds an ffmpeg binary with the `drawtext` filter available. Tries the
 * caller-specified path, then `ffmpeg` on PATH, then the keg-only
 * `ffmpeg-full` Homebrew formula (installed by this task specifically
 * because the project's default ffmpeg lacks libfreetype/drawtext).
 */
function resolveFfmpeg(forcedPath) {
  const candidates = [
    forcedPath,
    process.env.FFMPEG_BIN,
    'ffmpeg',
    '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
    '/usr/local/opt/ffmpeg-full/bin/ffmpeg',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const out = execFileSync(candidate, ['-hide_banner', '-filters'],
          {encoding: 'utf8'});
      if (/\bdrawtext\b/.test(out)) {
        return candidate;
      }
    } catch (e) {
      // Not found or not runnable; try the next candidate.
    }
  }
  throw new Error(
      'No ffmpeg with the drawtext filter was found. The project\'s ' +
      'default `ffmpeg` is built without libfreetype. Install the full ' +
      'build with `brew install ffmpeg-full` (keg-only, will not disturb ' +
      'the linked `ffmpeg`), or pass --ffmpeg <path> to a build that has ' +
      'drawtext (`ffmpeg -filters | grep drawtext` to check).');
}

/** Seconds -> "HH:MM:SS:FF" for the drawtext `timecode` option. */
function toSmpteTimecode(seconds, fps) {
  const totalFrames = Math.round(seconds * fps);
  const framesPerHour = fps * 3600;
  const h = Math.floor(totalFrames / framesPerHour) % 24;
  const remH = totalFrames % framesPerHour;
  const framesPerMin = fps * 60;
  const m = Math.floor(remH / framesPerMin);
  const remM = remH % framesPerMin;
  const s = Math.floor(remM / fps);
  const f = remM % fps;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
}

/**
 * Renders the video-only fragmented MP4: 270x480 H.264 Baseline 3.0 with a
 * burned-in SMPTE timecode (starting at --start-time) and a frame counter.
 * frag_duration is tuned to ~1.5 frame periods so the fragmenter reliably
 * flushes every 2 frames (~67ms/moof), matching the real capture's video
 * cadence.
 */
function renderVideoOnly(ffmpeg, outFile, totalDuration, startTime) {
  const timecode = toSmpteTimecode(startTime, FPS);
  const startFrame = Math.round(startTime * FPS);
  const videoFragUs = Math.round((1.5 / FPS) * 1e6);
  const vf =
      `drawtext=timecode='${timecode.replace(/:/g, '\\:')}'` +
      `:timecode_rate=${FPS}:tc24hmax=1:fontcolor=white:fontsize=22` +
      `:x=10:y=10:box=1:boxcolor=black@0.6,` +
      `drawtext=text='frame %{eif\\:n+${startFrame}\\:d}'` +
      `:fontcolor=yellow:fontsize=18:x=10:y=44:box=1:boxcolor=black@0.6`;
  const args = [
    '-y', '-hide_banner', '-loglevel', 'warning',
    '-f', 'lavfi', '-i',
    `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${totalDuration}`,
    '-vf', vf,
    '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0',
    '-pix_fmt', 'yuv420p', '-g', '9999',
    '-an', '-video_track_timescale', String(VIDEO_TIMESCALE),
    '-frag_duration', String(videoFragUs),
    '-movflags', 'empty_moov+default_base_moof',
    '-f', 'mp4', outFile,
  ];
  execFileSync(ffmpeg, args, {stdio: ['ignore', 'ignore', 'pipe']});
}

/**
 * Renders the audio-only fragmented MP4: AAC-LC 44.1kHz, a 0.5s, 1kHz sine
 * beep gated to the first 100ms of every ABSOLUTE second (i.e. aligned to
 * when --start-time + t crosses a whole second), so the beep can be
 * checked by eye/ear against the video's burned-in timecode. frag_duration
 * is tuned to flush after exactly one 1024-sample AAC frame (~23.2ms/moof),
 * matching the real capture's audio cadence and producing the ~1:3
 * video:audio moof ratio the real file shows.
 */
function renderAudioOnly(ffmpeg, outFile, totalDuration, startTime) {
  const audioFragUs =
      Math.round(0.5 * (AAC_SAMPLES_PER_FRAME / AUDIO_SAMPLE_RATE) * 1e6);
  const expr =
      `0.5*sin(2*PI*1000*t)*lt(mod(${startTime}+t\\,1)\\,0.1)`;
  const args = [
    '-y', '-hide_banner', '-loglevel', 'warning',
    '-f', 'lavfi', '-i',
    `aevalsrc=exprs='${expr}':sample_rate=${AUDIO_SAMPLE_RATE}` +
      `:duration=${totalDuration}`,
    '-c:a', 'aac', '-b:a', '64k', '-ar', String(AUDIO_SAMPLE_RATE),
    '-vn',
    '-frag_duration', String(audioFragUs),
    '-movflags', 'empty_moov+default_base_moof',
    '-f', 'mp4', outFile,
  ];
  execFileSync(ffmpeg, args, {stdio: ['ignore', 'ignore', 'pipe']});
}

/**
 * Renders a tiny (0.5s) combined video+audio MP4 purely to harvest a
 * `moov` that declares both tracks (trak x2 + mvex/trex x2) with the same
 * codec configs as the real per-track renders. The media samples in this
 * file are discarded entirely; only ftyp+moov are used.
 */
function renderMoovHarvest(ffmpeg, outFile) {
  const args = [
    '-y', '-hide_banner', '-loglevel', 'warning',
    '-f', 'lavfi', '-i', `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}` +
      ':duration=0.5',
    '-f', 'lavfi', '-i',
    `aevalsrc=exprs='0':sample_rate=${AUDIO_SAMPLE_RATE}:duration=0.5`,
    '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0',
    '-pix_fmt', 'yuv420p', '-g', '9999',
    '-c:a', 'aac', '-b:a', '64k', '-ar', String(AUDIO_SAMPLE_RATE),
    '-video_track_timescale', String(VIDEO_TIMESCALE),
    '-movflags', 'empty_moov+default_base_moof',
    '-f', 'mp4', outFile,
  ];
  execFileSync(ffmpeg, args, {stdio: ['ignore', 'ignore', 'pipe']});
}

// ───────────────────────── fragment extraction ─────────────────────────

/**
 * Walks a rendered single-track file and returns its moof/mdat pairs plus
 * enough parsed offsets to patch tfhd.track_ID and tfdt later. Skips the
 * leading ftyp/moov and any trailing mfra (movie fragment random access)
 * box that the muxer appends.
 */
function extractFragments(buf, trackKind) {
  const frags = [];
  for (const b of Box.topLevel(buf)) {
    if (b.type !== 'moof') continue;
    const next = Box.topLevel(buf, b.offset + b.size, buf.length)[0];
    if (!next || next.type !== 'mdat' || next.offset !== b.offset + b.size) {
      throw new Error(
          `Expected mdat immediately after moof at offset ${b.offset} ` +
          `in ${trackKind} render, found ${next && next.type}`);
    }
    const traf = Box.children(buf, b.offset, b.size)
        .find((c) => c.type === 'traf');
    const trafKids = Box.children(buf, traf.offset, traf.size);
    const tfhd = trafKids.find((c) => c.type === 'tfhd');
    const tfdt = trafKids.find((c) => c.type === 'tfdt');
    const trun = trafKids.find((c) => c.type === 'trun');
    if (!tfhd || !tfdt || !trun) {
      throw new Error(`traf at ${traf.offset} missing tfhd/tfdt/trun`);
    }
    const tfdtVersion = buf.readUInt8(tfdt.offset + 8);
    const tfdtRaw = tfdtVersion === 1 ?
      (BigInt(Box.u32(buf, tfdt.offset + 12)) << 32n) +
        BigInt(Box.u32(buf, tfdt.offset + 16)) :
      BigInt(Box.u32(buf, tfdt.offset + 12));

    const fullSize = next.offset + next.size - b.offset;
    const bytes = Buffer.from(buf.subarray(b.offset, b.offset + fullSize));

    frags.push({
      trackKind,
      bytes,
      moofSize: b.size,
      tfhdOffsetInFrag: tfhd.offset - b.offset,
      tfdtOffsetInFrag: tfdt.offset - b.offset,
      tfdtVersion,
      tfdtRaw, // BigInt, zero-based, in the source file's own timescale
    });
  }
  return frags;
}

/** Patches tfhd.track_ID (offset 12 in the tfhd payload) in place. */
function patchTrackId(frag, newTrackId) {
  const off = frag.tfhdOffsetInFrag + 12;
  frag.bytes.writeUInt32BE(newTrackId, off);
}

/** Patches tfdt's baseMediaDecodeTime (version-aware) in place. */
function patchTfdt(frag, absValue) {
  const off = frag.tfdtOffsetInFrag + 12;
  if (frag.tfdtVersion === 1) {
    frag.bytes.writeUInt32BE(Number(absValue >> 32n), off);
    frag.bytes.writeUInt32BE(Number(absValue & 0xFFFFFFFFn), off + 4);
  } else {
    if (absValue > 0xFFFFFFFFn) {
      throw new Error(
          `tfdt value ${absValue} overflows a version-0 (32-bit) tfdt box`);
    }
    frag.bytes.writeUInt32BE(Number(absValue), off);
  }
}

// ───────────────────────────── generation ──────────────────────────────

function generate(opts) {
  if (!opts.template.includes('${num}')) {
    throw new Error('--template must contain the literal "${num}"');
  }
  const ffmpeg = resolveFfmpeg(opts.ffmpeg);
  console.log(`Using ffmpeg: ${ffmpeg}`);

  const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bjsn-make-test-asset-'));
  const totalDuration = opts.segments * opts.duration;

  try {
    const videoFile = path.join(tmpDir, 'video-only.mp4');
    const audioFile = path.join(tmpDir, 'audio-only.mp4');
    const harvestFile = path.join(tmpDir, 'moov-harvest.mp4');

    console.log(
        `Rendering video-only track (${totalDuration.toFixed(3)}s, ` +
        `${WIDTH}x${HEIGHT}@${FPS}fps, H.264 Baseline 3.0)...`);
    renderVideoOnly(ffmpeg, videoFile, totalDuration, opts.startTime);

    console.log('Rendering audio-only track (AAC-LC 44.1kHz, beep-per-second)...');
    renderAudioOnly(ffmpeg, audioFile, totalDuration, opts.startTime);

    console.log('Rendering combined moov harvest (both tracks, tiny/discarded media)...');
    renderMoovHarvest(ffmpeg, harvestFile);

    const videoBuf = fs.readFileSync(videoFile);
    const audioBuf = fs.readFileSync(audioFile);
    const harvestBuf = fs.readFileSync(harvestFile);

    // ftyp + moov straight from the harvest render.
    const harvestBoxes = Box.topLevel(harvestBuf);
    const ftyp = harvestBoxes.find((b) => b.type === 'ftyp');
    const moov = harvestBoxes.find((b) => b.type === 'moov');
    if (!ftyp || !moov || moov.offset !== ftyp.offset + ftyp.size) {
      throw new Error('Harvest render did not produce ftyp immediately ' +
          'followed by moov as expected');
    }
    patchAvcConstraintFlags(harvestBuf, moov);
    const ftypMoov = harvestBuf.subarray(ftyp.offset, moov.offset + moov.size);

    // Sanity-check the harvested moov declares track 1 = video, 2 = audio,
    // and grab timescales for reporting.
    const moovBuf = harvestBuf; // moov box lives inside harvestBuf
    const traks = Box.children(moovBuf, moov.offset, moov.size)
        .filter((c) => c.type === 'trak');
    const trackInfo = {};
    for (const trak of traks) {
      const trakKids = Box.children(moovBuf, trak.offset, trak.size);
      const tkhd = trakKids.find((c) => c.type === 'tkhd');
      const version = moovBuf.readUInt8(tkhd.offset + 8);
      const idOff = tkhd.offset + (version === 1 ? 8 + 1 + 3 + 16 : 8 + 1 + 3 + 8);
      const trackId = Box.u32(moovBuf, idOff);
      const mdia = trakKids.find((c) => c.type === 'mdia');
      const mdiaKids = Box.children(moovBuf, mdia.offset, mdia.size);
      const mdhd = mdiaKids.find((c) => c.type === 'mdhd');
      const mdhdVersion = moovBuf.readUInt8(mdhd.offset + 8);
      const tsOff = mdhd.offset + (mdhdVersion === 1 ? 8 + 1 + 3 + 16 : 8 + 1 + 3 + 8);
      const timescale = Box.u32(moovBuf, tsOff);
      trackInfo[trackId] = {timescale};
    }
    if (!trackInfo[1] || !trackInfo[2]) {
      throw new Error(
          `Expected harvested moov to declare track_id 1 and 2, got: ` +
          `${Object.keys(trackInfo).join(',')}`);
    }
    console.log(
        `Harvested moov: track 1 timescale=${trackInfo[1].timescale} ` +
        `(video), track 2 timescale=${trackInfo[2].timescale} (audio)`);

    // Extract fragments from each single-track render.
    const videoFrags = extractFragments(videoBuf, 'video');
    const audioFrags = extractFragments(audioBuf, 'audio');
    console.log(
        `Extracted ${videoFrags.length} video fragments, ` +
        `${audioFrags.length} audio fragments from per-track renders.`);

    // Audio-only render numbers its (only) track 1; retarget to track 2 to
    // match the harvested moov's audio trak, and compute each fragment's
    // absolute tfdt (start-time offset added, in that track's own
    // timescale) plus a common millisecond value used only for bucketing/
    // sorting.
    const videoStartOffset = BigInt(Math.round(opts.startTime * VIDEO_TIMESCALE));
    const audioStartOffset = BigInt(Math.round(opts.startTime * AUDIO_TIMESCALE));

    const allFrags = [];
    for (const f of videoFrags) {
      const localMs = Number(f.tfdtRaw) * 1000 / VIDEO_TIMESCALE;
      patchTfdt(f, f.tfdtRaw + videoStartOffset);
      allFrags.push({...f, trackId: 1, localMs});
    }
    for (const f of audioFrags) {
      patchTrackId(f, 2);
      const localMs = Number(f.tfdtRaw) * 1000 / AUDIO_TIMESCALE;
      patchTfdt(f, f.tfdtRaw + audioStartOffset);
      allFrags.push({...f, trackId: 2, localMs});
    }
    allFrags.sort((a, b) => a.localMs - b.localMs);

    // Bucket into --segments windows of --duration seconds each. Any
    // trailing overshoot (ffmpeg pads the last fragment of each render to
    // a full frame/AAC-frame) is clamped into the final segment rather
    // than dropped or creating an extra file.
    const durationMs = opts.duration * 1000;
    const buckets = Array.from({length: opts.segments}, () => []);
    for (const f of allFrags) {
      let idx = Math.floor(f.localMs / durationMs);
      if (idx >= opts.segments) idx = opts.segments - 1;
      if (idx < 0) idx = 0;
      buckets[idx].push(f);
    }

    fs.mkdirSync(opts.out, {recursive: true});
    const written = [];
    for (let i = 0; i < opts.segments; i++) {
      const seqNum = opts.seqNum + i;
      const fileName = opts.template.replace('${num}', String(seqNum));
      const filePath = path.join(opts.out, fileName);

      const bjsnJson = {
        type: 'dynamic',
        gear_num: opts.gearNum,
        seq_num: seqNum,
        template_path: opts.template,
        gear_list: makeGearList(opts.gearNum),
      };
      const bjsnBox = buildBjsnBox(bjsnJson);

      const mediaParts = buckets[i].map((f) => f.bytes);
      const parts = i === 0 ?
        [ftypMoov, bjsnBox, STYP_BOX, ...mediaParts] :
        // Subsequent segments carrying their own bjsn box is THIS SCRIPT'S
        // ASSUMPTION, not something observed in real traffic -- we only
        // have the initial segment to go on. See report.
        [STYP_BOX, bjsnBox, ...mediaParts];

      const outBuf = Buffer.concat(parts);
      fs.writeFileSync(filePath, outBuf);
      written.push({filePath, size: outBuf.size || outBuf.length, seqNum,
        fragCount: buckets[i].length});
      console.log(
          `Wrote ${filePath} (${outBuf.length} bytes, seq_num=${seqNum}, ` +
          `${buckets[i].length} fragments)`);
    }

    const totalSize = written.reduce((s, w) => s + w.size, 0);
    console.log(`\nDone. ${written.length} files, ${totalSize} bytes total.`);
    return written;
  } finally {
    if (opts.keepTmp) {
      console.log(`Kept intermediate renders in ${tmpDir}`);
    } else {
      fs.rmSync(tmpDir, {recursive: true, force: true});
    }
  }
}

// ───────────────────────────── verification ────────────────────────────

/** Parses the bjsn box (if any) from a top-level box list. */
function readBjsn(buf, boxes) {
  const b = boxes.find((x) => x.type === 'bjsn');
  if (!b) return null;
  const payload = buf.subarray(b.offset + 8, b.offset + b.size);
  return JSON.parse(payload.toString('utf8'));
}

/** Reads mdhd timescale per track_id out of a moov box. */
function readTimescales(buf, moov) {
  const result = {};
  const traks = Box.children(buf, moov.offset, moov.size)
      .filter((c) => c.type === 'trak');
  for (const trak of traks) {
    const trakKids = Box.children(buf, trak.offset, trak.size);
    const tkhd = trakKids.find((c) => c.type === 'tkhd');
    const version = buf.readUInt8(tkhd.offset + 8);
    const idOff = tkhd.offset + (version === 1 ? 8 + 1 + 3 + 16 : 8 + 1 + 3 + 8);
    const trackId = Box.u32(buf, idOff);
    const mdia = trakKids.find((c) => c.type === 'mdia');
    const mdiaKids = Box.children(buf, mdia.offset, mdia.size);
    const mdhd = mdiaKids.find((c) => c.type === 'mdhd');
    const mdhdVersion = buf.readUInt8(mdhd.offset + 8);
    const tsOff = mdhd.offset + (mdhdVersion === 1 ? 8 + 1 + 3 + 16 : 8 + 1 + 3 + 8);
    result[trackId] = Box.u32(buf, tsOff);
  }
  return result;
}

/** Parses every moof/mdat pair in a file, returning per-traf info. */
function readMoofs(buf) {
  const out = [];
  const boxes = Box.topLevel(buf);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.type !== 'moof') continue;
    const mdat = boxes[i + 1];
    const trafs = Box.children(buf, b.offset, b.size)
        .filter((c) => c.type === 'traf');
    const trafInfo = trafs.map((traf) => {
      const kids = Box.children(buf, traf.offset, traf.size);
      const tfhd = kids.find((c) => c.type === 'tfhd');
      const tfdt = kids.find((c) => c.type === 'tfdt');
      const trun = kids.find((c) => c.type === 'trun');
      const trackId = Box.u32(buf, tfhd.offset + 12);
      const tfdtVersion = buf.readUInt8(tfdt.offset + 8);
      const tfdtValue = tfdtVersion === 1 ?
        (BigInt(Box.u32(buf, tfdt.offset + 12)) << 32n) +
          BigInt(Box.u32(buf, tfdt.offset + 16)) :
        BigInt(Box.u32(buf, tfdt.offset + 12));

      // tfhd may carry default_sample_duration/_size/_flags after
      // track_ID, gated by its own flag bits. When trun omits a
      // per-sample field (common for single-sample fragments -- ffmpeg
      // uses this to save 4 bytes per fragment), the value comes from
      // here instead.
      const tfhdFlags = Box.u32(buf, tfhd.offset + 8) & 0xFFFFFF;
      let tfhdP = tfhd.offset + 16;
      if (tfhdFlags & 0x000001) tfhdP += 8; // base-data-offset-present (64-bit)
      if (tfhdFlags & 0x000002) tfhdP += 4; // sample-description-index-present
      let defaultSampleSize = null;
      if (tfhdFlags & 0x000008) tfhdP += 4; // default-sample-duration-present
      if (tfhdFlags & 0x000010) { // default-sample-size-present
        defaultSampleSize = Box.u32(buf, tfhdP);
        tfhdP += 4;
      }

      const trunFlags = Box.u32(buf, trun.offset + 8) & 0xFFFFFF;
      const sampleCount = Box.u32(buf, trun.offset + 12);
      let p = trun.offset + 16;
      if (trunFlags & 0x000001) p += 4; // data-offset-present
      if (trunFlags & 0x000004) p += 4; // first-sample-flags-present
      let sampleTotal = 0;
      for (let s = 0; s < sampleCount; s++) {
        if (trunFlags & 0x000100) p += 4; // sample-duration-present
        if (trunFlags & 0x000200) {
          sampleTotal += Box.u32(buf, p); // sample-size-present (per sample)
          p += 4;
        } else {
          if (defaultSampleSize === null) {
            throw new Error(
                `traf at ${traf.offset}: trun has no per-sample size and ` +
                `tfhd has no default_sample_size`);
          }
          sampleTotal += defaultSampleSize;
        }
        if (trunFlags & 0x000400) p += 4; // sample-flags-present
        if (trunFlags & 0x000800) p += 4; // sample-composition-time-offsets
      }
      return {trackId, tfdt: tfdtValue, sampleCount, sampleTotal};
    });
    out.push({moofOffset: b.offset, moofSize: b.size,
      mdatSize: mdat && mdat.type === 'mdat' ? mdat.size : null,
      mdatPayloadSize: mdat && mdat.type === 'mdat' ? mdat.size - 8 : null,
      trafs: trafInfo});
  }
  return out;
}

function verify(dir) {
  const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.mp4'))
      .sort();
  if (files.length === 0) {
    throw new Error(`No .mp4 files found in ${dir}`);
  }
  console.log(`Verifying ${files.length} files in ${dir}\n`);

  let initialFile = null;
  let timescales = null;
  const perFileMoofs = {};
  const trafCountHistogram = {};
  let allSingleTraf = true;
  const errors = [];

  for (const name of files) {
    const filePath = path.join(dir, name);
    const buf = fs.readFileSync(filePath);
    const boxes = Box.topLevel(buf);
    const hasFtyp = boxes.some((b) => b.type === 'ftyp');
    const hasMoov = boxes.some((b) => b.type === 'moov');
    const hasStyp = boxes.some((b) => b.type === 'styp');
    const hasBjsn = boxes.some((b) => b.type === 'bjsn');
    const moofCount = boxes.filter((b) => b.type === 'moof').length;
    const mdatCount = boxes.filter((b) => b.type === 'mdat').length;

    if (hasFtyp && hasMoov) {
      if (initialFile) {
        errors.push(`Multiple files have ftyp+moov: ${initialFile} and ${name}`);
      }
      initialFile = name;
      const moov = boxes.find((b) => b.type === 'moov');
      timescales = readTimescales(buf, moov);
    } else if (hasFtyp || hasMoov) {
      errors.push(`${name}: has exactly one of ftyp/moov (should have both or neither)`);
    }

    const moofs = readMoofs(buf);
    perFileMoofs[name] = moofs;
    for (const m of moofs) {
      const n = m.trafs.length;
      trafCountHistogram[n] = (trafCountHistogram[n] || 0) + 1;
      if (n !== 1) allSingleTraf = false;
      if (m.mdatPayloadSize !== null) {
        const trafByteSum = m.trafs.reduce((s, t) => s + t.sampleTotal, 0);
        if (trafByteSum !== m.mdatPayloadSize) {
          errors.push(
              `${name}: moof@${m.moofOffset} mdat payload=${m.mdatPayloadSize} ` +
              `!= sum(trun sizes)=${trafByteSum}`);
        }
      }
    }
    if (moofCount !== mdatCount) {
      errors.push(`${name}: moof count (${moofCount}) != mdat count (${mdatCount})`);
    }

    console.log(
        `${name}: ftyp=${hasFtyp} moov=${hasMoov} styp=${hasStyp} ` +
        `bjsn=${hasBjsn} moof=${moofCount} mdat=${mdatCount}`);
  }

  console.log(`\n[1] Initial file: ${initialFile}`);
  console.log(`    Subsequent files without ftyp/moov: ` +
      `${files.filter((f) => f !== initialFile).length} / ${files.length - 1} expected`);

  console.log(`\n[2] trafCount distribution across all moofs: ` +
      JSON.stringify(trafCountHistogram));
  console.log(`    Every moof has exactly one traf: ${allSingleTraf}`);

  // [3] Track ids + interleaving, first file.
  const firstMoofs = perFileMoofs[initialFile];
  const trackSeq = firstMoofs.map((m) => m.trafs[0] && m.trafs[0].trackId);
  const distinctTracks = new Set(trackSeq);
  console.log(`\n[3] Track ids seen: ${[...distinctTracks].join(', ')}`);
  console.log(`    ${initialFile} moof track sequence (first 40): ` +
      trackSeq.slice(0, 40).join(','));
  const videoCount = trackSeq.filter((t) => t === 1).length;
  const audioCount = trackSeq.filter((t) => t === 2).length;
  console.log(`    ${initialFile} totals: video(track1)=${videoCount} ` +
      `audio(track2)=${audioCount} ratio=1:${(audioCount / videoCount).toFixed(2)}`);

  // [4] tfdt monotonicity within file + continuity across files, per track.
  console.log(`\n[4] tfdt continuity (timescales: ${JSON.stringify(timescales)})`);
  const lastTfdtByTrack = {};
  for (const name of files.slice(0, Math.max(3, files.length))) {
    const moofs = perFileMoofs[name];
    const byTrack = {};
    for (const m of moofs) {
      for (const t of m.trafs) {
        (byTrack[t.trackId] = byTrack[t.trackId] || []).push(t.tfdt);
      }
    }
    for (const trackId of Object.keys(byTrack)) {
      const vals = byTrack[trackId];
      let monotonic = true;
      for (let i = 1; i < vals.length; i++) {
        if (vals[i] < vals[i - 1]) monotonic = false;
      }
      const first = vals[0];
      const last = vals[vals.length - 1];
      const prevLast = lastTfdtByTrack[trackId];
      let gapNote = 'n/a (first file for this track)';
      if (prevLast !== undefined) {
        const ts = timescales[trackId] || 1;
        const gapTicks = first - prevLast;
        gapNote = `prevLast=${prevLast} thisFirst=${first} ` +
            `deltaTicks=${gapTicks} deltaMs=${(Number(gapTicks) * 1000 / ts).toFixed(2)}`;
      }
      lastTfdtByTrack[trackId] = last;
      if (files.indexOf(name) < 3) {
        console.log(
            `    ${name} track=${trackId} monotonic=${monotonic} ` +
            `first=${first} last=${last} count=${vals.length} :: ${gapNote}`);
      }
    }
  }

  console.log(`\n[5] moof/mdat + mdat-vs-trun-sizes: ` +
      `${errors.length === 0 ? 'ALL OK' : errors.length + ' PROBLEM(S)'}`);
  for (const e of errors) console.log(`    ERROR: ${e}`);

  console.log(`\nVerification ${errors.length === 0 ? 'PASSED' : 'FAILED'}`);
  return {errors, initialFile, trafCountHistogram, timescales};
}

// ───────────────────────────────── main ────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.verify) {
    const result = verify(opts.verify);
    process.exitCode = result.errors.length === 0 ? 0 : 1;
    return;
  }
  generate(opts);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`Error: ${e.message}`);
    if (e.stderr) console.error(e.stderr.toString());
    process.exit(1);
  }
}

module.exports = {Box, buildBjsnBox, toSmpteTimecode};
