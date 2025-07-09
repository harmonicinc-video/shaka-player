/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

describe('BjsnManifestParser', () => {
  const Util = shaka.test.Util;

  let parser;
  let playerInterface;
  let config;
  let networkingEngine;
  let validBjsnSegment;
  let validBjsnData;

  beforeEach(() => {
    networkingEngine = new shaka.test.FakeNetworkingEngine();

    playerInterface = {
      networkingEngine: networkingEngine,
      filter: () => Promise.resolve(),
      makeTextStreamsForClosedCaptions: () => {},
      onTimelineRegionAdded: () => {},
      onEvent: () => {},
      onError: () => {},
      isLowLatencyMode: () => false,
      updateDuration: () => {},
      newDrmInfo: () => {},
      onManifestUpdated: () => {},
      getBandwidthEstimate: () => 1000000,
      onMetadata: () => {},
      disableStream: () => {},
      addFont: () => {},
    };

    config = shaka.util.PlayerConfiguration.createDefault().manifest;

    parser = new shaka.media.BjsnManifestParser();

    // Create valid BJSN data for testing
    validBjsnData = {
      'type': 'static',
      'gear_num': 1,
      'seq_num': 10,
      'template_path': 'media-$' + '{num}.mp4',
      'gear_list': [
        {
          'hd5': {
            'realtime_bitrate': 800000,
          },
        },
      ],
    };

    // Create valid BJSN segment data
    const jsonString = JSON.stringify(validBjsnData);
    const jsonData = shaka.util.StringUtils.toUTF8(jsonString);

    // Create MP4 segment with BJSN box
    validBjsnSegment = new Uint8Array(24 + 8 + jsonData.length);
    validBjsnSegment.set([
      // ftyp box
      0x00, 0x00, 0x00, 0x18, // size
      0x66, 0x74, 0x79, 0x70, // 'ftyp'
      0x69, 0x73, 0x6F, 0x6D, // major brand 'isom'
      0x00, 0x00, 0x00, 0x00, // minor version
      0x69, 0x73, 0x6F, 0x6D, // compatible brand 'isom'
      0x6D, 0x70, 0x34, 0x31, // compatible brand 'mp41'
      // BJSN box header
      0x00, 0x00, 0x00, 0x08 + jsonData.length, // size
      0x62, 0x6A, 0x73, 0x6E, // 'bjsn' type
    ], 0);

    // Add the JSON data to the segment
    validBjsnSegment.set(jsonData, 32);
  });

  afterEach(() => {
    if (parser) {
      parser.stop();
    }
  });

  describe('configuration', () => {
    it('should configure successfully', () => {
      parser.configure(config);
      expect(parser.config_).toBe(config);
    });

    it('should handle configuration before start', () => {
      expect(() => {
        parser.configure(config);
      }).not.toThrow();
    });
  });

  describe('start', () => {
    beforeEach(() => {
      parser.configure(config);
    });

    it('should fail without configuration', async () => {
      const unconfiguredParser = new shaka.media.BjsnManifestParser();

      await expectAsync(
        unconfiguredParser.start('http://example.com/test.mp4', playerInterface)
      ).toBeRejected();
    });

    it('should parse valid BJSN segment and create manifest', async () => {
      const testUri = 'http://example.com/media-first.mp4';

      // Mock network response with valid BJSN segment
      networkingEngine.setResponseValue(testUri, validBjsnSegment.buffer);

      const manifest = await parser.start(testUri, playerInterface);

      expect(manifest).toBeDefined();
      expect(manifest.presentationTimeline).toBeDefined();
      expect(manifest.variants.length).toBe(1);
      expect(manifest.type).toBe('BJSN');
      expect(manifest.periodCount).toBe(1);
    });

    it('should create proper variants from BJSN data', async () => {
      const testUri = 'http://example.com/media-first.mp4';
      networkingEngine.setResponseValue(testUri, validBjsnSegment.buffer);

      const manifest = await parser.start(testUri, playerInterface);
      const variant = manifest.variants[0];

      expect(variant).toBeDefined();
      expect(variant.id).toBe(1);
      expect(variant.language).toBe('und');
      expect(variant.primary).toBe(true);
      expect(variant.bandwidth).toBe(800000);
      expect(variant.audio).toBeDefined();
      expect(variant.video).toBeDefined();
    });

    it('should create proper video stream', async () => {
      const testUri = 'http://example.com/media-first.mp4';
      networkingEngine.setResponseValue(testUri, validBjsnSegment.buffer);

      const manifest = await parser.start(testUri, playerInterface);
      const videoStream = manifest.variants[0].video;

      expect(videoStream).toBeDefined();
      expect(videoStream.id).toBe(1);
      expect(videoStream.originalId).toBe('hd5_video');
      expect(videoStream.mimeType).toBe('video/mp4');
      expect(videoStream.codecs).toBe('avc1.640028');
      expect(videoStream.type).toBe(shaka.util.ManifestParserUtils.ContentType.VIDEO);
      expect(videoStream.bandwidth).toBe(800000);
      expect(videoStream.segmentIndex).toBeDefined();
    });

    it('should create proper audio stream', async () => {
      const testUri = 'http://example.com/media-first.mp4';
      networkingEngine.setResponseValue(testUri, validBjsnSegment.buffer);

      const manifest = await parser.start(testUri, playerInterface);
      const audioStream = manifest.variants[0].audio;

      expect(audioStream).toBeDefined();
      expect(audioStream.id).toBe(2);
      expect(audioStream.originalId).toBe('hd5_audio');
      expect(audioStream.mimeType).toBe('audio/mp4');
      expect(audioStream.codecs).toBe('mp4a.40.2');
      expect(audioStream.type).toBe(shaka.util.ManifestParserUtils.ContentType.AUDIO);
      expect(audioStream.channelsCount).toBe(2);
      expect(audioStream.audioSamplingRate).toBe(48000);
    });

    it('should create segment index with proper references', async () => {
      const testUri = 'http://example.com/media-first.mp4';
      networkingEngine.setResponseValue(testUri, validBjsnSegment.buffer);

      const manifest = await parser.start(testUri, playerInterface);
      const segmentIndex = manifest.variants[0].video.segmentIndex;

      expect(segmentIndex).toBeDefined();
      expect(segmentIndex.numEvicted).toBe(0);

      // Check first segment reference (should be original URI)
      const firstRef = segmentIndex.get(0);
      expect(firstRef).toBeDefined();
      expect(firstRef.startTime).toBe(0);
      expect(firstRef.endTime).toBe(2);
      expect(firstRef.getUris()[0]).toBe(testUri);

      // Check second segment reference (should use template)
      const secondRef = segmentIndex.get(1);
      expect(secondRef).toBeDefined();
      expect(secondRef.startTime).toBe(2);
      expect(secondRef.endTime).toBe(4);
      expect(secondRef.getUris()[0]).toBe('http://example.com/media-11.mp4');
    });

    it('should handle static vs dynamic content types', async () => {
      const testUri = 'http://example.com/media-first.mp4';

      // Test static content
      networkingEngine.setResponseValue(testUri, validBjsnSegment.buffer);
      let manifest = await parser.start(testUri, playerInterface);
      expect(manifest.presentationTimeline.isStatic()).toBe(true);

      // Reset parser
      await parser.stop();
      parser = new shaka.media.BjsnManifestParser();
      parser.configure(config);

      // Test dynamic content
      const dynamicBjsnData = Object.assign({}, validBjsnData, {type: 'dynamic'});
      const dynamicJsonData = shaka.util.StringUtils.toUTF8(JSON.stringify(dynamicBjsnData));
      const dynamicSegment = new Uint8Array(32 + dynamicJsonData.length);
      dynamicSegment.set([
        // ftyp box
        0x00, 0x00, 0x00, 0x18,
        0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6F, 0x6D,
        0x00, 0x00, 0x00, 0x00,
        0x69, 0x73, 0x6F, 0x6D,
        0x6D, 0x70, 0x34, 0x31,
        // BJSN box header
        0x00, 0x00, 0x00, 0x08 + dynamicJsonData.length,
        0x62, 0x6A, 0x73, 0x6E,
      ], 0);

      // Add the JSON data to the segment
      dynamicSegment.set(dynamicJsonData, 32);

      networkingEngine.setResponseValue(testUri, dynamicSegment.buffer);
      manifest = await parser.start(testUri, playerInterface);
      expect(manifest.presentationTimeline.isStatic()).toBe(false);
    });

    it('should fail gracefully with invalid BJSN data', async () => {
      const testUri = 'http://example.com/media-first.mp4';

      // Create segment without BJSN box
      const invalidSegment = new Uint8Array([
        // ftyp box only
        0x00, 0x00, 0x00, 0x18,
        0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6F, 0x6D,
        0x00, 0x00, 0x00, 0x00,
        0x69, 0x73, 0x6F, 0x6D,
        0x6D, 0x70, 0x34, 0x31,
      ]);

      networkingEngine.setResponseValue(testUri, invalidSegment.buffer);

      await expectAsync(
        parser.start(testUri, playerInterface)
      ).toBeRejectedWithError(shaka.util.Error, jasmine.objectContaining({
        category: shaka.util.Error.Category.MANIFEST
      }));
    });

    it('should handle network errors gracefully', async () => {
      const testUri = 'http://example.com/media-first.mp4';

      // Mock network error
      networkingEngine.setRequestError(testUri, new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.NETWORK,
          shaka.util.Error.Code.HTTP_ERROR));

      await expectAsync(
        parser.start(testUri, playerInterface)
      ).toBeRejectedWithError(shaka.util.Error, jasmine.objectContaining({
        category: shaka.util.Error.Category.NETWORK
      }));
    });

    it('should extract correct base URL from manifest URI', async () => {
      const testCases = [
        {
          uri: 'http://example.com/path/to/media-first.mp4',
          expectedBase: 'http://example.com/path/to/',
        },
        {
          uri: 'https://cdn.example.com/stream/hd5/media-first.mp4',
          expectedBase: 'https://cdn.example.com/stream/hd5/',
        },
        {
          uri: 'media-first.mp4',
          expectedBase: '',
        },
      ];

      // Process test cases sequentially
      for (let i = 0; i < testCases.length; i++) {
        const testCase = testCases[i];
        networkingEngine.setResponseValue(testCase.uri, validBjsnSegment.buffer);

        await parser.start(testCase.uri, playerInterface);
        expect(parser.baseUrl_).toBe(testCase.expectedBase);

        // Reset for next test
        await parser.stop();
        parser = new shaka.media.BjsnManifestParser();
        parser.configure(config);
      }
    });
  });

  describe('stop', () => {
    beforeEach(() => {
      parser.configure(config);
    });

    it('should stop successfully without starting', async () => {
      await parser.stop();
      expect(parser.playerInterface_).toBeNull();
      expect(parser.config_).toBeNull();
    });

    it('should stop successfully after starting', async () => {
      const testUri = 'http://example.com/media-first.mp4';
      networkingEngine.setResponseValue(testUri, validBjsnSegment.buffer);

      await parser.start(testUri, playerInterface);
      await parser.stop();

      expect(parser.playerInterface_).toBeNull();
      expect(parser.config_).toBeNull();
      expect(parser.manifestUri_).toBe('');
      expect(parser.currentBjsnData_).toBeNull();
    });

    it('should handle multiple stop calls', async () => {
      await parser.stop();
      await parser.stop();
      expect(parser.playerInterface_).toBeNull();
    });
  });

  describe('segment URL generation', () => {
    beforeEach(() => {
      parser.configure(config);
    });

    it('should generate correct segment URLs', async () => {
      const testUri = 'http://example.com/stream/media-first.mp4';
      networkingEngine.setResponseValue(testUri, validBjsnSegment.buffer);

      await parser.start(testUri, playerInterface);

      // Test generateSegmentUrl_ method
      const templatePath = 'media-$' + '{num}.mp4';
      const url1 = parser.generateSegmentUrl_(templatePath, 11);
      const url2 = parser.generateSegmentUrl_(templatePath, 12);

      expect(url1).toBe('http://example.com/stream/media-11.mp4');
      expect(url2).toBe('http://example.com/stream/media-12.mp4');
    });

    it('should handle different template formats', async () => {
      const testUri = 'http://example.com/stream/media-first.mp4';

      // Create BJSN data with different template
      const customBjsnData = Object.assign({}, validBjsnData, {
        template_path: 'segment_$' + '{num}.m4s',
      });

      const jsonData = shaka.util.StringUtils.toUTF8(JSON.stringify(customBjsnData));
      const customSegment = new Uint8Array(32 + jsonData.length);
      customSegment.set([
        // ftyp box
        0x00, 0x00, 0x00, 0x18,
        0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6F, 0x6D,
        0x00, 0x00, 0x00, 0x00,
        0x69, 0x73, 0x6F, 0x6D,
        0x6D, 0x70, 0x34, 0x31,
        // BJSN box header
        0x00, 0x00, 0x00, 0x08 + jsonData.length,
        0x62, 0x6A, 0x73, 0x6E,
      ], 0);

      // Add the JSON data to the segment
      customSegment.set(jsonData, 32);

      networkingEngine.setResponseValue(testUri, customSegment.buffer);

      await parser.start(testUri, playerInterface);

      const url = parser.generateSegmentUrl_('segment_$' + '{num}.m4s', 15);
      expect(url).toBe('http://example.com/stream/segment-15.m4s');
    });
  });

  describe('manifest structure validation', () => {
    beforeEach(() => {
      parser.configure(config);
    });

    it('should create manifest with required fields', async () => {
      const testUri = 'http://example.com/media-first.mp4';
      networkingEngine.setResponseValue(testUri, validBjsnSegment.buffer);

      const manifest = await parser.start(testUri, playerInterface);

      // Validate top-level manifest structure
      expect(manifest.presentationTimeline).toBeDefined();
      expect(manifest.variants).toBeDefined();
      expect(manifest.textStreams).toBeDefined();
      expect(manifest.imageStreams).toBeDefined();
      expect(manifest.offlineSessionIds).toEqual([]);
      expect(manifest.sequenceMode).toBe(false);
      expect(manifest.type).toBeDefined();
      expect(manifest.periodCount).toBe(1);
      expect(manifest.gapCount).toBe(0);
      expect(manifest.isLowLatency).toBe(false);
    });

    it('should create streams with all required properties', async () => {
      const testUri = 'http://example.com/media-first.mp4';
      networkingEngine.setResponseValue(testUri, validBjsnSegment.buffer);

      const manifest = await parser.start(testUri, playerInterface);
      const videoStream = manifest.variants[0].video;
      const audioStream = manifest.variants[0].audio;

      // Validate video stream properties
      const requiredVideoProps = [
        'id', 'originalId', 'createSegmentIndex', 'closeSegmentIndex',
        'segmentIndex', 'mimeType', 'codecs', 'bandwidth', 'width', 'height',
        'encrypted', 'drmInfos', 'keyIds', 'language', 'type', 'primary',
      ];

      for (const prop of requiredVideoProps) {
        expect(videoStream[prop]).toBeDefined();
      }

      // Validate audio stream properties
      const requiredAudioProps = [
        'id', 'originalId', 'createSegmentIndex', 'closeSegmentIndex',
        'segmentIndex', 'mimeType', 'codecs', 'bandwidth', 'channelsCount',
        'audioSamplingRate', 'encrypted', 'drmInfos', 'keyIds', 'language',
        'type', 'primary',
      ];

      for (const prop of requiredAudioProps) {
        expect(audioStream[prop]).toBeDefined();
      }
    });

    it('should handle DRM metadata correctly', async () => {
      const testUri = 'http://example.com/media-first.mp4';

      // Create BJSN data with DRM info
      const drmBjsnData = Object.assign({}, validBjsnData, {
        gear_list: [{
          hd5: {
            realtime_bitrate: 800000,
            drm: {
              key_id: 'test-key-id',
              license_url: 'https://license.example.com',
            },
          },
        }],
      });

      const jsonData = shaka.util.StringUtils.toUTF8(JSON.stringify(drmBjsnData));
      const drmSegment = new Uint8Array(32 + jsonData.length);
      drmSegment.set([
        // ftyp box
        0x00, 0x00, 0x00, 0x18,
        0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6F, 0x6D,
        0x00, 0x00, 0x00, 0x00,
        0x69, 0x73, 0x6F, 0x6D,
        0x6D, 0x70, 0x34, 0x31,
        // BJSN box header
        0x00, 0x00, 0x00, 0x08 + jsonData.length,
        0x62, 0x6A, 0x73, 0x6E,
      ], 0);

      // Add the JSON data to the segment
      drmSegment.set(jsonData, 32);

      networkingEngine.setResponseValue(testUri, drmSegment.buffer);

      const manifest = await parser.start(testUri, playerInterface);
      const videoStream = manifest.variants[0].video;
      const audioStream = manifest.variants[0].audio;

      expect(videoStream.encrypted).toBe(true);
      expect(audioStream.encrypted).toBe(true);
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      parser.configure(config);
    });

    it('should handle malformed BJSN JSON', async () => {
      const testUri = 'http://example.com/media-first.mp4';

      // Create segment with invalid JSON
      const invalidJson = '{"invalid": json}';
      const invalidJsonData = shaka.util.StringUtils.toUTF8(invalidJson);
      const invalidSegment = new Uint8Array(32 + invalidJsonData.length);
      invalidSegment.set([
        // ftyp box
        0x00, 0x00, 0x00, 0x18,
        0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6F, 0x6D,
        0x00, 0x00, 0x00, 0x00,
        0x69, 0x73, 0x6F, 0x6D,
        0x6D, 0x70, 0x34, 0x31,
        // BJSN box header with invalid JSON
        0x00, 0x00, 0x00, 0x08 + invalidJsonData.length,
        0x62, 0x6A, 0x73, 0x6E,
      ], 0);

      // Add the invalid JSON data to the segment
      invalidSegment.set(invalidJsonData, 32);

      networkingEngine.setResponseValue(testUri, invalidSegment.buffer);

      await expectAsync(
        parser.start(testUri, playerInterface)
      ).toBeRejectedWithError(shaka.util.Error);
    });

    it('should handle empty segment data', async () => {
      const testUri = 'http://example.com/media-first.mp4';

      networkingEngine.setResponseValue(testUri, new ArrayBuffer(0));

      await expectAsync(
        parser.start(testUri, playerInterface)
      ).toBeRejectedWithError(shaka.util.Error);
    });

    it('should handle operation cancellation', async () => {
      const testUri = 'http://example.com/media-first.mp4';

      // Set up a delayed response
      networkingEngine.setDelayedResponse(testUri, validBjsnSegment.buffer, 1000);

      const startPromise = parser.start(testUri, playerInterface);

      // Stop the parser before the request completes
      await parser.stop();

      await expectAsync(startPromise).toBeRejectedWithError(
        shaka.util.Error,
        jasmine.objectContaining({
          code: shaka.util.Error.Code.OPERATION_ABORTED
        })
      );
    });
  });

  describe('integration with Shaka Player interfaces', () => {
    beforeEach(() => {
      parser.configure(config);
    });

    it('should call playerInterface methods appropriately', async () => {
      const testUri = 'http://example.com/media-first.mp4';
      networkingEngine.setResponseValue(testUri, validBjsnSegment.buffer);

      spyOn(playerInterface, 'filter').and.returnValue(Promise.resolve());
      spyOn(playerInterface, 'makeTextStreamsForClosedCaptions');

      await parser.start(testUri, playerInterface);

      // The parser should not call these in Phase 1, but verify interface is properly set
      expect(playerInterface.networkingEngine).toBeDefined();
      expect(typeof playerInterface.filter).toBe('function');
      expect(typeof playerInterface.makeTextStreamsForClosedCaptions).toBe('function');
    });

    it('should handle player interface callbacks without errors', async () => {
      const testUri = 'http://example.com/media-first.mp4';
      networkingEngine.setResponseValue(testUri, validBjsnSegment.buffer);

      // Test that no-op methods don't throw
      expect(() => {
        parser.update();
        parser.onExpirationUpdated('session1', Date.now());
        parser.onInitialVariantChosen(null);
        parser.banLocation('http://example.com');
        parser.setMediaElement(null);
      }).not.toThrow();

      const manifest = await parser.start(testUri, playerInterface);
      expect(manifest).toBeDefined();
    });
  });
});
