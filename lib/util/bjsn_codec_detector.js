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
 * @summary BJSN Codec Detection Utility - UPDATED VERSION
 *
 * Dynamically detects codec information from MP4 segments after BJSN box stripping
 * using existing Shaka Player MP4 parsing infrastructure for accurate MIME type generation.
 *
 * FEATURES:
 * - Proper track type association between HDLR and STSD boxes
 * - Accurate avcC and ESDS parsing for precise codec strings
 * - Support for both audio and video tracks in multiplexed content
 * - Uses shared Mp4BoxParsers.parseESDS() for consistent ESDS parsing
 * - Fallback mechanisms for robustness in non-standard scenarios
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
      // First check if this is an init segment (has moov box)
      const isInitSegment = shaka.util.BjsnCodecDetector.hasBox_(segmentData, 'moov');

      if (isInitSegment) {
        return shaka.util.BjsnCodecDetector.detectCodecsFromInitSegment_(segmentData);
      } else {
        // For media segments, we need to parse moof/traf structure
        return shaka.util.BjsnCodecDetector.detectCodecsFromMediaSegment_(segmentData);
      }
    } catch (error) {
      shaka.log.warning('BJSN codec detection failed:', error);

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
    const codecInfo = {
      video: null,
      audio: null,
      mimeType: null,
      isMultiplexed: false,
      detectionMethod: 'init-segment',
    };

    // Track all tracks and their STSD data
    const tracks = [];
    let currentTrack = null;

    const parser = new shaka.util.Mp4Parser()
        .box('moov', (box) => {
          shaka.util.Mp4Parser.children(box);
        })
        .box('trak', (box) => {
        // Start a new track
          currentTrack = {
            trackType: null,
            stsdData: null,
          };
          tracks.push(currentTrack);
          shaka.util.Mp4Parser.children(box);
        })
        .box('tkhd', (box) => {
        // Track header - no processing needed
        })
        .box('mdia', (box) => {
          shaka.util.Mp4Parser.children(box);
        })
        .box('mdhd', (box) => {
        // Media header - no processing needed
        })
        .fullBox('hdlr', (box) => {
          try {
          // Use the enhanced parseHDLR function
            const hdlr = shaka.util.Mp4BoxParsers.parseHDLR(box.reader);
            if (currentTrack && hdlr && hdlr.handlerType) {
              currentTrack.trackType = hdlr.handlerType;
            }
          } catch (error) {
            shaka.log.warning('HDLR parsing error:', error);
          }
        })
        .box('minf', (box) => {
          shaka.util.Mp4Parser.children(box);
        })
        .box('stbl', (box) => {
          shaka.util.Mp4Parser.children(box);
        })
        .fullBox('stsd', (box) => {
          if (currentTrack) {
          // Store the entire STSD box data for later parsing
            currentTrack.stsdData = {
              reader: box.reader,
              version: box.version,
              flags: box.flags,
            };
          }
        });

    try {
      parser.parse(segmentData);

      // Process all tracks that have both track type and STSD data
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];

        if (!track.trackType || !track.stsdData) {
          continue;
        }

        const codecData = shaka.util.BjsnCodecDetector.parseSTSD_(track.stsdData, track.trackType);

        if (codecData.video) {
          codecInfo.video = codecData.video;
        }

        if (codecData.audio) {
          codecInfo.audio = codecData.audio;
        }
      }

      // Determine if this is multiplexed content
      codecInfo.isMultiplexed = !!(codecInfo.video && codecInfo.audio);

      // If no codecs detected, use fallback
      if (!codecInfo.video && !codecInfo.audio) {
        return shaka.util.BjsnCodecDetector.getFallbackCodecInfo_();
      }

      // Generate MIME type
      codecInfo.mimeType = shaka.util.BjsnCodecDetector.generateMimeType_(codecInfo);

      return codecInfo;
    } catch (error) {
      shaka.log.warning('Init segment parsing failed:', error);
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
    const result = {video: null, audio: null};

    if (!trackType || !stsdData || !stsdData.reader) {
      return result;
    }

    const reader = stsdData.reader;
    // Reset reader position
    reader.seek(0);

    try {
      // STSD box structure:
      // 4 bytes: entry_count
      const entryCount = reader.readUint32();

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

        // Save position for content parsing
        const entryContentStart = reader.getPosition();
        const entryEnd = entryContentStart + entrySize - 8; // Subtract size and format fields

        // Ensure we don't read past the entry
        const availableBytes = reader.getLength() - reader.getPosition();
        const contentSize = Math.min(entrySize - 8, availableBytes);

        if (contentSize <= 0) {
          continue;
        }

        if (trackType === 'vide' && shaka.util.BjsnCodecDetector.isVideoFormat_(formatString)) {
          result.video = shaka.util.BjsnCodecDetector.parseVideoSampleEntry_(
              reader, formatString, entryContentStart, contentSize);
        } else if (trackType === 'soun' && shaka.util.BjsnCodecDetector.isAudioFormat_(formatString)) {
          result.audio = shaka.util.BjsnCodecDetector.parseAudioSampleEntry_(
              reader, formatString, entryContentStart, contentSize);
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
      shaka.log.warning('STSD parsing error:', error);
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
      reader.seek(contentStart);

      // Skip visual sample entry header
      reader.skip(8); // reserved(6) + data_reference_index(2)
      reader.skip(16); // pre_defined(2) + reserved(2) + pre_defined(12)
      const width = reader.readUint16();
      const height = reader.readUint16();
      reader.skip(50); // Rest of visual sample entry fields

      // Look for codec configuration boxes in remaining data
      const remainingStart = reader.getPosition();
      const remainingSize = contentStart + contentSize - remainingStart;

      if (remainingSize <= 0) {
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
      }

      return codecString;
    } catch (error) {
      shaka.log.warning('Video sample entry parsing failed:', error);
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

      // Look for codec configuration boxes in remaining data
      const remainingStart = reader.getPosition();
      const remainingSize = contentStart + contentSize - remainingStart;

      if (remainingSize <= 0) {
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
      }

      return codecString;
    } catch (error) {
      shaka.log.warning('Audio sample entry parsing failed:', error);
      return shaka.util.BjsnCodecDetector.getDefaultAudioCodec_(format);
    }
  }

  /**
   * Parse avcC box to extract H.264 codec string - ROBUST VERSION
   *
   * @param {!Uint8Array} data - Data containing avcC box
   * @return {?string} H.264 codec string (e.g., 'avc1.640028')
   * @private
   */
  static parseAvcC_(data) {
    // Method 1: Look for 'avcC' box with proper MP4 box structure
    // Box structure: size(4) + type(4) + payload
    for (let i = 0; i <= data.length - 12; i++) {
      // Check if this could be an avcC box
      if (i + 8 < data.length &&
          data[i + 4] === 0x61 && data[i + 5] === 0x76 &&
          data[i + 6] === 0x63 && data[i + 7] === 0x43) {
        const view = new DataView(data.buffer, data.byteOffset + i);
        const boxSize = view.getUint32(0);

        // Validate box size
        if (boxSize >= 12 && i + boxSize <= data.length) {
          const avcCContentStart = i + 8; // Skip size(4) + fourcc(4)

          if (avcCContentStart + 4 <= data.length) {
            const configurationVersion = data[avcCContentStart];
            const avcProfileIndication = data[avcCContentStart + 1];
            const profileCompatibility = data[avcCContentStart + 2];
            const avcLevelIndication = data[avcCContentStart + 3];

            // Construct codec string: avc1.ProfileCompatibilityLevel
            const codecString = 'avc1.' +
              avcProfileIndication.toString(16).padStart(2, '0').toUpperCase() +
              profileCompatibility.toString(16).padStart(2, '0').toUpperCase() +
              avcLevelIndication.toString(16).padStart(2, '0').toUpperCase();

            return codecString;
          }
        }
      }
    }

    // Method 2: Fallback - look for 'avcC' signature without strict box parsing
    // This handles cases where we might have partial data or different structure
    for (let i = 0; i < data.length - 8; i++) {
      if (data[i] === 0x61 && data[i+1] === 0x76 && data[i+2] === 0x63 && data[i+3] === 0x43) {
        // Try different content start positions
        const possibleStarts = [i + 4, i + 8]; // After fourcc, or after size+fourcc

        for (const contentStart of possibleStarts) {
          if (contentStart + 4 <= data.length) {
            const configurationVersion = data[contentStart];
            const avcProfileIndication = data[contentStart + 1];
            const profileCompatibility = data[contentStart + 2];
            const avcLevelIndication = data[contentStart + 3];

            // Validate that this looks like valid avcC data
            if (configurationVersion === 1 && avcProfileIndication > 0 && avcLevelIndication > 0) {
              const codecString = 'avc1.' +
                avcProfileIndication.toString(16).padStart(2, '0').toUpperCase() +
                profileCompatibility.toString(16).padStart(2, '0').toUpperCase() +
                avcLevelIndication.toString(16).padStart(2, '0').toUpperCase();

              return codecString;
            }
          }
        }
      }
    }

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
        // For now, return a standard H.265 codec string
        // Full hvcC parsing is complex and would require more detailed implementation
        const codecString = 'hvc1.1.6.L93.90';
        return codecString;
      }
    }

    return null;
  }

  /**
   * Parse ESDS box to extract AAC codec string - USING SHARED PARSER
   *
   * @param {!Uint8Array} data - Data containing ESDS box
   * @return {?string} AAC codec string (e.g., 'mp4a.40.2')
   * @private
   */
  static parseESDS_(data) {
    // Method 1: Look for 'esds' box with proper MP4 box structure
    for (let i = 0; i <= data.length - 12; i++) {
      // Check if this could be an esds box
      if (i + 8 < data.length &&
          data[i + 4] === 0x65 && data[i + 5] === 0x73 &&
          data[i + 6] === 0x64 && data[i + 7] === 0x73) {
        const view = new DataView(data.buffer, data.byteOffset + i);
        const boxSize = view.getUint32(0);

        // Validate box size
        if (boxSize >= 12 && i + boxSize <= data.length) {
          return shaka.util.BjsnCodecDetector.parseESDSWithSharedParser_(data, i + 8, boxSize - 8);
        }
      }
    }

    // Method 2: Fallback - look for 'esds' signature
    for (let i = 0; i < data.length - 8; i++) {
      if (data[i] === 0x65 && data[i+1] === 0x73 && data[i+2] === 0x64 && data[i+3] === 0x73) {
        return shaka.util.BjsnCodecDetector.parseESDSWithSharedParser_(data, i + 4, Math.min(50, data.length - i - 4));
      }
    }

    return null;
  }

  /**
   * Parse ESDS content using the shared Mp4BoxParsers.parseESDS() function
   *
   * @param {!Uint8Array} data - Full data buffer
   * @param {number} contentStart - Start of ESDS content
   * @param {number} contentSize - Size of ESDS content
   * @return {?string} AAC codec string
   * @private
   */
  static parseESDSWithSharedParser_(data, contentStart, contentSize) {
    try {
      // Create a DataViewReader for the ESDS content
      const esdsData = data.subarray(contentStart, contentStart + contentSize);
      const reader = new shaka.util.DataViewReader(esdsData, shaka.util.DataViewReader.Endianness.BIG_ENDIAN);

      // Skip version/flags (4 bytes) if present
      if (reader.hasMoreData() && contentSize > 4) {
        reader.skip(4);
      }

      // Use the shared parseESDS function
      const result = shaka.util.Mp4BoxParsers.parseESDS(reader);

      if (result && result.codec) {
        return result.codec;
      } else {
        return 'mp4a.40.2'; // Fallback to AAC-LC
      }
    } catch (error) {
      // Fallback to simple pattern matching approach
      return shaka.util.BjsnCodecDetector.parseESDSFallback_(data, contentStart, contentSize);
    }
  }

  /**
   * Fallback ESDS parsing using simple pattern matching
   *
   * @param {!Uint8Array} data - Full data buffer
   * @param {number} contentStart - Start of ESDS content
   * @param {number} contentSize - Size of ESDS content
   * @return {string} AAC codec string
   * @private
   */
  static parseESDSFallback_(data, contentStart, contentSize) {
    try {
      // Skip version/flags (4 bytes) and look for AudioObjectType
      const searchStart = contentStart + 4;
      const searchEnd = Math.min(searchStart + contentSize, data.length);

      // Look for the DecoderConfigDescriptor which contains AudioObjectType
      for (let j = searchStart; j < searchEnd - 1; j++) {
        const audioObjectType = (data[j] & 0xF8) >> 3;
        if (audioObjectType >= 1 && audioObjectType <= 4) {
          // Common AudioObjectTypes:
          // 1 = AAC Main, 2 = AAC LC, 3 = AAC SSR, 4 = AAC LTP
          const codecMap = {
            1: 'mp4a.40.1', // AAC Main
            2: 'mp4a.40.2', // AAC LC (most common)
            3: 'mp4a.40.3', // AAC SSR
            4: 'mp4a.40.4',  // AAC LTP
          };

          const codecString = codecMap[audioObjectType] || 'mp4a.40.2';
          return codecString;
        }
      }

      // If we can't find specific AudioObjectType, return AAC-LC as fallback
      return 'mp4a.40.2';
    } catch (error) {
      return 'mp4a.40.2'; // Ultimate fallback to AAC-LC
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
    // For media segments, we can only do basic detection
    // In a proper implementation, this would require the init segment
    // For now, return reasonable defaults based on typical BJSN content

    const codecInfo = {
      video: 'avc1.42E01E',  // H.264 Baseline Profile Level 3.0
      audio: 'mp4a.40.2',   // AAC-LC
      mimeType: null,
      isMultiplexed: true,  // Assume multiplexed for BJSN
      detectionMethod: 'media-segment-fallback',
    };

    codecInfo.mimeType = shaka.util.BjsnCodecDetector.generateMimeType_(codecInfo);

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
        return isSupported;
      }

      // Fallback: assume supported if MediaSource API not available
      return true;
    } catch (error) {
      shaka.log.warning('Codec support validation failed:', error);
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
   * @private
   */
  static getFallbackCodecInfo_() {
    const codecInfo = {
      video: 'avc1.42E01E',  // H.264 Baseline Profile Level 3.0
      audio: 'mp4a.40.2',   // AAC-LC
      mimeType: null,
      isMultiplexed: true,
      detectionMethod: 'fallback',
    };

    codecInfo.mimeType = shaka.util.BjsnCodecDetector.generateMimeType_(codecInfo);

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
      isValid: shaka.util.BjsnCodecDetector.validateCodecSupport(codecInfo.mimeType),
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
