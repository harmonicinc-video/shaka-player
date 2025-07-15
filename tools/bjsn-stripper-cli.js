#!/usr/bin/env node

/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview CLI tool for stripping BJSN boxes from MP4 files
 * 
 * This tool provides a command-line interface to remove BJSN boxes from MP4 files
 * using the Shaka Player's BjsnBoxStripper utility.
 * 
 * Usage:
 *   node bjsn-stripper-cli.js <input-file> [output-file]
 * 
 * Examples:
 *   node bjsn-stripper-cli.js input.mp4 output.mp4
 *   node bjsn-stripper-cli.js input.mp4  // Will create input_stripped.mp4
 */

const fs = require('fs');
const path = require('path');

// Simple implementation of the BJSN box stripper functionality
// This is a standalone version that doesn't depend on the full Shaka Player library

class BjsnBoxStripper {
  /**
   * Strip BJSN box from MP4 segment data
   * @param {Uint8Array} segmentData - MP4 segment data containing BJSN box
   * @return {Uint8Array} Clean MP4 segment data without BJSN box
   */
  static stripBjsnBox(segmentData) {
    try {
      console.log('🔧 BJSN STRIPPER: Starting to strip BJSN box');
      console.log('  📏 Input segment size:', segmentData.length, 'bytes');
      
      // Check if this segment actually contains a BJSN box
      if (!BjsnBoxStripper.hasBjsnBox(segmentData)) {
        console.log('  ✅ No BJSN box found, returning original data');
        return segmentData;
      }
      
      const bjsnBoxInfo = BjsnBoxStripper.findBjsnBox(segmentData);
      if (!bjsnBoxInfo) {
        console.log('  ⚠️ BJSN box detection failed, returning original data');
        return segmentData;
      }
      
      console.log('  🔍 BJSN box found at offset:', bjsnBoxInfo.start, 'size:', bjsnBoxInfo.size);
      
      // Create new segment without BJSN box
      const strippedData = BjsnBoxStripper.removeBox(segmentData, bjsnBoxInfo);
      
      console.log('  ✅ BJSN box stripped successfully');
      console.log('  📏 Output segment size:', strippedData.length, 'bytes');
      console.log('  📊 Size reduction:', segmentData.length - strippedData.length, 'bytes');
      
      return strippedData;
    } catch (error) {
      console.error('  ❌ BJSN stripping failed:', error.message);
      console.log('  🔄 Falling back to original data');
      return segmentData;
    }
  }

  /**
   * Check if segment contains a BJSN box
   * @param {Uint8Array} segmentData - MP4 segment data
   * @return {boolean} True if BJSN box is present
   */
  static hasBjsnBox(segmentData) {
    let offset = 0;
    
    while (offset < segmentData.length - 8) {
      // Read box size (4 bytes)
      const boxSize = (segmentData[offset] << 24) | 
                     (segmentData[offset + 1] << 16) | 
                     (segmentData[offset + 2] << 8) | 
                     segmentData[offset + 3];
      
      // Read box type (4 bytes)
      const boxType = String.fromCharCode(
        segmentData[offset + 4],
        segmentData[offset + 5],
        segmentData[offset + 6],
        segmentData[offset + 7]
      );
      
      if (boxType === 'bjsn') {
        return true;
      }
      
      // Move to next box
      if (boxSize === 0) {
        break; // Box extends to end of file
      }
      
      offset += boxSize;
    }
    
    return false;
  }

  /**
   * Find BJSN box location and size in segment
   * @param {Uint8Array} segmentData - MP4 segment data
   * @return {?{start: number, size: number}} BJSN box info
   */
  static findBjsnBox(segmentData) {
    let offset = 0;
    
    while (offset < segmentData.length - 8) {
      // Read box size (4 bytes)
      const boxSize = (segmentData[offset] << 24) | 
                     (segmentData[offset + 1] << 16) | 
                     (segmentData[offset + 2] << 8) | 
                     segmentData[offset + 3];
      
      // Read box type (4 bytes)
      const boxType = String.fromCharCode(
        segmentData[offset + 4],
        segmentData[offset + 5],
        segmentData[offset + 6],
        segmentData[offset + 7]
      );
      
      if (boxType === 'bjsn') {
        return {
          start: offset,
          size: boxSize
        };
      }
      
      // Move to next box
      if (boxSize === 0) {
        break; // Box extends to end of file
      }
      
      offset += boxSize;
    }
    
    return null;
  }

  /**
   * Remove a box from MP4 segment data
   * @param {Uint8Array} segmentData - Original segment data
   * @param {{start: number, size: number}} boxInfo - Box to remove
   * @return {Uint8Array} Segment data without the specified box
   */
  static removeBox(segmentData, boxInfo) {
    const beforeBox = segmentData.slice(0, boxInfo.start);
    const afterBox = segmentData.slice(boxInfo.start + boxInfo.size);
    
    // Combine the parts before and after the BJSN box
    const strippedData = new Uint8Array(beforeBox.length + afterBox.length);
    strippedData.set(beforeBox, 0);
    strippedData.set(afterBox, beforeBox.length);
    
    return strippedData;
  }

  /**
   * Get detailed info about BJSN box for debugging
   * @param {Uint8Array} segmentData - MP4 segment data
   * @return {?Object} Detailed BJSN box information
   */
  static getBjsnBoxInfo(segmentData) {
    const bjsnBoxInfo = BjsnBoxStripper.findBjsnBox(segmentData);
    if (!bjsnBoxInfo) {
      return null;
    }
    
    try {
      // Extract the JSON payload from the BJSN box
      const payloadStart = bjsnBoxInfo.start + 8; // Skip 4-byte size + 4-byte type
      const payloadEnd = bjsnBoxInfo.start + bjsnBoxInfo.size;
      const payload = segmentData.slice(payloadStart, payloadEnd);
      
      const jsonString = new TextDecoder('utf-8').decode(payload);
      const jsonData = JSON.parse(jsonString);
      
      return {
        start: bjsnBoxInfo.start,
        size: bjsnBoxInfo.size,
        payloadSize: payload.length,
        jsonData: jsonData
      };
    } catch (error) {
      return {
        start: bjsnBoxInfo.start,
        size: bjsnBoxInfo.size,
        error: error.message
      };
    }
  }

  /**
   * Strip BJSN, MOOV, and FTYP boxes from MP4 segment data
   * @param {Uint8Array} segmentData - Original segment data
   * @return {Uint8Array} Clean MP4 data without BJSN, MOOV, and FTYP boxes
   */
  static stripBjsnAndMoovBoxes(segmentData) {
    try {
      let offset = 0;
      const result = [];

      while (offset < segmentData.length - 8) {
        // Read box size (4 bytes)
        const boxSize = (segmentData[offset] << 24) | 
                       (segmentData[offset + 1] << 16) | 
                       (segmentData[offset + 2] << 8) | 
                       segmentData[offset + 3];
        
        // Read box type (4 bytes)
        const boxType = String.fromCharCode(
          segmentData[offset + 4],
          segmentData[offset + 5],
          segmentData[offset + 6],
          segmentData[offset + 7]
        );

        if (boxType === 'bjsn' || boxType === 'moov' || boxType === 'ftyp') {
          // Skip BJSN, MOOV, and FTYP boxes entirely
          console.log('🔧 BJSN BOX STRIPPER: Skipping', boxType, 'box at offset', offset);
          offset += boxSize;
          continue;
        }

        // Copy non-BJSN/MOOV/FTYP box
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
      console.error('🔧 BJSN BOX STRIPPER: Failed to strip BJSN and MOOV boxes:', error.message);
      return segmentData; // Return original data if stripping fails
    }
  }
}

// CLI functionality
function showUsage() {
  console.log(`
BJSN Box Stripper CLI Tool
=========================

Usage: node bjsn-stripper-cli.js [options] <input-file> [output-file]

Options:
  -h, --help          Show this help message
  -i, --info          Show BJSN box info without stripping
  -a, --all           Strip BJSN, MOOV, and FTYP boxes
  -v, --verbose       Verbose output

Arguments:
  input-file          Input MP4 file path
  output-file         Output MP4 file path (optional, defaults to input_stripped.mp4)

Examples:
  node bjsn-stripper-cli.js input.mp4 output.mp4
  node bjsn-stripper-cli.js input.mp4  # Creates input_stripped.mp4
  node bjsn-stripper-cli.js --info input.mp4  # Show BJSN box info
  node bjsn-stripper-cli.js --all input.mp4 output.mp4  # Strip multiple box types
`);
}

function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    showUsage();
    return;
  }

  let inputFile = '';
  let outputFile = '';
  let showInfo = false;
  let stripAll = false;
  let verbose = false;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '-i' || arg === '--info') {
      showInfo = true;
    } else if (arg === '-a' || arg === '--all') {
      stripAll = true;
    } else if (arg === '-v' || arg === '--verbose') {
      verbose = true;
    } else if (!inputFile) {
      inputFile = arg;
    } else if (!outputFile) {
      outputFile = arg;
    }
  }

  if (!inputFile) {
    console.error('❌ Error: Input file is required');
    showUsage();
    process.exit(1);
  }

  // Check if input file exists
  if (!fs.existsSync(inputFile)) {
    console.error('❌ Error: Input file does not exist:', inputFile);
    process.exit(1);
  }

  // Set default output file if not provided
  if (!outputFile && !showInfo) {
    const parsedPath = path.parse(inputFile);
    outputFile = path.join(parsedPath.dir, parsedPath.name + '_stripped' + parsedPath.ext);
  }

  console.log('📁 Processing file:', inputFile);
  
  try {
    // Read input file
    const inputData = fs.readFileSync(inputFile);
    const segmentData = new Uint8Array(inputData);
    
    if (showInfo) {
      // Show BJSN box information
      const bjsnInfo = BjsnBoxStripper.getBjsnBoxInfo(segmentData);
      if (bjsnInfo) {
        console.log('\n📊 BJSN Box Information:');
        console.log('  Position:', bjsnInfo.start);
        console.log('  Size:', bjsnInfo.size, 'bytes');
        console.log('  Payload Size:', bjsnInfo.payloadSize, 'bytes');
        
        if (bjsnInfo.jsonData) {
          console.log('  JSON Data:', JSON.stringify(bjsnInfo.jsonData, null, 2));
        } else if (bjsnInfo.error) {
          console.log('  Parse Error:', bjsnInfo.error);
        }
      } else {
        console.log('  ℹ️ No BJSN box found in file');
      }
      return;
    }

    // Strip BJSN boxes
    let strippedData;
    if (stripAll) {
      strippedData = BjsnBoxStripper.stripBjsnAndMoovBoxes(segmentData);
    } else {
      strippedData = BjsnBoxStripper.stripBjsnBox(segmentData);
    }

    // Write output file
    fs.writeFileSync(outputFile, strippedData);
    
    console.log('\n✅ Success!');
    console.log('  📄 Output file:', outputFile);
    console.log('  📏 Original size:', segmentData.length, 'bytes');
    console.log('  📏 Stripped size:', strippedData.length, 'bytes');
    console.log('  📊 Size reduction:', segmentData.length - strippedData.length, 'bytes');
    
    if (verbose) {
      console.log('\n🔍 Detailed Analysis:');
      console.log('  BJSN box present:', BjsnBoxStripper.hasBjsnBox(segmentData));
      console.log('  BJSN box present after stripping:', BjsnBoxStripper.hasBjsnBox(strippedData));
    }
    
  } catch (error) {
    console.error('❌ Error processing file:', error.message);
    process.exit(1);
  }
}

// Run the CLI
if (require.main === module) {
  main();
}

module.exports = { BjsnBoxStripper };
