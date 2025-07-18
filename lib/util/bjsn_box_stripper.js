/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.util.BjsnBoxStripper');

goog.require('goog.asserts');
goog.require('shaka.log');
goog.require('shaka.util.Mp4Parser');
goog.require('shaka.util.DataViewReader');
goog.require('shaka.util.BufferUtils');
goog.require('shaka.util.BjsnParser');
goog.require('shaka.util.StringUtils');

/**
 * @summary BJSN Box Stripper Utility
 * Removes BJSN boxes from MP4 segments while preserving valid MP4 structure
 * @export
 */
shaka.util.BjsnBoxStripper = class {
  /**
   * Strip BJSN box from MP4 segment data
   * @param {!Uint8Array} segmentData - MP4 segment data containing BJSN box
   * @return {!Uint8Array} Clean MP4 segment data without BJSN box
   * @export
   */
  static stripBjsnBox(segmentData) {
    try {
      shaka.log.info('🔧 BJSN STRIPPER: Starting to strip BJSN box');
      shaka.log.info('  📏 Input segment size:', segmentData.length, 'bytes');

      // First, check if this segment actually contains a BJSN box
      if (!shaka.util.BjsnBoxStripper.hasBjsnBox_(segmentData)) {
        shaka.log.info('  ✅ No BJSN box found, returning original data');
        return segmentData;
      }

      const bjsnBoxInfo = shaka.util.BjsnBoxStripper.findBjsnBox_(segmentData);
      if (!bjsnBoxInfo) {
        shaka.log.warning('  ⚠️ BJSN box detection failed, returning original data');
        return segmentData;
      }

      shaka.log.info('  🔍 BJSN box found:', bjsnBoxInfo);

      // Create new segment without BJSN box
      const strippedData = shaka.util.BjsnBoxStripper.removeBox_(
          segmentData, bjsnBoxInfo);

      shaka.log.info('  ✅ BJSN box stripped successfully');
      shaka.log.info('  📏 Output segment size:', strippedData.length, 'bytes');
      shaka.log.info('  📊 Size reduction:',
          segmentData.length - strippedData.length, 'bytes');

      // Validate the stripped segment
      if (!shaka.util.BjsnBoxStripper.validateMp4Structure_(strippedData)) {
        shaka.log.warning('  ⚠️ Stripped segment validation failed, returning original data');
        return segmentData;
      }

      return strippedData;
    } catch (error) {
      shaka.log.error('  ❌ BJSN stripping failed:', error);
      shaka.log.info('  🔄 Falling back to original data');
      return segmentData;
    }
  }

  /**
   * Check if segment contains a BJSN box
   * @param {!Uint8Array} segmentData - MP4 segment data
   * @return {boolean} True if BJSN box is present
   * @private
   */
  static hasBjsnBox_(segmentData) {
    let hasBjsn = false;

    const parser = new shaka.util.Mp4Parser()
        .box('bjsn', () => {
          hasBjsn = true;
        });

    try {
      parser.parse(segmentData, /* partialOkay= */ true, /* stopOnPartial= */ true);
    } catch (error) {
      shaka.log.v2('Error checking for BJSN box:', error);
    }

    return hasBjsn;
  }

  /**
   * Find BJSN box location and size in segment
   * @param {!Uint8Array} segmentData - MP4 segment data
   * @return {?{start: number, size: number, headerSize: number}} BJSN box info
   * @private
   */
  static findBjsnBox_(segmentData) {
    let bjsnBoxInfo = null;

    const parser = new shaka.util.Mp4Parser()
        .box('bjsn', (box) => {
          bjsnBoxInfo = {
            start: box.start,
            size: box.size,
            headerSize: shaka.util.Mp4Parser.headerSize(box),
          };
        });

    try {
      parser.parse(segmentData, /* partialOkay= */ true, /* stopOnPartial= */ true);
    } catch (error) {
      shaka.log.v2('Error finding BJSN box:', error);
    }

    return bjsnBoxInfo;
  }

  /**
   * Remove a box from MP4 segment data
   * @param {!Uint8Array} segmentData - Original segment data
   * @param {{start: number, size: number, headerSize: number}} boxInfo - Box to remove
   * @return {!Uint8Array} Segment data without the specified box
   * @private
   */
  static removeBox_(segmentData, boxInfo) {
    const beforeBox = segmentData.slice(0, boxInfo.start);
    const afterBox = segmentData.slice(boxInfo.start + boxInfo.size);

    // Combine the parts before and after the BJSN box
    const strippedData = new Uint8Array(beforeBox.length + afterBox.length);
    strippedData.set(beforeBox, 0);
    strippedData.set(afterBox, beforeBox.length);

    return strippedData;
  }

  /**
   * Strip BJSN, MOOV, and FTYP boxes from MP4 segment data
   * @param {!Uint8Array} segmentData - Original segment data
   * @return {!Uint8Array} Clean MP4 data without BJSN, MOOV, and FTYP boxes
   */
  static stripBjsnAndMoovBoxes(segmentData) {
    try {
      const dataView = new DataView(segmentData.buffer);
      let offset = 0;
      const result = [];

      while (offset < segmentData.length) {
        if (offset + 8 > segmentData.length) {
          // Not enough data for a complete box header
          result.push(segmentData.slice(offset));
          break;
        }

        const boxSize = dataView.getUint32(offset);
        const boxType = this.getBoxType_(segmentData, offset + 4);

        if (boxType === 'bjsn' || boxType === 'moov' || boxType === 'ftyp') {
          // Skip BJSN, MOOV, and FTYP boxes entirely
          shaka.log.v2('🔧 BJSN BOX STRIPPER: Skipping', boxType, 'box at offset', offset);
          offset += boxSize;
          continue;
        }

        // Copy non-BJSN/MOOV box
        const boxEnd = offset + boxSize;
        if (boxEnd <= segmentData.length) {
          result.push(segmentData.slice(offset, boxEnd));
          offset = boxEnd;
        } else {
          // Incomplete box at end
          result.push(segmentData.slice(offset));
          break;
        }
      }

      // Concatenate all remaining boxes
      const totalLength = result.reduce((sum, chunk) => sum + chunk.length, 0);
      const cleanData = new Uint8Array(totalLength);
      let position = 0;

      for (const chunk of result) {
        cleanData.set(chunk, position);
        position += chunk.length;
      }

      return cleanData;
    } catch (error) {
      shaka.log.warning('🔧 BJSN BOX STRIPPER: Failed to strip BJSN and MOOV boxes:', error);
      return segmentData; // Return original data if stripping fails
    }
  }

  /**
   * Validate that the stripped data is still a valid MP4 structure
   * @param {!Uint8Array} segmentData - Stripped segment data
   * @return {boolean} True if valid MP4 structure
   * @private
   */
  static validateMp4Structure_(segmentData) {
    if (segmentData.length < 8) {
      shaka.log.v2('Segment too small to be valid MP4');
      return false;
    }

    try {
      let hasValidBoxes = false;

      const parser = new shaka.util.Mp4Parser()
          .box('ftyp', () => { hasValidBoxes = true; })
          .box('moov', () => { hasValidBoxes = true; })
          .box('moof', () => { hasValidBoxes = true; })
          .box('mdat', () => { hasValidBoxes = true; });

      parser.parse(segmentData, /* partialOkay= */ true, /* stopOnPartial= */ true);

      return hasValidBoxes;
    } catch (error) {
      shaka.log.v2('MP4 validation error:', error);
      return false;
    }
  }

  /**
   * Get detailed info about BJSN box for debugging
   * @param {!Uint8Array} segmentData - MP4 segment data
   * @return {?Object} Detailed BJSN box information
   * @export
   */
  static getBjsnBoxInfo(segmentData) {
    let bjsnInfo = null;

    const parser = new shaka.util.Mp4Parser()
        .box('bjsn', (box) => {
          const payloadSize = box.reader.getLength();
          const payload = box.reader.readBytes(payloadSize);

          try {
            const jsonString = shaka.util.StringUtils.fromUTF8(payload);
            const jsonData = JSON.parse(jsonString);

            bjsnInfo = {
              start: box.start,
              size: box.size,
              headerSize: shaka.util.Mp4Parser.headerSize(box),
              payloadSize: payloadSize,
              jsonData: jsonData,
            };
          } catch (e) {
            bjsnInfo = {
              start: box.start,
              size: box.size,
              headerSize: shaka.util.Mp4Parser.headerSize(box),
              payloadSize: payloadSize,
              error: e.message,
            };
          }
        });

    try {
      parser.parse(segmentData, /* partialOkay= */ true, /* stopOnPartial= */ true);
    } catch (error) {
      shaka.log.v2('Error getting BJSN box info:', error);
    }

    return bjsnInfo;
  }

  /**
   * Create a stripped segment while preserving original for metadata extraction
   * @param {!Uint8Array} segmentData - Original segment data
   * @return {{original: !Uint8Array, stripped: !Uint8Array, bjsnData: ?Object}}
   *         Both original and stripped data plus extracted BJSN metadata
   * @export
   */
  static processSegment(segmentData) {
    // Extract BJSN metadata from original segment
    const bjsnData = shaka.util.BjsnParser.parseFromSegment(segmentData);

    // Create stripped version for MSE
    const strippedData = shaka.util.BjsnBoxStripper.stripBjsnBox(segmentData);

    return {
      original: segmentData,
      stripped: strippedData,
      bjsnData: bjsnData,
    };
  }

  /**
   * Check if segment data needs BJSN stripping
   * @param {!Uint8Array} segmentData - MP4 segment data
   * @return {boolean} True if segment contains BJSN box
   * @export
   */
  static needsStripping(segmentData) {
    return shaka.util.BjsnBoxStripper.hasBjsnBox_(segmentData);
  }

  /**
   * Extract box type from MP4 box header
   * @param {!Uint8Array} segmentData - MP4 segment data
   * @param {number} offset - Offset to the box type (4 bytes after box size)
   * @return {string} Box type as string
   * @private
   */
  static getBoxType_(segmentData, offset) {
    if (offset + 4 > segmentData.length) {
      return '';
    }

    return String.fromCharCode(
        segmentData[offset],
        segmentData[offset + 1],
        segmentData[offset + 2],
        segmentData[offset + 3],
    );
  }
};
