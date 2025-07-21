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
        static async detectCodecsFromSegment(segmentData) {
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
