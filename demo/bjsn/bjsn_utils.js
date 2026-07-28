class BjsnUtils {
    static BjsnParser = class {
        static parseFromSegment(data) {
            try {
                const bjsnBoxData = BjsnUtils.BjsnParser.extractBjsnBox_(data);
                if (!bjsnBoxData) {
                    return null;
                }
                const jsonString = BjsnUtils.StringUtils.fromUTF8(bjsnBoxData);
                const bjsnData = JSON.parse(jsonString);
                if (!BjsnUtils.BjsnParser.validateSchema(bjsnData)) {
                    return null;
                }
                return bjsnData;
            } catch (error) {
                console.warn('Failed to parse BJSN data:', error);
                return null;
            }
        }

        static validateSchema(bjsnData) {
            const requiredFields = ['type', 'gear_num', 'seq_num', 'template_path', 'gear_list'];
            for (const field of requiredFields) {
                if (!(field in bjsnData)) {
                    return false;
                }
            }
            return true;
        }

        static extractBjsnBox_(mp4Data) {
            let bjsnData = null;
            const parser = new BjsnUtils.Mp4Parser().box('bjsn', (box) => {
                // The content of the box is its total size minus the 8-byte header.
                const contentSize = box.size - 8;
                bjsnData = box.reader.readBytes(contentSize);
            });
            try {
                parser.parse(mp4Data, true, true);
            } catch (error) {
                return null;
            }
            return bjsnData;
        }
    };

    static BjsnBoxStripper = class {
        static stripBjsnBox(segmentData) {
            try {
                if (!BjsnUtils.BjsnBoxStripper.hasBjsnBox_(segmentData)) {
                    return segmentData;
                }
                const bjsnBoxInfo = BjsnUtils.BjsnBoxStripper.findBjsnBox_(segmentData);
                if (!bjsnBoxInfo) {
                    return segmentData;
                }
                return BjsnUtils.BjsnBoxStripper.removeBox_(segmentData, bjsnBoxInfo);
            } catch (error) {
                return segmentData;
            }
        }

        static hasBjsnBox_(segmentData) {
            let hasBjsn = false;
            const parser = new BjsnUtils.Mp4Parser().box('bjsn', () => {
                hasBjsn = true;
            });
            try {
                parser.parse(segmentData, true, true);
            } catch (error) {}
            return hasBjsn;
        }

        static findBjsnBox_(segmentData) {
            let bjsnBoxInfo = null;
            const parser = new BjsnUtils.Mp4Parser().box('bjsn', (box) => {
                bjsnBoxInfo = {
                    start: box.start,
                    size: box.size
                };
            });
            try {
                parser.parse(segmentData, true, true);
            } catch (error) {}
            return bjsnBoxInfo;
        }

        static removeBox_(segmentData, boxInfo) {
            const beforeBox = segmentData.slice(0, boxInfo.start);
            const afterBox = segmentData.slice(boxInfo.start + boxInfo.size);
            const strippedData = new Uint8Array(beforeBox.length + afterBox.length);
            strippedData.set(beforeBox, 0);
            strippedData.set(afterBox, beforeBox.length);
            return strippedData;
        }
    };

    static BjsnCodecDetector = class {
        static detectCodecsFromSegment(segmentData) {
            try {
                const isInitSegment = BjsnUtils.BjsnCodecDetector.hasBox_(segmentData, 'moov');
                if (isInitSegment) {
                    return BjsnUtils.BjsnCodecDetector.detectCodecsFromInitSegment_(segmentData);
                }
            } catch (error) {}
            return BjsnUtils.BjsnCodecDetector.getFallbackCodecInfo_();
        }

        static hasBox_(segmentData, boxType) {
            let hasBox = false;
            const parser = new BjsnUtils.Mp4Parser().box(boxType, () => {
                hasBox = true;
            });
            try {
                parser.parse(segmentData, true, true);
            } catch (error) {}
            return hasBox;
        }

        static detectCodecsFromInitSegment_(segmentData) {
            const codecInfo = {
                video: null,
                audio: null
            };
            const tracks = [];

            new BjsnUtils.Mp4Parser()
                .box('moov', (moovBox) => {
                    new BjsnUtils.Mp4Parser()
                        .box('trak', (trakBox) => {
                            const track = {
                                type: null,
                                stsdReader: null,
                            };

                            new BjsnUtils.Mp4Parser()
                                .box('mdia', (mdiaBox) => {
                                    new BjsnUtils.Mp4Parser()
                                        .fullBox('hdlr', (hdlrBox) => {
                                            const hdlr = BjsnUtils.Mp4BoxParsers.parseHDLR(hdlrBox.reader);
                                            if (hdlr) {
                                                track.type = hdlr.handlerType;
                                            }
                                        })
                                        .box('minf', (minfBox) => {
                                            new BjsnUtils.Mp4Parser()
                                                .box('stbl', (stblBox) => {
                                                    new BjsnUtils.Mp4Parser()
                                                        .fullBox('stsd', (stsdBox) => {
                                                            track.stsdReader = stsdBox.reader;
                                                        })
                                                        .parse(stblBox.reader, stblBox.partial, stblBox.stopOnPartial);
                                                })
                                                .parse(minfBox.reader, minfBox.partial, minfBox.stopOnPartial);
                                        })
                                        .parse(mdiaBox.reader, mdiaBox.partial, mdiaBox.stopOnPartial);
                                })
                                .parse(trakBox.reader, trakBox.partial, trakBox.stopOnPartial);

                            if (track.type && track.stsdReader) {
                                tracks.push(track);
                            }
                        })
                        .parse(moovBox.reader, moovBox.partial, moovBox.stopOnPartial);
                })
                .parse(segmentData, true, true);

            for (const track of tracks) {
                const codecs = BjsnUtils.BjsnCodecDetector.parseSTSD_(track.stsdReader, track.type);
                if (codecs.video) {
                    codecInfo.video = codecs.video;
                }
                if (codecs.audio) {
                    codecInfo.audio = codecs.audio;
                }
            }
            return codecInfo;
        }

        static parseSTSD_(reader, trackType) {
            const result = {
                video: null,
                audio: null,
            };
            // The reader is already positioned at the start of the stsd box's content.
            const version = reader.readUint8();
            const flags = reader.readUint24();
            const entryCount = reader.readUint32();

            for (let i = 0; i < entryCount; i++) {
                if (!reader.hasMoreData()) {
                    break;
                }

                const boxStart = reader.getPosition();
                const size = reader.readUint32();
                const type = BjsnUtils.Mp4Parser.typeToString(reader.readUint32());

                if (trackType === 'vide') {
                    result.video = BjsnUtils.BjsnCodecDetector.parseVideoSampleEntry_(reader, type);
                } else if (trackType === 'soun') {
                    result.audio = BjsnUtils.BjsnCodecDetector.parseAudioSampleEntry_(reader, type);
                }

                reader.seek(boxStart + size);
            }
            return result;
        }

        static parseVideoSampleEntry_(reader, format) {
            const avcC = BjsnUtils.BjsnCodecDetector.findBox_(reader, 'avcC');
            if (avcC) {
                const view = new DataView(avcC.buffer, avcC.byteOffset);
                const codecString = 'avc1.' +
                    view.getUint8(1).toString(16).padStart(2, '0') +
                    view.getUint8(2).toString(16).padStart(2, '0') +
                    view.getUint8(3).toString(16).padStart(2, '0');
                return codecString;
            }
            return 'avc1.42E01E';
        }

        static parseAudioSampleEntry_(reader, format) {
            const esdsBox = BjsnUtils.BjsnCodecDetector.findBox_(reader, 'esds');
            if (esdsBox) {
                const esds = BjsnUtils.Mp4BoxParsers.parseESDS(new BjsnUtils.DataViewReader(esdsBox, BjsnUtils.DataViewReader.Endianness.BIG_ENDIAN));
                if (esds && esds.codec) {
                    return esds.codec;
                }
            }
            return 'mp4a.40.2';
        }

        static findBox_(reader, boxType) {
            const initialPos = reader.getPosition();
            const remaining = reader.getLength() - initialPos;
            const subReader = new BjsnUtils.DataViewReader(reader.readBytes(remaining), reader.littleEndian_ ? BjsnUtils.DataViewReader.Endianness.LITTLE_ENDIAN : BjsnUtils.DataViewReader.Endianness.BIG_ENDIAN);

            while (subReader.hasMoreData()) {
                const boxStart = subReader.getPosition();
                if (boxStart + 8 > subReader.getLength()) {
                    break;
                }
                const size = subReader.readUint32();
                const type = BjsnUtils.Mp4Parser.typeToString(subReader.readUint32());

                if (size === 0) {
                    break;
                }

                if (type === boxType) {
                    subReader.seek(boxStart + 8);
                    return subReader.readBytes(size - 8);
                }
                subReader.seek(boxStart + size);
            }
            return null;
        }

        static getFallbackCodecInfo_() {
            return {
                video: 'avc1.42E01E',
                audio: 'mp4a.40.2'
            };
        }
    };

    static StringUtils = class {
        static fromUTF8(data) {
            return new TextDecoder().decode(data);
        }
    };

    static Mp4Parser = class {
        constructor() {
            this.boxParsers_ = {};
            this.fullBoxParsers_ = {};
        }

        static typeToString(type) {
            return String.fromCharCode(
                (type >> 24) & 0xff,
                (type >> 16) & 0xff,
                (type >> 8) & 0xff,
                type & 0xff);
        }

        box(type, callback) {
            this.boxParsers_[type] = callback;
            return this;
        }

        fullBox(type, callback) {
            this.fullBoxParsers_[type] = callback;
            return this;
        }

        parse(data, partialOkay, stopOnPartial) {
            const reader = (data instanceof BjsnUtils.DataViewReader) ?
                data :
                new BjsnUtils.DataViewReader(
                    data, BjsnUtils.DataViewReader.Endianness.BIG_ENDIAN);

            const end = reader.getPosition() + reader.getLength();

            while (reader.hasMoreData() && reader.getPosition() < end) {
                const boxStart = reader.getPosition();

                if (boxStart + 8 > end) {
                    break;
                }

                const size = reader.readUint32();
                const type = BjsnUtils.Mp4Parser.typeToString(reader.readUint32());
                let version = null;
                let flags = null;

                if (size === 0) {
                    break;
                }

                const boxEnd = boxStart + size;
                if (boxEnd > end) {
                    if (stopOnPartial) {
                        break;
                    }
                }

                const fullBoxCallback = this.fullBoxParsers_[type];
                if (fullBoxCallback) {
                    if (boxStart + 12 > end) {
                        if (stopOnPartial) {
                            break;
                        }
                    } else {
                        version = reader.readUint8();
                        flags = reader.readUint24();
                    }
                }

                const box = {
                    type: type,
                    version: version,
                    flags: flags,
                    reader: reader,
                    size: size,
                    start: boxStart,
                    partial: partialOkay,
                    stopOnPartial: stopOnPartial
                };

                const callback = fullBoxCallback || this.boxParsers_[type];
                if (callback) {
                    callback.call(this, box);
                }

                reader.seek(boxEnd);
            }
        }
    };

    static Mp4BoxParsers = class {
        static parseHDLR(reader) {
            reader.skip(4); // pre_defined
            const handlerType = BjsnUtils.Mp4Parser.typeToString(reader.readUint32());
            return {
                handlerType: handlerType
            };
        }

        static parseESDS(reader) {
            // Simplified ESDS parsing
            while (reader.hasMoreData()) {
                const tag = reader.readUint8();
                let size = 0;
                let nextByte;
                do {
                    nextByte = reader.readUint8();
                    size = (size << 7) | (nextByte & 0x7f);
                } while ((nextByte & 0x80) !== 0);

                if (tag === 0x03) { // ES_DescrTag
                    reader.skip(2); // ES_ID
                    reader.skip(1); // streamDependenceFlag, URL_Flag, OCRstreamFlag
                } else if (tag === 0x04) { // DecoderConfigDescrTag
                    const objectTypeIndication = reader.readUint8();
                    reader.skip(12); // streamType, upStream, reserved, bufferSizeDB, maxBitrate, avgBitrate
                    if (objectTypeIndication === 0x40) { // MPEG-4 AAC
                        return {
                            codec: 'mp4a.40.2'
                        };
                    }
                } else {
                    reader.skip(size);
                }
            }
            return null;
        }
    };

    static DataViewReader = class {
        constructor(data, endianness) {
            this.dataView_ = new DataView(data.buffer, data.byteOffset, data.length);
            this.littleEndian_ = endianness === BjsnUtils.DataViewReader.Endianness.LITTLE_ENDIAN;
            this.position_ = 0;
        }

        getPosition() {
            return this.position_;
        }
        getLength() {
            return this.dataView_.byteLength;
        }
        hasMoreData() {
            return this.position_ < this.dataView_.byteLength;
        }
        seek(position) {
            this.position_ = position;
        }
        skip(length) {
            this.position_ += length;
        }
        readUint8() {
            const value = this.dataView_.getUint8(this.position_);
            this.position_ += 1;
            return value;
        }
        readUint16() {
            const value = this.dataView_.getUint16(this.position_, this.littleEndian_);
            this.position_ += 2;
            return value;
        }
        readUint24() {
            const value = (this.dataView_.getUint8(this.position_) << 16) |
                (this.dataView_.getUint8(this.position_ + 1) << 8) |
                this.dataView_.getUint8(this.position_ + 2);
            this.position_ += 3;
            return value;
        }
        readUint32() {
            const value = this.dataView_.getUint32(this.position_, this.littleEndian_);
            this.position_ += 4;
            return value;
        }
        readBytes(length) {
            const value = new Uint8Array(this.dataView_.buffer, this.dataView_.byteOffset + this.position_, length);
            this.position_ += length;
            return value;
        }
    };
}

BjsnUtils.DataViewReader.Endianness = {
    BIG_ENDIAN: 0,
    LITTLE_ENDIAN: 1
};

/**
 * MP4 Box utilities for parsing and manipulating MP4 containers
 */
BjsnUtils.Mp4BoxUtils = class {
  static readUint32(data, offset) {
    return (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
  }

  static writeUint32(data, offset, value) {
    data[offset] = (value >> 24) & 0xFF;
    data[offset + 1] = (value >> 16) & 0xFF;
    data[offset + 2] = (value >> 8) & 0xFF;
    data[offset + 3] = value & 0xFF;
  }

  static getBoxType(data, offset) {
    return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
  }

  static parseTopLevelBoxes(data) {
    const boxes = [];
    let offset = 0;
    while (offset < data.length - 8) {
      let size = BjsnUtils.Mp4BoxUtils.readUint32(data, offset);
      const type = BjsnUtils.Mp4BoxUtils.getBoxType(data, offset + 4);
      if (size === 1) {
        console.log('64-bit box size not supported');
        return [];
      }
      if (offset + size > data.length) {
        console.log(`Box ${type} size ${size} exceeds buffer length`);
        break;
      }
      boxes.push({ type, offset, size, data: data.slice(offset, offset + size) });
      offset += size;
    }
    return boxes;
  }

  static parseChildBoxes(parentData) {
      const boxes = [];
      let offset = 8; // Skip parent box header
      while (offset < parentData.length - 8) {
          const size = BjsnUtils.Mp4BoxUtils.readUint32(parentData, offset);
          const type = BjsnUtils.Mp4BoxUtils.getBoxType(parentData, offset + 4);
          if (size === 0 || offset + size > parentData.length) {
              break;
          }
          boxes.push({ type, offset, size, data: parentData.slice(offset, offset + size) });
          offset += size;
      }
      return boxes;
  }

  static parseTfdtBox(tfdtData) {
    // TFDT box contains baseMediaDecodeTime
    // Box header (8 bytes) + version (1 byte) + flags (3 bytes) = 12 bytes offset
    if (tfdtData.length < 16) return null;
    
    const version = tfdtData[8];
    const offset = 12; // Skip box header + version + flags
    
    if (version === 1) {
      // 64-bit baseMediaDecodeTime
      if (tfdtData.length < offset + 8) return null;
      // Read as two 32-bit values and combine (JavaScript number precision limitation)
      const high = BjsnUtils.Mp4BoxUtils.readUint32(tfdtData, offset);
      const low = BjsnUtils.Mp4BoxUtils.readUint32(tfdtData, offset + 4);
      return (high * 0x100000000) + low;
    } else {
      // 32-bit baseMediaDecodeTime
      if (tfdtData.length < offset + 4) return null;
      return BjsnUtils.Mp4BoxUtils.readUint32(tfdtData, offset);
    }
  }

  static extractBaseMediaDecodeTime(segmentData) {
    try {
      const boxes = BjsnUtils.Mp4BoxUtils.parseTopLevelBoxes(segmentData);
      const moofBox = boxes.find(b => b.type === 'moof');
      if (!moofBox) return null;

      const moofChildren = BjsnUtils.Mp4BoxUtils.parseChildBoxes(moofBox.data);
      const trafBox = moofChildren.find(b => b.type === 'traf');
      if (!trafBox) return null;

      const trafChildren = BjsnUtils.Mp4BoxUtils.parseChildBoxes(trafBox.data);
      const tfdtBox = trafChildren.find(b => b.type === 'tfdt');
      if (!tfdtBox) return null;

      return BjsnUtils.Mp4BoxUtils.parseTfdtBox(tfdtBox.data);
    } catch (e) {
      console.log('Error extracting baseMediaDecodeTime:', e.message);
      return null;
    }
  }
};

/**
 * BJSN MP4 processor for handling segmented MP4 files
 */
BjsnUtils.BjsnMp4Processor = class {
  static processFile(data) {
    const strippedData = BjsnUtils.BjsnMp4Processor.stripBjsnBox(data);
    const boxes = BjsnUtils.Mp4BoxUtils.parseTopLevelBoxes(strippedData);
    const ftypBox = boxes.find(b => b.type === 'ftyp');
    const moovBox = boxes.find(b => b.type === 'moov');
    const moofBoxes = boxes.filter(b => b.type === 'moof');
    const mdatBoxes = boxes.filter(b => b.type === 'mdat');

    if (!ftypBox || !moovBox) {
      // For subsequent segments, moov is not expected.
      // We can handle this by calling a different method for media segments.
      return BjsnUtils.BjsnMp4Processor.processMediaSegment(data, []);
    }

    const tracks = BjsnUtils.BjsnMp4Processor.parseTracksFromMoov(moovBox.data);
    const initSegments = {};
    tracks.forEach(track => {
      initSegments[track.id] = BjsnUtils.BjsnMp4Processor.createInitSegmentForTrack(ftypBox.data, moovBox.data, track.id, tracks);
    });

    const mediaSegments = BjsnUtils.BjsnMp4Processor.groupMediaSegmentsByTrack(moofBoxes, mdatBoxes, tracks);
    return { tracks, initSegments, mediaSegments };
  }

  static processMediaSegment(data, trackIds) {
    const boxes = BjsnUtils.Mp4BoxUtils.parseTopLevelBoxes(data);
    const moofBoxes = boxes.filter(b => b.type === 'moof');
    const mdatBoxes = boxes.filter(b => b.type === 'mdat');

    const tracks = trackIds.map(id => ({ id }));
    const mediaSegments = BjsnUtils.BjsnMp4Processor.groupMediaSegmentsByTrack(moofBoxes, mdatBoxes, tracks);
    return { mediaSegments };
  }

  static stripBjsnBox(data) {
    const boxes = BjsnUtils.Mp4BoxUtils.parseTopLevelBoxes(data);
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

  static parseTracksFromMoov(moovData) {
    const tracks = [];
    const moovChildren = BjsnUtils.Mp4BoxUtils.parseChildBoxes(moovData);
    moovChildren.forEach(child => {
      if (child.type === 'trak') {
        const track = BjsnUtils.BjsnMp4Processor.parseTrack(child.data);
        if (track) {
          tracks.push(track);
        }
      }
    });
    return tracks;
  }

  static parseTrack(trakData) {
    let trackId = null;
    let handlerType = null;
    let timescale = null;
    const trakChildren = BjsnUtils.Mp4BoxUtils.parseChildBoxes(trakData);
    const tkhdBox = trakChildren.find(b => b.type === 'tkhd');
    if (tkhdBox) {
      trackId = BjsnUtils.BjsnMp4Processor.parseTrackId(tkhdBox.data);
    }
    const mdiaBox = trakChildren.find(b => b.type === 'mdia');
    if (mdiaBox) {
      handlerType = BjsnUtils.BjsnMp4Processor.findHandlerType(mdiaBox.data);
      timescale = BjsnUtils.BjsnMp4Processor.parseTimescale(mdiaBox.data);
    }
    if (trackId !== null && handlerType !== null) {
      return { id: trackId, handlerType, timescale: timescale || (handlerType === 'vide' ? 90000 : 44100), trak: trakData };
    }
    return null;
  }

  static parseTimescale(mdiaData) {
    const mdiaChildren = BjsnUtils.Mp4BoxUtils.parseChildBoxes(mdiaData);
    const mdhdBox = mdiaChildren.find(b => b.type === 'mdhd');
    if (mdhdBox && mdhdBox.data.length >= 20) {
      // Skip box header (8) + version (1) + flags (3) + creation_time (4) + modification_time (4) = 20 bytes
      // timescale is the next 4 bytes
      const timescale = BjsnUtils.Mp4BoxUtils.readUint32(mdhdBox.data, 20);
      return timescale;
    }
    return null;
  }

  static parseTrackId(tkhdData) {
    const version = tkhdData[8];
    // version(1) + flags(3) + creation_time(4/8) + modification_time(4/8)
    const trackIdOffset = version === 1 ? 28 : 20;
    if (tkhdData.length >= trackIdOffset + 4) {
      return BjsnUtils.Mp4BoxUtils.readUint32(tkhdData, trackIdOffset);
    }
    return null;
  }

  static findHandlerType(mdiaData) {
    const mdiaChildren = BjsnUtils.Mp4BoxUtils.parseChildBoxes(mdiaData);
    const hdlrBox = mdiaChildren.find(b => b.type === 'hdlr');
    if (hdlrBox && hdlrBox.data.length >= 24) {
      return BjsnUtils.Mp4BoxUtils.getBoxType(hdlrBox.data, 16);
    }
    return null;
  }

  static createInitSegmentForTrack(ftypData, moovData, trackId, allTracks) {
    const filteredMoov = BjsnUtils.BjsnMp4Processor.filterMoovForTrack(moovData, trackId, allTracks);
    const initSegment = new Uint8Array(ftypData.length + filteredMoov.length);
    initSegment.set(ftypData, 0);
    initSegment.set(filteredMoov, ftypData.length);
    return initSegment;
  }

  static filterMoovForTrack(moovData, trackId, allTracks) {
      const moovChildren = BjsnUtils.Mp4BoxUtils.parseChildBoxes(moovData);
      const filteredChildren = [];
      moovChildren.forEach(child => {
          if (child.type !== 'trak' && child.type !== 'mvex') {
              filteredChildren.push(child.data);
          } else if (child.type === 'trak') {
              const currentTrackId = BjsnUtils.BjsnMp4Processor.getTrackIdFromTrak(child.data);
              if (currentTrackId === trackId) {
                  filteredChildren.push(child.data);
              }
          } else if (child.type === 'mvex') {
              // Keep mvex, but filter trex inside
              const mvexChildren = BjsnUtils.Mp4BoxUtils.parseChildBoxes(child.data);
              const filteredTrex = mvexChildren.filter(trex => {
                  if (trex.type === 'trex') {
                      const trexTrackId = BjsnUtils.Mp4BoxUtils.readUint32(trex.data, 12);
                      return trexTrackId === trackId;
                  }
                  return true; // keep other boxes inside mvex
              });
              const newMvexPayload = new Uint8Array(filteredTrex.reduce((s, b) => s + b.data.length, 0));
              let offset = 0;
              filteredTrex.forEach(b => {
                  newMvexPayload.set(b.data, offset);
                  offset += b.data.length;
              });

              const newMvex = new Uint8Array(8 + newMvexPayload.length);
              BjsnUtils.Mp4BoxUtils.writeUint32(newMvex, 0, newMvex.length);
              newMvex[4] = 'm'.charCodeAt(0);
              newMvex[5] = 'v'.charCodeAt(0);
              newMvex[6] = 'e'.charCodeAt(0);
              newMvex[7] = 'x'.charCodeAt(0);
              newMvex.set(newMvexPayload, 8);
              filteredChildren.push(newMvex);
          }
      });

      const payloadSize = filteredChildren.reduce((sum, child) => sum + child.length, 0);
      const payload = new Uint8Array(payloadSize);
      let offset = 0;
      filteredChildren.forEach(child => {
          payload.set(child, offset);
          offset += child.length;
      });

      const newMoov = new Uint8Array(8 + payload.length);
      BjsnUtils.Mp4BoxUtils.writeUint32(newMoov, 0, newMoov.length);
      newMoov[4] = 'm'.charCodeAt(0);
      newMoov[5] = 'o'.charCodeAt(0);
      newMoov[6] = 'o'.charCodeAt(0);
      newMoov[7] = 'v'.charCodeAt(0);
      newMoov.set(payload, 8);
      return newMoov;
  }

  static getTrackIdFromTrak(trakData) {
      const tkhdBox = BjsnUtils.Mp4BoxUtils.parseChildBoxes(trakData).find(b => b.type === 'tkhd');
      if (tkhdBox) {
          return BjsnUtils.BjsnMp4Processor.parseTrackId(tkhdBox.data);
      }
      return null;
  }

  static groupMediaSegmentsByTrack(moofBoxes, mdatBoxes, tracks) {
    const mediaSegments = {};
    tracks.forEach(t => mediaSegments[t.id] = []);

    if (moofBoxes.length !== mdatBoxes.length) {
        console.log('Warning: moof and mdat box counts do not match.');
    }

    for (let i = 0; i < moofBoxes.length; i++) {
        const moof = moofBoxes[i];
        const mdat = mdatBoxes[i];
        const trackId = BjsnUtils.BjsnMp4Processor.getTrackIdFromMoof(moof.data);
        if (trackId && mediaSegments[trackId]) {
            const segmentData = new Uint8Array(moof.size + mdat.size);
            segmentData.set(moof.data, 0);
            segmentData.set(mdat.data, moof.size);
            mediaSegments[trackId].push(segmentData);
        }
    }
    return mediaSegments;
  }

  static getTrackIdFromMoof(moofData) {
      const trafBox = BjsnUtils.Mp4BoxUtils.parseChildBoxes(moofData).find(b => b.type === 'traf');
      if (trafBox) {
          const tfhdBox = BjsnUtils.Mp4BoxUtils.parseChildBoxes(trafBox.data).find(b => b.type === 'tfhd');
          if (tfhdBox) {
              // A 'tfhd' box is a "full box" which contains a version and flags.
              // The track_ID is after the 8-byte box header, 1-byte version, and 3-byte flags.
              const trackIdOffset = 8 + 4;
              if (tfhdBox.data.length >= trackIdOffset + 4) {
                return BjsnUtils.Mp4BoxUtils.readUint32(tfhdBox.data, trackIdOffset);
              }
          }
      }
      return null;
  }
};

/**
 * Progressive MP4 parser for early extraction of BJSN and init segments
 */
BjsnUtils.ProgressiveMp4Parser = class {
  constructor(onMediaSegmentCallback, onBjsnDataCallback, onInitSegmentsCallback) {
    this.buffer = new Uint8Array(0);
    this.parsedBoxes = [];
    this.bjsnData = null;
    this.ftypBox = null;
    this.moovBox = null;
    this.foundAllInit = false;
    this.onMediaSegmentCallback = onMediaSegmentCallback;
    this.onBjsnDataCallback = onBjsnDataCallback;
    this.onInitSegmentsCallback = onInitSegmentsCallback;
    this.pendingMoof = null;
    this.tracks = null;
    
    // Track callback states
    this.bjsnDataSent = false;
    this.initSegmentsSent = false;
    this.pendingMediaSegments = []; // Queue for media segments waiting for init
  }

  appendData(newData) {
    // Append new data to buffer
    const combined = new Uint8Array(this.buffer.length + newData.length);
    combined.set(this.buffer);
    combined.set(newData, this.buffer.length);
    this.buffer = combined;

    // Try to parse more boxes
    this.parseAvailableBoxes();
  }

  parseAvailableBoxes() {
    let offset = 0;
    
    while (offset < this.buffer.length - 8) {
      // Need at least 8 bytes for size and type
      const size = BjsnUtils.Mp4BoxUtils.readUint32(this.buffer, offset);
      const type = BjsnUtils.Mp4BoxUtils.getBoxType(this.buffer, offset + 4);
      
      if (size === 0 || size === 1) {
        // Special cases we don't handle
        break;
      }
      
      if (offset + size > this.buffer.length) {
        // Box not fully available yet
        break;
      }
      
      // Extract complete box
      const boxData = this.buffer.slice(offset, offset + size);
      const box = { type, offset, size, data: boxData };
      this.parsedBoxes.push(box);
      
      // Process specific box types
      if (type === 'bjsn' && !this.bjsnData) {
        this.bjsnData = this.parseBjsnBox(boxData);
        console.log('BJSN box found and parsed early:', this.bjsnData);
        
        // Immediately send via callback
        if (!this.bjsnDataSent && this.onBjsnDataCallback) {
          this.onBjsnDataCallback(this.bjsnData);
          this.bjsnDataSent = true;
          console.log('BJSN data sent via callback');
        }
      } else if (type === 'ftyp' && !this.ftypBox) {
        this.ftypBox = box;
        console.log('ftyp box found, size:', size);
      } else if (type === 'moov' && !this.moovBox) {
        this.moovBox = box;
        console.log('moov box found, size:', size);
        this.foundAllInit = true;
        // Extract tracks info for media segment processing
        this.tracks = BjsnUtils.BjsnMp4Processor.parseTracksFromMoov(this.moovBox.data);
        
        // Process and send init segments via callback
        if (!this.initSegmentsSent && this.onInitSegmentsCallback) {
          const initSegments = {};
          this.tracks.forEach(track => {
            initSegments[track.id] = BjsnUtils.BjsnMp4Processor.createInitSegmentForTrack(
              this.ftypBox.data, 
              this.moovBox.data, 
              track.id, 
              this.tracks
            );
          });
          
          this.onInitSegmentsCallback(initSegments, this.tracks);
          this.initSegmentsSent = true;
          console.log('Init segments sent via callback');
        }
        
        // Process any pending media segments now that init is ready
        this.processPendingMediaSegments();
      } else if (type === 'moof') {
        // Store moof and wait for matching mdat
        this.pendingMoof = box;
      } else if (type === 'mdat' && this.pendingMoof) {
        // We have a complete moof/mdat pair - process it immediately
        this.processMediaSegment(this.pendingMoof, box);
        this.pendingMoof = null;
      }
      
      offset += size;
    }
    
    // Remove parsed data from buffer
    if (offset > 0) {
      this.buffer = this.buffer.slice(offset);
    }
  }

  processMediaSegment(moofBox, mdatBox) {
    if (!this.tracks) return;
    
    // Get track ID from moof
    const trackId = BjsnUtils.BjsnMp4Processor.getTrackIdFromMoof(moofBox.data);
    if (!trackId) return;
    
    // Combine moof and mdat into a single segment
    const segmentData = new Uint8Array(moofBox.size + mdatBox.size);
    segmentData.set(moofBox.data, 0);
    segmentData.set(mdatBox.data, moofBox.size);
    
    // Check if we can process this media segment immediately
    if (this.canProcessMediaSegments()) {
      this.onMediaSegmentCallback(trackId, segmentData);
    } else {
      // Queue the media segment for later processing
      this.pendingMediaSegments.push({
        trackId: trackId,
        segmentData: segmentData
      });
      console.log(`Queued media segment for track ${trackId} (waiting for init segments)`);
    }
  }

  // Check if we're ready to process media segments
  canProcessMediaSegments() {
    return this.initSegmentsSent && this.bjsnDataSent;
  }

  // Process any media segments that were queued waiting for init segments
  processPendingMediaSegments() {
    if (!this.canProcessMediaSegments()) {
      return;
    }
    
    console.log(`Processing ${this.pendingMediaSegments.length} queued media segments`);
    
    // Process all queued segments
    while (this.pendingMediaSegments.length > 0) {
      const { trackId, segmentData } = this.pendingMediaSegments.shift();
      this.onMediaSegmentCallback(trackId, segmentData);
    }
  }

  parseBjsnBox(boxData) {
    try {
      // Skip 8-byte box header
      const jsonData = boxData.slice(8);
      const jsonString = new TextDecoder().decode(jsonData);
      return JSON.parse(jsonString);
    } catch (e) {
      console.log('Failed to parse BJSN box:', e.message);
      return null;
    }
  }

  hasInitSegments() {
    return this.initSegmentsSent && this.ftypBox && this.moovBox;
  }

  // Keep this for backward compatibility
  getInitSegments() {
    if (!this.hasInitSegments()) {
      return null;
    }
    
    // Process and return init segments
    const tracks = this.tracks || BjsnUtils.BjsnMp4Processor.parseTracksFromMoov(this.moovBox.data);
    const initSegments = {};
    
    tracks.forEach(track => {
      initSegments[track.id] = BjsnUtils.BjsnMp4Processor.createInitSegmentForTrack(
        this.ftypBox.data, 
        this.moovBox.data, 
        track.id, 
        tracks
      );
    });
    
    return { tracks, initSegments };
  }

  getRemainingBoxes() {
    // Return all parsed boxes except bjsn, ftyp, moov, and already processed moof/mdat
    return this.parsedBoxes.filter(box => 
      box.type !== 'bjsn' && 
      box.type !== 'ftyp' && 
      box.type !== 'moov' &&
      box.type !== 'moof' &&
      box.type !== 'mdat'
    );
  }
};
