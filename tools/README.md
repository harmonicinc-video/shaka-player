# BJSN tools

Two command-line utilities for working with BJSN (Bytedance JSON) CMAF content,
as described in TikTok's CMAF CDN distribution architecture:

| Script | Purpose |
| --- | --- |
| `bjsn-stripper-cli.js` | Inspect a captured segment, or strip its `bjsn` box |
| `bjsn-make-test-asset.js` | Generate a synthetic multi-segment BJSN asset with ffmpeg |

Both are plain Node scripts with no dependencies beyond Node itself
(`bjsn-make-test-asset.js` also shells out to ffmpeg).

---

# bjsn-make-test-asset.js

Generates a synthetic multi-segment BJSN asset. We have only one real captured
segment, which is not enough to test timeline mapping or live segment
continuation, so this produces a controllable stand-in.

```bash
node tools/bjsn-make-test-asset.js --out testdata/bjsn/generated \
  --segments 10 --duration 2.0 --start-time 2333.176 \
  --seq-num 11905 --template 'media_${num}.mp4'

# check the result's structure
node tools/bjsn-make-test-asset.js --verify testdata/bjsn/generated
```

Output mirrors the real capture's structure: one `traf` per `moof`, video and
audio moofs interleaved roughly 1:3, `tfdt` starting at a large non-zero media
time and continuing seamlessly across segment files, and a `bjsn` box in every
segment. Only the first segment carries `ftyp`+`moov` — but see the divergences
below, because the customer spec suggests every segment should.

The video has a burned-in timecode and frame counter, and the audio beeps at each
whole second, so A/V sync can be judged by eye and ear.

**`drawtext` requirement.** The burned-in timecode needs an ffmpeg built with
libfreetype. Homebrew's default `ffmpeg` may lack it; the script auto-detects a
`drawtext`-capable binary and errors clearly if it finds none.

**Divergences from the real capture** — this asset is a stand-in, not a replica:

- Audio `mdhd` timescale is the sample rate (44100); the real capture uses 1000.
  Useful in that it forces per-track timescale reading, but it does not cover the
  real timescale-1000 audio case.
- A/V start skew is ~0; the real capture has ~10 ms. So it does not exercise the
  "t0 = minimum across tracks" path.
- One synthetic gear, versus nine in the real capture.
- Subsequent segments contain a `bjsn` box. **Confirmed** by the customer spec
  (V2.0, 16 May): every segment carries the metadata.
- Subsequent segments contain **no** `ftyp`/`moov`. This is an assumption and
  the customer spec suggests it is **wrong** — it says initial and subsequent
  segments are "identical in content". A `--init-every-segment` flag and a
  fixture regeneration are likely needed; see plan §2b.

---

# bjsn-stripper-cli.js

A command-line utility for removing BJSN (Bytedance JSON) boxes from MP4 files. This tool is designed to work with CMAF segments that contain BJSN boxes as described in TikTok's CMAF CDN distribution architecture.

## Overview

The BJSN Box Stripper CLI tool provides a standalone way to inspect BJSN CMAF
segments and to remove their `bjsn` box — the custom metadata box TikTok embeds
in every segment. It reads both initial and subsequent segments (see "Segment
kinds" below).

## Installation

This tool is part of the Shaka Player project. No additional installation is required beyond having Node.js installed.

## Usage

### Basic Usage

```bash
# Strip BJSN boxes from a file
node tools/bjsn-stripper-cli.js input.mp4 output.mp4

# Strip BJSN boxes (output file will be input_stripped.mp4)
node tools/bjsn-stripper-cli.js input.mp4
```

### Advanced Usage

```bash
# Show BJSN box info and file structure, without writing anything
node tools/bjsn-stripper-cli.js --info input.mp4

# Split an initial segment into per-track init and media segments
node tools/bjsn-stripper-cli.js --split input.mp4 output-prefix

# Also detect and print codec strings
node tools/bjsn-stripper-cli.js --info --codec input.mp4

# Verbose output (includes stack traces on error)
node tools/bjsn-stripper-cli.js --verbose input.mp4 output.mp4
```

### Command Line Options

Authoritative list — run `--help` to confirm:

- `-h, --help`: Show help message
- `-i, --info`: Show BJSN box info and file structure, without stripping
- `-s, --split`: Split into separate init and media segments (initial segment only)
- `-c, --codec`: Detect and display codec information
- `-v, --verbose`: Verbose output

Exit status is `0` on success and `1` on any error.

## BJSN Box Format

BJSN boxes contain JSON metadata with the following structure:

```json
{
  "type": "dynamic/static",
  "gear_num": 3,
  "seq_num": 10,
  "template_path": "123-media-first-${num}.mp4",
  "gear_list": [
    {
      "uhd5": {
        "realtime_bitrate": 1000000,
        "drm": {
          "key": "value"
        }
      }
    }
  ]
}
```

## Examples

### Example 1: Inspecting a real capture

Actual output, not illustrative:

```
$ node tools/bjsn-stripper-cli.js --info test/test/assets/bjsn-initial-segment.mp4
📁 Processing file: test/test/assets/bjsn-initial-segment.mp4

📊 File Information:
  Size: 76774 bytes

📊 BJSN Box:
  Offset: 1104
  Size: 433 bytes
  Data: {
  "type": "dynamic",
  "gear_num": 9,
  "seq_num": 11905,
  "template_path": "media_${num}.mp4",
  "gear_list": [
    {
      "hd": {
        "realtime_bitrate": 2000000
      }
    ... (9 gears total)
  ]
}

📊 Segment kind: initial (has ftyp + moov)
  Fragments: 116 moof / 116 mdat
  Track 1: video (vide) — 30 fragments
  Track 2: audio (soun) — 86 fragments
```

### Example 2: A subsequent segment

Handler types live in the `moov`, so a segment without one reports its tracks by
the IDs found in the fragment headers:

```
$ node tools/bjsn-stripper-cli.js --info test/test/assets/bjsn/media_11909.mp4
📊 Segment kind: subsequent (no ftyp/moov — init lives in the initial segment)
  Fragments: 116 moof / 116 mdat

📊 Tracks:
  Track 1: track1 (unknown (no moov in this segment)) — 30 fragments
  Track 2: track2 (unknown (no moov in this segment)) — 86 fragments
```

### Example 3: Stripping

```
$ node tools/bjsn-stripper-cli.js input.mp4 out
🔧 Processing MP4 file...
  ✅ BJSN box removed
  📊 Size reduction: 433 bytes
  📊 Found 2 tracks

✅ Created out_stripped.mp4 (76341 bytes)
```

## Technical Details

### Box Detection

The tool uses a simple MP4 box parser to:
1. Scan through the file looking for boxes
2. Read the 4-byte box size and 4-byte box type
3. Identify BJSN boxes by their type signature ('bjsn')
4. Extract or remove the box as needed

### Box Removal

When removing a box:
1. The tool creates a new buffer excluding the BJSN box
2. It copies the data before and after the box
3. The result is a valid MP4 file without the BJSN box

### Safety Features

- **Fallback on Error**: If any error occurs during processing, the tool returns the original data
- **Validation**: Basic validation is performed to ensure the file is still valid after stripping
- **Non-destructive**: The original file is never modified unless explicitly specified

## Integration with Shaka Player

**Note:** earlier revisions of this file described this tool as complementing a
`shaka.util.BjsnBoxStripper` class in the library. That class was part of the v1
attempt and **does not exist on this branch** — see
`docs/design/bjsn-integration-plan-v2.md` §5. There is currently no BJSN code
under `lib/` at all; Phase 2 introduces it. This CLI stands alone, and is useful
for:

- Preprocessing files before distribution
- Debugging and analysis of BJSN box content
- Batch processing of MP4 files
- Development and testing workflows

## Error Handling

The tool includes comprehensive error handling:

- **File not found**: Clear error message if input file doesn't exist
- **Parse errors**: Graceful handling of malformed MP4 files
- **JSON errors**: Proper error reporting for invalid BJSN JSON content
- **Write errors**: File system error handling for output operations

## Performance Considerations

- The tool loads the entire file into memory, so it's best suited for reasonably sized files
- For very large files, consider using the streaming version in the Shaka Player library
- The box parsing is optimized for speed with minimal memory allocations

## Segment kinds

Both BJSN segment kinds are accepted:

- an **initial** segment (`ftyp` + `moov` + `bjsn` + fragments) reports each
  track's handler, so tracks appear as `video`/`audio`;
- a **subsequent** segment (`styp` + `bjsn` + fragments, no `moov`) can be
  inspected and stripped too, but since the handler types live in the `moov`,
  its tracks are labelled `track1`, `track2`, … by the IDs found in the
  fragment headers.

`--split` needs the `moov` to build per-track init segments, so it only works on
an initial segment and fails with an explanatory message otherwise.

A file that is neither — no `ftyp`+`moov` and no `moof` — is rejected rather than
reported as a vacuous success.

## Limitations

- Only works with MP4 files
- Loads entire file into memory
- Basic MP4 box parsing (doesn't handle all edge cases)
- No support for fragmented MP4 files with multiple BJSN boxes
- `--split` requires an initial segment (see "Segment kinds" above)

## Contributing

This tool is part of the Shaka Player project. For bug reports and feature requests, please use the main Shaka Player issue tracker.

## License

This tool is licensed under the Apache License 2.0, same as the Shaka Player project.
