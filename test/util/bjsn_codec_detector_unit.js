/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.require('shaka.util.BjsnCodecDetector');
goog.require('shaka.util.Mp4BoxParsers');
goog.require('shaka.util.Mp4Parser');

describe('BjsnCodecDetector', () => {
  const Util = shaka.test.Util;
  const BjsnCodecDetector = shaka.util.BjsnCodecDetector;

  describe('detectCodecsFromSegment', () => {
    it('detects H.264 + AAC from init segment', async () => {
      // Create a minimal MP4 init segment with H.264 + AAC
      const initSegment = createH264AacInitSegment();

      const codecInfo = await BjsnCodecDetector
          .detectCodecsFromSegment(initSegment);

      expect(codecInfo.video).toMatch(/^avc1\./);
      expect(codecInfo.audio).toMatch(/^mp4a\./);
      expect(codecInfo.isMultiplexed).toBe(true);
      expect(codecInfo.mimeType).toContain('video/mp4');
      expect(codecInfo.mimeType).toContain('avc1');
      expect(codecInfo.mimeType).toContain('mp4a');
      expect(codecInfo.detectionMethod).toBe('init-segment');
    });

    it('falls back gracefully for media segments', async () => {
      // Create a minimal MP4 media segment (moof + mdat)
      const mediaSegment = createMediaSegment();

      const codecInfo = await BjsnCodecDetector
          .detectCodecsFromSegment(mediaSegment);

      expect(codecInfo.video).toBe('avc1.42E01E');
      expect(codecInfo.audio).toBe('mp4a.40.2');
      expect(codecInfo.isMultiplexed).toBe(true);
      expect(codecInfo.detectionMethod).toBe('media-segment-fallback');
    });

    it('returns fallback on detection failure', async () => {
      // Create invalid MP4 data
      const invalidData = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

      const codecInfo = await BjsnCodecDetector
          .detectCodecsFromSegment(invalidData);

      expect(codecInfo.video).toBe('avc1.42E01E');
      expect(codecInfo.audio).toBe('mp4a.40.2');
      expect(codecInfo.detectionMethod).toBe('fallback');
    });
  });

  describe('validateCodecSupport', () => {
    beforeEach(() => {
      // Mock MediaSource API
      window.MediaSource = {
        isTypeSupported: jasmine.createSpy('isTypeSupported')
            .and.returnValue(true),
      };
    });

    afterEach(() => {
      delete window.MediaSource;
    });

    it('validates supported codecs', () => {
      const mimeType = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';

      const isSupported = BjsnCodecDetector.validateCodecSupport(mimeType);

      expect(isSupported).toBe(true);
      expect(window.MediaSource.isTypeSupported)
          .toHaveBeenCalledWith(mimeType);
    });

    it('rejects unsupported codecs', () => {
      window.MediaSource.isTypeSupported.and.returnValue(false);
      const mimeType = 'video/mp4; codecs="unsupported.codec"';

      const isSupported = BjsnCodecDetector.validateCodecSupport(mimeType);

      expect(isSupported).toBe(false);
    });

    it('falls back gracefully when MediaSource unavailable', () => {
      delete window.MediaSource;
      const mimeType = 'video/mp4; codecs="avc1.42E01E"';

      const isSupported = BjsnCodecDetector.validateCodecSupport(mimeType);

      expect(isSupported).toBe(true);
    });
  });

  describe('createDetectionResult', () => {
    it('creates valid detection result', () => {
      const segmentUrl = 'https://example.com/segment.mp4';
      const codecInfo = {
        video: 'avc1.42E01E',
        audio: 'mp4a.40.2',
        mimeType: 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',
        isMultiplexed: true,
        detectionMethod: 'init-segment',
      };

      // Mock MediaSource for validation
      window.MediaSource = {
        isTypeSupported: () => true,
      };

      const result = BjsnCodecDetector.createDetectionResult(segmentUrl,
          codecInfo);

      expect(result.segmentUrl).toBe(segmentUrl);
      expect(result.codecInfo).toBe(codecInfo);
      expect(result.timestamp).toBeGreaterThan(0);
      expect(result.isValid).toBe(true);

      delete window.MediaSource;
    });
  });

  // Helper functions to create test MP4 data

  function createH264AacInitSegment() {
    // Create FTYP box
    const ftyp = new Uint8Array([
      // Box size (20 bytes)
      0x00, 0x00, 0x00, 0x14,
      // Box type 'ftyp'
      0x66, 0x74, 0x79, 0x70,
      // Major brand 'isom'
      0x69, 0x73, 0x6F, 0x6D,
      // Minor version
      0x00, 0x00, 0x02, 0x00,
      // Compatible brands 'isom'
      0x69, 0x73, 0x6F, 0x6D,
    ]);

    // Create simplified MOOV box with video and audio tracks
    const moov = createMoovWithVideoAndAudio('avc1', 'mp4a');

    // Combine boxes
    const result = new Uint8Array(ftyp.length + moov.length);
    result.set(ftyp, 0);
    result.set(moov, ftyp.length);

    return result;
  }

  function createMediaSegment() {
    // Create minimal media segment with MOOF + MDAT
    const moof = createMoofBox();
    const mdat = createMdatBox();

    const result = new Uint8Array(moof.length + mdat.length);
    result.set(moof, 0);
    result.set(mdat, moof.length);

    return result;
  }

  function createMoofBox() {
    return new Uint8Array([
      0x00, 0x00, 0x00, 0x08, // size = 8
      0x6D, 0x6F, 0x6F, 0x66,  // 'moof'
    ]);
  }

  function createMdatBox() {
    return new Uint8Array([
      0x00, 0x00, 0x00, 0x10, // size = 16
      0x6D, 0x64, 0x61, 0x74, // 'mdat'
      0x00, 0x01, 0x02, 0x03, // sample data
      0x04, 0x05, 0x06, 0x07,
    ]);
  }

  function createMoovWithVideoAndAudio(videoFormat, audioFormat) {
    // Simplified MOOV structure with video and audio tracks
    const moovHeader = new Uint8Array([
      0x00, 0x00, 0x00, 0x40, // size = 64 (simplified)
      0x6D, 0x6F, 0x6F, 0x76,  // 'moov'
    ]);

    const videoTrak = createTrakBox(videoFormat, 'vide');
    const audioTrak = createTrakBox(audioFormat, 'soun');

    const result = new Uint8Array(moovHeader.length + videoTrak.length +
        audioTrak.length);
    result.set(moovHeader, 0);
    result.set(videoTrak, moovHeader.length);
    result.set(audioTrak, moovHeader.length + videoTrak.length);

    return result;
  }

  function createTrakBox(format, handlerType) {
    // Simplified TRAK box with MDIA > HDLR and STBL > STSD
    const trakHeader = new Uint8Array([
      0x00, 0x00, 0x00, 0x30, // size = 48
      0x74, 0x72, 0x61, 0x6B,  // 'trak'
    ]);

    const mdia = createMdiaBox(format, handlerType);

    const result = new Uint8Array(trakHeader.length + mdia.length);
    result.set(trakHeader, 0);
    result.set(mdia, trakHeader.length);

    return result;
  }

  function createMdiaBox(format, handlerType) {
    const mdiaHeader = new Uint8Array([
      0x00, 0x00, 0x00, 0x28, // size = 40
      0x6D, 0x64, 0x69, 0x61,  // 'mdia'
    ]);

    const hdlr = createHdlrBox(handlerType);
    const minf = createMinfBox(format);

    const result = new Uint8Array(mdiaHeader.length + hdlr.length +
        minf.length);
    result.set(mdiaHeader, 0);
    result.set(hdlr, mdiaHeader.length);
    result.set(minf, mdiaHeader.length + hdlr.length);

    return result;
  }

  function createHdlrBox(handlerType) {
    const handlerBytes = new Uint8Array(4);
    for (let i = 0; i < 4; i++) {
      handlerBytes[i] = handlerType.charCodeAt(i);
    }

    return new Uint8Array([
      0x00, 0x00, 0x00, 0x20, // size = 32
      0x68, 0x64, 0x6C, 0x72, // 'hdlr'
      0x00, 0x00, 0x00, 0x00, // version + flags
      0x00, 0x00, 0x00, 0x00, // pre_defined
      ...handlerBytes,         // handler_type
      0x00, 0x00, 0x00, 0x00, // reserved[0]
      0x00, 0x00, 0x00, 0x00, // reserved[1]
      0x00, 0x00, 0x00, 0x00,  // reserved[2]
    ]);
  }

  function createMinfBox(format) {
    const minfHeader = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, // size = 24
      0x6D, 0x69, 0x6E, 0x66,  // 'minf'
    ]);

    const stbl = createStblBox(format);

    const result = new Uint8Array(minfHeader.length + stbl.length);
    result.set(minfHeader, 0);
    result.set(stbl, minfHeader.length);

    return result;
  }

  function createStblBox(format) {
    const stblHeader = new Uint8Array([
      0x00, 0x00, 0x00, 0x10, // size = 16
      0x73, 0x74, 0x62, 0x6C,  // 'stbl'
    ]);

    const stsd = createStsdBox(format);

    const result = new Uint8Array(stblHeader.length + stsd.length);
    result.set(stblHeader, 0);
    result.set(stsd, stblHeader.length);

    return result;
  }

  function createStsdBox(format) {
    const formatBytes = new Uint8Array(4);
    for (let i = 0; i < 4; i++) {
      formatBytes[i] = format.charCodeAt(i);
    }

    return new Uint8Array([
      0x00, 0x00, 0x00, 0x18, // size = 24
      0x73, 0x74, 0x73, 0x64, // 'stsd'
      0x00, 0x00, 0x00, 0x00, // version + flags
      0x00, 0x00, 0x00, 0x01, // entry_count = 1
      0x00, 0x00, 0x00, 0x08, // sample entry size = 8
      ...formatBytes,           // sample entry format
    ]);
  }
});
