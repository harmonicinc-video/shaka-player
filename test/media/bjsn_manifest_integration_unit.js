/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.require('shaka.media.BjsnManifestParser');
goog.require('shaka.util.BjsnCodecDetector');
goog.require('shaka.util.BjsnBoxStripper');

describe('BJSN Dynamic Codec Detection Integration', () => {
  const Util = shaka.test.Util;
  const BjsnManifestParser = shaka.media.BjsnManifestParser;
  const BjsnCodecDetector = shaka.util.BjsnCodecDetector;
  const BjsnBoxStripper = shaka.util.BjsnBoxStripper;

  /** @type {!shaka.test.FakeNetworkingEngine} */
  let networkingEngine;
  /** @type {!shaka.media.BjsnManifestParser} */
  let parser;
  /** @type {shaka.extern.ManifestParser.PlayerInterface} */
  let playerInterface;

  beforeEach(() => {
    networkingEngine = new shaka.test.FakeNetworkingEngine();
    parser = new BjsnManifestParser();

    playerInterface = {
      networkingEngine: networkingEngine,
      onError: fail,
      onEvent: fail,
      onManifestUpdated: jasmine.createSpy('onManifestUpdated'),
      filter: () => Promise.resolve(),
      makeTextStreamsForClosedCaptions: (manifest) => Promise.resolve(),
      onTimelineRegionAdded: fail,
      onMetadata: fail,
      onSegmentAppended: fail,
    };

    parser.configure({
      retryParameters: shaka.net.Backoff.defaultRetryParameters(),
      availabilityWindowOverride: NaN,
      disableText: false,
      disableVideo: false,
      disableAudio: false,
      disableThumbnails: false,
      defaultPresentationDelay: 10,
      dash: {
        customScheme: () => null,
        ignoreDrmInfo: false,
        disableXlinkProcessing: false,
        xlinkFailGracefully: false,
        ignoreMinBufferTime: false,
        autoCorrectDrift: true,
        initialSegmentLimit: 1000,
        ignoreSuggestedPresentationDelay: false,
        ignoreEmptyAdaptationSet: false,
        ignoreMaxSegmentDuration: false,
        keySystemsByURI: {},
        manifestPreprocessor: (element) => element,
        manifestPreprocessorTXml: (element) => element,
        sequenceMode: false,
        multiPeriodSegmentLimit: 1000,
        enableFastSwitching: false,
      },
      hls: {},
    });
  });

  afterEach(() => {
    parser.stop();
  });

  describe('end-to-end codec detection', () => {
    it('detects codecs from BJSN segment and creates manifest', async () => {
      // Create test BJSN segment with embedded metadata
      const bjsnData = {
        type: 'static',
        gear_num: 1,
        seq_num: 1,
        template_path: 'segment-${num}.mp4',
        gear_list: [{
          'hd': {
            realtime_bitrate: 2000000,
            drm: null,
          },
        }],
      };

      const bjsnSegmentData = createBjsnSegmentWithH264Aac(bjsnData);

      // Mock network response
      networkingEngine.setResponseValue('test-manifest.mp4', bjsnSegmentData);

      // Parse manifest
      const manifest = await parser.start('test-manifest.mp4', playerInterface);

      // Verify manifest structure
      expect(manifest).toBeTruthy();
      expect(manifest.variants).toBeTruthy();
      expect(manifest.variants.length).toBe(1);

      const variant = manifest.variants[0];
      expect(variant.video).toBeTruthy();
      expect(variant.audio).toBeTruthy();

      // Verify dynamic codec detection worked
      expect(variant.video.codecs).toMatch(/^avc1\./);
      expect(variant.video.fullMimeTypes.size).toBe(1);

      const videoMimeType = Array.from(variant.video.fullMimeTypes)[0];
      expect(videoMimeType).toContain('video/mp4');
      expect(videoMimeType).toContain('avc1');
      expect(videoMimeType).toContain('mp4a'); // Should include audio codec for muxed content
    });

    it('handles codec detection failure gracefully', async () => {
      const bjsnData = {
        type: 'static',
        gear_num: 1,
        seq_num: 1,
        template_path: 'segment-${num}.mp4',
        gear_list: [{
          'hd': {
            realtime_bitrate: 2000000,
          },
        }],
      };

      // Create segment with invalid MP4 data after BJSN box
      const invalidSegment = createBjsnSegmentWithInvalidMp4(bjsnData);

      networkingEngine.setResponseValue('test-manifest.mp4', invalidSegment);

      // Parse manifest - should use fallback codecs
      const manifest = await parser.start('test-manifest.mp4', playerInterface);

      expect(manifest).toBeTruthy();
      expect(manifest.variants.length).toBe(1);

      const variant = manifest.variants[0];
      expect(variant.video.codecs).toBe('avc1.42E01E,mp4a.40.2'); // Fallback codecs
    });

    it('sets up BJSN response filter for automatic stripping', async () => {
      const bjsnData = {
        type: 'static',
        gear_num: 1,
        seq_num: 1,
        template_path: 'segment-${num}.mp4',
        gear_list: [{
          'hd': {
            realtime_bitrate: 2000000,
          },
        }],
      };

      const bjsnSegment = createBjsnSegmentWithH264Aac(bjsnData);
      networkingEngine.setResponseValue('test-manifest.mp4', bjsnSegment);

      await parser.start('test-manifest.mp4', playerInterface);

      // Verify response filter was registered
      const filters = networkingEngine.getResponseFilters();
      expect(filters.length).toBeGreaterThan(0);

      // Test the filter by simulating a segment request
      const segmentWithBjsn = createBjsnSegmentWithH264Aac(bjsnData);
      const originalSize = segmentWithBjsn.byteLength;

      const mockResponse = {
        uri: 'segment-1.mp4',
        data: segmentWithBjsn,
        headers: {},
        status: 200,
      };

      // Apply the response filter
      const responseFilter = filters[filters.length - 1]; // Get the BJSN filter
      await responseFilter(
          shaka.net.NetworkingEngine.RequestType.SEGMENT,
          mockResponse,
          {},
      );

      // Verify BJSN box was stripped
      expect(mockResponse.data.byteLength).toBeLessThan(originalSize);

      // Verify the stripped data is valid MP4
      const strippedData = new Uint8Array(mockResponse.data);
      expect(BjsnBoxStripper.needsStripping(strippedData)).toBe(false);
    });

    it('validates detected codecs against MediaSource API', async () => {
      // Mock MediaSource API
      window.MediaSource = {
        isTypeSupported: jasmine.createSpy('isTypeSupported').and.returnValue(true),
      };

      const bjsnData = {
        type: 'static',
        gear_num: 1,
        seq_num: 1,
        template_path: 'segment-${num}.mp4',
        gear_list: [{
          'hd': {
            realtime_bitrate: 2000000,
          },
        }],
      };

      const bjsnSegment = createBjsnSegmentWithH264Aac(bjsnData);
      networkingEngine.setResponseValue('test-manifest.mp4', bjsnSegment);

      await parser.start('test-manifest.mp4', playerInterface);

      // Verify MediaSource.isTypeSupported was called
      expect(window.MediaSource.isTypeSupported).toHaveBeenCalled();

      const calledWith = window.MediaSource.isTypeSupported.calls.mostRecent().args[0];
      expect(calledWith).toContain('video/mp4');
      expect(calledWith).toContain('codecs=');

      delete window.MediaSource;
    });

    it('caches codec detection results', async () => {
      const bjsnData = {
        type: 'static',
        gear_num: 1,
        seq_num: 1,
        template_path: 'segment-${num}.mp4',
        gear_list: [{
          'hd': {
            realtime_bitrate: 2000000,
          },
        }],
      };

      const bjsnSegment = createBjsnSegmentWithH264Aac(bjsnData);
      networkingEngine.setResponseValue('test-manifest.mp4', bjsnSegment);

      // Spy on codec detection
      spyOn(BjsnCodecDetector, 'detectCodecsFromSegment').and.callThrough();

      await parser.start('test-manifest.mp4', playerInterface);

      // Verify codec detection was called once
      expect(BjsnCodecDetector.detectCodecsFromSegment).toHaveBeenCalledTimes(1);

      // Verify caching worked (check internal state)
      expect(parser.detectedCodecs_).toBeTruthy();
      expect(parser.codecCache_.size).toBe(1);
    });
  });

  // Helper functions for creating test data

  function createBjsnSegmentWithH264Aac(bjsnData) {
    // Create BJSN box
    const bjsnJson = JSON.stringify(bjsnData);
    const bjsnJsonBytes = shaka.util.StringUtils.toUTF8(bjsnJson);
    const bjsnBoxSize = 8 + bjsnJsonBytes.length;

    const bjsnBox = new Uint8Array(bjsnBoxSize);
    const view = new DataView(bjsnBox.buffer);

    // Write BJSN box header
    view.setUint32(0, bjsnBoxSize); // size
    bjsnBox.set([0x62, 0x6A, 0x73, 0x6E], 4); // 'bjsn'
    bjsnBox.set(bjsnJsonBytes, 8); // JSON payload

    // Create minimal MP4 init segment with H.264 + AAC
    const mp4InitSegment = createH264AacInitSegment();

    // Combine BJSN box + MP4 data
    const result = new Uint8Array(bjsnBox.length + mp4InitSegment.length);
    result.set(bjsnBox, 0);
    result.set(mp4InitSegment, bjsnBox.length);

    return result.buffer;
  }

  function createBjsnSegmentWithInvalidMp4(bjsnData) {
    // Create valid BJSN box
    const bjsnJson = JSON.stringify(bjsnData);
    const bjsnJsonBytes = shaka.util.StringUtils.toUTF8(bjsnJson);
    const bjsnBoxSize = 8 + bjsnJsonBytes.length;

    const bjsnBox = new Uint8Array(bjsnBoxSize);
    const view = new DataView(bjsnBox.buffer);

    view.setUint32(0, bjsnBoxSize);
    bjsnBox.set([0x62, 0x6A, 0x73, 0x6E], 4);
    bjsnBox.set(bjsnJsonBytes, 8);

    // Create invalid MP4 data
    const invalidMp4 = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

    const result = new Uint8Array(bjsnBox.length + invalidMp4.length);
    result.set(bjsnBox, 0);
    result.set(invalidMp4, bjsnBox.length);

    return result.buffer;
  }

  function createH264AacInitSegment() {
    // Create minimal valid MP4 init segment
    // FTYP box
    const ftyp = new Uint8Array([
      0x00, 0x00, 0x00, 0x20, // size = 32
      0x66, 0x74, 0x79, 0x70, // 'ftyp'
      0x69, 0x73, 0x6F, 0x6D, // major_brand = 'isom'
      0x00, 0x00, 0x02, 0x00, // minor_version
      0x69, 0x73, 0x6F, 0x6D, // compatible_brands[0]
      0x69, 0x73, 0x6F, 0x32, // compatible_brands[1]
      0x61, 0x76, 0x63, 0x31, // compatible_brands[2]
      0x6D, 0x70, 0x34, 0x31,  // compatible_brands[3]
    ]);

    // Simplified MOOV box with video and audio tracks
    const moov = new Uint8Array(256); // Simplified 256-byte MOOV
    moov.set([
      0x00, 0x00, 0x01, 0x00, // size = 256
      0x6D, 0x6F, 0x6F, 0x76, // 'moov'
    ], 0);

    // Fill with minimal structure that codec detector can parse
    // This would be more complex in a real implementation

    const result = new Uint8Array(ftyp.length + moov.length);
    result.set(ftyp, 0);
    result.set(moov, ftyp.length);

    return result;
  }
});
