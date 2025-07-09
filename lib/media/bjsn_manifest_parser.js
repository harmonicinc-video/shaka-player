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

/**
 * @summary BJSN Manifest Parser
 * Implements Shaka Player manifest parser interface for BJSN-enabled streams
 *
 * @implements {shaka.extern.ManifestParser}
 * @export
 */
shaka.media.BjsnManifestParser = class {
  /** Creates a new BJSN manifest parser. */
  constructor() {
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
    this.segmentDuration_ = 2; // Default 2 second segments
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

    shaka.log.info('Starting BJSN manifest parser for:', uri);

    try {
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

      // Create the manifest from BJSN data
      this.manifest_ = this.createManifestFromBjsn_(bjsnData);

      shaka.log.info('Successfully created BJSN manifest');
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
    this.playerInterface_ = null;
    this.config_ = null;
    this.manifestUri_ = '';
    this.baseUrl_ = '';
    this.currentBjsnData_ = null;
    this.manifest_ = null;
    this.presentationTimeline_ = null;

    return this.operationManager_.destroy();
  }

  /**
   * @override
   * @exportInterface
   */
  update() {
    // For Phase 1, we don't support live updates
    // This will be implemented in Phase 2/3
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
    // Create presentation timeline
    this.presentationTimeline_ = new shaka.media.PresentationTimeline(
        /* presentationStartTime= */ null,
        /* delay= */ 0,
        /* autoCorrectDrift= */ true);

    // For Phase 1, assume VOD content
    const isLive = bjsnData.type === 'dynamic';
    this.presentationTimeline_.setStatic(!isLive);

    if (!isLive) {
      // For VOD, set a default duration that can be updated later
      this.presentationTimeline_.setDuration(Infinity);
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
    // For Phase 1, we assume the stream contains both audio and video
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
      mimeType: 'video/mp4', // Default for CMAF
      codecs: 'avc1.640028', // Default H.264 high profile
      frameRate: 30,
      pixelAspectRatio: '1:1',
      bandwidth: gearData.realtime_bitrate || 0,
      width: 1920, // Default values - should be updated with actual data
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
      isAudioMuxedInVideo: true, // For Phase 1, assume muxed content
      baseOriginalId: null,
    };

    // Create audio stream
    const audioStream = {
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
      codecs: 'mp4a.40.2', // Default AAC-LC
      frameRate: undefined,
      pixelAspectRatio: undefined,
      bandwidth: Math.floor((gearData.realtime_bitrate || 0) * 0.1), // 10%
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
      channelsCount: 2, // Default stereo
      audioSamplingRate: 48000, // Default sampling rate
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
    const startTime = 0;
    let currentTime = startTime;

    // For Phase 1, create references for the current and next few segments
    // In a real implementation, this would be based on actual content duration
    const segmentCount = 10; // Create references for 10 segments initially

    for (let i = 0; i <= segmentCount; i++) {
      const segmentNumber = bjsnData.seq_num + i;
      let segmentUrl;

      if (i === 0) {
        // First segment uses the original URI
        segmentUrl = this.manifestUri_;
      } else {
        // Subsequent segments use template_path
        segmentUrl = this.generateSegmentUrl_(bjsnData.template_path,
            segmentNumber);
      }

      const startTimestamp = currentTime;
      const endTimestamp = currentTime + this.segmentDuration_;

      const reference = new shaka.media.SegmentReference(
          startTimestamp,
          endTimestamp,
          () => [segmentUrl],
          /* startByte= */ 0,
          /* endByte= */ null,
          /* initSegmentReference= */ null,
          /* timestampOffset= */ 0,
          /* appendWindowStart= */ 0,
          /* appendWindowEnd= */ Infinity);

      references.push(reference);
      currentTime += this.segmentDuration_;
    }

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
    const fileName = shaka.util.BjsnParser.generateNextSegmentUrl(
        templatePath, seqNum - 1); // seqNum is already incremented
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

// Register the BJSN manifest parser
// For now, we don't auto-register by MIME type since Phase 1 uses
// configuration-based selection
// This would be uncommented for automatic detection in future phases:
// shaka.media.ManifestParser.registerParserByMime('video/mp4',
//     () => new shaka.media.BjsnManifestParser());

/**
 * BJSN Parser Factory
 * @return {!shaka.media.BjsnManifestParser}
 */
shaka.media.BjsnManifestParser.factory = () => {
  return new shaka.media.BjsnManifestParser();
};
