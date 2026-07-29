# BJSN Support Implementation Specification

> ## ⚠️ v1-era document — read `bjsn-integration-plan-v2.md` first
>
> Still the best statement of **what we are trying to achieve** and of the
> multi-phase ABR ambition. It is **not** a valid implementation guide: it was
> written before any BJSN file had been measured, and before the v1 attempt
> failed. Where it disagrees with `bjsn-integration-plan-v2.md`, the plan wins.
>
> Specifically superseded:
>
> - **Box order** (§ "CMAF Segment Structure"): `bjsn` follows `moov`, it does
>   not precede it, and a `styp` box sits between `moov` and the first `moof`.
>   Corrected in place below.
> - **File structure** (§ "File Structure"): the `gear_manager.js`,
>   `bjsn_abr_manager.js` and `bjsn_networking_engine.js` layout belongs to the
>   ABR phases. The component set for the work actually in progress is plan §3.2,
>   which is much smaller — the Phase 1 spike removed the need for a transmuxer
>   plugin and for per-track init synthesis.
> - **Integration approach**: this document implies patching core pipeline
>   classes. v2's central invariant is **zero diff to `lib/`**, achieved through
>   `registerParserByMime`, `SegmentReference.setSegmentData` and (if ever needed)
>   `registerTransmuxer`. Plan §1 explains why v1 failed doing it the other way.
>
> The "Phase 1/2/3" numbering here (single gear → manual gear switching → ABR) is
> **not** the same as the plan's Phase 0–7 numbering. This document's Phase 1
> roughly corresponds to the plan's Phases 2–6; its Phases 2 and 3 are the plan's
> Phase 7.

## Project Overview

**Objective**: Integrate BJSN (Bytedance JSON) box parsing into Shaka Player to support TikTok's CMAF CDN distribution architecture without MPD dependency.

**Technical Context**: 
- BJSN boxes contain manifest metadata embedded in CMAF segments
- Segments contain interleaved video/audio fragments (moof+mdat pairs)
- Stream-based parsing required for low-latency playback
- URL generation based on template_path and gear switching

## Background

TikTok's CMAF CDN distribution architecture introduces BJSN boxes to embed manifest metadata directly into segments, eliminating MPD dependency. This approach:

1. **Reduces CDN Complexity**: CDNs no longer need to perform media-level parsing or custom file stitching
2. **Enables ABR Compatibility**: Supports adaptive bitrate streaming without traditional MPD files
3. **Optimizes Startup Performance**: Provides manifest data in the first segment download
4. **Supports Low-Latency Streaming**: Comparable QoS to HTTP-FLV protocols

### BJSN Box Structure

```
Box Structure:
├── size (4 bytes)
├── type: 'bjsn' (4 bytes)
└── JSON payload:
    ├── "type": "dynamic/static"
    ├── "gear_num": number of ABR variants
    ├── "seq_num": segment sequence number
    ├── "template_path": "URL template with ${num} placeholder"
    └── "gear_list": array of bitrate variants with metadata
```

### CMAF Segment Structure

Corrected against the real capture
(`test/test/assets/bjsn-initial-segment.mp4`). The original diagram placed the
BJSN box before `moov` and omitted `styp`.

```
Initial segment:
├── ftyp box (24 B)
├── moov box (1080 B — vide track 1 + soun track 2, both timescale 1000)
├── BJSN box (433 B at offset 1104 — AFTER moov)
├── styp box (24 B — must be preserved)
├── moof box (exactly one traf; track 1 = video)
├── mdat box (video fragment data)
├── moof box (exactly one traf; track 2 = audio)
├── mdat box (audio fragment data)
└── ... (116 pairs: 30 video, 86 audio, interleaved ~1:3)

Subsequent segments: styp (+ BJSN) + moof/mdat pairs. No ftyp or moov.
```

Media time does **not** start at zero: the capture's first `tfdt` is 2333176
(2333.176 s at timescale 1000). See plan §3.4 for why this matters.

## Phase 1: Single Gear Support

### 1.1 Core Requirements
- Parse BJSN boxes from CMAF segments using stream-based approach
- Extract basic playback metadata (seq_num, template_path)
- Generate subsequent segment URLs using template_path placeholder replacement
- Maintain existing Shaka Player playback functionality

### 1.2 Technical Components

#### 1.2.1 BJSN Box Parser
```javascript
// Target: lib/util/bjsn_parser.js
class BjsnParser {
  /**
   * Parse BJSN box from segment stream
   * @param {Uint8Array} segmentData - Partial or complete segment data
   * @returns {Object|null} Parsed BJSN metadata or null if incomplete
   */
  static parseFromStream(segmentData) {}
  
  /**
   * Validate BJSN JSON schema
   * @param {Object} bjsnData - Parsed JSON data
   * @returns {boolean} Validation result
   */
  static validateSchema(bjsnData) {}
  
  /**
   * Extract BJSN box from MP4 structure
   * @param {Uint8Array} data - MP4 data
   * @returns {Uint8Array|null} BJSN box data
   */
  static extractBjsnBox(data) {}
}
```

#### 1.2.2 BJSN-Enabled Manifest Parser
```javascript
// Target: lib/media/bjsn_manifest_parser.js
class BjsnManifestParser {
  /**
   * Initialize parser with single gear support
   * @param {Object} config - Parser configuration
   */
  constructor(config) {}
  
  /**
   * Parse initial segment and extract BJSN metadata
   * @param {string} uri - Initial segment URI
   * @param {Object} playerInterface - Shaka player interface
   * @returns {Promise<Object>} Manifest object
   */
  async start(uri, playerInterface) {}
  
  /**
   * Generate next segment URL using template_path
   * @param {number} seqNum - Sequence number
   * @returns {string} Next segment URL
   */
  generateSegmentUrl(seqNum) {}
  
  /**
   * Update manifest with new BJSN data from segment
   * @param {Object} bjsnData - New BJSN metadata
   * @returns {void}
   */
  updateFromBjsn(bjsnData) {}
  
  /**
   * Create Shaka manifest structure from BJSN data
   * @param {Object} bjsnData - BJSN metadata
   * @returns {Object} Shaka manifest object
   */
  createManifestFromBjsn(bjsnData) {}
}
```

### 1.3 Integration Points
- Register BJSN parser in `shaka.media.ManifestParser`
- Extend `shaka.util.Mp4Parser` for BJSN box detection
- Modify segment loading logic to handle BJSN metadata updates
- Update parser registration to handle BJSN-enabled streams

### 1.4 Testing Strategy
- Unit tests for BJSN box parsing with various data sizes
- Integration tests with mock CMAF segments
- Playback validation with single-gear streams
- Stream-based parsing tests with incomplete data

### 1.5 Success Criteria
- Single-gear BJSN streams play successfully
- BJSN metadata correctly extracted from segments
- Subsequent segment URLs generated properly
- No regression in existing playback functionality

## Phase 2: Multiple Gear with Manual Switching

### 2.1 Enhanced Requirements
- Parse complete gear_list from BJSN metadata
- Implement manual bitrate switching API
- Handle gear URL generation and fallback mechanisms
- Support Old-Gear-Path header for CDN fallback

### 2.2 Technical Components

#### 2.2.1 Enhanced BJSN Manifest Parser
```javascript
// Extension to Phase 1 parser
class BjsnManifestParser {
  /**
   * Extract available variants from gear_list
   * @param {Object} bjsnData - BJSN metadata
   * @returns {Array<Object>} Shaka variant objects
   */
  createVariantsFromGears(bjsnData) {}
  
  /**
   * Generate gear-specific segment URL
   * @param {string} gearName - Target gear identifier
   * @param {number} seqNum - Sequence number
   * @returns {string} Gear-specific segment URL
   */
  generateGearSegmentUrl(gearName, seqNum) {}
  
  /**
   * Handle manual bitrate switch request
   * @param {string} newGear - Target gear name
   * @returns {Promise<void>} Switch completion promise
   */
  async switchToGear(newGear) {}
  
  /**
   * Update base URL for gear switching
   * @param {string} baseUrl - Current base URL
   * @param {string} gearName - New gear name
   * @returns {string} Updated base URL
   */
  updateBaseUrlForGear(baseUrl, gearName) {}
}
```

#### 2.2.2 Gear Management System
```javascript
// Target: lib/media/gear_manager.js
class GearManager {
  /**
   * Track current and available gears
   * @param {Array<Object>} gearList - Available gears from BJSN
   */
  constructor(gearList) {}
  
  /**
   * Select optimal gear based on criteria
   * @param {Object} criteria - Selection criteria
   * @returns {Object} Selected gear object
   */
  selectGear(criteria) {}
  
  /**
   * Generate fallback headers for gear switching
   * @param {string} currentGear - Current gear name
   * @param {number} seqNum - Sequence number
   * @returns {Object} HTTP headers for fallback
   */
  generateFallbackHeaders(currentGear, seqNum) {}
  
  /**
   * Handle AbrDowngrade response from CDN
   * @param {Object} response - HTTP response
   * @returns {boolean} Whether downgrade occurred
   */
  handleAbrDowngrade(response) {}
  
  /**
   * Get available gear variants
   * @returns {Array<Object>} Available gear variants
   */
  getAvailableGears() {}
}
```

### 2.3 API Extensions
- Add manual bitrate switching methods to Player API
- Implement gear enumeration and selection interfaces
- Support for AbrDowngrade header handling
- Provide gear metadata access for applications

### 2.4 Network Integration
- Extend networking engine to handle gear-specific headers
- Implement CDN fallback mechanism
- Support for Last-Segment-Duration header processing

### 2.5 Testing Strategy
- Multi-gear parsing validation
- Manual switching API testing
- CDN fallback scenario simulation
- Network failure recovery testing
- Header processing validation

### 2.6 Success Criteria
- Multiple gears correctly parsed and exposed
- Manual gear switching works without playback interruption
- CDN fallback mechanism functions properly
- API provides clear gear selection interface

## Phase 3: Automatic Bitrate Switching

### 3.1 Advanced Requirements
- Integrate with Shaka's existing ABR algorithms
- Implement prefetch optimization (Range: bytes=0-0)
- Support real-time bitrate adaptation based on network conditions
- Handle Last-Segment-Duration header for duration correction

### 3.2 Technical Components

#### 3.2.1 BJSN-Aware ABR Manager
```javascript
// Target: lib/abr/bjsn_abr_manager.js
class BjsnAbrManager {
  /**
   * ABR manager with BJSN gear awareness
   * @param {Object} abrConfig - ABR configuration
   */
  constructor(abrConfig) {}
  
  /**
   * Evaluate network conditions and select optimal gear
   * @param {Object} networkMetrics - Current network metrics
   * @param {Array<Object>} availableGears - Available gears from BJSN
   * @returns {Object} Selected gear for next segment
   */
  selectOptimalGear(networkMetrics, availableGears) {}
  
  /**
   * Implement prefetch strategy for gear switching
   * @param {string} targetGear - Target gear for prefetch
   * @param {number} seqNum - Sequence number
   * @returns {Promise<void>} Prefetch completion
   */
  async prefetchGear(targetGear, seqNum) {}
  
  /**
   * Update ABR state with BJSN realtime_bitrate
   * @param {Object} gearData - Current gear metadata
   * @returns {void}
   */
  updateWithGearData(gearData) {}
}
```

#### 3.2.2 Enhanced Network Engine Integration
```javascript
// Extend existing networking engine
class BjsnNetworkingEngine {
  /**
   * Send prefetch hint for gear switching
   * @param {string} url - Target segment URL
   * @returns {Promise<void>} Prefetch request completion
   */
  async sendPrefetchHint(url) {}
  
  /**
   * Handle segment duration correction
   * @param {Object} response - HTTP response with duration header
   * @returns {void} Update internal duration tracking
   */
  handleDurationCorrection(response) {}
  
  /**
   * Process gear switching with fallback support
   * @param {string} targetUrl - Target gear URL
   * @param {Object} fallbackHeaders - Fallback headers
   * @returns {Promise<Object>} Response with gear metadata
   */
  async requestWithGearFallback(targetUrl, fallbackHeaders) {}
}
```

### 3.3 Performance Optimizations
- Implement intelligent prefetch timing
- Optimize BJSN parsing for streaming scenarios
- Cache gear metadata for rapid switching decisions
- Minimize network overhead during gear transitions

### 3.4 ABR Integration
- Extend existing ABR algorithms to work with BJSN gear data
- Implement gear-specific bandwidth estimation
- Support for real-time bitrate updates from BJSN
- Integrate with existing ABR configuration system

### 3.5 Testing Strategy
- Automated ABR decision validation
- Performance benchmarking for gear switching
- Network condition simulation testing
- End-to-end playback validation
- Prefetch mechanism testing

### 3.6 Success Criteria
- Automatic ABR provides optimal viewing experience
- Prefetch mechanism reduces switching latency
- Integration with existing ABR system is seamless
- Performance metrics meet or exceed traditional DASH

## Implementation Guidelines

### Development Workflow
1. **Repository Setup**: Create feature branch `feature/bjsn-support`
2. **Phase Implementation**: Complete each phase sequentially with full testing
3. **Code Review**: Peer review before phase completion
4. **Documentation**: Update technical documentation for each phase

### Technical Standards
- **Library Reuse**: Leverage existing Shaka utilities (`shaka.util.Mp4Parser`, `shaka.net.NetworkingEngine`)
- **Error Handling**: Implement robust error recovery and fallback mechanisms
- **Performance**: Optimize for low-latency streaming scenarios
- **Testing**: Maintain >90% code coverage for new components

### Dependencies
- **MP4 Parsing**: Extend `shaka.util.Mp4Parser` for BJSN box detection
- **Network Layer**: Integrate with `shaka.net.NetworkingEngine`
- **ABR System**: Enhance existing `shaka.abr.SimpleAbrManager`

### File Structure
```
lib/
├── util/
│   └── bjsn_parser.js          # BJSN box parsing utilities
├── media/
│   ├── bjsn_manifest_parser.js # BJSN manifest parser
│   └── gear_manager.js         # Gear management system
├── abr/
│   └── bjsn_abr_manager.js     # BJSN-aware ABR manager
└── net/
    └── bjsn_networking_engine.js # Network extensions
```

### Testing Structure
```
test/
├── util/
│   └── bjsn_parser_unit.js     # BJSN parser unit tests
├── media/
│   └── bjsn_manifest_unit.js   # Manifest parser tests
└── integration/
    └── bjsn_playback_test.js   # End-to-end tests
```

## Success Criteria

### Phase 1: Single Gear Support
- Single-gear BJSN streams play successfully
- BJSN metadata correctly extracted from segments
- Subsequent segment URLs generated properly
- No regression in existing playback functionality

### Phase 2: Multiple Gear with Manual Switching
- Multiple gears correctly parsed and exposed
- Manual gear switching works without playback interruption
- CDN fallback mechanism functions properly
- API provides clear gear selection interface

### Phase 3: Automatic Bitrate Switching
- Automatic ABR provides optimal viewing experience
- Prefetch mechanism reduces switching latency
- Integration with existing ABR system is seamless
- Performance metrics meet or exceed traditional DASH

## Risk Assessment

### Technical Risks
- **MP4 Parsing Complexity**: Stream-based parsing may introduce edge cases
- **Network Integration**: Gear switching may affect existing network logic
- **Performance Impact**: Additional parsing overhead during playback

### Mitigation Strategies
- Comprehensive unit testing for all parsing scenarios
- Gradual rollout with feature flags
- Performance monitoring and optimization
- Fallback to traditional DASH when BJSN parsing fails

This specification provides a systematic approach to implementing BJSN support while maintaining Shaka Player's architecture and performance standards.
