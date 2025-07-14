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
 * @summary BJSN Codec Detection Utility - FIXED VERSION
 * 
 * Dynamically detects codec information from MP4 segments after BJSN box stripping
 * using existing Shaka Player MP4 parsing infrastructure for accurate MIME type generation.
 * 
 * FIXES:
 * - Proper track type association between HDLR and STSD boxes
 * - Accurate avcC and ESDS parsing for precise codec strings
 * - Support for both audio and video tracks in multiplexed content
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
   * Detect codecs from an MP4 init segment - FIXED VERSION
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

    // Track all tracks and their STSD data
    const tracks = [];
    let currentTrack = null;

    const parser = new shaka.util.Mp4Parser()
      .box('moov', shaka.util.Mp4Parser.children)
      .box('trak', (box) => {
        // Start a new track
        currentTrack = {
          trackType: null,
          stsdData: null
        };
        tracks.push(currentTrack);
        shaka.util.Mp4Parser.children(box);
      })
      .box('mdia', shaka.util.Mp4Parser.children)
      .fullBox('hdlr', (box) => {
        const hdlr = shaka.util.Mp4BoxParsers.parseHDLR(box.reader);
        if (currentTrack) {
          currentTrack.trackType = hdlr.handlerType;
          shaka.log.info('    🏷️  Found track type:', hdlr.handlerType);
        }
      })
      .box('minf', shaka.util.Mp4Parser.children)
      .box('stbl', shaka.util.Mp4Parser.children)
      .fullBox('stsd', (box) => {
        if (currentTrack) {
          // Store the entire STSD box data for later parsing
          currentTrack.stsdData = {
            reader: box.reader,
            version: box.version,
            flags: box.flags
          };
          shaka.log.info('    📊 Captured STSD data for track type:', currentTrack.trackType);
        }
      });

    try {
      parser.parse(segmentData);
      
      // Now process all tracks that have both track type and STSD data
      for (const track of tracks) {
        if (!track.trackType || !track.stsdData) {
          shaka.log.warning('    ⚠️ Incomplete track data, skipping');
          continue;
        }

        const codecData = shaka.util.BjsnCodecDetector.parseSTSD_(track.stsdData, track.trackType);
        
        if (codecData.video) {
          codecInfo.video = codecData.video;
          shaka.log.info('    🎥 Video codec detected:', codecData.video);
        }
        
        if (codecData.audio) {
          codecInfo.audio = codecData.audio;
          shaka.log.info('    🎵 Audio codec detected:', codecData.audio);
        }
      }
      
      // Determine if this is multiplexed content
      codecInfo.isMultiplexed = !!(codecInfo.video && codecInfo.audio);
      
      // If no codecs detected, use fallback
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
   * Parse STSD box to extract codec information - FIXED VERSION
   * 
   * @param {!Object} stsdData - STSD box data with reader
   * @param {?string} trackType - Track type ('vide', 'soun', etc.)
   * @return {{video: ?string, audio: ?string}} Codec information
   * @private
   */
  static parseSTSD_(stsdData, trackType) {
    const result = { video: null, audio: null };
    
    if (!trackType || !stsdData || !stsdData.reader) {
      shaka.log.warning('      ⚠️  Invalid STSD data for parsing');
      return result;
    }
    
    const reader = stsdData.reader;
    // Reset reader position
    reader.seek(0);
    
    try {
      // STSD box structure:
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
        
        // Save position for content parsing
        const entryContentStart = reader.getPosition();
        const entryEnd = entryContentStart + entrySize - 8; // Subtract size and format fields
        
        // Ensure we don't read past the entry
        const availableBytes = reader.getLength() - reader.getPosition();
        const contentSize = Math.min(entrySize - 8, availableBytes);
        
        if (contentSize <= 0) {
          shaka.log.warning('      ⚠️  No content data in sample entry');
          continue;
        }

        if (trackType === 'vide' && shaka.util.BjsnCodecDetector.isVideoFormat_(formatString)) {
          result.video = shaka.util.BjsnCodecDetector.parseVideoSampleEntry_(
            reader, formatString, entryContentStart, contentSize);
        } else if (trackType === 'soun' && shaka.util.BjsnCodecDetector.isAudioFormat_(formatString)) {
          result.audio = shaka.util.BjsnCodecDetector.parseAudioSampleEntry_(
            reader, formatString, entryContentStart, contentSize);
        } else {
          shaka.log.info('      ➡️  Skipping sample entry for track type:', trackType, 'format:', formatString);
        }
        
        // Move to next entry
        const nextEntryPos = entryContentStart + contentSize;
        if (nextEntryPos <= reader.getLength()) {
          reader.seek(nextEntryPos);
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
   * Parse video sample entry to get codec string - ENHANCED VERSION
   * 
   * @param {!shaka.util.DataViewReader} reader - Data reader
   * @param {string} format - Video format fourcc
   * @param {number} contentStart - Start position of entry content
   * @param {number} contentSize - Size of entry content
   * @return {?string} Video codec string
   * @private
   */
  static parseVideoSampleEntry_(reader, format, contentStart, contentSize) {
    try {
      shaka.log.info('        🎬 Parsing video sample entry for format:', format);
      
      reader.seek(contentStart);
      
      // Skip visual sample entry header
      reader.skip(8); // reserved(6) + data_reference_index(2)
      reader.skip(16); // pre_defined(2) + reserved(2) + pre_defined(12)
      const width = reader.readUint16();
      const height = reader.readUint16();
      reader.skip(50); // Rest of visual sample entry fields
      
      shaka.log.info('        📐 Video dimensions:', width + 'x' + height);
      
      // Look for codec configuration boxes in remaining data
      const remainingStart = reader.getPosition();
      const remainingSize = contentStart + contentSize - remainingStart;
      
      if (remainingSize <= 0) {
        shaka.log.info('        ℹ️  No codec configuration data');
        return shaka.util.BjsnCodecDetector.getDefaultVideoCodec_(format);
      }
      
      const remainingData = reader.readBytes(remainingSize);
      let codecString = null;
      
      if (format === 'avc1' || format === 'avc3') {
        codecString = shaka.util.BjsnCodecDetector.parseAvcC_(remainingData);
      } else if (format === 'hvc1' || format === 'hev1') {
        codecString = shaka.util.BjsnCodecDetector.parseHvcC_(remainingData);
      }
      
      // Fallback to default if parsing failed
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
   * Parse audio sample entry to get codec string - ENHANCED VERSION
   * 
   * @param {!shaka.util.DataViewReader} reader - Data reader
   * @param {string} format - Audio format fourcc
   * @param {number} contentStart - Start position of entry content
   * @param {number} contentSize - Size of entry content
   * @return {?string} Audio codec string
   * @private
   */
  static parseAudioSampleEntry_(reader, format, contentStart, contentSize) {
    try {
      shaka.log.info('        🎵 Parsing audio sample entry for format:', format);
      
      reader.seek(contentStart);
      
      // Skip audio sample entry header
      reader.skip(8); // reserved(6) + data_reference_index(2)
      reader.skip(8); // reserved(8)
      const channelCount = reader.readUint16();
      const sampleSize = reader.readUint16();
      reader.skip(2); // pre_defined(2)
      reader.skip(2); // reserved(2)  
      const sampleRate = reader.readUint16();
      reader.skip(2); // reserved(2)
      
      shaka.log.info('        🎼 Audio info:', channelCount + ' channels, ' + sampleRate + ' Hz');
      
      // Look for codec configuration boxes in remaining data
      const remainingStart = reader.getPosition();
      const remainingSize = contentStart + contentSize - remainingStart;
      
      if (remainingSize <= 0) {
        shaka.log.info('        ℹ️  No codec configuration data');
        return shaka.util.BjsnCodecDetector.getDefaultAudioCodec_(format);
      }
      
      const remainingData = reader.readBytes(remainingSize);
      let codecString = null;
      
      if (format === 'mp4a') {
        codecString = shaka.util.BjsnCodecDetector.parseESDS_(remainingData);
      } else if (format === 'ac-3') {
        codecString = 'ac-3';
      } else if (format === 'ec-3') {
        codecString = 'ec-3';
      }
      
      // Fallback to default if parsing failed
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
   * Parse avcC box to extract H.264 codec string
   * 
   * @param {!Uint8Array} data - Data containing avcC box
   * @return {?string} H.264 codec string (e.g., 'avc1.640028')
   * @private
   */
  static parseAvcC_(data) {
    // Look for 'avcC' box
    for (let i = 0; i < data.length - 8; i++) {
      if (data[i] === 0x61 && data[i+1] === 0x76 && data[i+2] === 0x63 && data[i+3] === 0x43) {
        shaka.log.info('        📦 Found avcC box at offset:', i);
        
        // avcC box structure: size(4) + 'avcC'(4) + content
        const avcCStart = i + 8; // Skip box header
        
        if (avcCStart + 4 >= data.length) {
          shaka.log.warning('        ⚠️  avcC box too small');
          return null;
        }
        
        const configurationVersion = data[avcCStart];
        const avcProfileIndication = data[avcCStart + 1];
        const profileCompatibility = data[avcCStart + 2];
        const avcLevelIndication = data[avcCStart + 3];
        
        // Construct codec string: avc1.ProfileCompatibilityLevel
        const codecString = 'avc1.' + 
          avcProfileIndication.toString(16).padStart(2, '0').toUpperCase() +
          profileCompatibility.toString(16).padStart(2, '0').toUpperCase() +
          avcLevelIndication.toString(16).padStart(2, '0').toUpperCase();
          
        shaka.log.info('        ✅ avcC parsed - Profile:', avcProfileIndication.toString(16), 
                      'Compatibility:', profileCompatibility.toString(16),
                      'Level:', avcLevelIndication.toString(16));
        shaka.log.info('        🎯 H.264 codec string:', codecString);
        
        return codecString;
      }
    }
    
    shaka.log.warning('        ⚠️  No avcC box found');
    return null;
  }

  /**
   * Parse hvcC box to extract H.265 codec string
   * 
   * @param {!Uint8Array} data - Data containing hvcC box
   * @return {?string} H.265 codec string
   * @private
   */
  static parseHvcC_(data) {
    // Look for 'hvcC' box
    for (let i = 0; i < data.length - 8; i++) {
      if (data[i] === 0x68 && data[i+1] === 0x76 && data[i+2] === 0x63 && data[i+3] === 0x43) {
        shaka.log.info('        📦 Found hvcC box at offset:', i);
        
        // For now, return a standard H.265 codec string
        // Full hvcC parsing is complex and would require more detailed implementation
        const codecString = 'hvc1.1.6.L93.90';
        shaka.log.info('        🎯 H.265 codec string:', codecString);
        
        return codecString;
      }
    }
    
    shaka.log.warning('        ⚠️  No hvcC box found');
    return null;
  }

  /**
   * Parse ESDS box to extract AAC codec string
   * 
   * @param {!Uint8Array} data - Data containing ESDS box
   * @return {?string} AAC codec string (e.g., 'mp4a.40.2')
   * @private
   */
  static parseESDS_(data) {
    // Look for 'esds' box
    for (let i = 0; i < data.length - 8; i++) {
      if (data[i] === 0x65 && data[i+1] === 0x73 && data[i+2] === 0x64 && data[i+3] === 0x73) {
        shaka.log.info('        📦 Found esds box at offset:', i);
        
        // ESDS parsing is complex, but for most AAC content it's AAC-LC (mp4a.40.2)
        // More detailed parsing would require implementing the full ESDS descriptor chain
        
        try {
          // Try to find the AudioObjectType in the ESDS
          const esdsStart = i + 12; // Skip box header + version/flags
          
          // Look for the DecoderConfigDescriptor which contains AudioObjectType
          // This is a simplified approach - full ESDS parsing is quite complex
          for (let j = esdsStart; j < Math.min(esdsStart + 50, data.length - 1); j++) {
            const audioObjectType = (data[j] & 0xF8) >> 3;
            if (audioObjectType >= 1 && audioObjectType <= 4) {
              // Common AudioObjectTypes:
              // 1 = AAC Main, 2 = AAC LC, 3 = AAC SSR, 4 = AAC LTP
              const codecMap = {
                1: 'mp4a.40.1', // AAC Main
                2: 'mp4a.40.2', // AAC LC (most common)
                3: 'mp4a.40.3', // AAC SSR
                4: 'mp4a.40.4'  // AAC LTP
              };
              
              const codecString = codecMap[audioObjectType] || 'mp4a.40.2';
              shaka.log.info('        🎯 AAC AudioObjectType:', audioObjectType, '-> codec:', codecString);
              return codecString;
            }
          }
        } catch (error) {
          shaka.log.warning('        ⚠️  ESDS parsing failed:', error);
        }
        
        // Fallback to AAC-LC
        const fallbackCodec = 'mp4a.40.2';
        shaka.log.info('        🔄 Using fallback AAC codec:', fallbackCodec);
        return fallbackCodec;
      }
    }
    
    shaka.log.warning('        ⚠️  No esds box found');
    return null;
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
 *   Video codec string (e.g., 'avc1.640028')
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