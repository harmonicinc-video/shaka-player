/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

describe('BjsnParser', () => {
  let validBjsnData;
  let validBjsnJson;
  let bjsnBoxWithValidData;
  let mp4WithBjsnBox;
  let mp4WithoutBjsnBox;
  let partialMp4Data;
  let invalidJsonBjsnBox;

  beforeAll(() => {
    // Valid BJSN JSON data for testing
    validBjsnJson = {
      "type": "dynamic",
      "gear_num": 3,
      "seq_num": 10,
      "template_path": "123-media-first-${num}.mp4",
      "gear_list": [
        {
          "uhd5": {
            "realtime_bitrate": 1000000,
            "drm": { "key": "value" }
          }
        },
        {
          "hd5": {
            "realtime_bitrate": 800000,
            "drm": { "key": "value" }
          }
        },
        {
          "ld5": {
            "realtime_bitrate": 300000,
            "drm": { "key": "value" }
          }
        }
      ]
    };

    // Convert JSON to UTF-8 bytes
    const jsonString = JSON.stringify(validBjsnJson);
    validBjsnData = shaka.util.StringUtils.toUTF8(jsonString);

    // Create BJSN box with valid JSON data
    bjsnBoxWithValidData = new Uint8Array(8 + validBjsnData.length);
    bjsnBoxWithValidData.set([
      0x00, 0x00, 0x00, 0x08 + validBjsnData.length, // size (header + payload)
      0x62, 0x6A, 0x73, 0x6E // 'bjsn' type
    ], 0);
    bjsnBoxWithValidData.set(validBjsnData, 8);

    // Create complete MP4 with ftyp and BJSN box
    mp4WithBjsnBox = new Uint8Array(24 + bjsnBoxWithValidData.length);
    mp4WithBjsnBox.set([
      // ftyp box
      0x00, 0x00, 0x00, 0x18, // size
      0x66, 0x74, 0x79, 0x70, // 'ftyp'
      0x69, 0x73, 0x6F, 0x6D, // major brand 'isom'
      0x00, 0x00, 0x00, 0x00, // minor version
      0x69, 0x73, 0x6F, 0x6D, // compatible brand 'isom'
      0x6D, 0x70, 0x34, 0x31 // compatible brand 'mp41'
    ], 0);
    mp4WithBjsnBox.set(bjsnBoxWithValidData, 24);

    // Create MP4 without BJSN box
    mp4WithoutBjsnBox = new Uint8Array([
      // ftyp box only
      0x00, 0x00, 0x00, 0x18, // size
      0x66, 0x74, 0x79, 0x70, // 'ftyp'
      0x69, 0x73, 0x6F, 0x6D, // major brand 'isom'
      0x00, 0x00, 0x00, 0x00, // minor version
      0x69, 0x73, 0x6F, 0x6D, // compatible brand 'isom'
      0x6D, 0x70, 0x34, 0x31, // compatible brand 'mp41'
      // mdat box
      0x00, 0x00, 0x00, 0x10, // size
      0x6D, 0x64, 0x61, 0x74, // 'mdat'
      0x00, 0x11, 0x22, 0x33, // some data
      0x44, 0x55, 0x66, 0x77
    ]);

    // Create partial MP4 data (incomplete BJSN box)
    partialMp4Data = new Uint8Array([
      // ftyp box
      0x00, 0x00, 0x00, 0x18, // size
      0x66, 0x74, 0x79, 0x70, // 'ftyp'
      0x69, 0x73, 0x6F, 0x6D, // major brand 'isom'
      0x00, 0x00, 0x00, 0x00, // minor version
      0x69, 0x73, 0x6F, 0x6D, // compatible brand 'isom'
      0x6D, 0x70, 0x34, 0x31, // compatible brand 'mp41'
      // Incomplete BJSN box (header only)
      0x00, 0x00, 0x00, 0x50, // size (larger than actual data)
      0x62, 0x6A, 0x73, 0x6E  // 'bjsn' type (no payload)
    ]);

    // Create BJSN box with invalid JSON
    const invalidJson = '{"invalid": json}';
    const invalidJsonData = shaka.util.StringUtils.toUTF8(invalidJson);
    invalidJsonBjsnBox = new Uint8Array(8 + invalidJsonData.length);
    invalidJsonBjsnBox.set([
      0x00, 0x00, 0x00, 0x08 + invalidJsonData.length, // size
      0x62, 0x6A, 0x73, 0x6E // 'bjsn' type
    ], 0);
    invalidJsonBjsnBox.set(invalidJsonData, 8);
  });

  describe('parseFromSegment', () => {
    it('should parse valid BJSN box from segment', () => {
      const result = shaka.util.BjsnParser.parseFromSegment(mp4WithBjsnBox);
      
      expect(result).not.toBeNull();
      expect(result.type).toBe('dynamic');
      expect(result.gear_num).toBe(3);
      expect(result.seq_num).toBe(10);
      expect(result.template_path).toBe('123-media-first-${num}.mp4');
      expect(result.gear_list).toEqual(validBjsnJson.gear_list);
    });

    it('should return null when BJSN box is not found', () => {
      const result = shaka.util.BjsnParser.parseFromSegment(mp4WithoutBjsnBox);
      expect(result).toBeNull();
    });

    it('should return null for partial/incomplete data', () => {
      const result = shaka.util.BjsnParser.parseFromSegment(partialMp4Data);
      expect(result).toBeNull();
    });

    it('should return null for invalid JSON in BJSN box', () => {
      const mp4WithInvalidJson = new Uint8Array(24 + invalidJsonBjsnBox.length);
      mp4WithInvalidJson.set([
        // ftyp box
        0x00, 0x00, 0x00, 0x18, // size
        0x66, 0x74, 0x79, 0x70, // 'ftyp'
        0x69, 0x73, 0x6F, 0x6D, // major brand 'isom'
        0x00, 0x00, 0x00, 0x00, // minor version
        0x69, 0x73, 0x6F, 0x6D, // compatible brand 'isom'
        0x6D, 0x70, 0x34, 0x31 // compatible brand 'mp41'
      ], 0);
      mp4WithInvalidJson.set(invalidJsonBjsnBox, 24);

      const result = shaka.util.BjsnParser.parseFromSegment(mp4WithInvalidJson);
      expect(result).toBeNull();
    });

    it('should handle empty input gracefully', () => {
      const result = shaka.util.BjsnParser.parseFromSegment(new Uint8Array(0));
      expect(result).toBeNull();
    });
  });

  describe('validateSchema', () => {
    it('should validate complete valid BJSN schema', () => {
      const result = shaka.util.BjsnParser.validateSchema(validBjsnJson);
      expect(result).toBe(true);
    });

    it('should reject missing required fields', () => {
      const testCases = [
        Object.assign({}, validBjsnJson, { type: undefined }),
        Object.assign({}, validBjsnJson, { gear_num: undefined }),
        Object.assign({}, validBjsnJson, { seq_num: undefined }),
        Object.assign({}, validBjsnJson, { template_path: undefined }),
        Object.assign({}, validBjsnJson, { gear_list: undefined })
      ];

      testCases.forEach((testCase, index) => {
        delete testCase[Object.keys(testCase).find(key => testCase[key] === undefined)];
        const result = shaka.util.BjsnParser.validateSchema(testCase);
        expect(result).toBe(false, `Test case ${index} should be invalid`);
      });
    });

    it('should reject invalid type field', () => {
      const invalidTypes = ['invalid', 'live', '', null, 123];
      
      invalidTypes.forEach((invalidType) => {
        const testData = Object.assign({}, validBjsnJson, { type: invalidType });
        const result = shaka.util.BjsnParser.validateSchema(testData);
        expect(result).toBe(false, `Type "${invalidType}" should be invalid`);
      });
    });

    it('should accept valid type fields', () => {
      const validTypes = ['dynamic', 'static'];
      
      validTypes.forEach((validType) => {
        const testData = Object.assign({}, validBjsnJson, { type: validType });
        const result = shaka.util.BjsnParser.validateSchema(testData);
        expect(result).toBe(true, `Type "${validType}" should be valid`);
      });
    });

    it('should reject invalid gear_num field', () => {
      const invalidGearNums = [0, -1, 'string', null, undefined];
      
      invalidGearNums.forEach((invalidGearNum) => {
        const testData = Object.assign({}, validBjsnJson, { gear_num: invalidGearNum });
        const result = shaka.util.BjsnParser.validateSchema(testData);
        expect(result).toBe(false, `gear_num "${invalidGearNum}" should be invalid`);
      });
    });

    it('should reject invalid seq_num field', () => {
      const invalidSeqNums = [-1, 'string', null, undefined];
      
      invalidSeqNums.forEach((invalidSeqNum) => {
        const testData = Object.assign({}, validBjsnJson, { seq_num: invalidSeqNum });
        const result = shaka.util.BjsnParser.validateSchema(testData);
        expect(result).toBe(false, `seq_num "${invalidSeqNum}" should be invalid`);
      });
    });

    it('should reject invalid template_path field', () => {
      const invalidTemplatePaths = [
        'no-placeholder.mp4',
        '',
        null,
        undefined,
        123,
        'path-with-wrong-placeholder-${wrong}.mp4'
      ];
      
      invalidTemplatePaths.forEach((invalidPath) => {
        const testData = Object.assign({}, validBjsnJson, { template_path: invalidPath });
        const result = shaka.util.BjsnParser.validateSchema(testData);
        expect(result).toBe(false, `template_path "${invalidPath}" should be invalid`);
      });
    });

    it('should reject invalid gear_list field', () => {
      const invalidGearLists = [
        [],
        null,
        undefined,
        'string',
        [null],
        [{}], // empty gear object
        [{ gear1: null }], // null gear data
        [{ gear1: 'string' }], // non-object gear data
        [{ gear1: {}, gear2: {} }] // multiple keys in single gear
      ];
      
      invalidGearLists.forEach((invalidGearList) => {
        const testData = Object.assign({}, validBjsnJson, { gear_list: invalidGearList });
        const result = shaka.util.BjsnParser.validateSchema(testData);
        expect(result).toBe(false, `gear_list should be invalid`);
      });
    });

    it('should reject invalid realtime_bitrate in gear data', () => {
      const invalidBitrates = ['string', null, undefined, -1];
      
      invalidBitrates.forEach((invalidBitrate) => {
        const testData = Object.assign({}, validBjsnJson, {
          gear_list: [{
            test_gear: {
              realtime_bitrate: invalidBitrate
            }
          }]
        });
        const result = shaka.util.BjsnParser.validateSchema(testData);
        expect(result).toBe(false, `realtime_bitrate "${invalidBitrate}" should be invalid`);
      });
    });
  });

  describe('generateNextSegmentUrl', () => {
    it('should generate correct next segment URL', () => {
      const templatePath = '123-media-first-${num}.mp4';
      const seqNum = 10;
      const expected = '123-media-first-11.mp4';
      
      const result = shaka.util.BjsnParser.generateNextSegmentUrl(templatePath, seqNum);
      expect(result).toBe(expected);
    });

    it('should handle different sequence numbers', () => {
      const templatePath = 'segment-${num}.mp4';
      
      const testCases = [
        { seqNum: 0, expected: 'segment-1.mp4' },
        { seqNum: 99, expected: 'segment-100.mp4' },
        { seqNum: 999, expected: 'segment-1000.mp4' }
      ];
      
      testCases.forEach(({ seqNum, expected }) => {
        const result = shaka.util.BjsnParser.generateNextSegmentUrl(templatePath, seqNum);
        expect(result).toBe(expected);
      });
    });

    it('should handle different template formats', () => {
      const testCases = [
        { template: 'media_${num}.mp4', seqNum: 5, expected: 'media_6.mp4' },
        { template: '${num}-segment.mp4', seqNum: 10, expected: '11-segment.mp4' },
        { template: 'stream/part-${num}.m4s', seqNum: 20, expected: 'stream/part-21.m4s' }
      ];
      
      testCases.forEach(({ template, seqNum, expected }) => {
        const result = shaka.util.BjsnParser.generateNextSegmentUrl(template, seqNum);
        expect(result).toBe(expected);
      });
    });
  });

  describe('extractGearNames', () => {
    it('should extract gear names correctly', () => {
      const result = shaka.util.BjsnParser.extractGearNames(validBjsnJson.gear_list);
      expect(result).toEqual(['uhd5', 'hd5', 'ld5']);
    });

    it('should handle empty gear list', () => {
      const result = shaka.util.BjsnParser.extractGearNames([]);
      expect(result).toEqual([]);
    });

    it('should handle malformed gear entries', () => {
      const malformedGearList = [
        { gear1: { bitrate: 1000 } }, // valid
        {}, // invalid - no keys
        { gear2: { bitrate: 800 }, gear3: { bitrate: 600 } }, // invalid - multiple keys
        { gear4: { bitrate: 400 } } // valid
      ];
      
      const result = shaka.util.BjsnParser.extractGearNames(malformedGearList);
      expect(result).toEqual(['gear1', 'gear4']);
    });
  });

  describe('getGearData', () => {
    it('should retrieve gear data by name', () => {
      const result = shaka.util.BjsnParser.getGearData(validBjsnJson.gear_list, 'hd5');
      expect(result).toEqual({
        realtime_bitrate: 800000,
        drm: { key: 'value' }
      });
    });

    it('should return null for non-existent gear', () => {
      const result = shaka.util.BjsnParser.getGearData(validBjsnJson.gear_list, 'nonexistent');
      expect(result).toBeNull();
    });

    it('should handle empty gear list', () => {
      const result = shaka.util.BjsnParser.getGearData([], 'any_gear');
      expect(result).toBeNull();
    });

    it('should handle exact gear name matches only', () => {
      const gearList = [
        { hd5: { bitrate: 800 } },
        { hd50: { bitrate: 1000 } }
      ];
      
      const result1 = shaka.util.BjsnParser.getGearData(gearList, 'hd5');
      const result2 = shaka.util.BjsnParser.getGearData(gearList, 'hd50');
      const result3 = shaka.util.BjsnParser.getGearData(gearList, 'hd');
      
      expect(result1).toEqual({ bitrate: 800 });
      expect(result2).toEqual({ bitrate: 1000 });
      expect(result3).toBeNull();
    });
  });

  describe('edge cases and error handling', () => {
    it('should handle BJSN box with empty JSON', () => {
      const emptyJson = '{}';
      const emptyJsonData = shaka.util.StringUtils.toUTF8(emptyJson);
      const bjsnBoxWithEmptyJson = new Uint8Array([
        0x00, 0x00, 0x00, 0x08 + emptyJsonData.length,
        0x62, 0x6A, 0x73, 0x6E,
        ...emptyJsonData
      ]);
      
      const mp4WithEmptyJson = new Uint8Array([
        // ftyp box
        0x00, 0x00, 0x00, 0x18,
        0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6F, 0x6D,
        0x00, 0x00, 0x00, 0x00,
        0x69, 0x73, 0x6F, 0x6D,
        0x6D, 0x70, 0x34, 0x31,
        // BJSN box with empty JSON
        ...bjsnBoxWithEmptyJson
      ]);

      const result = shaka.util.BjsnParser.parseFromSegment(mp4WithEmptyJson);
      expect(result).toBeNull(); // Should fail validation
    });

    it('should handle corrupted MP4 data gracefully', () => {
      const corruptedMp4 = new Uint8Array([
        0xFF, 0xFF, 0xFF, 0xFF, // invalid box size
        0x62, 0x6A, 0x73, 0x6E, // bjsn type
        0x00, 0x11, 0x22, 0x33  // some data
      ]);

      const result = shaka.util.BjsnParser.parseFromSegment(corruptedMp4);
      expect(result).toBeNull();
    });

    it('should handle very large segment data', () => {
      // Create a large MP4 with BJSN box at the beginning
      const largeData = new Uint8Array(10000);
      largeData.fill(0x00); // Fill with zeros
      
      // Add valid BJSN box at the start
      const bjsnBox = bjsnBoxWithValidData;
      largeData.set(bjsnBox, 0);
      
      const result = shaka.util.BjsnParser.parseFromSegment(largeData);
      expect(result).not.toBeNull();
      expect(result.type).toBe('dynamic');
    });
  });
});
