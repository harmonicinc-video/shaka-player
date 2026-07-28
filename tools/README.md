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
time and continuing seamlessly across segment files, an initial segment carrying
`ftyp`+`moov`+`bjsn` and subsequent segments carrying neither `ftyp` nor `moov`.

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
- Subsequent segments contain a `bjsn` box. That is an **assumption** — only an
  initial segment has ever been captured.

---

# bjsn-stripper-cli.js

A command-line utility for removing BJSN (Bytedance JSON) boxes from MP4 files. This tool is designed to work with CMAF segments that contain BJSN boxes as described in TikTok's CMAF CDN distribution architecture.

## Overview

The BJSN Box Stripper CLI tool provides a standalone way to process MP4 files and remove BJSN boxes, which are custom metadata boxes used in TikTok's streaming architecture. The tool can also remove other box types like MOOV and FTYP boxes if needed.

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
# Show BJSN box information without stripping
node tools/bjsn-stripper-cli.js --info input.mp4

# Strip BJSN, MOOV, and FTYP boxes
node tools/bjsn-stripper-cli.js --all input.mp4 output.mp4

# Verbose output
node tools/bjsn-stripper-cli.js --verbose input.mp4 output.mp4
```

### Command Line Options

- `-h, --help`: Show help message
- `-i, --info`: Show BJSN box information without stripping
- `-a, --all`: Strip BJSN, MOOV, and FTYP boxes
- `-v, --verbose`: Enable verbose output

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

### Example 1: Basic Box Stripping

```bash
$ node tools/bjsn-stripper-cli.js sample.mp4 clean.mp4
🔧 BJSN STRIPPER: Starting to strip BJSN box
  📏 Input segment size: 1234567 bytes
  🔍 BJSN box found at offset: 123 size: 456
  ✅ BJSN box stripped successfully
  📏 Output segment size: 1234111 bytes
  📊 Size reduction: 456 bytes

✅ Success!
  📄 Output file: clean.mp4
  📏 Original size: 1234567 bytes
  📏 Stripped size: 1234111 bytes
  📊 Size reduction: 456 bytes
```

### Example 2: Inspecting BJSN Box Content

```bash
$ node tools/bjsn-stripper-cli.js --info sample.mp4
📁 Processing file: sample.mp4

📊 BJSN Box Information:
  Position: 123
  Size: 456 bytes
  Payload Size: 448 bytes
  JSON Data: {
    "type": "dynamic",
    "gear_num": 3,
    "seq_num": 10,
    "template_path": "123-media-first-${num}.mp4",
    "gear_list": [
      {
        "uhd5": {
          "realtime_bitrate": 1000000
        }
      }
    ]
  }
```

### Example 3: No BJSN Box Found

```bash
$ node tools/bjsn-stripper-cli.js regular.mp4 output.mp4
🔧 BJSN STRIPPER: Starting to strip BJSN box
  📏 Input segment size: 1234567 bytes
  ✅ No BJSN box found, returning original data

✅ Success!
  📄 Output file: output.mp4
  📏 Original size: 1234567 bytes
  📏 Stripped size: 1234567 bytes
  📊 Size reduction: 0 bytes
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

This CLI tool complements the existing `shaka.util.BjsnBoxStripper` class in the Shaka Player library. While the library version is optimized for browser environments and streaming use cases, this CLI version is designed for:

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
