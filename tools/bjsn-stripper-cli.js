#!/usr/bin/env node

/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Enhanced CLI tool for processing BJSN-enabled MP4 files
 * 
 * This tool can:
 * 1. Strip BJSN boxes from MP4 files
 * 2. Extract separate init segments for each track (with proper filtering)
 * 3. Extract separate media segments for video and audio tracks
 * 4. Detect and display codec information using Shaka's codec detector
 * 
 * Usage:
 *   node bjsn-stripper-cli.js [options] <input-file> [output-prefix]
 */

const fs = require('fs');
const path = require('path');

// Try to load Shaka Player utilities if available
let BjsnCodecDetector = null;
try {
  const compiledPath = path.join(__dirname, '..', 'dist', 'shaka-player.compiled.js');
  if (fs.existsSync(compiledPath)) {
    const shaka = require(compiledPath);
    if (shaka.util && shaka.util.BjsnCodecDetector) {
      BjsnCodecDetector = shaka.util.BjsnCodecDetector;
      console.log('✅ Loaded Shaka Player codec detector');
    }
  }
} catch (e) {
  console.log('⚠️ Could not load Shaka Player, using fallback codec detection');
}

// Fallback codec detector if Shaka is not available
if (!BjsnCodecDetector) {
  BjsnCodecDetector = {
    detectCodecsFromSegment: async (data) => {
      let videoCodec = null;
      let audioCodec = null;
      
      // Look for codec boxes in the data
      for (let i = 0; i < data.length - 8; i++) {
        const boxSize = (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3];
        const boxType = String.fromCharCode(data[i + 4], data[i + 5], data[i + 6], data[i + 7]);
        
        if (boxType === 'avcC' && boxSize >= 11 && i + boxSize <= data.length) {
          // Parse AVC configuration
          // avcC box structure:
          // - 8 bytes: box header (size + 'avcC')
          // - 1 byte: configuration version (should be 1)
          // - 1 byte: AVCProfileIndication
          // - 1 byte: profile_compatibility
          // - 1 byte: AVCLevelIndication
          const configStart = i + 8;
          if (configStart + 4 <= data.length) {
            const configVersion = data[configStart];
            if (configVersion === 1) {
              const profile = data[configStart + 1].toString(16).padStart(2, '0').toUpperCase();
              const compat = data[configStart + 2].toString(16).padStart(2, '0').toUpperCase();
              const level = data[configStart + 3].toString(16).padStart(2, '0').toUpperCase();
              videoCodec = `avc1.${profile}${compat}${level}`;
            }
          }
        } else if (boxType === 'hvcC' && boxSize >= 23 && i + boxSize <= data.length) {
          // HEVC configuration - simplified
          videoCodec = 'hvc1.1.6.L93.90';
        } else if (boxType === 'esds' && boxSize >= 20 && i + boxSize <= data.length) {
          // Elementary Stream Descriptor - for AAC
          // This is a simplified detection
          audioCodec = 'mp4a.40.2'; // AAC-LC
        } else if (boxType === 'mp4a' && !audioCodec) {
          // If we find mp4a sample entry, assume AAC-LC
          audioCodec = 'mp4a.40.2';
        }
      }
      
      // Also check for codec indicators in stsd box
      if (!videoCodec || !audioCodec) {
        const stsdData = findBox(data, 'stsd');
        if (stsdData) {
          // Skip stsd header (8 bytes) + version/flags (4 bytes) + entry count (4 bytes)
          let offset = 16;
          while (offset < stsdData.length - 8) {
            const entrySize = (stsdData[offset] << 24) | (stsdData[offset + 1] << 16) | 
                             (stsdData[offset + 2] << 8) | stsdData[offset + 3];
            const entryType = String.fromCharCode(
              stsdData[offset + 4], stsdData[offset + 5], 
              stsdData[offset + 6], stsdData[offset + 7]
            );
            
            if (!videoCodec && (entryType === 'avc1' || entryType === 'avc3')) {
              // Look for avcC within this entry
              const avcCData = findBox(stsdData.slice(offset, offset + entrySize), 'avcC');
              if (avcCData && avcCData.length >= 12) {
                const profile = avcCData[9].toString(16).padStart(2, '0').toUpperCase();
                const compat = avcCData[10].toString(16).padStart(2, '0').toUpperCase();
                const level = avcCData[11].toString(16).padStart(2, '0').toUpperCase();
                videoCodec = `avc1.${profile}${compat}${level}`;
              } else {
                videoCodec = 'avc1.42E01E'; // Fallback
              }
            } else if (!audioCodec && entryType === 'mp4a') {
              audioCodec = 'mp4a.40.2'; // AAC-LC fallback
            }
            
            offset += entrySize;
            if (offset >= stsdData.length) break;
          }
        }
      }
      
      return {
        video: videoCodec,
        audio: audioCodec,
        mimeType: videoCodec && audioCodec ? 
          `video/mp4; codecs="${videoCodec},${audioCodec}"` :
          videoCodec ? `video/mp4; codecs="${videoCodec}"` :
          audioCodec ? `audio/mp4; codecs="${audioCodec}"` : null,
        isMultiplexed: !!(videoCodec && audioCodec),
        detectionMethod: 'fallback'
      };
    }
  };
}

// Helper function to find a box in data
function findBox(data, boxType) {
  for (let i = 0; i < data.length - 8; i++) {
    const size = (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3];
    const type = String.fromCharCode(data[i + 4], data[i + 5], data[i + 6], data[i + 7]);
    
    if (type === boxType && size > 0 && i + size <= data.length) {
      return data.slice(i, i + size);
    }
  }
  return null;
}

class Mp4BoxUtils {
  /**
   * Read a 32-bit unsigned integer from buffer
   */
  static readUint32(data, offset) {
    return (data[offset] << 24) | 
           (data[offset + 1] << 16) | 
           (data[offset + 2] << 8) | 
           data[offset + 3];
  }

  /**
   * Write a 32-bit unsigned integer to buffer
   */
  static writeUint32(data, offset, value) {
    data[offset] = (value >> 24) & 0xFF;
    data[offset + 1] = (value >> 16) & 0xFF;
    data[offset + 2] = (value >> 8) & 0xFF;
    data[offset + 3] = value & 0xFF;
  }

  /**
   * Get box type as string
   */
  static getBoxType(data, offset) {
    return String.fromCharCode(
      data[offset],
      data[offset + 1],
      data[offset + 2],
      data[offset + 3]
    );
  }

  /**
   * Parse all top-level boxes
   */
  static parseTopLevelBoxes(data) {
    const boxes = [];
    let offset = 0;

    while (offset < data.length - 8) {
      const size = Mp4BoxUtils.readUint32(data, offset);
      const type = Mp4BoxUtils.getBoxType(data, offset + 4);

      if (size === 0) {
        boxes.push({
          type,
          offset,
          size: data.length - offset,
          data: data.slice(offset, data.length)
        });
        break;
      }

      if (size === 1) {
        console.warn('64-bit box size not supported');
        break;
      }

      if (offset + size > data.length) {
        console.warn('Box size exceeds data length');
        break;
      }

      boxes.push({
        type,
        offset,
        size,
        data: data.slice(offset, offset + size)
      });

      offset += size;
    }

    return boxes;
  }

  /**
   * Create a new box
   */
  static createBox(type, payload) {
    const box = new Uint8Array(8 + payload.length);
    Mp4BoxUtils.writeUint32(box, 0, box.length);
    box[4] = type.charCodeAt(0);
    box[5] = type.charCodeAt(1);
    box[6] = type.charCodeAt(2);
    box[7] = type.charCodeAt(3);
    box.set(payload, 8);
    return box;
  }

  /**
   * Parse child boxes from a parent box
   */
  static parseChildBoxes(parentData) {
    const boxes = [];
    let offset = 8; // Skip parent box header

    while (offset < parentData.length - 8) {
      const size = Mp4BoxUtils.readUint32(parentData, offset);
      const type = Mp4BoxUtils.getBoxType(parentData, offset + 4);

      if (size === 0 || offset + size > parentData.length) {
        break;
      }

      boxes.push({
        type,
        offset,
        size,
        data: parentData.slice(offset, offset + size)
      });

      offset += size;
    }

    return boxes;
  }
}

class BjsnMp4Processor {
  /**
   * Process BJSN MP4 file and extract components
   */
  static processFile(data) {
    // First, strip BJSN box
    const strippedData = BjsnMp4Processor.stripBjsnBox(data);
    
    // Parse top-level boxes
    const boxes = Mp4BoxUtils.parseTopLevelBoxes(strippedData);
    
    // Find essential boxes
    const ftypBox = boxes.find(b => b.type === 'ftyp');
    const moovBox = boxes.find(b => b.type === 'moov');
    const moofBoxes = boxes.filter(b => b.type === 'moof');
    const mdatBoxes = boxes.filter(b => b.type === 'mdat');

    // Only a BJSN *initial* segment carries ftyp+moov.  Subsequent segments
    // are styp (+bjsn) + moof/mdat, and must still be processable -- refusing
    // them means the tool cannot inspect 9 out of every 10 captured files.
    const hasInit = !!(ftypBox && moovBox);

    // Relaxing the old "must have ftyp+moov" rule would otherwise let any
    // non-MP4 file through as a vacuous success, so require that the file look
    // like one thing or the other: an initial segment, or fragments.
    if (!hasInit && moofBoxes.length === 0) {
      const found = boxes.length ?
          [...new Set(boxes.map(b => b.type))].join(', ') : 'none';
      throw new Error(
          'not a recognisable MP4: expected either ftyp+moov (an initial ' +
          'segment) or at least one moof (a subsequent segment). ' +
          `Top-level boxes found: ${found}`);
    }

    // With a moov we know each track's handler; without one, all we can learn
    // is the set of track IDs appearing in the fragments.
    const tracks = hasInit ?
        BjsnMp4Processor.parseTracksFromMoov(moovBox.data) :
        BjsnMp4Processor.parseTracksFromMoofs(moofBoxes);

    const initSegments = {};
    if (hasInit) {
      tracks.forEach(track => {
        const initSegment = BjsnMp4Processor.createInitSegmentForTrack(
          ftypBox.data,
          moovBox.data,
          track.id,
          tracks
        );
        initSegments[track.type] = {
          trackId: track.id,
          data: initSegment
        };
      });
    }

    // Group media segments by track
    const mediaSegments = BjsnMp4Processor.groupMediaSegmentsByTrack(
      moofBoxes, 
      mdatBoxes, 
      tracks
    );

    return {
      hasInit,
      tracks,
      initSegments,
      mediaSegments,
      moofCount: moofBoxes.length,
      mdatCount: mdatBoxes.length,
      originalSize: data.length,
      strippedSize: strippedData.length
    };
  }

  /**
   * Derive the track list from fragment headers, for segments with no moov.
   * Only the IDs are knowable here -- the handler type lives in the moov -- so
   * tracks are labelled "trackN" rather than video/audio.
   */
  static parseTracksFromMoofs(moofBoxes) {
    const ids = [];
    moofBoxes.forEach(moofBox => {
      const trackId = BjsnMp4Processor.getTrackIdFromMoof(moofBox.data);
      if (trackId !== null && !ids.includes(trackId)) {
        ids.push(trackId);
      }
    });
    return ids.sort((a, b) => a - b).map(id => ({
      id,
      type: `track${id}`,
      handler: 'unknown (no moov in this segment)'
    }));
  }

  /**
   * Strip BJSN box from data
   */
  static stripBjsnBox(data) {
    const boxes = Mp4BoxUtils.parseTopLevelBoxes(data);
    const nonBjsnBoxes = boxes.filter(b => b.type !== 'bjsn');
    
    const totalSize = nonBjsnBoxes.reduce((sum, box) => sum + box.data.length, 0);
    const result = new Uint8Array(totalSize);
    
    let offset = 0;
    nonBjsnBoxes.forEach(box => {
      result.set(box.data, offset);
      offset += box.data.length;
    });
    
    return result;
  }

  /**
   * Parse tracks from moov box
   */
  static parseTracksFromMoov(moovData) {
    const tracks = [];
    const moovChildren = Mp4BoxUtils.parseChildBoxes(moovData);
    
    moovChildren.forEach(child => {
      if (child.type === 'trak') {
        const trackInfo = BjsnMp4Processor.parseTrack(child.data);
        if (trackInfo) {
          tracks.push(trackInfo);
        }
      }
    });
    
    return tracks;
  }

  /**
   * Parse a single track box
   */
  static parseTrack(trakData) {
    let trackId = null;
    let handlerType = null;
    
    const trakChildren = Mp4BoxUtils.parseChildBoxes(trakData);
    
    // Find tkhd
    const tkhdBox = trakChildren.find(b => b.type === 'tkhd');
    if (tkhdBox) {
      trackId = BjsnMp4Processor.parseTrackId(tkhdBox.data);
    }
    
    // Find mdia and then hdlr
    const mdiaBox = trakChildren.find(b => b.type === 'mdia');
    if (mdiaBox) {
      handlerType = BjsnMp4Processor.findHandlerType(mdiaBox.data);
    }
    
    if (trackId !== null && handlerType !== null) {
      return {
        id: trackId,
        type: handlerType === 'vide' ? 'video' : 
              handlerType === 'soun' ? 'audio' : handlerType,
        handler: handlerType
      };
    }
    
    return null;
  }

  /**
   * Parse track ID from tkhd box
   */
  static parseTrackId(tkhdData) {
    const version = tkhdData[8];
    const timeSkip = version === 1 ? 16 : 8;
    const trackIdOffset = 12 + timeSkip;
    
    if (trackIdOffset + 4 <= tkhdData.length) {
      return Mp4BoxUtils.readUint32(tkhdData, trackIdOffset);
    }
    
    return null;
  }

  /**
   * Find handler type in mdia box
   */
  static findHandlerType(mdiaData) {
    const mdiaChildren = Mp4BoxUtils.parseChildBoxes(mdiaData);
    const hdlrBox = mdiaChildren.find(b => b.type === 'hdlr');
    
    if (hdlrBox && hdlrBox.data.length >= 20) {
      const handlerType = Mp4BoxUtils.getBoxType(hdlrBox.data, 16);
      return handlerType;
    }
    
    return null;
  }

  /**
   * Create init segment for a specific track
   */
  static createInitSegmentForTrack(ftypData, moovData, trackId, allTracks) {
    const filteredMoov = BjsnMp4Processor.filterMoovForTrack(moovData, trackId, allTracks);
    
    const initSegment = new Uint8Array(ftypData.length + filteredMoov.length);
    initSegment.set(ftypData, 0);
    initSegment.set(filteredMoov, ftypData.length);
    
    return initSegment;
  }

  /**
   * Filter moov box to include only specified track
   */
  static filterMoovForTrack(moovData, trackId, allTracks) {
    const moovChildren = Mp4BoxUtils.parseChildBoxes(moovData);
    const filteredChildren = [];
    
    moovChildren.forEach(child => {
      if (child.type === 'mvhd') {
        // Keep movie header
        filteredChildren.push(child.data);
      } else if (child.type === 'trak') {
        // Check if this is the track we want
        const trakId = BjsnMp4Processor.getTrackIdFromTrak(child.data);
        if (trakId === trackId) {
          filteredChildren.push(child.data);
        }
      } else if (child.type === 'mvex') {
        // Filter mvex to only include trex for our track
        const filteredMvex = BjsnMp4Processor.filterMvexForTrack(child.data, trackId);
        if (filteredMvex) {
          filteredChildren.push(filteredMvex);
        }
      } else {
        // Keep other boxes
        filteredChildren.push(child.data);
      }
    });
    
    // Reconstruct moov box
    const payloadSize = filteredChildren.reduce((sum, child) => sum + child.length, 0);
    const payload = new Uint8Array(payloadSize);
    let offset = 0;
    filteredChildren.forEach(child => {
      payload.set(child, offset);
      offset += child.length;
    });
    
    return Mp4BoxUtils.createBox('moov', payload);
  }

  /**
   * Get track ID from trak box
   */
  static getTrackIdFromTrak(trakData) {
    const trakChildren = Mp4BoxUtils.parseChildBoxes(trakData);
    const tkhdBox = trakChildren.find(b => b.type === 'tkhd');
    
    if (tkhdBox) {
      return BjsnMp4Processor.parseTrackId(tkhdBox.data);
    }
    
    return null;
  }

  /**
   * Filter mvex box for specific track
   */
  static filterMvexForTrack(mvexData, trackId) {
    const mvexChildren = Mp4BoxUtils.parseChildBoxes(mvexData);
    const filteredChildren = [];
    
    mvexChildren.forEach(child => {
      if (child.type === 'mehd') {
        filteredChildren.push(child.data);
      } else if (child.type === 'trex') {
        if (child.data.length >= 20) {
          const trexTrackId = Mp4BoxUtils.readUint32(child.data, 12);
          if (trexTrackId === trackId) {
            filteredChildren.push(child.data);
          }
        }
      }
    });
    
    if (filteredChildren.length === 0) {
      return null;
    }
    
    const payloadSize = filteredChildren.reduce((sum, child) => sum + child.length, 0);
    const payload = new Uint8Array(payloadSize);
    let offset = 0;
    filteredChildren.forEach(child => {
      payload.set(child, offset);
      offset += child.length;
    });
    
    return Mp4BoxUtils.createBox('mvex', payload);
  }

  /**
   * Group media segments by track
   */
  static groupMediaSegmentsByTrack(moofBoxes, mdatBoxes, tracks) {
    // Keyed by whatever the track list calls each track, so this works for
    // video/audio from a moov and for trackN derived from fragment headers.
    // Previously the keys were hardcoded to video/audio, which silently
    // dropped any track that was neither.
    const result = {};
    tracks.forEach(track => {
      result[track.type] = [];
    });

    moofBoxes.forEach((moofBox, index) => {
      if (index < mdatBoxes.length) {
        const mdatBox = mdatBoxes[index];
        const trackId = BjsnMp4Processor.getTrackIdFromMoof(moofBox.data);

        if (trackId !== null) {
          const track = tracks.find(t => t.id === trackId);
          if (track) {
            const segment = new Uint8Array(moofBox.data.length + mdatBox.data.length);
            segment.set(moofBox.data, 0);
            segment.set(mdatBox.data, moofBox.data.length);
            result[track.type].push(segment);
          }
        }
      }
    });

    return result;
  }

  /**
   * Get track ID from moof box
   */
  static getTrackIdFromMoof(moofData) {
    const moofChildren = Mp4BoxUtils.parseChildBoxes(moofData);
    const trafBox = moofChildren.find(b => b.type === 'traf');
    
    if (trafBox) {
      return BjsnMp4Processor.getTrackIdFromTraf(trafBox.data);
    }
    
    return null;
  }

  /**
   * Get track ID from traf box
   */
  static getTrackIdFromTraf(trafData) {
    const trafChildren = Mp4BoxUtils.parseChildBoxes(trafData);
    const tfhdBox = trafChildren.find(b => b.type === 'tfhd');
    
    if (tfhdBox && tfhdBox.data.length >= 16) {
      const trackId = Mp4BoxUtils.readUint32(tfhdBox.data, 12);
      return trackId;
    }
    
    return null;
  }

  /**
   * Get BJSN info from data
   */
  static getBjsnInfo(data) {
    const boxes = Mp4BoxUtils.parseTopLevelBoxes(data);
    const bjsnBox = boxes.find(b => b.type === 'bjsn');
    
    if (!bjsnBox) {
      return null;
    }
    
    try {
      const payload = bjsnBox.data.slice(8);
      const jsonString = new TextDecoder('utf-8').decode(payload);
      const jsonData = JSON.parse(jsonString);
      
      return {
        offset: bjsnBox.offset,
        size: bjsnBox.size,
        data: jsonData
      };
    } catch (error) {
      return {
        offset: bjsnBox.offset,
        size: bjsnBox.size,
        error: error.message
      };
    }
  }
}

// CLI functionality
function showUsage() {
  console.log(`
BJSN MP4 Processor - Enhanced Version
=====================================

Usage: node bjsn-stripper-cli.js [options] <input-file> [output-prefix]

Options:
  -h, --help          Show this help message
  -i, --info          Show BJSN box info and file structure
  -s, --split         Split into separate init and media segments
  -c, --codec         Detect and display codec information
  -v, --verbose       Verbose output

Arguments:
  input-file          Input MP4 file path
  output-prefix       Output file prefix (defaults to input filename)

Output Files (split mode):
  <prefix>_video_init.mp4   - Video track init segment (ftyp + filtered moov)
  <prefix>_audio_init.mp4   - Audio track init segment (ftyp + filtered moov)
  <prefix>_video_media.mp4  - All video media segments (moof + mdat pairs)
  <prefix>_audio_media.mp4  - All audio media segments (moof + mdat pairs)

Examples:
  node bjsn-stripper-cli.js --info input.mp4
  node bjsn-stripper-cli.js --split input.mp4
  node bjsn-stripper-cli.js --split --codec input.mp4 output
`);
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    showUsage();
    return;
  }

  let inputFile = '';
  let outputPrefix = '';
  let showInfo = false;
  let splitMode = false;
  let detectCodec = false;
  let verbose = false;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '-i' || arg === '--info') {
      showInfo = true;
    } else if (arg === '-s' || arg === '--split') {
      splitMode = true;
    } else if (arg === '-c' || arg === '--codec') {
      detectCodec = true;
    } else if (arg === '-v' || arg === '--verbose') {
      verbose = true;
    } else if (!inputFile) {
      inputFile = arg;
    } else if (!outputPrefix) {
      outputPrefix = arg;
    }
  }

  if (!inputFile) {
    console.error('❌ Error: Input file is required');
    showUsage();
    process.exit(1);
  }

  if (!fs.existsSync(inputFile)) {
    console.error('❌ Error: Input file does not exist:', inputFile);
    process.exit(1);
  }

  if (!outputPrefix) {
    const parsedPath = path.parse(inputFile);
    outputPrefix = path.join(parsedPath.dir, parsedPath.name);
  }

  console.log('📁 Processing file:', inputFile);
  
  try {
    const inputData = fs.readFileSync(inputFile);
    const data = new Uint8Array(inputData);
    
    if (showInfo) {
      console.log('\n📊 File Information:');
      console.log('  Size:', data.length, 'bytes');
      
      const bjsnInfo = BjsnMp4Processor.getBjsnInfo(data);
      if (bjsnInfo) {
        console.log('\n📊 BJSN Box:');
        console.log('  Offset:', bjsnInfo.offset);
        console.log('  Size:', bjsnInfo.size, 'bytes');
        if (bjsnInfo.data) {
          console.log('  Data:', JSON.stringify(bjsnInfo.data, null, 2));
        } else if (bjsnInfo.error) {
          console.log('  Error:', bjsnInfo.error);
        }
      } else {
        console.log('\n  ℹ️ No BJSN box found');
      }
      
      const processed = BjsnMp4Processor.processFile(data);

      console.log('\n📊 Segment kind:',
          processed.hasInit ?
              'initial (has ftyp + moov)' :
              'subsequent (no ftyp/moov — init lives in the initial segment)');
      console.log('  Fragments:', processed.moofCount, 'moof /',
          processed.mdatCount, 'mdat');

      console.log('\n📊 Tracks:');
      processed.tracks.forEach(track => {
        const count = (processed.mediaSegments[track.type] || []).length;
        console.log(`  Track ${track.id}: ${track.type} (${track.handler})` +
            ` — ${count} fragments`);
      });
      
      if (detectCodec) {
        const strippedData = BjsnMp4Processor.stripBjsnBox(data);
        const codecInfo = await BjsnCodecDetector.detectCodecsFromSegment(strippedData);
        console.log('\n📊 Codecs:');
        console.log('  Video:', codecInfo.video || 'Not detected');
        console.log('  Audio:', codecInfo.audio || 'Not detected');
        if (codecInfo.mimeType) {
          console.log('  MIME:', codecInfo.mimeType);
        }
        console.log('  Detection method:', codecInfo.detectionMethod);
      }
      
      return;
    }

    console.log('\n🔧 Processing MP4 file...');
    const processed = BjsnMp4Processor.processFile(data);
    
    console.log('  ✅ BJSN box removed');
    console.log('  📊 Size reduction:', data.length - processed.strippedSize, 'bytes');
    console.log('  📊 Found', processed.tracks.length, 'tracks');
    
    if (splitMode) {
      if (!processed.hasInit) {
        throw new Error(
            'cannot split: this segment has no moov, so per-track init ' +
            'segments cannot be built. Only a BJSN initial segment carries ' +
            'init. Run without --split to strip the bjsn box, or point ' +
            '--split at the initial segment.');
      }
      console.log('\n🔪 Creating separate segments...');

      // Write init segments
      for (const [type, segment] of Object.entries(processed.initSegments)) {
        const filename = `${outputPrefix}_${type}_init.mp4`;
        fs.writeFileSync(filename, segment.data);
        console.log(`  ✅ Created ${filename} (${segment.data.length} bytes, Track ${segment.trackId})`);
      }
      
      // Write media segments
      for (const [type, segments] of Object.entries(processed.mediaSegments)) {
        if (segments.length > 0) {
          const totalSize = segments.reduce((sum, seg) => sum + seg.length, 0);
          const combined = new Uint8Array(totalSize);
          let offset = 0;
          segments.forEach(seg => {
            combined.set(seg, offset);
            offset += seg.length;
          });
          
          const filename = `${outputPrefix}_${type}_media.mp4`;
          fs.writeFileSync(filename, combined);
          console.log(`  ✅ Created ${filename} (${combined.length} bytes, ${segments.length} segments)`);
        }
      }
      
      if (detectCodec) {
        console.log('\n🔍 Detecting codecs...');
        const strippedData = BjsnMp4Processor.stripBjsnBox(data);
        const codecInfo = await BjsnCodecDetector.detectCodecsFromSegment(strippedData);
        console.log('  Video codec:', codecInfo.video || 'Not detected');
        console.log('  Audio codec:', codecInfo.audio || 'Not detected');
        console.log('  Detection method:', codecInfo.detectionMethod);
      }
    } else {
      const strippedData = BjsnMp4Processor.stripBjsnBox(data);
      const outputFile = `${outputPrefix}_stripped.mp4`;
      fs.writeFileSync(outputFile, strippedData);
      console.log(`\n✅ Created ${outputFile} (${strippedData.length} bytes)`);
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run the CLI
if (require.main === module) {
  main();
}

module.exports = { BjsnMp4Processor, Mp4BoxUtils };
