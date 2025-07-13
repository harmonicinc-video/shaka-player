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
goog.require('shaka.util.Error');
goog.require('shaka.util.ManifestParserUtils');
goog.require('shaka.util.MimeUtils');
goog.require('shaka.util.OperationManager');
goog.require('shaka.util.StringUtils');
goog.require('shaka.util.Timer');

/**
 * @summary BJSN Manifest Parser
 * Implements Shaka Player manifest parser interface for BJSN-enabled streams
 * with periodic update support for live content
 *
 * @implements {shaka.extern.ManifestParser}
 * @export
 */
shaka.media.BjsnManifestParser = class {
  /** Creates a new BJSN manifest parser. */
  constructor() {
    shaka.log.info('🔥 BJSN PARSER: Constructor called - BJSN parser instantiated');
    
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
    this.segmentDuration_ = 2; // Default 2 second segments per BJSN spec

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
    this.cachedInitialSegmentData_ = null; // Cache initial segment data for reuse
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

    shaka.log.info('🔥 BJSN PARSER: start() method called for URI:', uri);
    shaka.log.info('Starting BJSN manifest parser for:', uri);

    try {
      shaka.log.info('🔥 BJSN PARSER: Requesting initial segment for metadata extraction');
      // Request the initial segment to extract BJSN metadata
      const bjsnData = await this.requestInitialSegment_(uri);

      if (!bjsnData) {
        throw new shaka.util.Error(
            shaka.util.Error.Severity.CRITICAL,
            shaka.util.Error.Category.MANIFEST,
            shaka.util.Error.Code.UNABLE_TO_GUESS_MANIFEST_TYPE,
            uri);
      }

      this.currentBjsnData_ = bjsnData;
      this.isLive_ = bjsnData.type === 'dynamic';
      this.lastKnownSequence_ = bjsnData.seq_num;

      // Create the manifest from BJSN data
      this.manifest_ = this.createManifestFromBjsn_(bjsnData);

      // Start periodic updates for live content
      if (this.isLive_) {
        this.startPeriodicUpdates_();
      }

      shaka.log.info('Successfully created BJSN manifest, isLive:',
          this.isLive_);
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
    
    // Clear cached segment data
    this.cachedInitialSegmentData_ = null;

    return this.operationManager_.destroy();
  }

  /**
   * @override
   * @exportInterface
   */
  update() {
    if (!this.isLive_) {
      // No updates needed for VOD content
      return;
    }

    // Trigger immediate update for live content
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

    // Start the timer
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
   * Perform a live manifest update
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
        // Fetch the new segment to get updated BJSN data
        const newBjsnData = await this.requestSegmentBjsnData_(segmentUrl);

        if (newBjsnData && newBjsnData.seq_num > this.lastKnownSequence_) {
          shaka.log.info('BJSN: Found new segment sequence:',
              newBjsnData.seq_num);

          // Update our tracking
          this.lastKnownSequence_ = newBjsnData.seq_num;
          this.currentBjsnData_ = newBjsnData;

          // Add new segments to all streams
          this.updateSegmentIndexes_(newBjsnData);

          // Update presentation timeline for live edge
          this.updatePresentationTimeline_();

          // Notify player of manifest update
          if (this.playerInterface_ &&
              this.playerInterface_.onManifestUpdated) {
            this.playerInterface_.onManifestUpdated();
          }
        }
      }
    } catch (error) {
      shaka.log.warning('BJSN update check failed:', error);
    }
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
   * Request BJSN data from a specific segment
   * @param {string} segmentUrl
   * @return {!Promise<?Object>}
   * @private
   */
  async requestSegmentBjsnData_(segmentUrl) {
    try {
      const requestType = shaka.net.NetworkingEngine.RequestType.SEGMENT;
      const request = shaka.net.NetworkingEngine.makeRequest(
          [segmentUrl], this.config_.retryParameters);

      const operation = this.playerInterface_.networkingEngine.request(
          requestType, request);
      this.operationManager_.manage(operation);

      const response = await operation.promise;
      return shaka.util.BjsnParser.parseFromSegment(
          new Uint8Array(response.data));
    } catch (error) {
      shaka.log.warning('Failed to fetch BJSN data from segment:',
          segmentUrl, error);
      return null;
    }
  }

  /**
   * Update segment indexes with new segments
   * @param {!Object} bjsnData
   * @private
   */
  updateSegmentIndexes_(bjsnData) {
    if (!this.manifest_ || !this.manifest_.variants) {
      return;
    }

    // Calculate new segment timing
    const segmentDuration = this.segmentDuration_;
    const currentSequence = bjsnData.seq_num;

    // Add new segments to each stream
    for (const variant of this.manifest_.variants) {
      if (variant.video) {
        this.addNewSegmentToIndex_(variant.video, bjsnData, currentSequence);
      }
      if (variant.audio) {
        this.addNewSegmentToIndex_(variant.audio, bjsnData, currentSequence);
      }
    }

    // Add to text streams if any
    if (this.manifest_.textStreams) {
      for (const textStream of this.manifest_.textStreams) {
        this.addNewSegmentToIndex_(textStream, bjsnData, currentSequence);
      }
    }
  }

  /**
   * Add new segment to a specific stream's segment index
   * @param {!shaka.extern.Stream} stream
   * @param {!Object} bjsnData
   * @param {number} sequence
   * @private
   */
  addNewSegmentToIndex_(stream, bjsnData, sequence) {
    if (!stream.segmentIndex) {
      return;
    }

    // Calculate segment timing based on existing segment count
    // This ensures continuous timeline regardless of sequence numbers
    const segmentCount = stream.segmentIndex.getNumReferences();
    const startTime = segmentCount * this.segmentDuration_;
    const endTime = (segmentCount + 1) * this.segmentDuration_;

    // Generate segment URL for the new sequence
    const segmentUrl = this.generateSegmentUrl_(
        bjsnData.template_path, sequence);

    // Create new segment reference
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

    shaka.log.info('BJSN: Added new segment to stream:', stream.type,
        'sequence:', sequence, 'startTime:', startTime, 'isLive:',
        this.isLive_);
  }

  /**
   * Update presentation timeline for live edge
   * @private
   */
  updatePresentationTimeline_() {
    if (!this.presentationTimeline_ || !this.isLive_) {
      return;
    }

    // Calculate new duration based on latest segment
    const latestSequence = this.lastKnownSequence_;
    const baseSequence = this.currentBjsnData_.seq_num;
    const totalSegments = (latestSequence - baseSequence) +
        this.maxSegmentsAhead_;
    const newDuration = totalSegments * this.segmentDuration_;

    // Update timeline duration
    this.presentationTimeline_.setDuration(newDuration);

    // Set availability window duration for live streams
    // Following HLS/DASH pattern: maintain reasonable availability window
    const availabilityDuration = this.maxSegmentsAhead_ *
        this.segmentDuration_;
    this.presentationTimeline_.setSegmentAvailabilityDuration(
        availabilityDuration);

    shaka.log.v2('BJSN: Updated presentation timeline, duration:',
        newDuration, 'availability:', availabilityDuration);
  }

  /**
   * Request the initial segment and extract BJSN metadata
   * @param {string} uri - The URI of the initial segment
   * @return {!Promise<?Object>} Promise resolving to BJSN data or null
   * @private
   */
  async requestInitialSegment_(uri) {
    const requestType = shaka.net.NetworkingEngine.RequestType.SEGMENT;
    const request = shaka.net.NetworkingEngine.makeRequest(
        [uri], this.config_.retryParameters);

    const operation = this.playerInterface_.networkingEngine.request(
        requestType, request);
    this.operationManager_.manage(operation);

    const response = await operation.promise;

    // Cache the initial segment data for reuse during playback
    this.cachedInitialSegmentData_ = response.data;

    shaka.log.info('BJSN: Cached initial segment data for reuse, size:', 
        response.data.byteLength, 'bytes');

    // Parse BJSN data from the segment
    return shaka.util.BjsnParser.parseFromSegment(
        new Uint8Array(response.data));
  }

  /**
   * Create Shaka manifest from BJSN data
   * @param {!Object} bjsnData - BJSN metadata
   * @return {!shaka.extern.Manifest} Shaka manifest object
   * @private
   */
  createManifestFromBjsn_(bjsnData) {
    const isLive = bjsnData.type === 'dynamic';
    const presentationStartTime = isLive ? Date.now() / 1000 : null;

    // Create presentation timeline
    this.presentationTimeline_ = new shaka.media.PresentationTimeline(
        presentationStartTime,
        /* delay= */ 0,
        /* autoCorrectDrift= */ true);

    if (isLive) {
      this.presentationTimeline_.setStatic(false);
      // For live, set a reasonable initial duration
      const initialDuration = this.maxSegmentsAhead_ * this.segmentDuration_;
      this.presentationTimeline_.setDuration(initialDuration);
    } else {
      this.presentationTimeline_.setStatic(true);
      // Set finite duration for VOD
      const totalSegments = 8; // Default for VOD
      const estimatedDuration = totalSegments * this.segmentDuration_;
      this.presentationTimeline_.setDuration(estimatedDuration);
    }

    // Create a single period for Phase 1
    const period = this.createPeriodFromBjsn_(bjsnData);

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
   * Create a period from BJSN data
   * @param {!Object} bjsnData - BJSN metadata
   * @return {!Object} Period data with streams
   * @private
   */
  createPeriodFromBjsn_(bjsnData) {
    // For Phase 1, use the first available gear only
    const firstGear = bjsnData.gear_list[0];
    const gearName = Object.keys(firstGear)[0];
    const gearData = firstGear[gearName];

    // Create streams for audio and video
    const streams = this.createStreamsFromGear_(gearName, gearData, bjsnData);

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
   * Create streams from gear data
   * @param {string} gearName - Name of the gear
   * @param {!Object} gearData - Gear metadata
   * @param {!Object} bjsnData - Complete BJSN data
   * @return {!Object} Streams object containing audio/video/text streams
   * @private
   */
  createStreamsFromGear_(gearName, gearData, bjsnData) {
    const segmentIndex = this.createSegmentIndex_(bjsnData);
    const isMuxed = true;  // For Phase 1, assume muxed content

    // Create video stream
    const videoStream = {
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
      codecs: 'avc1.640028',
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
      fullMimeTypes: new Set(['video/mp4; codecs="avc1.640028"']),
      isAudioMuxedInVideo: isMuxed,
      baseOriginalId: null,
    };

    let audioStream = null;
    if (isMuxed) {
      videoStream.codecs += ', mp4a.40.2';
      videoStream.fullMimeTypes = new Set(
          ['video/mp4; codecs="' + videoStream.codecs + '"']);
    } else {
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
        codecs: 'mp4a.40.2',
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
        fullMimeTypes: new Set(['audio/mp4; codecs="mp4a.40.2"']),
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
   * Create segment index from BJSN data
   * @param {!Object} bjsnData - BJSN metadata
   * @return {!shaka.media.SegmentIndex} Segment index
   * @private
   */
  createSegmentIndex_(bjsnData) {
    const references = [];
    const startSeqNum = bjsnData.seq_num;

    // For live content, create initial segments + some ahead
    // For VOD content, create a reasonable number for testing
    const maxSegments = this.isLive_ ? this.maxSegmentsAhead_ : 8;

    shaka.log.info('Creating BJSN segment index with', maxSegments,
        'segments starting from seq', startSeqNum, 'isLive:', this.isLive_);

    for (let i = 0; i < maxSegments; i++) {
      const currentSeqNum = startSeqNum + i;
      const startTime = i * this.segmentDuration_;
      const endTime = (i + 1) * this.segmentDuration_;

      const segmentUrl = this.generateSegmentUrl_(bjsnData.template_path,
          currentSeqNum);

      const reference = new shaka.media.SegmentReference(
          startTime,
          endTime,
          () => [segmentUrl],
          0, null, null, 0, 0, Infinity);

      references.push(reference);
    }

    shaka.log.info('Created BJSN segment index with', references.length,
        'references');
    return new shaka.media.SegmentIndex(references);
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
  shaka.log.info('🔥 BJSN PARSER FACTORY: Creating new BJSN parser instance');
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
