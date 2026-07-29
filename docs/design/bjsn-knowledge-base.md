# BJSN Implementation Knowledge Base

> ## ⚠️ v1-era document — read `bjsn-integration-plan-v2.md` first
>
> Written before any BJSN file had been measured. It captures useful intent, but
> several claims here are **wrong or unverified**. Where this document and
> `bjsn-integration-plan-v2.md` disagree, the plan wins — its facts come from
> measuring `test/test/assets/bjsn-initial-segment.mp4`.
>
> Known wrong:
>
> - **Box order.** This document says `bjsn` sits before `moov`, "early
>   positioning for efficient parsing". Measured reality is `ftyp` (24 B) →
>   `moov` (1080 B) → `bjsn` (433 B, offset 1104) → `styp` → fragments. There is
>   no early-`bjsn` optimisation to exploit; a parser must be order-agnostic and
>   simply wait until it holds both boxes. Corrected in place below.
> - **`styp` box** between `moov` and the first `moof` is missing from every
>   diagram here. It must be kept with the media, not filtered out.
> - **One `moof` per track.** Not stated here. Each `moof` holds exactly one
>   `traf`, and video/audio moofs interleave ~1:3 within a single file.
>
> **Since confirmed by the customer spec** (V2.0, 16 May — see plan §2b), so the
> items below are no longer guesses: `${num}` templating, `abr_pts` as a real
> client→CDN startup-latency parameter, gear switching as a path-suffix swap, and
> that **every** segment carries a `bjsn` box.
>
> Still unverified against real bytes, because only ONE real initial segment has
> ever been captured and we have no URL provenance for it:
>
> - the precise `abr_pts` "initial request only" rule (the spec describes the
>   mechanism, not the client's exact request pattern)
> - the exact base-URL rewrite for a gear switch
> - **whether subsequent segments also carry `ftyp` + `moov`.** The spec implies
>   they do; our fixtures assume they do not. Plan §2b explains why this is the
>   single most consequential open question, and how to settle it cheaply.
>
> The spec also adds requirements absent from this document entirely: per-gear
> `drm` in `gear_list`, the `Last-Segment-Duration` response header, `Range:
> bytes=0-0` prefetch pre-warm, and the `Old-Gear-Path` / `Abr-Downgrade` fallback
> handshake. See plan §2b — it is the current summary, not this file.
>
> Treat every "Gear Management" and ABR section below as design intent for a later
> phase, not as settled fact.

## Overview

This document captures additional technical insights, clarifications, and implementation details discovered during the BJSN specification development process. It serves as a companion to the main specification document.

## Key Technical Insights

### URL Generation Pattern

**Initial Understanding vs. Reality**
- **Initial Assumption**: Simple suffix replacement pattern
- **Actual Pattern**: Gear names replace the segment after the last dash in URLs

```javascript
// Incorrect approach (initial understanding)
newBaseUrl = baseUrl.replace(/suffix_\d+/, newGearName)

// Correct approach (clarified)
newBaseUrl = baseUrl.replace(/-[^-]*\/$/, "-" + newGearName + "/")
```

**Real-world URL Structure**:
- Base URL: `/stream-A-hd5/`
- Gear switch: `/stream-A-hd5/` → `/stream-A-uhd5/`
- Final segment URL: `{baseUrl}{templatePath.replace("${num}", nextSeqNum)}`

### Template Path Resolution

**Key Clarification**: The `${num}` placeholder in `template_path` is replaced with `current_seq_num + 1` to retrieve the next segment.

```javascript
// Template path example: "123-media-first-${num}.mp4"
// For seq_num = 10, next segment becomes: "123-media-first-11.mp4"
nextSegmentUrl = templatePath.replace("${num}", currentSeqNum + 1)
```

### ABR Parameter Usage

**Critical Implementation Detail**: The `abr_pts` parameter is only required for the initial `media_first.mp4` request. Subsequent segment requests do not include this parameter.

```javascript
// Initial request (with abr_pts)
GET /stream-A-hd5/media_first.mp4?abr_pts=1800

// Subsequent requests (no abr_pts)
GET /stream-A-hd5/media_seg_11.mp4
GET /stream-A-hd5/media_seg_12.mp4
```

### CMAF Segment Structure

**Enhanced Understanding**: Segments contain interleaved video/audio fragments to minimize startup latency.

Corrected against `test/test/assets/bjsn-initial-segment.mp4`. The original
diagram here placed `bjsn` before `moov` and omitted `styp`; both were wrong.

```
Initial segment (the URL the user loads):
├── ftyp  (24 B)
├── moov  (1080 B — two trak: vide id=1, soun id=2, both timescale 1000)
├── bjsn  (433 B at offset 1104 — AFTER moov, not before)
├── styp  (24 B — keep this; do not filter it out)
├── moof  (one traf only, track 1, tfdt 2333176)
├── mdat  (video data)
├── moof  (one traf only, track 2, tfdt 2333186)
├── mdat  (audio data)
└── ... 116 moof/mdat pairs total: 30 video, 86 audio, interleaved ~1 video : 3 audio

Subsequent segments: styp (+ bjsn?) + fragments. No ftyp, no moov.
```

Each `moof` carries **exactly one** `traf`, so a fragment belongs to a single
track and is routed by its `tfhd.track_ID`.

**Implementation Impact**: Stream-based parsing required to handle progressive fragment loading without waiting for complete segment download. Because `bjsn` follows `moov`, a progressive parser gains no benefit from expecting `bjsn` early — it must be box-type driven and wait until it holds both.

## Stream-Based Parsing Requirements

### Progressive Data Processing

**Key Requirement**: BJSN parsing must handle streaming data scenarios where segments are processed incrementally.

```javascript
// Handle partial segment data
function parseFromStream(segmentData) {
    // Must handle incomplete MP4 boxes
    // Return null if insufficient data
    // Support incremental parsing as more data arrives
}
```

### Early Metadata Extraction

**Performance Optimization**: BJSN box positioning enables manifest metadata extraction from initial segment bytes without full download.

## Gear Management System

### Gear Naming Convention

**Clarification**: Gear names (uhd5, hd5, ld5) are dynamic identifiers that directly replace URL path segments.

```javascript
// Gear list structure
"gear_list": [
    {
        "uhd5": {
            "realtime_bitrate": 1000000,
            "drm": { "key": "value" }
        }
    },
    {
        "hd5": {
            "realtime_bitrate": 800000,
            "drm": { "key": "value" }
        }
    }
]
```

### CDN Fallback Mechanism

**Critical Feature**: `Old-Gear-Path` header provides CDN fallback during gear switching failures.

```javascript
// Request headers for gear switching
headers["Old-Gear-Path"] = constructUrlForGear(currentGear, nextSeqNum)

// CDN response indicates fallback used
if (response.headers["AbrDowngrade"] === "1") {
    // Handle downgrade scenario
}
```

## Network Integration Considerations

### Prefetch Strategy

**Implementation Note**: Range requests for prefetch optimization should be deferred to Phase 3 to maintain implementation focus.

```javascript
// Prefetch hint (Phase 3 implementation)
fetch(targetUrl, {
    headers: { "Range": "bytes=0-0" }
})
// Should trigger CDN prefetch without returning media data
```

### Duration Correction

**Metadata Update**: `Last-Segment-Duration` header provides actual duration feedback for previous segments.

```javascript
// Response header processing
if (response.headers["Last-Segment-Duration"]) {
    const durationMs = parseInt(response.headers["Last-Segment-Duration"])
    updatePreviousSegmentDuration(durationMs)
}
```

## Implementation Architecture Decisions

### Library Reuse Strategy

**Principle**: Leverage existing Shaka Player utilities to minimize reinvention.

**Key Libraries**:
- `shaka.util.Mp4Parser` - Extend for BJSN box detection
- `shaka.net.NetworkingEngine` - Integrate gear switching logic
- `shaka.abr.SimpleAbrManager` - Enhance for BJSN-aware ABR

### Error Handling Philosophy

**Approach**: Implement robust fallback mechanisms without breaking existing functionality.

```javascript
// Fallback strategy
try {
    bjsnData = parseBjsnFromSegment(segmentData)
} catch (error) {
    // Log error but continue with previous metadata
    console.warn('BJSN parsing failed, using previous metadata')
    bjsnData = previousBjsnData
}
```

## Testing Strategy Insights

### Stream-Based Testing Requirements

**Challenge**: Testing incremental parsing with partial data scenarios.

**Solution**:
```javascript
// Test with various data chunk sizes
testBjsnParsing([
    new Uint8Array(100),  // Partial header
    new Uint8Array(500),  // Incomplete box
    new Uint8Array(1000)  // Complete BJSN data
])
```

### Multi-Gear Validation

**Requirement**: Validate gear switching without playback interruption.

**Approach**:
- Mock CDN responses for different gears
- Test fallback mechanism with simulated failures
- Validate URL generation across gear transitions

## Performance Considerations

### Parsing Optimization

**Constraint**: BJSN parsing must not introduce significant latency during segment processing.

**Strategy**:
- Cache parsed BJSN data to avoid redundant processing
- Implement efficient MP4 box scanning
- Use streaming JSON parsing for large BJSN payloads

### Memory Management

**Consideration**: Gear metadata caching should not cause memory leaks during long playback sessions.

## Development Workflow Clarifications

### Phase-Based Implementation

**Approach**: Sequential phase completion with full testing before progression.

**Branch Strategy**:
```bash
# Feature branch for entire implementation
git checkout -b feature/bjsn-support

# Phase-specific sub-branches if needed
git checkout -b feature/bjsn-support-phase1
```

### Integration Points

**Key Files to Modify**:
- `lib/media/manifest_parser.js` - Register BJSN parser
- `lib/util/mp4_parser.js` - Extend box detection
- `lib/net/networking_engine.js` - Add gear switching support

## Common Pitfalls and Solutions

### URL Construction Errors

**Pitfall**: Incorrect gear name substitution in URLs.

**Solution**: Use precise regex patterns for URL manipulation.

```javascript
// Correct approach
baseUrl.replace(/-[^-]*\/$/, "-" + gearName + "/")

// Avoid generic replacements that might match unintended substrings
```

### Metadata Synchronization

**Pitfall**: Stale BJSN metadata during rapid gear switching.

**Solution**: Always update metadata from the most recent segment's BJSN data.

### Stream State Management

**Pitfall**: Lost sequence tracking during error recovery.

**Solution**: Maintain robust sequence number validation and recovery mechanisms.

## Future Considerations

### Scalability

**Consideration**: Architecture should support additional TikTok-specific features without major refactoring.

**Approach**: Modular design with clear separation of concerns.

### Compatibility

**Requirement**: Maintain backwards compatibility with existing DASH/HLS streams.

**Strategy**: BJSN support as additive feature, not replacement.

## Documentation Requirements

### API Documentation

**Requirement**: Clear documentation for manual gear switching APIs introduced in Phase 2.

### Integration Guide

**Requirement**: Developer guide for applications wanting to use BJSN features.

### Performance Metrics

**Requirement**: Benchmarking documentation comparing BJSN vs traditional DASH performance.

## Validation Criteria

### Phase 1 Success Metrics
- BJSN parsing accuracy: 100% for well-formed segments
- Startup latency: No regression vs traditional DASH
- Memory usage: Minimal overhead for metadata caching

### Phase 2 Success Metrics
- Gear switching latency: <200ms for manual switches
- CDN fallback rate: <1% under normal conditions
- API usability: Clear and intuitive for application developers

### Phase 3 Success Metrics
- ABR efficiency: Comparable to existing algorithms
- Prefetch effectiveness: >80% cache hit rate for predicted switches
- User experience: Smooth playback during automatic switching

This knowledge base provides the detailed technical context necessary for successful BJSN implementation while maintaining professional software engineering standards.
