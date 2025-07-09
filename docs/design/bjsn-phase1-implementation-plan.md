# Phase 1 Implementation Plan: BJSN Single Gear Support (Updated)

## Overview

This document provides a detailed implementation plan for Phase 1 of BJSN support in Shaka Player. The objective is to enable single-gear CMAF playback using BJSN metadata embedded in segments, with parser selection via configuration rather than automatic detection.

## Prerequisites and Environment Setup

### Repository Management
1. **Sync Local Repository**
   ```bash
   cd /Users/elvisfan/development/agentCode/shaka-player
   git fetch origin
   git pull origin main
   ```

2. **Create Feature Branch**
   ```bash
   git checkout -b feature/bjsn-phase1
   git push -u origin feature/bjsn-phase1
   ```

3. **Verify Build Environment**
   ```bash
   npm install
   npm run build
   npm test
   ```

## Technical Architecture Analysis

### Current Shaka Player Manifest Parser System

Before implementation, examine the existing architecture:

1. **Manifest Parser Interface** (`lib/media/manifest_parser.js`)
2. **MP4 Parsing Utilities** (`lib/util/mp4_parser.js`)
3. **Parser Registration System** (`lib/media/manifest_parser_factory.js`)
4. **Configuration System** (`lib/player.js` and configuration objects)

### Integration Strategy

**Reuse Existing Infrastructure**:
- Leverage `shaka.util.Mp4Parser` for MP4 box detection
- Follow existing manifest parser patterns for consistency
- Utilize `shaka.net.NetworkingEngine` for segment requests
- Use configuration-based parser selection for Phase 1 simplicity

## Implementation Components

### Component 1: BJSN Box Parser (`lib/util/bjsn_parser.js`)

**Purpose**: Parse BJSN boxes from MP4 data streams with robust error handling.

**Dependencies**: 
- `shaka.util.Mp4Parser` - Existing MP4 parsing infrastructure
- Standard JSON parsing with validation

**API Design**:
```javascript
/**
 * BJSN Box Parser Utility
 * Handles stream-based parsing of BJSN metadata from CMAF segments
 */
goog.provide('shaka.util.BjsnParser');

goog.require('shaka.util.Mp4Parser');
goog.require('shaka.log');

/**
 * @namespace shaka.util.BjsnParser
 */
shaka.util.BjsnParser = class {
  /**
   * Parse BJSN box from MP4 segment data
   * @param {!Uint8Array} data - MP4 segment data (partial or complete)
   * @return {?Object} Parsed BJSN metadata or null if insufficient data
   */
  static parseFromSegment(data) {}

  /**
   * Validate BJSN JSON schema
   * @param {!Object} bjsnData - Parsed JSON object
   * @return {boolean} Whether the schema is valid
   */
  static validateSchema(bjsnData) {}

  /**
   * Extract BJSN box raw data from MP4 structure
   * @param {!Uint8Array} mp4Data - MP4 data
   * @return {?Uint8Array} BJSN box payload or null if not found
   * @private
   */
  static extractBjsnBox_(mp4Data) {}
};
```

**Implementation Details**:
- Use `shaka.util.Mp4Parser` to scan for 'bjsn' box type
- Handle incomplete data gracefully (return null for partial boxes)
- Implement robust JSON parsing with try-catch error handling
- Validate required BJSN fields: `type`, `gear_num`, `seq_num`, `template_path`, `gear_list`

### Component 2: BJSN Manifest Parser (`lib/media/bjsn_manifest_parser.js`)

**Purpose**: Convert BJSN metadata into Shaka Player manifest structure.

**Dependencies**:
- `shaka.util.BjsnParser` - BJSN parsing utilities
- `shaka.media.PresentationTimeline` - Timeline management
- `shaka.media.SegmentIndex` - Segment indexing

**API Design**:
```javascript
/**
 * BJSN Manifest Parser
 * Implements Shaka Player manifest parser interface for BJSN-enabled streams
 */
goog.provide('shaka.media.BjsnManifestParser');

goog.require('shaka.util.BjsnParser');
goog.require('shaka.media.ManifestParser');
goog.require('shaka.media.PresentationTimeline');

/**
 * @implements {shaka.extern.ManifestParser}
 */
shaka.media.BjsnManifestParser = class {
  constructor() {
    /** @private {?shaka.extern.ManifestParser.PlayerInterface} */
    this.playerInterface_ = null;
    
    /** @private {?Object} */
    this.currentBjsnData_ = null;
    
    /** @private {string} */
    this.baseUrl_ = '';
    
    /** @private {!shaka.util.OperationManager} */
    this.operationManager_ = new shaka.util.OperationManager();
  }

  /**
   * @override
   */
  configure(config) {}

  /**
   * @override
   */
  async start(uri, playerInterface) {}

  /**
   * @override
   */
  stop() {}

  /**
   * @override
   */
  update() {}

  /**
   * @override
   */
  onExpirationUpdated(sessionId, expiration) {}

  /**
   * Generate next segment URL using template_path
   * @param {number} seqNum - Sequence number
   * @return {string} Next segment URL
   * @private
   */
  generateSegmentUrl_(seqNum) {}

  /**
   * Create Shaka manifest from BJSN data
   * @param {!Object} bjsnData - BJSN metadata
   * @return {!shaka.extern.Manifest} Shaka manifest object
   * @private
   */
  createManifestFromBjsn_(bjsnData) {}
};
```

**Implementation Strategy**:
- Follow existing manifest parser patterns in Shaka Player codebase
- Create single variant/stream for Phase 1 (single gear support)
- Generate segment references using `template_path` pattern
- Implement proper timeline management for live/VOD content

### Component 3: Configuration-Based Parser Selection (Updated Approach)

**File**: `lib/player.js` (Player configuration)

**Modification**: Add configuration option to explicitly select BJSN parser.

```javascript
// Add to player configuration schema
const bjsnConfig = {
  // Enable BJSN parsing mode
  enabled: false,
  
  // Configuration for BJSN-specific behavior
  options: {
    // Timeout for BJSN box parsing (ms)
    parseTimeout: 5000,
    
    // Enable debug logging for BJSN operations
    debugLogging: false
  }
};
```

**Configuration Usage**:
```javascript
// Application code to enable BJSN parser
player.configure({
  bjsn: {
    enabled: true,
    options: {
      debugLogging: true
    }
  }
});

// Load BJSN stream
await player.load(bjsnStreamUri);
```

**Implementation Strategy**:
- Add BJSN configuration section to player config schema
- Modify `player.load()` to check BJSN configuration before parser selection
- Use configuration flag to explicitly choose BJSN parser over automatic detection
- Provides clear control and avoids detection complexity in Phase 1

### Component 4: Player Integration

**File**: `lib/player.js`

**Modification**: Update load method to support BJSN parser selection.

```javascript
// In Player.load() method
if (this.config_.bjsn && this.config_.bjsn.enabled) {
  // Use BJSN parser explicitly
  const parser = new shaka.media.BjsnManifestParser();
  // Configure and start parser
} else {
  // Use existing parser selection logic
}
```

## Development Workflow

### Step 1: Repository Analysis (Day 1)
1. **Examine Current MP4 Parser**
   ```bash
   # Review existing MP4 parsing implementation
   find lib -name "*mp4*" -type f | head -10
   ```
2. **Study Manifest Parser Patterns**
   - Review `lib/media/dash_parser.js` for implementation patterns
   - Understand configuration system in `lib/player.js`
   - Analyze timeline and segment index creation

3. **Study Configuration System**
   - Examine existing configuration patterns
   - Understand player initialization flow
   - Review parser selection logic

### Step 2: BJSN Parser Implementation (Day 2-3)
1. **Create `lib/util/bjsn_parser.js`**
   - Implement MP4 box scanning using existing utilities
   - Add JSON parsing with validation
   - Handle streaming data scenarios

2. **Unit Test Development**
   ```bash
   # Create test file
   touch test/util/bjsn_parser_unit.js
   ```
   - Test with various MP4 data sizes
   - Validate schema checking
   - Error handling verification

### Step 3: Manifest Parser Implementation (Day 4-5)
1. **Create `lib/media/bjsn_manifest_parser.js`**
   - Implement manifest parser interface
   - Single gear manifest generation
   - Segment URL template processing

2. **Integration Testing**
   - Create mock BJSN segments for testing
   - Verify manifest structure compatibility
   - Test playback initialization

### Step 4: Configuration Integration (Day 6)
1. **Modify Player Configuration**
   - Add BJSN configuration schema
   - Update player load logic
   - Implement configuration validation

2. **End-to-End Testing**
   - Test with sample BJSN streams
   - Verify configuration-based selection
   - Validate segment loading

## Testing Strategy

### Unit Tests
**File**: `test/util/bjsn_parser_unit.js`
```javascript
describe('BjsnParser', () => {
  it('should parse valid BJSN box', () => {});
  it('should handle incomplete data gracefully', () => {});
  it('should validate required schema fields', () => {});
  it('should reject malformed JSON', () => {});
});
```

### Integration Tests
**File**: `test/media/bjsn_manifest_unit.js`
```javascript
describe('BjsnManifestParser', () => {
  it('should create valid manifest from BJSN', () => {});
  it('should generate correct segment URLs', () => {});
  it('should integrate with player configuration', () => {});
});
```

### Configuration Tests
**File**: `test/player_bjsn_unit.js`
```javascript
describe('Player BJSN Configuration', () => {
  it('should select BJSN parser when configured', () => {});
  it('should fallback to default parsers when disabled', () => {});
  it('should validate BJSN configuration options', () => {});
});
```

### Mock Data Creation
Create test fixtures with valid BJSN segments:
```javascript
// test/test_data/bjsn_segments.js
const mockBjsnData = {
  "type": "dynamic",
  "gear_num": 1,
  "seq_num": 10,
  "template_path": "media-${num}.mp4",
  "gear_list": [{
    "hd5": {
      "realtime_bitrate": 800000
    }
  }]
};
```

## Quality Assurance

### Code Review Checklist
- [ ] Follows existing Shaka Player coding standards
- [ ] Proper error handling and logging
- [ ] Comprehensive unit test coverage (>90%)
- [ ] Documentation comments for public APIs
- [ ] No memory leaks in parsing logic
- [ ] Configuration integration follows existing patterns

### Performance Validation
- [ ] BJSN parsing adds <10ms overhead per segment
- [ ] Memory usage remains stable during long playback
- [ ] No regression in existing DASH/HLS performance
- [ ] Configuration overhead is negligible

### Compatibility Testing
- [ ] No interference with existing functionality when BJSN disabled
- [ ] Graceful degradation when BJSN parsing fails
- [ ] Proper cleanup in error scenarios
- [ ] Configuration validation prevents invalid states

## Documentation Updates

### API Documentation
Update JSDoc comments for new public APIs in:
- `lib/util/bjsn_parser.js`
- `lib/media/bjsn_manifest_parser.js`
- Player configuration schema

### Developer Guide
Create section in existing documentation:
- BJSN format overview
- Configuration requirements
- Integration examples

### Configuration Reference
Update configuration documentation:
- BJSN configuration options
- Usage examples
- Migration guide

## Risk Mitigation

### Technical Risks
1. **MP4 Parsing Complexity**
   - **Mitigation**: Leverage existing `shaka.util.Mp4Parser` infrastructure
   - **Fallback**: Comprehensive error handling with graceful degradation

2. **Configuration Integration Issues**
   - **Mitigation**: Follow existing configuration patterns
   - **Fallback**: Conservative validation with clear error messages

3. **Performance Impact**
   - **Mitigation**: Benchmarking and optimization
   - **Fallback**: Configuration flag for enabling/disabling BJSN support

### Integration Risks
1. **Player State Management**
   - **Mitigation**: Careful integration with existing player lifecycle
   - **Fallback**: Isolated BJSN logic with minimal state changes

2. **Regression in Existing Functionality**
   - **Mitigation**: Comprehensive regression testing
   - **Fallback**: Feature isolation with configuration-based activation

## Success Criteria

### Functional Requirements
- [ ] Single-gear BJSN streams play successfully when configured
- [ ] BJSN metadata correctly extracted from segments
- [ ] Subsequent segment URLs generated using template_path
- [ ] No regression in existing DASH/HLS playback
- [ ] Configuration-based parser selection works reliably

### Technical Requirements
- [ ] Code coverage >90% for new components
- [ ] Performance overhead <10ms per segment
- [ ] Memory usage remains stable
- [ ] All existing tests continue to pass
- [ ] Configuration integration follows Shaka patterns

### Documentation Requirements
- [ ] API documentation complete
- [ ] Configuration guide updated
- [ ] Code comments comprehensive

## Timeline

| Day | Task | Deliverable |
|-----|------|-------------|
| 1 | Repository analysis and architecture study | Technical analysis document |
| 2-3 | BJSN parser implementation | `bjsn_parser.js` with unit tests |
| 4-5 | Manifest parser implementation | `bjsn_manifest_parser.js` with tests |
| 6 | Configuration integration | Working end-to-end implementation |
| 7 | Testing and documentation | Complete Phase 1 implementation |

## Next Steps

Upon completion of Phase 1:
1. **Code Review**: Comprehensive peer review before merge
2. **Performance Analysis**: Benchmark results vs baseline
3. **Documentation Review**: Ensure all documentation is current
4. **Merge Preparation**: Verify all tests pass and documentation complete

**Merge Criteria**: 
- All unit tests pass
- Integration tests validate functionality
- Code review approval
- Documentation complete
- No performance regression
- Configuration integration verified

This implementation plan provides a systematic, methodical approach to implementing BJSN Phase 1 support with configuration-based parser selection, maintaining professional software engineering standards and leveraging existing Shaka Player infrastructure.
