/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.util.BjsnParser');

goog.require('goog.asserts');
goog.require('shaka.log');
goog.require('shaka.util.Mp4Parser');
goog.require('shaka.util.StringUtils');
goog.require('shaka.util.Error');

/**
 * @summary BJSN Box Parser Utility
 * Handles stream-based parsing of BJSN metadata from CMAF segments
 * @export
 */
shaka.util.BjsnParser = class {
  /**
   * Parse BJSN box from MP4 segment data
   * @param {!Uint8Array} data - MP4 segment data (partial or complete)
   * @return {?Object} Parsed BJSN metadata or null if insufficient data
   * @export
   */
  static parseFromSegment(data) {
    try {
      // Extract BJSN box data from MP4 structure
      const bjsnBoxData = shaka.util.BjsnParser.extractBjsnBox_(data);

      if (!bjsnBoxData) {
        shaka.log.v2('BJSN box not found in segment data');
        return null;
      }

      // Convert bytes to UTF-8 string
      const jsonString = shaka.util.StringUtils.fromUTF8(bjsnBoxData);

      // Parse JSON
      const bjsnData = JSON.parse(jsonString);

      // Validate schema
      if (!shaka.util.BjsnParser.validateSchema(bjsnData)) {
        shaka.log.warning('Invalid BJSN schema detected');
        return null;
      }

      shaka.log.v2('Successfully parsed BJSN metadata:', bjsnData);
      return bjsnData;
    } catch (error) {
      shaka.log.warning('Failed to parse BJSN data:', error);
      return null;
    }
  }

  /**
   * Validate BJSN JSON schema
   * @param {!Object} bjsnData - Parsed JSON object
   * @return {boolean} Whether the schema is valid
   * @export
   */
  static validateSchema(bjsnData) {
    // Check required fields
    const requiredFields = ['type', 'gear_num', 'seq_num', 'template_path',
      'gear_list'];

    for (const field of requiredFields) {
      if (!(field in bjsnData)) {
        shaka.log.warning('Missing required BJSN field:', field);
        return false;
      }
    }

    // Validate specific field types
    if (typeof bjsnData.type !== 'string' ||
        (bjsnData.type !== 'dynamic' && bjsnData.type !== 'static')) {
      shaka.log.warning('Invalid BJSN type field:', bjsnData.type);
      return false;
    }

    if (typeof bjsnData.gear_num !== 'number' || bjsnData.gear_num < 1) {
      shaka.log.warning('Invalid BJSN gear_num field:', bjsnData.gear_num);
      return false;
    }

    if (typeof bjsnData.seq_num !== 'number' || bjsnData.seq_num < 0) {
      shaka.log.warning('Invalid BJSN seq_num field:', bjsnData.seq_num);
      return false;
    }

    if (typeof bjsnData.template_path !== 'string' ||
        // eslint-disable-next-line no-template-curly-in-string
        bjsnData.template_path.indexOf('${num}') === -1) {
      shaka.log.warning('Invalid BJSN template_path field:',
          bjsnData.template_path);
      return false;
    }

    if (!Array.isArray(bjsnData.gear_list) || bjsnData.gear_list.length === 0) {
      shaka.log.warning('Invalid BJSN gear_list field:', bjsnData.gear_list);
      return false;
    }

    // Validate gear_list entries
    for (const gear of bjsnData.gear_list) {
      if (typeof gear !== 'object' || gear === null) {
        shaka.log.warning('Invalid gear entry in gear_list:', gear);
        return false;
      }

      // Each gear should have exactly one key (gear name) with an object value
      const gearKeys = Object.keys(gear);
      if (gearKeys.length !== 1) {
        shaka.log.warning('Gear entry should have exactly one key:', gear);
        return false;
      }

      const gearData = gear[gearKeys[0]];
      if (typeof gearData !== 'object' || gearData === null) {
        shaka.log.warning('Invalid gear data:', gearData);
        return false;
      }

      // Validate realtime_bitrate if present
      if ('realtime_bitrate' in gearData &&
          typeof gearData.realtime_bitrate !== 'number') {
        shaka.log.warning('Invalid realtime_bitrate in gear:', gearData);
        return false;
      }
    }

    return true;
  }

  /**
   * Extract BJSN box raw data from MP4 structure
   * @param {!Uint8Array} mp4Data - MP4 data
   * @return {?Uint8Array} BJSN box payload or null if not found
   * @private
   */
  static extractBjsnBox_(mp4Data) {
    let bjsnData = null;

    const parser = new shaka.util.Mp4Parser()
        .box('bjsn', (box) => {
          // Extract all remaining data from the BJSN box
          const remainingBytes = box.reader.getLength() -
              box.reader.getPosition();
          bjsnData = box.reader.readBytes(remainingBytes);
          box.parser.stop(); // Stop parsing once we find the BJSN box
        });

    try {
      // Use partialOkay=true to handle streaming scenarios
      // Use stopOnPartial=true to avoid reading incomplete boxes
      parser.parse(mp4Data, /* partialOkay= */ true, /* stopOnPartial= */ true);
    } catch (error) {
      shaka.log.v2('MP4 parsing failed during BJSN extraction:', error);
      return null;
    }

    return bjsnData;
  }

  /**
   * Generate next segment URL using template_path and sequence number
   * @param {string} templatePath - Template path from BJSN data
   * @param {number} seqNum - Current sequence number
   * @return {string} Next segment URL
   * @export
   */
  static generateNextSegmentUrl(templatePath, seqNum) {
    // Next segment is current sequence number + 1
    const nextSeqNum = seqNum + 1;
    // eslint-disable-next-line no-template-curly-in-string
    return templatePath.replace('${num}', nextSeqNum.toString());
  }

  /**
   * Extract gear names from gear_list
   * @param {!Array<!Object>} gearList - Array of gear objects
   * @return {!Array<string>} Array of gear names
   * @export
   */
  static extractGearNames(gearList) {
    const gearNames = [];

    for (const gear of gearList) {
      const gearKeys = Object.keys(gear);
      if (gearKeys.length === 1) {
        gearNames.push(gearKeys[0]);
      }
    }
    return gearNames;
  }

  /**
   * Get gear data by name
   * @param {!Array<!Object>} gearList - Array of gear objects
   * @param {string} gearName - Name of the gear to find
   * @return {?Object} Gear data or null if not found
   * @export
   */
  static getGearData(gearList, gearName) {
    for (const gear of gearList) {
      if (gearName in gear) {
        return gear[gearName];
      }
    }
    return null;
  }
};
