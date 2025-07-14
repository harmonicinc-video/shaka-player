/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.media.BjsnManifestParser');

goog.require('goog.asserts');
goog.require('shaka.log');
goog.require('shaka.net.NetworkingEngine');
goog.require('shaka.media.ManifestParser');
goog.require('shaka.media.PresentationTimeline');
goog.require('shaka.media.SegmentIndex');
goog.require('shaka.media.SegmentReference');
goog.require('shaka.util.BjsnParser');
goog.require('shaka.util.BjsnBoxStripper');
goog.require('shaka.util.BjsnCodecDetector');

goog.require('shaka.util.Error');
goog.require('shaka.util.ManifestParserUtils');
goog.require('shaka.util.MimeUtils');
goog.require('shaka.util.OperationManager');
goog.require('shaka.util.StringUtils');
goog.require('shaka.util.Timer');
goog.require('shaka.util.Mp4Parser');
goog.require('shaka.util.Mp4BoxParsers');

/**
 * @summary BJSN Manifest Parser with Real MP4 Timestamp Extraction
 * Implements Shaka Player manifest parser interface for BJSN-enabled streams
 * with accurate timestamp parsing from MP4 segments for proper timeline construction
 *
 * @implements {shaka.extern.ManifestParser}
 * @export
 */
shaka.media.BjsnManifestParser = class {
  /** Creates a new BJSN manifest parser. */
  constructor() {
    shaka.log.info('🔥 BJSN PARSER: Constructor called - BJSN parser with MP4 timestamp extraction');

    /** @private {?shaka.extern.ManifestConfiguration} */
    this.config_ = null;

    /** @private {?shaka.extern.ManifestParser.PlayerInterface} */
    this.playerInterface_ = null;

    /** @private {?Object} */
    this.currentBjsnData_ = null;

    /** @private {string} */
    this.manifestUri_ = '';

    /** @private {string} */
    this.baseUrl_ = '';

    /** @private {!shaka.util.OperationManager} */
    this.operationManager_ = new shaka.util.OperationManager();

    /** @private {?shaka.extern.Manifest} */
    this.manifest_ = null;

    /** @private {?shaka.media.PresentationTimeline} */
    this.presentationTimeline_ = null;

    /** @private {number} */
    this.defaultSegmentDuration_ = 2; // Default 2 second segments

    /** @private {?shaka.util.Timer} */
    this.updateTimer_ = null;

    /** @private {number} */
    this.updateIntervalSeconds_ = 2; // Fixed 2-second update interval

    /** @private {boolean} */
    this.isLive_ = false;

    /** @private {number} */
    this.lastKnownSequence_ = 0;

    /** @private {!Map<string, !shaka.media.SegmentIndex>} */
    this.segmentIndexes_ = new Map();

    /** @private {number} */
    this.maxSegmentsAhead_ = 10; // Keep max 10 segments ahead

    /** @private {?ArrayBuffer} */
    this.cachedInitialSegmentData_ = null;

    /** @private {?shaka.util.BjsnCodecDetector.CodecInfo} */
    this.detectedCodecs_ = null;

    /** @private {!Map<string, !shaka.util.BjsnCodecDetector.DetectionResult>} */
    this.codecCache_ = new Map();

    /** @private {?shaka.extern.ResponseFilter} */
    this.bjsnResponseFilter_ = null;

    // NEW: MP4 Timestamp Extraction Support
    /** @private {!Map<number, !shaka.media.BjsnManifestParser.SegmentTimingInfo>} */
    this.segmentTimingCache_ = new Map();

    /** @private {?number} */
    this.baseMediaTime_ = null; // First segment's actual timestamp

    /** @private {?number} */
    this.firstSequenceNumber_ = null; // First segment's sequence number

    /** @private {number} */
    this.timescale_ = 90000; // Default MP4 timescale

    /** @private {boolean} */
    this.useActualTimestamps_ = true; // Use real MP4 timestamps instead of artificial ones
  }

  /**
   * @override
   * @exportInterface
   */
  configure(config, isPreloadFn) {
    this.config_ = config;
  }

  /**
   * @override
   * @exportInterface
   */
  async start(uri, playerInterface) {
    goog.asserts.assert(this.config_, 'Must call configure() before start()!');
    this.manifestUri_ = uri;
    this.playerInterface_ = playerInterface;
    this.baseUrl_ = this.extractBaseUrl_(uri);

    shaka.log.info('🔥 BJSN PARSER: start() with MP4 timestamp extraction for URI:', uri);

    try {
      // Extract both BJSN metadata and MP4 timestamps from initial segment
      const {bjsnData, codecInfo, timingInfo} = await this.requestInitialSegmentWithTimingInfo_(uri);

      if (!bjsnData) {
        throw new shaka.util.Error(
            shaka.util.Error.Severity.CRITICAL,
            shaka.util.Error.Category.MANIFEST,
            shaka.util.Error.Code.UNABLE_TO_GUESS_MANIFEST_TYPE,
            uri);
      }

      this.currentBjsnData_ = bjsnData;
      this.detectedCodecs_ = codecInfo;
      this.isLive_ = bjsnData.type === 'dynamic';
      this.lastKnownSequence_ = bjsnData.seq_num;

      // Initialize timing information from first segment
      if (timingInfo) {
        this.baseMediaTime_ = timingInfo.startTime;
        this.firstSequenceNumber_ = bjsnData.seq_num;
        this.timescale_ = timingInfo.timescale || 90000;
        this.segmentTimingCache_.set(bjsnData.seq_num, timingInfo);
        
        shaka.log.info('🕐 BJSN TIMESTAMP: Initialized timing from first segment');
        shaka.log.info('  📍 Base media time:', this.baseMediaTime_);
        shaka.log.info('  🔢 First sequence:', this.firstSequenceNumber_);
        shaka.log.info('  ⏰ Timescale:', this.timescale_);
        shaka.log.info('  📊 Segment duration:', timingInfo.duration);
      }

      // Validate detected codecs
      if (!codecInfo.video && !codecInfo.audio) {
        shaka.log.warning('🔥 BJSN PARSER: No codecs detected, forcing fallback');
        codecInfo = shaka.util.BjsnCodecDetector.getFallbackCodecInfo_();
      }

      // Set up response filter for BJSN box stripping
      this.setupBjsnResponseFilter_();

      // Create the manifest with real MP4 timestamps
      this.manifest_ = this.createManifestFromBjsn_(bjsnData, codecInfo);

      // Start periodic updates for live content
      if (this.isLive_) {
        this.startPeriodicUpdates_();
      }

      shaka.log.info('✅ BJSN manifest created with MP4 timestamp extraction');
      shaka.log.info('  🎬 IsLive:', this.isLive_);
      shaka.log.info('  🎥 Codecs:', codecInfo);
      shaka.log.info('  ⏰ Using actual timestamps:', this.useActualTimestamps_);
      
      return this.manifest_;
    } catch (error) {
      if (error instanceof shaka.util.Error) {
        throw error;
      }

      throw new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.MANIFEST,
          shaka.util.Error.Code.DASH_INVALID_XML,
          uri, error.message);
    }
  }

  /**
   * @override
   * @exportInterface
   */
  stop() {
    this.stopPeriodicUpdates_();
    this.removeBjsnResponseFilter_();

    this.playerInterface_ = null;
    this.config_ = null;
    this.manifestUri_ = '';
    this.baseUrl_ = '';
    this.currentBjsnData_ = null;
    this.manifest_ = null;
    this.presentationTimeline_ = null;
    this.isLive_ = false;
    this.lastKnownSequence_ = 0;
    this.segmentIndexes_.clear();
    this.detectedCodecs_ = null;
    this.codecCache_.clear();
    this.segmentTimingCache_.clear();

    // Clear timestamp extraction state
    this.baseMediaTime_ = null;
    this.firstSequenceNumber_ = null;
    this.timescale_ = 90000;
    this.cachedInitialSegmentData_ = null;

    return this.operationManager_.destroy();
  }

  /**
   * @override
   * @exportInterface
   */
  update() {
    if (!this.isLive_) {
      return;
    }
    this.performUpdate_().catch((error) => {
      shaka.log.warning('BJSN manifest update failed:', error);
    });
  }

  /**
   * @override
   * @exportInterface
   */
  onExpirationUpdated(sessionId, expiration) {
    // No-op for BJSN streams
  }

  /**
   * @override
   * @exportInterface
   */
  onInitialVariantChosen(variant) {
    // No-op for Phase 1
  }

  /**
   * @override
   * @exportInterface
   */
  banLocation(uri) {
    // No-op for Phase 1
  }

  /**
   * @override
   * @exportInterface
   */
  setMediaElement(mediaElement) {
    // No-op for BJSN streams in Phase 1
  }

  /**
   * Request initial segment and extract both BJSN data and MP4 timing information
   * @param {string} uri - The URI of the initial segment
   * @return {!Promise<{bjsnData: ?Object, codecInfo: !shaka.util.BjsnCodecDetector.CodecInfo, timingInfo: ?shaka.media.BjsnManifestParser.SegmentTimingInfo}>} 
   * @private
   */
  async requestInitialSegmentWithTimingInfo_(uri) {
    const requestType = shaka.net.NetworkingEngine.RequestType.SEGMENT;
    const request = shaka.net.NetworkingEngine.makeRequest(
        [uri], this.config_.retryParameters);

    const operation = this.playerInterface_.networkingEngine.request(
        requestType, request);
    this.operationManager_.manage(operation);

    const response = await operation.promise;

    // Cache the initial segment data
    this.cachedInitialSegmentData_ = response.data;

    const originalSegmentData = new Uint8Array(response.data);
    
    // Extract BJSN metadata
    const bjsnData = shaka.util.BjsnParser.parseFromSegment(originalSegmentData);

    // Strip BJSN box for codec detection and MP4 parsing
    const strippedSegmentData = shaka.util.BjsnBoxStripper.stripBjsnBox(originalSegmentData);
    
    shaka.log.info('🔍 BJSN PARSER: Analyzing initial segment for codecs and timestamps');
    
    // Detect codecs from clean MP4 data
    const codecInfo = await shaka.util.BjsnCodecDetector.detectCodecsFromSegment(strippedSegmentData);

    // Extract MP4 timing information
    const timingInfo = await this.extractTimingFromSegment_(strippedSegmentData, bjsnData ? bjsnData.seq_num : 0);

    // Cache results
    const detectionResult = shaka.util.BjsnCodecDetector.createDetectionResult(uri, codecInfo);
    this.codecCache_.set(uri, detectionResult);

    return {bjsnData, codecInfo, timingInfo};
  }

  /**
   * Extract timing information from an MP4 segment
   * @param {!Uint8Array} segmentData - Stripped MP4 segment data
   * @param {number} sequenceNumber - Sequence number for this segment
   * @return {!Promise<?shaka.media.BjsnManifestParser.SegmentTimingInfo>}
   * @private
   */
  async extractTimingFromSegment_(segmentData, sequenceNumber) {
    try {
      shaka.log.info('🕐 BJSN TIMESTAMP: Extracting timing from segment', sequenceNumber);

      let startTime = null;
      let duration = null;
      let timescale = this.timescale_;

      // Check if this is an init segment (contains moov box)
      const isInitSegment = this.hasBox_(segmentData, 'moov');
      
      if (isInitSegment) {
        shaka.log.info('  📦 Processing INIT segment for timescale');
        timescale = this.extractTimescaleFromInit_(segmentData) || timescale;
        this.timescale_ = timescale;
        
        return {
          startTime: 0,
          duration: this.defaultSegmentDuration_,
          timescale: timescale,
          sequenceNumber: sequenceNumber,
          isInitSegment: true
        };
      }

      // For media segments, extract TFDT and TRUN information
      const parser = new shaka.util.Mp4Parser()
        .box('moof', shaka.util.Mp4Parser.children)
        .box('traf', shaka.util.Mp4Parser.children)
        .fullBox('tfdt', (box) => {
          if (box.version === 0 || box.version === 1) {
            const parsed = shaka.util.Mp4BoxParsers.parseTFDTInaccurate(
                box.reader, box.version);
            const baseMediaDecodeTime = parsed.baseMediaDecodeTime;
            startTime = baseMediaDecodeTime / timescale;
            
            shaka.log.info('  ⏰ TFDT baseMediaDecodeTime:', baseMediaDecodeTime);
            shaka.log.info('  🕐 Calculated startTime:', startTime, 'seconds');
          }
        })
        .fullBox('trun', (box) => {
          if (duration === null) {
            // Parse TRUN to get total segment duration
            const parsed = this.parseTRUN_(box.reader, box.version, box.flags);
            if (parsed && parsed.totalDuration > 0) {
              duration = parsed.totalDuration / timescale;
              shaka.log.info('  📏 TRUN total duration:', parsed.totalDuration);
              shaka.log.info('  🕐 Calculated duration:', duration, 'seconds');
            }
          }
        });

      parser.parse(segmentData);

      // Fallback duration calculation
      if (duration === null) {
        duration = this.defaultSegmentDuration_;
        shaka.log.info('  🔄 Using default duration:', duration, 'seconds');
      }

      if (startTime !== null) {
        const timingInfo = {
          startTime: startTime,
          duration: duration,
          timescale: timescale,
          sequenceNumber: sequenceNumber,
          isInitSegment: false
        };

        shaka.log.info('  ✅ Extracted timing info:', timingInfo);
        return timingInfo;
      } else {
        shaka.log.warning('  ⚠️ No TFDT found, cannot extract start time');
        return null;
      }

    } catch (error) {
      shaka.log.warning('🕐 BJSN TIMESTAMP: Failed to extract timing:', error);
      return null;
    }
  }

  /**
   * Extract timescale from MP4 init segment
   * @param {!Uint8Array} initData - MP4 init segment data
   * @return {?number} Timescale value or null if not found
   * @private
   */
  extractTimescaleFromInit_(initData) {
    let timescale = null;

    const parser = new shaka.util.Mp4Parser()
      .box('moov', shaka.util.Mp4Parser.children)
      .box('trak', shaka.util.Mp4Parser.children)
      .box('mdia', shaka.util.Mp4Parser.children)
      .fullBox('mdhd', (box) => {
        if (box.version === 0 || box.version === 1) {
          const parsed = shaka.util.Mp4BoxParsers.parseMDHD(box.reader, box.version);
          if (parsed && parsed.timescale) {
            timescale = parsed.timescale;
            shaka.log.info('  🎯 Found timescale in MDHD:', timescale);
          }
        }
      });

    try {
      parser.parse(initData);
    } catch (error) {
      shaka.log.warning('Failed to parse init segment for timescale:', error);
    }

    return timescale;
  }

  /**
   * Parse TRUN box to extract sample durations
   * @param {!shaka.util.DataViewReader} reader - Data reader
   * @param {number} version - Box version
   * @param {number} flags - Box flags
   * @return {?{sampleCount: number, totalDuration: number}}
   * @private
   */
  parseTRUN_(reader, version, flags) {
    try {
      const sampleCount = reader.readUint32();
      
      // Check flags to determine what fields are present
      const dataOffsetPresent = !!(flags & 0x000001);
      const firstSampleFlagsPresent = !!(flags & 0x000004);
      const sampleDurationPresent = !!(flags & 0x000100);
      const sampleSizePresent = !!(flags & 0x000200);
      const sampleFlagsPresent = !!(flags & 0x000400);
      const sampleCompositionTimePresent = !!(flags & 0x000800);

      // Skip data offset if present
      if (dataOffsetPresent) {
        reader.readUint32();
      }

      // Skip first sample flags if present
      if (firstSampleFlagsPresent) {
        reader.readUint32();
      }

      let totalDuration = 0;

      // Process each sample
      for (let i = 0; i < sampleCount; i++) {
        let sampleDuration = 0;
        
        if (sampleDurationPresent) {
          sampleDuration = reader.readUint32();
          totalDuration += sampleDuration;
        }
        
        if (sampleSizePresent) {
          reader.readUint32(); // Skip sample size
        }
        
        if (sampleFlagsPresent) {
          reader.readUint32(); // Skip sample flags
        }
        
        if (sampleCompositionTimePresent) {
          reader.readUint32(); // Skip composition time offset
        }
      }

      return {
        sampleCount: sampleCount,
        totalDuration: totalDuration
      };

    } catch (error) {
      shaka.log.warning('Failed to parse TRUN box:', error);
      return null;
    }
  }

  /**
   * Check if a box type exists in the segment
   * @param {!Uint8Array} segmentData - MP4 segment data
   * @param {string} boxType - Box type to search for
   * @return {boolean} True if box exists
   * @private
   */
  hasBox_(segmentData, boxType) {
    let hasBox = false;
    
    const parser = new shaka.util.Mp4Parser()
      .box(boxType, () => {
        hasBox = true;
      });
    
    try {
      parser.parse(segmentData, /* partialOkay= */ true, /* stopOnPartial= */ true);
    } catch (error) {
      // Ignore errors, just check for box presence
    }
    
    return hasBox;
  }

  /**
   * Create segment index with real MP4 timestamps
   * @param {!Object} bjsnData - BJSN metadata
   * @return {!shaka.media.SegmentIndex} Segment index with accurate timestamps
   * @private
   */
  createSegmentIndex_(bjsnData) {
    const references = [];
    const startSeqNum = bjsnData.seq_num;

    shaka.log.info('🕐 BJSN TIMING: Creating segment index with MP4 timestamps');
    shaka.log.info('  🔢 Starting sequence:', startSeqNum);
    shaka.log.info('  ⏰ Use actual timestamps:', this.useActualTimestamps_);

    if (this.isLive_) {
      // For live streams, only create the first segment with actual timestamp
      // Additional segments will be added dynamically as they become available
      const cachedTiming = this.segmentTimingCache_.get(startSeqNum);
      let startTime, endTime;

      if (cachedTiming && !cachedTiming.isInitSegment && this.useActualTimestamps_) {
        // Use the actual extracted timestamp from the first segment
        startTime = cachedTiming.startTime;
        endTime = startTime + cachedTiming.duration;
        shaka.log.info('  📍 Using real MP4 timestamp for first segment');
        shaka.log.info('  ⏰ Start time:', startTime, 'seconds');
        shaka.log.info('  📏 Duration:', cachedTiming.duration, 'seconds');
      } else {
        // Fallback for first segment if timing extraction failed
        startTime = this.baseMediaTime_ || 0;
        endTime = startTime + this.defaultSegmentDuration_;
        shaka.log.warning('  ⚠️ Using fallback timing for first segment');
      }

      const segmentUrl = this.generateSegmentUrl_(bjsnData.template_path, startSeqNum);
      const reference = new shaka.media.SegmentReference(
          startTime,
          endTime,
          () => [segmentUrl],
          0, null, null, 0, 0, Infinity);

      references.push(reference);

      shaka.log.info('  ✅ Created initial live segment:', {
        sequence: startSeqNum,
        startTime: startTime,
        endTime: endTime,
        duration: endTime - startTime,
        url: segmentUrl
      });
    } else {
      // For VOD content, create multiple segments with estimated timing
      const maxSegments = 8;
      for (let i = 0; i < maxSegments; i++) {
        const currentSeqNum = startSeqNum + i;
        let startTime, endTime;

        if (this.useActualTimestamps_ && this.baseMediaTime_ !== null) {
          // For VOD, use estimated timing based on first segment
          const estimatedDuration = this.defaultSegmentDuration_;
          startTime = this.baseMediaTime_ + (i * estimatedDuration);
          endTime = startTime + estimatedDuration;

          // Use cached timing info if available for more accuracy
          const cachedTiming = this.segmentTimingCache_.get(currentSeqNum);
          if (cachedTiming && !cachedTiming.isInitSegment) {
            startTime = cachedTiming.startTime;
            endTime = startTime + cachedTiming.duration;
          }
        } else {
          // Fallback to artificial sequential timestamps
          startTime = i * this.defaultSegmentDuration_;
          endTime = (i + 1) * this.defaultSegmentDuration_;
        }

        const segmentUrl = this.generateSegmentUrl_(bjsnData.template_path, currentSeqNum);
        const reference = new shaka.media.SegmentReference(
            startTime,
            endTime,
            () => [segmentUrl],
            0, null, null, 0, 0, Infinity);

        references.push(reference);
      }
      shaka.log.info('  ✅ Created', maxSegments, 'VOD segments');
    }

    shaka.log.info('✅ BJSN segment index created with', references.length, 'references');
    return new shaka.media.SegmentIndex(references);
  }

  /**
   * Start periodic updates for live content
   * @private
   */
  startPeriodicUpdates_() {
    if (this.updateTimer_) {
      return; // Already started
    }

    shaka.log.info('Starting BJSN periodic updates with',
        this.updateIntervalSeconds_, 'second interval');

    this.updateTimer_ = new shaka.util.Timer(() => {
      this.performUpdate_().catch((error) => {
        shaka.log.warning('BJSN periodic update failed:', error);
      });
    });

    this.updateTimer_.tickEvery(this.updateIntervalSeconds_);
  }

  /**
   * Stop periodic updates
   * @private
   */
  stopPeriodicUpdates_() {
    if (this.updateTimer_) {
      this.updateTimer_.stop();
      this.updateTimer_ = null;
      shaka.log.info('BJSN periodic updates stopped');
    }
  }

  /**
   * Perform a live manifest update with timestamp-aware segment discovery
   * @return {!Promise}
   * @private
   */
  async performUpdate_() {
    if (!this.isLive_ || !this.currentBjsnData_) {
      return;
    }

    try {
      // Check for new segments by probing the next expected sequence
      const nextSequence = this.lastKnownSequence_ + 1;
      const segmentUrl = this.generateSegmentUrl_(
          this.currentBjsnData_.template_path, nextSequence);

      // Check if the next segment is available
      const isAvailable = await this.checkSegmentAvailability_(segmentUrl);

      if (isAvailable) {
        // Fetch the new segment to get both BJSN data and timing info
        const {bjsnData, timingInfo} = await this.requestSegmentWithTiming_(segmentUrl);

        if (bjsnData && bjsnData.seq_num > this.lastKnownSequence_) {
          shaka.log.info('🕐 BJSN UPDATE: Found new segment sequence:', bjsnData.seq_num);

          // Cache the timing information
          if (timingInfo) {
            this.segmentTimingCache_.set(bjsnData.seq_num, timingInfo);
            const endTime = timingInfo.startTime + timingInfo.duration;
            shaka.log.info('  ⏰ Cached timing for sequence', bjsnData.seq_num, ':', 
                timingInfo.startTime, '-', endTime);
          }

          // Update our tracking
          this.lastKnownSequence_ = bjsnData.seq_num;
          this.currentBjsnData_ = bjsnData;

          // Add new segments to all streams with accurate timestamps
          this.updateSegmentIndexesWithTiming_(bjsnData, timingInfo);

          // Update presentation timeline for live edge
          this.updatePresentationTimeline_();

          // Notify player of manifest update
          if (this.playerInterface_ && this.playerInterface_.onManifestUpdated) {
            this.playerInterface_.onManifestUpdated();
          }
        }
      }
    } catch (error) {
      shaka.log.warning('BJSN update check failed:', error);
    }
  }

  /**
   * Request segment with both BJSN data and timing extraction
   * @param {string} segmentUrl
   * @return {!Promise<{bjsnData: ?Object, timingInfo: ?shaka.media.BjsnManifestParser.SegmentTimingInfo}>}
   * @private
   */
  async requestSegmentWithTiming_(segmentUrl) {
    try {
      const requestType = shaka.net.NetworkingEngine.RequestType.SEGMENT;
      const request = shaka.net.NetworkingEngine.makeRequest(
          [segmentUrl], this.config_.retryParameters);

      const operation = this.playerInterface_.networkingEngine.request(
          requestType, request);
      this.operationManager_.manage(operation);

      const response = await operation.promise;
      const originalSegmentData = new Uint8Array(response.data);
      
      // Extract BJSN data
      const bjsnData = shaka.util.BjsnParser.parseFromSegment(originalSegmentData);
      
      // Strip BJSN box and extract timing
      const strippedSegmentData = shaka.util.BjsnBoxStripper.stripBjsnBox(originalSegmentData);
      const timingInfo = await this.extractTimingFromSegment_(
          strippedSegmentData, bjsnData ? bjsnData.seq_num : 0);

      return {bjsnData, timingInfo};
    } catch (error) {
      shaka.log.warning('Failed to fetch segment with timing:', segmentUrl, error);
      return {bjsnData: null, timingInfo: null};
    }
  }

  /**
   * Update segment indexes with new segments using accurate timestamps
   * @param {!Object} bjsnData
   * @param {?shaka.media.BjsnManifestParser.SegmentTimingInfo} timingInfo
   * @private
   */
  updateSegmentIndexesWithTiming_(bjsnData, timingInfo) {
    if (!this.manifest_ || !this.manifest_.variants) {
      return;
    }

    const currentSequence = bjsnData.seq_num;

    // Calculate timing for the new segment
    let startTime, endTime;
    if (timingInfo && !timingInfo.isInitSegment) {
      startTime = timingInfo.startTime;
      endTime = startTime + timingInfo.duration;  // Use duration, not endTime property
      shaka.log.info('🕐 Using extracted timing for sequence', currentSequence);
      shaka.log.info('  ⏰ Start:', startTime, 'End:', endTime, 'Duration:', timingInfo.duration);
    } else {
      // Fallback to estimated timing (should rarely happen for live streams)
      const segmentIndex = currentSequence - (this.firstSequenceNumber_ || 0);
      startTime = (this.baseMediaTime_ || 0) + (segmentIndex * this.defaultSegmentDuration_);
      endTime = startTime + this.defaultSegmentDuration_;
      shaka.log.warning('🕐 Using fallback timing for sequence', currentSequence);
      shaka.log.warning('  ⏰ Start:', startTime, 'End:', endTime);
    }

    // Add new segments to each stream
    for (const variant of this.manifest_.variants) {
      if (variant.video) {
        this.addTimedSegmentToIndex_(variant.video, bjsnData, startTime, endTime);
      }
      if (variant.audio) {
        this.addTimedSegmentToIndex_(variant.audio, bjsnData, startTime, endTime);
      }
    }

    // Add to text streams if any
    if (this.manifest_.textStreams) {
      for (const textStream of this.manifest_.textStreams) {
        this.addTimedSegmentToIndex_(textStream, bjsnData, startTime, endTime);
      }
    }
  }

  /**
   * Add new segment with accurate timing to a stream's segment index
   * @param {!shaka.extern.Stream} stream
   * @param {!Object} bjsnData
   * @param {number} startTime - Actual start time in seconds
   * @param {number} endTime - Actual end time in seconds
   * @private
   */
  addTimedSegmentToIndex_(stream, bjsnData, startTime, endTime) {
    if (!stream.segmentIndex) {
      return;
    }

    const sequence = bjsnData.seq_num;
    const segmentUrl = this.generateSegmentUrl_(bjsnData.template_path, sequence);

    // Create segment reference with accurate timestamps
    const reference = new shaka.media.SegmentReference(
        startTime,
        endTime,
        () => [segmentUrl],
        0, null, null, 0, 0, Infinity);

    if (this.isLive_) {
      // For live streams, use mergeAndEvict to handle availability window
      const windowStart = this.presentationTimeline_ ?
          this.presentationTimeline_.getSegmentAvailabilityStart() : 0;
      stream.segmentIndex.mergeAndEvict([reference], windowStart);
    } else {
      // For VOD streams, use regular merge
      stream.segmentIndex.merge([reference]);
    }

    shaka.log.info('🕐 BJSN TIMING: Added timed segment to stream:', stream.type);
    shaka.log.info('  🔢 Sequence:', sequence);
    shaka.log.info('  ⏰ Timing:', startTime.toFixed(3), '-', endTime.toFixed(3));
    shaka.log.info('  📏 Duration:', (endTime - startTime).toFixed(3), 'seconds');
  }

  /**
   * Check if a segment is available
   * @param {string} segmentUrl
   * @return {!Promise<boolean>}
   * @private
   */
  async checkSegmentAvailability_(segmentUrl) {
    try {
      const requestType = shaka.net.NetworkingEngine.RequestType.SEGMENT;
      const request = shaka.net.NetworkingEngine.makeRequest(
          [segmentUrl], this.config_.retryParameters);

      // Use HEAD request to check availability without downloading
      request.method = 'HEAD';

      const operation = this.playerInterface_.networkingEngine.request(
          requestType, request);

      // Add short timeout for availability check
      const timeoutMs = 2000; // 2 second timeout
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timeout')), timeoutMs);
      });

      const response = await Promise.race([operation.promise, timeoutPromise]);
      return response.status >= 200 && response.status < 300;
    } catch (error) {
      // Segment not available yet
      return false;
    }
  }

  /**
   * Update presentation timeline for live edge with accurate timing
   * @private
   */
  updatePresentationTimeline_() {
    if (!this.presentationTimeline_ || !this.isLive_) {
      return;
    }

    // Calculate duration based on actual segment timing
    const cachedTimings = Array.from(this.segmentTimingCache_.values());
    const mediaTimings = cachedTimings.filter(t => !t.isInitSegment);

    if (mediaTimings.length > 0) {
      const sortedTimings = mediaTimings.sort((a, b) => a.startTime - b.startTime);
      const firstTiming = sortedTimings[0];
      const lastTiming = sortedTimings[sortedTimings.length - 1];
      
      const lastEndTime = lastTiming.startTime + lastTiming.duration;
      const actualDuration = lastEndTime - firstTiming.startTime + 
          (this.maxSegmentsAhead_ * this.defaultSegmentDuration_);
      
      this.presentationTimeline_.setDuration(actualDuration);

      // Set availability window duration for live streams
      const availabilityDuration = this.maxSegmentsAhead_ * this.defaultSegmentDuration_;
      this.presentationTimeline_.setSegmentAvailabilityDuration(availabilityDuration);

      shaka.log.v2('🕐 BJSN TIMELINE: Updated with actual timing');
      shaka.log.v2('  📏 Duration:', actualDuration);
      shaka.log.v2('  📊 Availability:', availabilityDuration);
    }
  }

  /**
   * Set up response filter to automatically strip BJSN boxes from segments
   * @private
   */
  setupBjsnResponseFilter_() {
    if (!this.playerInterface_ || !this.playerInterface_.networkingEngine) {
      return;
    }

    /** @type {!shaka.extern.ResponseFilter} */
    this.bjsnResponseFilter_ = (type, response, context) => {
      // Only process segment requests
      if (type !== shaka.net.NetworkingEngine.RequestType.SEGMENT) {
        return;
      }

      const originalData = new Uint8Array(response.data);
      
      // Check if this segment needs BJSN stripping
      if (shaka.util.BjsnBoxStripper.needsStripping(originalData)) {
        shaka.log.v2('🔧 BJSN RESPONSE FILTER: Stripping BJSN box from segment:', response.uri);
        
        // Strip the BJSN box
        const strippedData = shaka.util.BjsnBoxStripper.stripBjsnBox(originalData);
        response.data = strippedData.buffer;
        
        shaka.log.v2('🔧 BJSN RESPONSE FILTER: Segment processed successfully');
        shaka.log.v2('  📏 Original size:', originalData.length, 'bytes');
        shaka.log.v2('  📏 Stripped size:', strippedData.length, 'bytes');
      }
    };

    this.playerInterface_.networkingEngine.registerResponseFilter(this.bjsnResponseFilter_);
    shaka.log.info('🔧 BJSN PARSER: Response filter registered for automatic BJSN box stripping');
  }

  /**
   * Remove the BJSN response filter
   * @private
   */
  removeBjsnResponseFilter_() {
    if (this.playerInterface_ && 
        this.playerInterface_.networkingEngine && 
        this.bjsnResponseFilter_) {
      this.playerInterface_.networkingEngine.unregisterResponseFilter(this.bjsnResponseFilter_);
      this.bjsnResponseFilter_ = null;
      shaka.log.info('🔧 BJSN PARSER: Response filter unregistered');
    }
  }

  /**
   * Create Shaka manifest from BJSN data with dynamic codec detection
   * @param {!Object} bjsnData - BJSN metadata
   * @param {!shaka.util.BjsnCodecDetector.CodecInfo} codecInfo - Detected codec information  
   * @return {!shaka.extern.Manifest} Shaka manifest object
   * @private
   */
  createManifestFromBjsn_(bjsnData, codecInfo) {
    const isLive = bjsnData.type === 'dynamic';
    const presentationStartTime = isLive ? Date.now() / 1000 : null;

    // Create presentation timeline
    this.presentationTimeline_ = new shaka.media.PresentationTimeline(
        presentationStartTime,
        /* delay= */ 0,
        /* autoCorrectDrift= */ true);

    if (isLive) {
      this.presentationTimeline_.setStatic(false);
      // For live, set initial duration based on actual timing if available
      let initialDuration = this.maxSegmentsAhead_ * this.defaultSegmentDuration_;
      if (this.baseMediaTime_ !== null) {
        // Adjust for live streams that don't start at 0
        initialDuration = Math.max(initialDuration, this.baseMediaTime_ + initialDuration);
      }
      this.presentationTimeline_.setDuration(initialDuration);
    } else {
      this.presentationTimeline_.setStatic(true);
      // Set finite duration for VOD
      const totalSegments = 8; // Default for VOD
      const estimatedDuration = totalSegments * this.defaultSegmentDuration_;
      this.presentationTimeline_.setDuration(estimatedDuration);
    }

    // Create a single period for Phase 1 with detected codecs
    const period = this.createPeriodFromBjsn_(bjsnData, codecInfo);

    return {
      presentationTimeline: this.presentationTimeline_,
      variants: period.variants || [],
      textStreams: period.textStreams || [],
      imageStreams: period.imageStreams || [],
      offlineSessionIds: [],
      sequenceMode: false,
      ignoreManifestTimestampsInSegmentsMode: false,
      type: shaka.media.ManifestParser.BJSN || 'BJSN',
      serviceDescription: null,
      nextUrl: null,
      periodCount: 1,
      gapCount: 0,
      isLowLatency: false,
      startTime: null,
    };
  }

  /**
   * Create a period from BJSN data with dynamic codec detection
   * @param {!Object} bjsnData - BJSN metadata
   * @param {!shaka.util.BjsnCodecDetector.CodecInfo} codecInfo - Detected codec information
   * @return {!Object} Period data with streams
   * @private
   */
  createPeriodFromBjsn_(bjsnData, codecInfo) {
    // For Phase 1, use the first available gear only
    const firstGear = bjsnData.gear_list[0];
    const gearName = Object.keys(firstGear)[0];
    const gearData = firstGear[gearName];

    // Create streams for audio and video with detected codecs
    const streams = this.createStreamsFromGear_(gearName, gearData, bjsnData, codecInfo);

    // Create a single variant combining audio and video
    const variant = {
      id: 1,
      language: 'und',
      primary: true,
      audio: streams.audio,
      video: streams.video,
      bandwidth: gearData.realtime_bitrate || 0,
      allowedByApplication: true,
      allowedByKeySystem: true,
      decodingInfos: [],
      disabledUntilTime: 0,
    };

    return {
      variants: [variant],
      textStreams: streams.text ? [streams.text] : [],
      imageStreams: [],
    };
  }

  /**
   * Create streams from gear data with dynamic codec detection
   * @param {string} gearName - Name of the gear
   * @param {!Object} gearData - Gear metadata
   * @param {!Object} bjsnData - Complete BJSN data
   * @param {!shaka.util.BjsnCodecDetector.CodecInfo} codecInfo - Detected codec information
   * @return {!Object} Streams object containing audio/video/text streams
   * @private
   */
  createStreamsFromGear_(gearName, gearData, bjsnData, codecInfo) {
    const segmentIndex = this.createSegmentIndex_(bjsnData);
    
    shaka.log.info('🎬 BJSN PARSER: Creating streams with detected codecs');
    shaka.log.info('  🎥 Video codec:', codecInfo.video || 'none');
    shaka.log.info('  🎵 Audio codec:', codecInfo.audio || 'none');
    shaka.log.info('  🔀 Multiplexed:', codecInfo.isMultiplexed);
    shaka.log.info('  📄 MIME type:', codecInfo.mimeType);

    // Determine stream configuration based on detected codecs
    const hasVideo = !!codecInfo.video;
    const hasAudio = !!codecInfo.audio;
    const isMuxed = codecInfo.isMultiplexed;

    let videoStream = null;
    let audioStream = null;

    if (hasVideo) {
      // Create video stream with detected codec
      videoStream = {
        id: 1,
        originalId: gearName + '_video',
        groupId: null,
        createSegmentIndex: () => Promise.resolve(),
        closeSegmentIndex: () => {
          if (videoStream.segmentIndex) {
            videoStream.segmentIndex.release();
            videoStream.segmentIndex = null;
          }
        },
        segmentIndex: segmentIndex,
        mimeType: 'video/mp4',
        codecs: codecInfo.video,
        frameRate: 30,
        pixelAspectRatio: '1:1',
        bandwidth: gearData.realtime_bitrate || 0,
        width: 1920,
        height: 1080,
        kind: undefined,
        encrypted: !!gearData.drm,
        drmInfos: [],
        keyIds: new Set(),
        language: 'und',
        originalLanguage: null,
        label: null,
        type: shaka.util.ManifestParserUtils.ContentType.VIDEO,
        primary: true,
        trickModeVideo: null,
        dependencyStream: null,
        emsgSchemeIdUris: null,
        roles: [],
        forced: false,
        channelsCount: null,
        audioSamplingRate: null,
        spatialAudio: false,
        closedCaptions: new Map(),
        hdr: undefined,
        colorGamut: undefined,
        videoLayout: undefined,
        tilesLayout: undefined,
        accessibilityPurpose: undefined,
        external: false,
        fastSwitching: false,
        fullMimeTypes: new Set(),
        isAudioMuxedInVideo: isMuxed,
        baseOriginalId: null,
      };

      // Set full MIME types based on multiplexing
      if (isMuxed && hasAudio) {
        const muxedCodecs = codecInfo.video + ',' + codecInfo.audio;
        videoStream.codecs = muxedCodecs;
        videoStream.fullMimeTypes = new Set(['video/mp4; codecs="' + muxedCodecs + '"']);
      } else {
        videoStream.fullMimeTypes = new Set(['video/mp4; codecs="' + codecInfo.video + '"']);
      }
    }

    if (hasAudio && !isMuxed) {
      // Create separate audio stream for non-muxed content
      audioStream = {
        id: 2,
        originalId: gearName + '_audio',
        groupId: null,
        createSegmentIndex: () => Promise.resolve(),
        closeSegmentIndex: () => {
          if (audioStream.segmentIndex) {
            audioStream.segmentIndex.release();
            audioStream.segmentIndex = null;
          }
        },
        segmentIndex: segmentIndex,
        mimeType: 'audio/mp4',
        codecs: codecInfo.audio,
        frameRate: undefined,
        pixelAspectRatio: undefined,
        bandwidth: Math.floor((gearData.realtime_bitrate || 0) * 0.1),
        width: undefined,
        height: undefined,
        kind: undefined,
        encrypted: !!gearData.drm,
        drmInfos: [],
        keyIds: new Set(),
        language: 'und',
        originalLanguage: null,
        label: null,
        type: shaka.util.ManifestParserUtils.ContentType.AUDIO,
        primary: true,
        trickModeVideo: null,
        dependencyStream: null,
        emsgSchemeIdUris: null,
        roles: [],
        forced: false,
        channelsCount: 2,
        audioSamplingRate: 48000,
        spatialAudio: false,
        closedCaptions: new Map(),
        hdr: undefined,
        colorGamut: undefined,
        videoLayout: undefined,
        tilesLayout: undefined,
        accessibilityPurpose: undefined,
        external: false,
        fastSwitching: false,
        fullMimeTypes: new Set(['audio/mp4; codecs="' + codecInfo.audio + '"']),
        isAudioMuxedInVideo: false,
        baseOriginalId: null,
      };
    }

    return {
      video: videoStream,
      audio: audioStream,
      text: null, // No text streams in Phase 1
    };
  }

  /**
   * Generate segment URL using template_path and sequence number
   * @param {string} templatePath - Template path from BJSN data
   * @param {number} seqNum - Sequence number
   * @return {string} Complete segment URL
   * @private
   */
  generateSegmentUrl_(templatePath, seqNum) {
    const fileName = templatePath.replace(/\$\{num\}/g, seqNum.toString());
    return this.baseUrl_ + fileName;
  }

  /**
   * Extract base URL from the manifest URI
   * @param {string} uri - The manifest URI
   * @return {string} Base URL
   * @private
   */
  extractBaseUrl_(uri) {
    const lastSlashIndex = uri.lastIndexOf('/');
    if (lastSlashIndex === -1) {
      return '';
    }
    return uri.substring(0, lastSlashIndex + 1);
  }
};

/**
 * @typedef {{
 *   startTime: number,
 *   duration: number,
 *   timescale: number,
 *   sequenceNumber: number,
 *   isInitSegment: boolean,
 *   type: string,
 *   trackId: ?number,
 *   sampleCount: ?number,
 *   trackCount: ?number
 * }}
 *
 * @property {number} startTime
 *   Start time in seconds from MP4 TFDT
 * @property {number} duration
 *   Duration in seconds from MP4 TRUN or default
 * @property {number} timescale
 *   MP4 timescale used for calculations
 * @property {number} sequenceNumber
 *   Sequence number of this segment
 * @property {boolean} isInitSegment
 *   Whether this is an initialization segment
 * @property {string} type
 *   Type of timing info ('init', 'media', 'fallback')
 * @property {?number} trackId
 *   Track ID from TFHD (for media segments)
 * @property {?number} sampleCount
 *   Number of samples (for media segments)
 * @property {?number} trackCount
 *   Number of tracks (for init segments)
 * @exportDoc
 */
shaka.media.BjsnManifestParser.SegmentTimingInfo;

/**
 * @const {string}
 */
shaka.media.BjsnManifestParser.BJSN = 'BJSN';

// Add BJSN to ManifestParser constants if not already defined
if (!shaka.media.ManifestParser.BJSN) {
  shaka.media.ManifestParser.BJSN = 'BJSN';
}

/**
 * BJSN Parser Factory
 * @return {!shaka.media.BjsnManifestParser}
 */
shaka.media.BjsnManifestParser.factory = () => {
  shaka.log.info('🔥 BJSN PARSER FACTORY: Creating new BJSN parser instance with MP4 timestamp extraction');
  return new shaka.media.BjsnManifestParser();
};

// Register the BJSN manifest parser for video/mp4 MIME type
shaka.media.ManifestParser.registerParserByMime('video/mp4',
    shaka.media.BjsnManifestParser.factory);

// Also register for common MP4 MIME type variants
shaka.media.ManifestParser.registerParserByMime('video/mp4; codecs="avc1"',
    shaka.media.BjsnManifestParser.factory);
shaka.media.ManifestParser.registerParserByMime('video/mp4; codecs="hvc1"',
    shaka.media.BjsnManifestParser.factory);