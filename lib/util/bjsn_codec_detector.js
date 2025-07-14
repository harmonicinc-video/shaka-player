/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.util.BjsnCodecDetector');

goog.require('goog.asserts');
goog.require('shaka.log');
goog.require('shaka.util.Mp4BoxParsers');
goog.require('shaka.util.Mp4Parser');
goog.require('shaka.util.MimeUtils');
goog.require('shaka.util.DataViewReader');
goog.require('shaka.util.Error');

/**
 * @summary BJSN Codec Detection Utility
 * 
 * Dynamically detects codec information from MP4 segments after BJSN box stripping
 * using existing Shaka Player MP4 parsing infrastructure for accurate MIME type generation.
 * 
 * @export
 */
shaka.util.BjsnCodecDetector = class {
  /**
   * Detect codecs from a stripped MP4 segment (init or media segment)
   * 
   * @param {!Uint8Array} segmentData - Stripped MP4 segment data (without BJSN box)
   * @return {!Promise<!shaka.util.BjsnCodecDetector.CodecInfo>} Detected codec information
   * @export
   */
  static async detectCodecsFromSegment(segmentData) {
    try {
      shaka.log.info('🔍 BJSN CODEC DETECTOR: Starting codec detection');
      shaka.log.info('  📏 Segment size:', segmentData.length, 'bytes');

      // First check if this is an init segment (has moov box)
      const isInitSegment = shaka.util.BjsnCodecDetector.hasBox_(segmentData, 'moov');
      shaka.log.info('  📦 Segment type:', isInitSegment ? 'INIT' : 'MEDIA');

      if (isInitSegment) {
        return shaka.util.BjsnCodecDetector.detectCodecsFromInitSegment_(segmentData);
      } else {
        // For media segments, we need to parse moof/traf structure
        return shaka.util.BjsnCodecDetector.detectCodecsFromMediaSegment_(segmentData);
      }
    } catch (error) {
      shaka.log.warning('🔍 BJSN CODEC DETECTOR: Detection failed:', error);
      
      // Return fallback codec info
      return shaka.util.BjsnCodecDetector.getFallbackCodecInfo_();
    }
  }

  /**
   * Detect codecs from an MP4 init segment
   * 
   * @param {!Uint8Array} segmentData - MP4 init segment data
   * @return {!shaka.util.BjsnCodecDetector.CodecInfo} Detected codec information
   * @private
   */
  static detectCodecsFromInitSegment_(segmentData) {
    shaka.log.info('  🎬 Detecting codecs from INIT segment');
    
    const codecInfo = {
      video: null,
      audio: null,
      mimeType: null,
      isMultiplexed: false,
      detectionMethod: 'init-segment'
    };

    let currentTrackType = null;

    const parser = new shaka.util.Mp4Parser()
      .box('moov', shaka.util.Mp4Parser.children)
      .box('trak', (box) => {
        // Reset track type for each new track
        currentTrackType = null;
        shaka.util.Mp4Parser.children(box);
      })
      .box('mdia', shaka.util.Mp4Parser.children)
      .box('hdlr', (box) => {
        const hdlr = shaka.util.Mp4BoxParsers.parseHDLR(box.reader);
        currentTrackType = hdlr.handlerType;
        
        shaka.log.info('    🏷️  Found track type:', currentTrackType);
      })
      .box('minf', shaka.util.Mp4Parser.children)
      .box('stbl', shaka.util.Mp4Parser.children)
      .box('stsd', (box) => {
        // Parse sample description to get codec info for current track
        const codecData = shaka.util.BjsnCodecDetector.parseSTSD_(box, currentTrackType);
        
        if (codecData.video) {
          codecInfo.video = codecData.video;
          shaka.log.info('    🎥 Video codec detected:', codecData.video);
        }
        
        if (codecData.audio) {
          codecInfo.audio = codecData.audio;
          shaka.log.info('    🎵 Audio codec detected:', codecData.audio);
        }
      });

    try {
      parser.parse(segmentData);
      
      // Determine if this is multiplexed content
      codecInfo.isMultiplexed = !!(codecInfo.video && codecInfo.audio);
      
      // If no codecs detected but we detected tracks, use fallback
      if (!codecInfo.video && !codecInfo.audio) {
        shaka.log.warning('  ⚠️  No codecs detected from STSD boxes, using fallback');
        return shaka.util.BjsnCodecDetector.getFallbackCodecInfo_();
      }
      
      // Generate MIME type
      codecInfo.mimeType = shaka.util.BjsnCodecDetector.generateMimeType_(codecInfo);
      
      shaka.log.info('  ✅ Init segment codec detection complete');
      shaka.log.info('    🎥 Video:', codecInfo.video || 'none');
      shaka.log.info('    🎵 Audio:', codecInfo.audio || 'none');
      shaka.log.info('    🔀 Multiplexed:', codecInfo.isMultiplexed);
      shaka.log.info('    📄 MIME type:', codecInfo.mimeType);

      return codecInfo;
    } catch (error) {
      shaka.log.warning('  ❌ Init segment parsing failed:', error);
      throw error;
    }
  }

  /**
   * Detect codecs from an MP4 media segment (fallback method)
   * 
   * @param {!Uint8Array} segmentData - MP4 media segment data
   * @return {!shaka.util.BjsnCodecDetector.CodecInfo} Detected codec information
   * @private
   */
  static detectCodecsFromMediaSegment_(segmentData) {
    shaka.log.info('  📺 Detecting codecs from MEDIA segment (limited info)');
    
    // For media segments, we can only do basic detection
    // In a proper implementation, this would require the init segment
    // For now, return reasonable defaults based on typical BJSN content
    
    const codecInfo = {
      video: 'avc1.42E01E',  // H.264 Baseline Profile Level 3.0
      audio: 'mp4a.40.2',   // AAC-LC
      mimeType: null,
      isMultiplexed: true,  // Assume multiplexed for BJSN
      detectionMethod: 'media-segment-fallback'
    };

    codecInfo.mimeType = shaka.util.BjsnCodecDetector.generateMimeType_(codecInfo);
    
    shaka.log.info('  ⚠️  Using fallback detection for media segment');
    shaka.log.info('    🎥 Video (fallback):', codecInfo.video);
    shaka.log.info('    🎵 Audio (fallback):', codecInfo.audio);
    shaka.log.info('    📄 MIME type:', codecInfo.mimeType);

    return codecInfo;
  }

  /**
   * Parse STSD box to extract codec information
   * 
   * @param {!shaka.util.Mp4Parser.ParsedBox} stsdBox - Parsed STSD box
   * @param {?string} trackType - Track type ('vide', 'soun', etc.)
   * @return {{video: ?string, audio: ?string}} Codec information
   * @private
   */
  static parseSTSD_(stsdBox, trackType) {
    const result = { video: null, audio: null };
    
    if (!trackType) {
      shaka.log.warning('      ⚠️  No track type available for STSD parsing');
      return result;
    }
    
    const reader = stsdBox.reader;
    
    try {
      // STSD box structure:
      // 4 bytes: version and flags (already parsed by Mp4Parser)
      // 4 bytes: entry_count
      const entryCount = reader.readUint32();
      
      shaka.log.info('      📊 STSD entry count:', entryCount, 'for track type:', trackType);
      
      // Process each sample entry
      for (let i = 0; i < entryCount; i++) {
        if (!reader.hasMoreData()) {
          break;
        }
        
        // Each sample entry starts with:
        // 4 bytes: size
        // 4 bytes: format (fourcc)
        const entrySize = reader.readUint32();
        const format = reader.readUint32();
        const formatString = shaka.util.Mp4Parser.typeToString(format);
        
        shaka.log.info('      🏷️  Sample entry format:', formatString, 'size:', entrySize);
        
        // Save position to parse the sample entry content
        const entryStart = reader.getPosition() - 8; // Include size and format
        const entryEnd = entryStart + entrySize;
        
        // Ensure we don't read past the entry
        if (entryEnd > reader.getLength()) {
          shaka.log.warning('      ⚠️  Entry size extends beyond available data, skipping');
          break;
        }
        
        if (trackType === 'vide' && shaka.util.BjsnCodecDetector.isVideoFormat_(formatString)) {
          result.video = shaka.util.BjsnCodecDetector.parseVideoSampleEntry_(
            reader, formatString, entryEnd);
        } else if (trackType === 'soun' && shaka.util.BjsnCodecDetector.isAudioFormat_(formatString)) {
          result.audio = shaka.util.BjsnCodecDetector.parseAudioSampleEntry_(
            reader, formatString, entryEnd);
        } else {
          shaka.log.info('      ➡️  Skipping sample entry for track type:', trackType, 'format:', formatString);
        }
        
        // Move to next entry (ensure we don't go past the end)
        if (entryEnd <= reader.getLength()) {
          reader.seek(entryEnd);
        } else {
          break;
        }
      }
    } catch (error) {
      shaka.log.warning('      ❌ STSD parsing error:', error);
    }
    
    return result;
  }

  /**
   * Parse video sample entry to get codec string
   * 
   * @param {!shaka.util.DataViewReader} reader - Data reader
   * @param {string} format - Video format fourcc
   * @param {number} entryEnd - End position of this entry
   * @return {?string} Video codec string
   * @private
   */
  static parseVideoSampleEntry_(reader, format, entryEnd) {
    try {
      shaka.log.info('        🎬 Parsing video sample entry for format:', format);
      
      // The visual sample entry starts after the first 8 bytes (size + format)
      // which have already been read, plus 6 bytes reserved + 2 bytes data_reference_index
      reader.skip(8); // reserved(6) + data_reference_index(2)
      
      // Check if we have enough data for visual sample entry fields
      const remainingBytes = entryEnd - reader.getPosition();
      if (remainingBytes < 70) { // 70 bytes for the rest of visual sample entry
        shaka.log.warning('        ⚠️  Not enough data for visual sample entry, using default codec');
        return shaka.util.BjsnCodecDetector.getDefaultVideoCodec_(format);
      }
      
      // Read visual sample entry fields manually to be more precise
      reader.skip(16); // pre_defined(2) + reserved(2) + pre_defined(12)
      const width = reader.readUint16();
      const height = reader.readUint16();
      reader.skip(50); // horizresolution(4) + vertresolution(4) + reserved(4) + frame_count(2) + compressorname(32) + depth(2) + pre_defined(2)
      
      shaka.log.info('        📐 Video dimensions:', width + 'x' + height);
      
      // Check if we have remaining data to parse for codec configuration
      const remainingDataLength = entryEnd - reader.getPosition();
      if (remainingDataLength <= 0) {
        shaka.log.info('        ℹ️  No codec configuration data, using default for format:', format);
        return shaka.util.BjsnCodecDetector.getDefaultVideoCodec_(format);
      }
      
      shaka.log.info('        📦 Parsing codec config boxes from', remainingDataLength, 'remaining bytes');
      
      // Parse codec-specific boxes within the sample entry
      const remainingData = reader.readBytes(remainingDataLength);
      
      // Create a parser for the remaining data to find codec config boxes
      const subParser = new shaka.util.Mp4Parser();
      let codecString = null;
      
      if (format === 'avc1' || format === 'avc3') {
        // H.264
        subParser.box('avcC', (box) => {
          try {
            const avcc = shaka.util.Mp4BoxParsers.parseAVCC('avc1', box.reader, 'avcC');
            codecString = avcc.codec;
            shaka.log.info('        ✅ Found avcC codec:', codecString);
          } catch (error) {
            shaka.log.warning('        ⚠️  avcC parsing failed:', error);
          }
        });
      } else if (format === 'hvc1' || format === 'hev1') {
        // H.265
        subParser.box('hvcC', (box) => {
          try {
            const hvcc = shaka.util.Mp4BoxParsers.parseHVCC('hvc1', box.reader, 'hvcC');
            codecString = hvcc.codec;
            shaka.log.info('        ✅ Found hvcC codec:', codecString);
          } catch (error) {
            shaka.log.warning('        ⚠️  hvcC parsing failed:', error);
          }
        });
      } else if (format === 'vp09') {
        // VP9
        subParser.box('vpcC', (box) => {
          try {
            const vpcc = shaka.util.Mp4BoxParsers.parseVPCC('vp09', box.reader, 'vpcC');
            codecString = vpcc.codec;
            shaka.log.info('        ✅ Found vpcC codec:', codecString);
          } catch (error) {
            shaka.log.warning('        ⚠️  vpcC parsing failed:', error);
          }
        });
      } else if (format === 'av01') {
        // AV1
        subParser.box('av1C', (box) => {
          try {
            const av1c = shaka.util.Mp4BoxParsers.parseAV1C('av01', box.reader, 'av1C');
            codecString = av1c.codec;
            shaka.log.info('        ✅ Found av1C codec:', codecString);
          } catch (error) {
            shaka.log.warning('        ⚠️  av1C parsing failed:', error);
          }
        });
      }
      
      if (remainingData.length > 0) {
        try {
          subParser.parse(remainingData);
        } catch (error) {
          shaka.log.warning('        ⚠️  Codec configuration box parsing failed:', error);
        }
      }
      
      // If no specific codec config found, use the format as base
      if (!codecString) {
        codecString = shaka.util.BjsnCodecDetector.getDefaultVideoCodec_(format);
        shaka.log.info('        🔄 Using default codec for format:', format, '->', codecString);
      }
      
      return codecString;
      
    } catch (error) {
      shaka.log.warning('        ❌ Video sample entry parsing failed:', error);
      return shaka.util.BjsnCodecDetector.getDefaultVideoCodec_(format);
    }
  }

  /**
   * Parse audio sample entry to get codec string
   * 
   * @param {!shaka.util.DataViewReader} reader - Data reader
   * @param {string} format - Audio format fourcc
   * @param {number} entryEnd - End position of this entry
   * @return {?string} Audio codec string
   * @private
   */
  static parseAudioSampleEntry_(reader, format, entryEnd) {
    try {
      shaka.log.info('        🎵 Parsing audio sample entry for format:', format);
      
      // The audio sample entry starts after the first 8 bytes (size + format)
      // which have already been read, plus 6 bytes reserved + 2 bytes data_reference_index
      reader.skip(8); // reserved(6) + data_reference_index(2)
      
      // Check if we have enough data for audio sample entry fields
      const remainingBytes = entryEnd - reader.getPosition();
      if (remainingBytes < 20) { // 20 bytes for the rest of audio sample entry
        shaka.log.warning('        ⚠️  Not enough data for audio sample entry, using default codec');
        return shaka.util.BjsnCodecDetector.getDefaultAudioCodec_(format);
      }
      
      // Read audio sample entry fields manually
      reader.skip(8); // reserved(8)
      const channelCount = reader.readUint16();
      const sampleSize = reader.readUint16();
      reader.skip(2); // pre_defined(2)
      reader.skip(2); // reserved(2)  
      const sampleRate = reader.readUint16();
      reader.skip(2); // reserved(2)
      
      shaka.log.info('        🎼 Audio info:', channelCount + ' channels, ' + sampleRate + ' Hz');
      
      // Check if we have remaining data to parse for codec configuration
      const remainingDataLength = entryEnd - reader.getPosition();
      if (remainingDataLength <= 0) {
        shaka.log.info('        ℹ️  No codec configuration data, using default for format:', format);
        return shaka.util.BjsnCodecDetector.getDefaultAudioCodec_(format);
      }
      
      shaka.log.info('        📦 Parsing audio codec config from', remainingDataLength, 'remaining bytes');
      
      // Parse codec-specific boxes within the sample entry
      const remainingData = reader.readBytes(remainingDataLength);
      
      // Create a parser for the remaining data to find codec config boxes
      const subParser = new shaka.util.Mp4Parser();
      let codecString = null;
      
      if (format === 'mp4a') {
        // AAC or other MPEG audio
        subParser.box('esds', (box) => {
          try {
            const esds = shaka.util.Mp4BoxParsers.parseESDS(box.reader);
            codecString = esds.codec;
            shaka.log.info('        ✅ Found ESDS codec:', codecString);
          } catch (error) {
            shaka.log.warning('        ⚠️  ESDS parsing failed:', error);
          }
        });
      } else if (format === 'ac-3') {
        // AC-3
        codecString = 'ac-3';
      } else if (format === 'ec-3') {
        // E-AC-3
        codecString = 'ec-3';
      }
      
      if (remainingData.length > 0) {
        try {
          subParser.parse(remainingData);
        } catch (error) {
          shaka.log.warning('        ⚠️  Codec configuration box parsing failed:', error);
        }
      }
      
      // If no specific codec config found, use the format as base
      if (!codecString) {
        codecString = shaka.util.BjsnCodecDetector.getDefaultAudioCodec_(format);
        shaka.log.info('        🔄 Using default codec for format:', format, '->', codecString);
      }
      
      return codecString;
      
    } catch (error) {
      shaka.log.warning('        ❌ Audio sample entry parsing failed:', error);
      return shaka.util.BjsnCodecDetector.getDefaultAudioCodec_(format);
    }
  }

  /**
   * Generate MIME type from codec information
   * 
   * @param {!shaka.util.BjsnCodecDetector.CodecInfo} codecInfo - Detected codec info
   * @return {string} Generated MIME type
   * @private
   */
  static generateMimeType_(codecInfo) {
    if (codecInfo.isMultiplexed && codecInfo.video && codecInfo.audio) {
      // Multiplexed video + audio
      const codecs = codecInfo.video + ',' + codecInfo.audio;
      return shaka.util.MimeUtils.getFullType('video/mp4', codecs);
    } else if (codecInfo.video) {
      // Video only
      return shaka.util.MimeUtils.getFullType('video/mp4', codecInfo.video);
    } else if (codecInfo.audio) {
      // Audio only  
      return shaka.util.MimeUtils.getFullType('audio/mp4', codecInfo.audio);
    } else {
      // Fallback to basic MP4
      return 'video/mp4';
    }
  }

  /**
   * Validate that detected codecs are supported by the browser
   * 
   * @param {string} mimeType - Full MIME type with codecs
   * @return {boolean} True if codecs are supported
   * @export
   */
  static validateCodecSupport(mimeType) {
    try {
      if (window.MediaSource && window.MediaSource.isTypeSupported) {
        const isSupported = window.MediaSource.isTypeSupported(mimeType);
        shaka.log.info('🧪 BJSN CODEC DETECTOR: Codec support test');
        shaka.log.info('  📄 MIME type:', mimeType);
        shaka.log.info('  ✅ Supported:', isSupported);
        return isSupported;
      }
      
      // Fallback: assume supported if MediaSource API not available
      shaka.log.warning('🧪 MediaSource API not available, assuming codec support');
      return true;
    } catch (error) {
      shaka.log.warning('🧪 Codec support validation failed:', error);
      return false;
    }
  }

  /**
   * Check if a box type exists in the segment
   * 
   * @param {!Uint8Array} segmentData - MP4 segment data
   * @param {string} boxType - Box type to search for
   * @return {boolean} True if box exists
   * @private
   */
  static hasBox_(segmentData, boxType) {
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
   * Check if format is a video format
   * 
   * @param {string} format - Format fourcc
   * @return {boolean} True if video format
   * @private
   */
  static isVideoFormat_(format) {
    const videoFormats = ['avc1', 'avc3', 'hvc1', 'hev1', 'vp09', 'av01', 'mp4v'];
    return videoFormats.includes(format);
  }

  /**
   * Check if format is an audio format
   * 
   * @param {string} format - Format fourcc
   * @return {boolean} True if audio format
   * @private
   */
  static isAudioFormat_(format) {
    const audioFormats = ['mp4a', 'ac-3', 'ec-3', 'opus', 'fLaC'];
    return audioFormats.includes(format);
  }

  /**
   * Get default video codec for format
   * 
   * @param {string} format - Video format fourcc
   * @return {string} Default codec string
   * @private
   */
  static getDefaultVideoCodec_(format) {
    switch (format) {
      case 'avc1':
      case 'avc3':
        return 'avc1.42E01E'; // H.264 Baseline Profile Level 3.0
      case 'hvc1':
      case 'hev1':
        return 'hvc1.1.6.L93.90'; // H.265 Main Profile Level 3.1
      case 'vp09':
        return 'vp09.00.30.08'; // VP9 Profile 0 Level 3.0
      case 'av01':
        return 'av01.0.05M.08'; // AV1 Main Profile Level 3.0
      default:
        return 'avc1.42E01E'; // Fallback to H.264
    }
  }

  /**
   * Get default audio codec for format
   * 
   * @param {string} format - Audio format fourcc
   * @return {string} Default codec string
   * @private
   */
  static getDefaultAudioCodec_(format) {
    switch (format) {
      case 'mp4a':
        return 'mp4a.40.2'; // AAC-LC
      case 'ac-3':
        return 'ac-3';
      case 'ec-3':
        return 'ec-3';
      case 'opus':
        return 'opus';
      case 'fLaC':
        return 'flac';
      default:
        return 'mp4a.40.2'; // Fallback to AAC-LC
    }
  }

  /**
   * Get fallback codec information when detection fails
   * 
   * @return {!shaka.util.BjsnCodecDetector.CodecInfo} Fallback codec info
   * @export
   */
  static getFallbackCodecInfo_() {
    shaka.log.info('🔄 BJSN CODEC DETECTOR: Using fallback codec info');
    
    const codecInfo = {
      video: 'avc1.42E01E',  // H.264 Baseline Profile Level 3.0
      audio: 'mp4a.40.2',   // AAC-LC  
      mimeType: null,
      isMultiplexed: true,
      detectionMethod: 'fallback'
    };

    codecInfo.mimeType = shaka.util.BjsnCodecDetector.generateMimeType_(codecInfo);
    
    shaka.log.info('  🎥 Fallback video codec:', codecInfo.video);
    shaka.log.info('  🎵 Fallback audio codec:', codecInfo.audio);
    shaka.log.info('  📄 Fallback MIME type:', codecInfo.mimeType);

    return codecInfo;
  }

  /**
   * Create a codec detection result with caching support
   * 
   * @param {string} segmentUrl - Segment URL for caching key
   * @param {!shaka.util.BjsnCodecDetector.CodecInfo} codecInfo - Detected codec info
   * @return {!shaka.util.BjsnCodecDetector.DetectionResult} Detection result
   * @export
   */
  static createDetectionResult(segmentUrl, codecInfo) {
    return {
      segmentUrl: segmentUrl,
      codecInfo: codecInfo,
      timestamp: Date.now(),
      isValid: shaka.util.BjsnCodecDetector.validateCodecSupport(codecInfo.mimeType)
    };
  }
};

/**
 * @typedef {{
 *   video: ?string,
 *   audio: ?string, 
 *   mimeType: ?string,
 *   isMultiplexed: boolean,
 *   detectionMethod: string
 * }}
 *
 * @property {?string} video
 *   Video codec string (e.g., 'avc1.42E01E')
 * @property {?string} audio  
 *   Audio codec string (e.g., 'mp4a.40.2')
 * @property {?string} mimeType
 *   Generated MIME type with codecs
 * @property {boolean} isMultiplexed
 *   Whether content has both video and audio tracks
 * @property {string} detectionMethod
 *   How the codec was detected ('init-segment', 'media-segment-fallback', 'fallback')
 * @exportDoc
 */
shaka.util.BjsnCodecDetector.CodecInfo;

/**
 * @typedef {{
 *   segmentUrl: string,
 *   codecInfo: !shaka.util.BjsnCodecDetector.CodecInfo,
 *   timestamp: number,
 *   isValid: boolean
 * }}
 *
 * @property {string} segmentUrl
 *   URL of the segment that was analyzed
 * @property {!shaka.util.BjsnCodecDetector.CodecInfo} codecInfo
 *   Detected codec information
 * @property {number} timestamp
 *   When the detection was performed
 * @property {boolean} isValid
 *   Whether the detected codecs are supported by the browser
 * @exportDoc
 */
shaka.util.BjsnCodecDetector.DetectionResult;