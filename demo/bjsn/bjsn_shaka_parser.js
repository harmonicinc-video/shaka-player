/**
 * BJSN manifest parser plugin for Shaka Player.
 *
 * This is the demo-level prototype of Phase 3 of
 * docs/design/bjsn-integration-plan-v2.md.  It lets `shaka.Player` play BJSN
 * without a single change to `lib/`, by using three public extension points:
 *
 *   1. `shaka.media.ManifestParser.registerParserByMime()` registers this class
 *      under `application/bjsn`.
 *   2. `InitSegmentReference.setSegmentData()` / `SegmentReference
 *      .setSegmentData()` hand the already-downloaded first file to the
 *      streaming pipeline, so it is never fetched twice.
 *   3. A `NetworkingEngine` response filter strips the `bjsn` box out of
 *      subsequent segments and reads the in-band manifest state back out of
 *      them (plan section 3.5).
 *
 * ## Shape: Option A, one muxed SourceBuffer
 *
 * Per the Phase 1 spike (plan section 3.1) we publish a *single* video Stream
 * whose codec string carries both codecs, e.g.
 * `video/mp4; codecs="avc1.42E01E,mp4a.40.2"`, and leave `variant.audio` null.
 * Shaka creates one SourceBuffer and appends the file verbatim; the browser
 * decodes both tracks out of it.
 *
 * Note what we deliberately do *not* use: `stream.isAudioMuxedInVideo`.  That
 * flag looks like the obvious fit, but it sets `needSplitMuxedContent_` in
 * `media_source_engine.js`, which makes Shaka *demux* into two buffers -- the
 * opposite of Option A, and the HLS-shaped path where v1 hit a bug.  Instead we
 * rely on `stream_utils.js` `getDecodingConfigs_()`, which already handles a
 * comma-separated video codec list with no separate audio stream by building
 * both an AudioConfiguration and a VideoConfiguration for MediaCapabilities.
 * A muxed video-only variant is therefore a first-class shape in Shaka, and
 * needs no core diff.
 *
 * The cost is the one Option A always had: no independent audio track
 * selection, and no per-track ABR.  See plan section 3.1 / Phase 7.
 *
 * ## Timeline
 *
 * BJSN media time does not start at zero (the real capture starts at ~2333 s),
 * so per plan section 3.4 we leave the media timeline alone and move the
 * presentation timeline to meet it: `timestampOffset` stays 0, references carry
 * real media times, and `setUserSeekStart(t0)` puts the bottom of the seek
 * range at the first sample.  For a dynamic stream `notifySegments()` does the
 * rest: with a non-null presentation start time and `autoCorrectDrift`, it
 * recomputes the start time from the segment end times on every call, which
 * lands the live edge exactly on the end of the last known segment.
 *
 * @author Harmonic Inc
 */

/**
 * The mime type this parser registers under.  Pass it as the third argument to
 * `player.load()`, since a `.mp4` URL would otherwise be treated as progressive
 * src= content.
 *
 * @const {string}
 */
const BJSN_MIME_TYPE = 'application/bjsn';

/**
 * Splits a whole BJSN file into the pieces Shaka wants, and reads its `bjsn`
 * box.  Every BJSN segment carries `ftyp`+`moov`+`bjsn`+`styp`+fragments
 * (plan section 2b), so this is the same operation for the first file and for
 * every subsequent one.
 */
class BjsnSegmentBytes {
  /**
   * @param {!Uint8Array} bytes A complete BJSN file.
   * @return {{
   *   init: ?Uint8Array,
   *   media: ?Uint8Array,
   *   bjsn: ?Object,
   *   boxes: !Array<{type: string, offset: number, size: number}>
   * }}
   *   `init` is `ftyp`+`moov` concatenated -- the init segment for Option A,
   *   used unfiltered because a single muxed buffer wants both `trak`s.
   *   `media` is everything from the first `styp`/`moof` onwards, which drops
   *   the `bjsn` box and the redundant init that every segment repeats.
   */
  static split(bytes) {
    const boxes = BjsnUtils.Mp4BoxUtils.parseTopLevelBoxes(bytes);

    const initParts = [];
    let mediaStart = null;
    let bjsnBox = null;

    for (const box of boxes) {
      if (box.type === 'ftyp' || box.type === 'moov') {
        // Keep file order rather than assuming ftyp precedes moov.
        initParts.push(box.data);
      } else if (box.type === 'bjsn') {
        bjsnBox = box;
      } else if (mediaStart === null &&
                 (box.type === 'styp' || box.type === 'moof')) {
        // Slice from here to the end instead of reassembling: the remainder of
        // a BJSN file is contiguous styp + moof/mdat pairs, and `styp` must
        // survive (the Phase 1 spike found MSE accepts it, and a box filter
        // that silently dropped it would be a subtle bug).
        mediaStart = box.offset;
      }
    }

    let init = null;
    if (initParts.length) {
      const total = initParts.reduce((sum, part) => sum + part.length, 0);
      init = new Uint8Array(total);
      let offset = 0;
      for (const part of initParts) {
        init.set(part, offset);
        offset += part.length;
      }
    }

    let bjsn = null;
    if (bjsnBox) {
      try {
        bjsn = JSON.parse(
            new TextDecoder().decode(bjsnBox.data.subarray(8)));
      } catch (e) {
        bjsn = null;
      }
    }

    return {
      init,
      media: mediaStart === null ? null : bytes.subarray(mediaStart),
      bjsn,
      boxes: boxes.map((b) => ({type: b.type, offset: b.offset, size: b.size})),
    };
  }

  /**
   * Reads the presentation-time span of a file from its fragments' `tfdt`
   * boxes, per track.
   *
   * @param {!Uint8Array} bytes
   * @param {!Object<number, number>} timescaleByTrackId
   * @return {{
   *   t0: ?number,
   *   duration: ?number,
   *   perTrack: !Object<number, {first: number, last: number, count: number}>
   * }}
   */
  static timing(bytes, timescaleByTrackId) {
    const boxes = BjsnUtils.Mp4BoxUtils.parseTopLevelBoxes(bytes);
    /** @type {!Object<number, !Array<number>>} */
    const timesByTrack = {};

    for (const box of boxes) {
      if (box.type !== 'moof') {
        continue;
      }
      const trackId = BjsnUtils.BjsnMp4Processor.getTrackIdFromMoof(box.data);
      const baseTime = BjsnUtils.Mp4BoxUtils.extractBaseMediaDecodeTime(
          box.data);
      const timescale = timescaleByTrackId[trackId];
      if (trackId == null || baseTime == null || !timescale) {
        continue;
      }
      if (!timesByTrack[trackId]) {
        timesByTrack[trackId] = [];
      }
      timesByTrack[trackId].push(baseTime / timescale);
    }

    const perTrack = {};
    let t0 = null;
    let duration = null;

    for (const trackId of Object.keys(timesByTrack)) {
      const times = timesByTrack[trackId];
      times.sort((a, b) => a - b);
      const first = times[0];
      const last = times[times.length - 1];
      perTrack[trackId] = {first, last, count: times.length};

      // t0 is the *minimum* across tracks: the spike measured ~10 ms of A/V
      // start skew in the real capture, so the tracks do not begin on the same
      // tick (plan section 3.1).
      t0 = t0 === null ? first : Math.min(t0, first);

      // The span covered by the fragments we can see, plus one more fragment's
      // worth to account for the last fragment's own duration.  The real
      // capture has 30 video fragments across ~2.007 s, so the median gap is
      // accurate to a frame.  This is the plan's `tfdt`-derivation fallback;
      // the authoritative source is the `Last-Segment-Duration` header, which
      // arrives one segment late and so cannot size the first segment.
      if (times.length >= 2) {
        const gaps = [];
        for (let i = 1; i < times.length; i++) {
          gaps.push(times[i] - times[i - 1]);
        }
        gaps.sort((a, b) => a - b);
        const medianGap = gaps[Math.floor(gaps.length / 2)];
        const span = (last - first) + medianGap;
        duration = duration === null ? span : Math.max(duration, span);
      }
    }

    return {t0, duration, perTrack};
  }

  /**
   * Pulls the display and audio parameters out of a `moov` so the UI and
   * Shaka's capability checks have real numbers instead of fallbacks.
   *
   * @param {!Uint8Array} moovData
   * @return {{
   *   width: ?number, height: ?number,
   *   channelCount: ?number, sampleRate: ?number
   * }}
   */
  static describeMoov(moovData) {
    const Utils = BjsnUtils.Mp4BoxUtils;
    const result = {
      width: null, height: null, channelCount: null, sampleRate: null,
    };

    for (const trak of Utils.parseChildBoxes(moovData)) {
      if (trak.type !== 'trak') {
        continue;
      }
      const mdia = Utils.parseChildBoxes(trak.data)
          .find((b) => b.type === 'mdia');
      if (!mdia) {
        continue;
      }
      const handlerType = BjsnUtils.BjsnMp4Processor.findHandlerType(mdia.data);
      const minf = Utils.parseChildBoxes(mdia.data)
          .find((b) => b.type === 'minf');
      if (!minf) {
        continue;
      }
      const stbl = Utils.parseChildBoxes(minf.data)
          .find((b) => b.type === 'stbl');
      if (!stbl) {
        continue;
      }
      const stsd = Utils.parseChildBoxes(stbl.data)
          .find((b) => b.type === 'stsd');
      if (!stsd) {
        continue;
      }
      // stsd payload: 8 header + 4 version/flags + 4 entry_count, then the
      // first sample entry (itself an 8-byte-headed box).
      const entry = stsd.data.subarray(16);
      if (entry.length < 8) {
        continue;
      }
      const sampleEntry = entry.subarray(8);

      if (handlerType === 'vide' && sampleEntry.length >= 32) {
        // VisualSampleEntry: 6 reserved + 2 data_reference_index +
        // 16 pre_defined/reserved, then 2-byte width and 2-byte height.
        result.width = (sampleEntry[24] << 8) | sampleEntry[25];
        result.height = (sampleEntry[26] << 8) | sampleEntry[27];
      } else if (handlerType === 'soun' && sampleEntry.length >= 20) {
        // AudioSampleEntry: 6 reserved + 2 data_reference_index +
        // 8 reserved, then 2-byte channelcount, 2-byte samplesize,
        // 2-byte pre_defined, 2-byte reserved, 4-byte samplerate (16.16).
        result.channelCount = (sampleEntry[16] << 8) | sampleEntry[17];
        result.sampleRate = (sampleEntry[24] << 8) | sampleEntry[25];
      }
    }

    return result;
  }
}

/**
 * A minimal resolvable promise, so `start()` can resolve on `bjsn`+`moov`
 * while the rest of the first file is still downloading.
 */
class BjsnDeferred {
  constructor() {
    this.resolved = false;
    this.promise = new Promise((resolve, reject) => {
      this.resolve_ = resolve;
      this.reject_ = reject;
    });
    // Nothing waits on a rejection until `await`, so keep it from being an
    // unhandled rejection in the meantime.
    this.promise.catch(() => {});
  }

  /** @param {*=} value */
  resolve(value) {
    if (!this.resolved) {
      this.resolved = true;
      this.resolve_(value);
    }
  }

  /** @param {*} error */
  reject(error) {
    if (!this.resolved) {
      this.resolved = true;
      this.reject_(error);
    }
  }
}

/**
 * `shaka.extern.ManifestParser` for BJSN.
 *
 * Nothing in the class body touches `shaka.*` at definition time, so this file
 * can be loaded as a plain script before the Closure debug loader has finished
 * pulling in the library.  Call `BjsnShakaParser.register()` once
 * `window.shaka` exists.
 */
class BjsnShakaParser {
  constructor() {
    /** @private {?shaka.extern.ManifestConfiguration} */
    this.config_ = null;
    /** @private {?shaka.extern.ManifestParser.PlayerInterface} */
    this.playerInterface_ = null;
    /** @private {?string} */
    this.uri_ = null;
    /** @private {?URL} */
    this.baseUri_ = null;

    /** @private {?shaka.extern.Manifest} */
    this.manifest_ = null;
    /** @private {?shaka.media.PresentationTimeline} */
    this.timeline_ = null;
    /** @private {?shaka.extern.Stream} */
    this.stream_ = null;
    /** @private {?shaka.media.SegmentIndex} */
    this.segmentIndex_ = null;
    /** @private {?shaka.media.InitSegmentReference} */
    this.initReference_ = null;

    /** Parsed `bjsn` box of the most recent segment seen. @private */
    this.bjsn_ = null;
    /** @private {?Array<!Object>} Tracks read out of `moov`. */
    this.tracks_ = null;
    /** @private {?Uint8Array} `ftyp`+`moov` of the first file. */
    this.initBytes_ = null;
    /** @private {?Uint8Array} The complete first file. */
    this.firstFileBytes_ = null;
    /** @private {?number} */
    this.t0_ = null;
    /** @private {?number} */
    this.segmentDuration_ = null;
    /** @private {?number} Duration reported by `Last-Segment-Duration`, in s. */
    this.reportedDuration_ = null;
    /** @private {?number} The seq_num of the last reference we published. */
    this.lastSeqNum_ = null;
    /** @private {?number} The end time of the last reference we published. */
    this.lastEndTime_ = null;
    /**
     * The highest seq_num we have actually seen arrive, read from the in-band
     * `bjsn` box.  Publishing references beyond this + 1 would advertise
     * segments the origin has not produced.
     *
     * @private {?number}
     */
    this.receivedSeqNum_ = null;
    /**
     * The end time, in real media time, of the last segment that arrived.  Used
     * to anchor the next reference instead of accumulating duration estimates,
     * which would drift over a long run.
     *
     * @private {?number}
     */
    this.receivedEndTime_ = null;
    /** @private {number} Consecutive ticks spent waiting for a segment. */
    this.waitingTicks_ = 0;

    /** @private {?BjsnDeferred} Resolves once the manifest can be built. */
    this.ready_ = null;
    /** @private {?BjsnDeferred} Resolves once the first file is complete. */
    this.firstFileComplete_ = null;
    /** @private {?shaka.util.AbortableOperation} */
    this.operation_ = null;
    /** @private {?number} setTimeout handle for the live loop. */
    this.updateTimer_ = null;
    /** @private {?function(!shaka.extern.Response)} */
    this.responseFilter_ = null;
    /** @private {boolean} */
    this.stopped_ = false;

    /**
     * Optional observer, set by the demo page, so the UI can time the parse
     * steps that only the parser can see.  Free functions, all optional.
     *
     * @type {{
     *   onFirstByte: (function()|undefined),
     *   onBjsn: (function(!Object)|undefined),
     *   onInit: (function(!Array<!Object>, !Object)|undefined),
     *   onManifest: (function(!Object)|undefined),
     *   onSegmentAdded: (function(number, number, number)|undefined),
     *   onSegmentResponse: (function(string, !Object)|undefined),
     *   onLog: (function(string, ...*)|undefined)
     * }}
     */
    this.hooks = BjsnShakaParser.hooks;
  }

  /**
   * @param {shaka.extern.ManifestConfiguration} config
   * @param {(function():boolean)=} isPreloadFn
   */
  configure(config, isPreloadFn) {
    this.config_ = config;
  }

  /**
   * @param {string} uri
   * @param {shaka.extern.ManifestParser.PlayerInterface} playerInterface
   * @return {!Promise<shaka.extern.Manifest>}
   */
  async start(uri, playerInterface) {
    this.uri_ = uri;
    this.playerInterface_ = playerInterface;
    this.baseUri_ = new URL(uri, location.href);
    this.ready_ = new BjsnDeferred();
    this.firstFileComplete_ = new BjsnDeferred();

    this.installResponseFilter_();

    const progressive = new BjsnUtils.ProgressiveMp4Parser(
        (trackId, fragment) => this.onFragment_(trackId, fragment),
        (bjsn) => this.onBjsn_(bjsn),
        (initSegments, tracks) => this.onMoov_(progressive, tracks));

    const RequestType = shaka.net.NetworkingEngine.RequestType;
    const request = shaka.net.NetworkingEngine.makeRequest(
        [uri], this.config_.retryParameters);

    // Parse as the bytes arrive so `start()` can resolve on bjsn+moov rather
    // than on the whole file -- this is where the startup latency parity with
    // the standalone player comes from.  The fetch plugin clones the response
    // for streaming, so `response.data` below is still the complete body.
    let sawChunk = false;
    request.streamDataCallback = async (chunk) => {
      if (this.stopped_) {
        return;
      }
      if (!sawChunk) {
        sawChunk = true;
        this.log_('first byte of initial file');
        this.fire_('onFirstByte');
      }
      progressive.appendData(BjsnTimingProbe.asUint8Array(chunk));
    };

    this.operation_ = playerInterface.networkingEngine.request(
        RequestType.MANIFEST, request);

    this.operation_.promise.then((response) => {
      if (this.stopped_) {
        return;
      }
      this.firstFileBytes_ = BjsnTimingProbe.asUint8Array(response.data);
      // Not every network plugin supports streaming (the XHR plugin does not).
      // If we never saw a chunk, feed the whole body now so the same callbacks
      // fire and everything downstream is unchanged.
      if (!sawChunk) {
        this.log_('no progressive chunks; parsing the complete file');
        this.fire_('onFirstByte');
        progressive.appendData(this.firstFileBytes_);
      }
      this.readLastSegmentDuration_(response);
      this.firstFileComplete_.resolve();
      // Guard against a file that somehow lacked bjsn or moov: without this,
      // `start()` would hang instead of failing.
      if (!this.ready_.resolved) {
        this.ready_.reject(this.error_(
            'BJSN file is missing a bjsn box or a moov box'));
      }
    }, (error) => {
      this.ready_.reject(error);
      this.firstFileComplete_.reject(error);
    });

    await this.ready_.promise;
    return this.manifest_;
  }

  /** @return {!Promise} */
  async stop() {
    this.stopped_ = true;
    if (this.updateTimer_ !== null) {
      clearTimeout(this.updateTimer_);
      this.updateTimer_ = null;
    }
    if (this.responseFilter_ && this.playerInterface_) {
      this.playerInterface_.networkingEngine.unregisterResponseFilter(
          this.responseFilter_);
      this.responseFilter_ = null;
    }
    if (this.ready_ && !this.ready_.resolved) {
      this.ready_.reject(this.abortError_());
    }
    if (this.operation_) {
      const operation = this.operation_;
      this.operation_ = null;
      try {
        await operation.abort();
      } catch (e) {
        // Aborting a finished operation is not an error worth surfacing.
      }
    }
    this.playerInterface_ = null;
    this.config_ = null;
  }

  /** Shaka calls this when an `emsg` box asks for a manifest refresh. */
  update() {
    this.addNextReference_();
  }

  /**
   * @param {string} sessionId
   * @param {number} expiration
   */
  onExpirationUpdated(sessionId, expiration) {}

  /** @param {shaka.extern.Variant} variant */
  onInitialVariantChosen(variant) {}

  /** @param {string} uri */
  banLocation(uri) {}

  /** @param {HTMLMediaElement} mediaElement */
  setMediaElement(mediaElement) {}

  // ---------------------------------------------------------------- parsing

  /**
   * @param {!Object} bjsn
   * @private
   */
  onBjsn_(bjsn) {
    if (!bjsn) {
      return;
    }
    this.bjsn_ = bjsn;
    this.log_(`bjsn box parsed: seq_num=${bjsn.seq_num} ` +
        `type=${bjsn.type} template=${bjsn.template_path}`);
    this.fire_('onBjsn', bjsn);
    this.maybeBuildManifest_();
  }

  /**
   * @param {!BjsnUtils.ProgressiveMp4Parser} progressive
   * @param {!Array<!Object>} tracks
   * @private
   */
  onMoov_(progressive, tracks) {
    this.tracks_ = tracks;

    // Option A wants the moov unfiltered: one buffer, both traks.  We take the
    // raw ftyp and moov off the progressive parser rather than using the
    // per-track init segments it synthesises, which Option A does not need.
    const ftyp = progressive.ftypBox ? progressive.ftypBox.data : null;
    const moov = progressive.moovBox ? progressive.moovBox.data : null;
    if (ftyp && moov) {
      this.initBytes_ = new Uint8Array(ftyp.length + moov.length);
      this.initBytes_.set(ftyp, 0);
      this.initBytes_.set(moov, ftyp.length);
    }

    this.codecs_ = BjsnUtils.BjsnCodecDetector.detectCodecsFromSegment(
        this.initBytes_ || moov);
    this.mediaParams_ = moov ?
        BjsnSegmentBytes.describeMoov(moov) :
        {width: null, height: null, channelCount: null, sampleRate: null};

    this.log_('moov parsed', {
      tracks: tracks.map((t) => ({
        id: t.id, handlerType: t.handlerType, timescale: t.timescale,
      })),
      codecs: this.codecs_,
      params: this.mediaParams_,
    });
    this.fire_('onInit', tracks, {
      codecs: this.codecs_,
      params: this.mediaParams_,
      initBytes: this.initBytes_ ? this.initBytes_.length : 0,
    });
    this.maybeBuildManifest_();
  }

  /**
   * Fragments arrive here purely so we can learn `t0` -- the media time the
   * presentation actually starts at -- before the whole file has downloaded.
   * The bytes themselves are not used: Shaka appends whole segments.
   *
   * @param {number} trackId
   * @param {!Uint8Array} fragment
   * @private
   */
  onFragment_(trackId, fragment) {
    if (!this.tracks_) {
      return;
    }
    const track = this.tracks_.find((t) => t.id === trackId);
    if (!track || !track.timescale) {
      return;
    }
    const baseTime = BjsnUtils.Mp4BoxUtils.extractBaseMediaDecodeTime(fragment);
    if (baseTime == null) {
      return;
    }
    const mediaTime = baseTime / track.timescale;

    if (!this.firstFragmentTimes_) {
      /** @private {!Object<number, number>} */
      this.firstFragmentTimes_ = {};
    }
    if (this.firstFragmentTimes_[trackId] === undefined) {
      this.firstFragmentTimes_[trackId] = mediaTime;
      this.log_(`first ${track.handlerType} fragment at ` +
          `${mediaTime.toFixed(3)}s (track ${trackId})`);
      this.maybeBuildManifest_();
    }
  }

  /**
   * Build the manifest as soon as we know enough: the `bjsn` box, the `moov`,
   * and the first fragment of every track (which gives `t0`).  All of that sits
   * in the first couple of KB of the file, so this resolves long before the
   * download finishes.
   *
   * @private
   */
  maybeBuildManifest_() {
    if (this.manifest_ || this.stopped_) {
      return;
    }
    if (!this.bjsn_ || !this.tracks_ || !this.initBytes_) {
      return;
    }
    const times = this.firstFragmentTimes_ || {};
    const haveAllTracks = this.tracks_.every(
        (t) => times[t.id] !== undefined);
    if (!haveAllTracks) {
      return;
    }

    this.t0_ = Math.min(...this.tracks_.map((t) => times[t.id]));
    this.manifest_ = this.buildManifest_();
    this.log_(`manifest built: t0=${this.t0_.toFixed(3)}s ` +
        `live=${this.timeline_.isLive()}`);
    this.fire_('onManifest', {
      t0: this.t0_,
      isLive: this.timeline_.isLive(),
      codecs: this.stream_.codecs,
      mimeType: this.stream_.mimeType,
    });
    this.ready_.resolve();
  }

  /**
   * @return {!shaka.extern.Manifest}
   * @private
   */
  buildManifest_() {
    const ContentType = shaka.util.ManifestParserUtils.ContentType;
    const MimeUtils = shaka.util.MimeUtils;

    const isDynamic = this.bjsn_.type === 'dynamic';

    // A non-null presentation start time is required for a live timeline to
    // compute a live edge at all.  The value does not matter: with
    // autoCorrectDrift on, every notifySegments() recomputes it from the
    // segment end times, which is what puts the live edge on our media clock
    // instead of on wall-clock zero.
    this.timeline_ = new shaka.media.PresentationTimeline(
        /* presentationStartTime= */ 0,
        /* presentationDelay= */ 0,
        /* autoCorrectDrift= */ true);
    this.timeline_.setStatic(!isDynamic);
    // The CDN keeps segments for at least 10 s (plan section 2b), but nothing
    // forces us to evict, and evicting is how a prototype gets mysterious seek
    // failures.  Keep everything and bound the bottom with userSeekStart.
    this.timeline_.setSegmentAvailabilityDuration(Infinity);
    this.timeline_.setUserSeekStart(this.t0_);

    const videoCodec = this.codecs_.video;
    const audioCodec = this.codecs_.audio;
    // One Stream, both codecs.  See the file header for why this, and not
    // isAudioMuxedInVideo.
    const codecs = [videoCodec, audioCodec].filter(Boolean).join(',');
    const mimeType = 'video/mp4';

    const videoTrack = this.tracks_.find((t) => t.handlerType === 'vide');
    const audioTrack = this.tracks_.find((t) => t.handlerType === 'soun');

    // Bandwidth: prefer the gear the bjsn box says we are on.  gear_list is a
    // list of single-key objects, e.g. [{"hd": {"realtime_bitrate": 2000000}}].
    let bandwidth = 0;
    if (Array.isArray(this.bjsn_.gear_list) && this.bjsn_.gear_list.length) {
      const first = this.bjsn_.gear_list[0];
      const gearName = Object.keys(first)[0];
      if (gearName && first[gearName]) {
        bandwidth = first[gearName].realtime_bitrate || 0;
      }
    }

    const stream = {
      id: 1,
      originalId: 'bjsn-muxed',
      groupId: null,
      createSegmentIndex: () => this.createSegmentIndex_(),
      closeSegmentIndex: undefined,
      segmentIndex: null,
      mimeType,
      codecs,
      frameRate: undefined,
      pixelAspectRatio: undefined,
      hdr: undefined,
      colorGamut: undefined,
      videoLayout: undefined,
      bandwidth: bandwidth || undefined,
      width: this.mediaParams_.width || undefined,
      height: this.mediaParams_.height || undefined,
      kind: undefined,
      encrypted: false,
      drmInfos: [],
      keyIds: new Set(),
      language: 'und',
      originalLanguage: null,
      label: 'BJSN muxed (video+audio)',
      type: ContentType.VIDEO,
      primary: true,
      trickModeVideo: null,
      dependencyStream: null,
      emsgSchemeIdUris: null,
      roles: [],
      accessibilityPurpose: null,
      forced: false,
      channelsCount: this.mediaParams_.channelCount || null,
      audioSamplingRate: this.mediaParams_.sampleRate ||
          (audioTrack ? audioTrack.timescale : null),
      spatialAudio: false,
      closedCaptions: new Map(),
      tilesLayout: undefined,
      matchedStreams: undefined,
      mssPrivateData: undefined,
      external: false,
      fastSwitching: false,
      fullMimeTypes: new Set([MimeUtils.getFullType(mimeType, codecs)]),
      // Deliberately false; see the file header.
      isAudioMuxedInVideo: false,
      baseOriginalId: null,
    };
    this.stream_ = stream;

    const variant = {
      id: 1,
      language: 'und',
      disabledUntilTime: 0,
      primary: true,
      // Null, so stream_utils' multiplexed-codec path builds both an audio and
      // a video MediaCapabilities configuration from the codec list above.
      audio: null,
      video: stream,
      bandwidth: bandwidth || 0,
      allowedByApplication: true,
      allowedByKeySystem: true,
      decodingInfos: [],
    };

    return {
      presentationTimeline: this.timeline_,
      variants: [variant],
      textStreams: [],
      imageStreams: [],
      offlineSessionIds: [],
      // False: we want real media timestamps, which is the whole point of
      // section 3.4.  Sequence mode would throw away the timeline we are
      // carefully preserving.
      sequenceMode: false,
      ignoreManifestTimestampsInSegmentsMode: false,
      type: 'BJSN',
      serviceDescription: null,
      nextUrl: null,
      periodCount: 1,
      gapCount: 0,
      isLowLatency: false,
      // Start on the segment we have already downloaded, not at the live edge.
      //
      // At manifest time the index holds exactly one reference, so the live
      // edge *is* that segment's end time -- and a live stream starts at the
      // live edge, which means Shaka would skip straight past the file the user
      // asked for and begin at seq_num+1.  That both wastes the bytes we
      // retained for `setSegmentData()` and makes startup slower than the
      // standalone player, which starts at `buffered.start(0)`.
      startTime: this.t0_,
    };
  }

  /**
   * Shaka calls this once, before it uses the segment index.  We use it as the
   * join point for the rest of the first file: by the time the index exists,
   * the bytes are in hand and can be attached to the first reference, so the
   * streaming pipeline never downloads the file a second time.
   *
   * @return {!Promise}
   * @private
   */
  async createSegmentIndex_() {
    await this.firstFileComplete_.promise;
    if (this.stopped_) {
      return;
    }
    if (this.segmentIndex_) {
      this.stream_.segmentIndex = this.segmentIndex_;
      return;
    }

    const timescaleByTrackId = {};
    for (const track of this.tracks_) {
      timescaleByTrackId[track.id] = track.timescale;
    }
    const timing = BjsnSegmentBytes.timing(
        this.firstFileBytes_, timescaleByTrackId);
    this.segmentDuration_ =
        this.reportedDuration_ || timing.duration || 2.0;
    this.log_(`segment duration ${this.segmentDuration_.toFixed(3)}s ` +
        `(${this.reportedDuration_ ? 'Last-Segment-Duration header' :
            'derived from tfdt deltas'})`, timing.perTrack);

    const split = BjsnSegmentBytes.split(this.firstFileBytes_);

    this.initReference_ = new shaka.media.InitSegmentReference(
        () => [this.uri_], /* startByte= */ 0, /* endByte= */ null);
    // No network request: Shaka's fetch path checks getSegmentData() first.
    this.initReference_.setSegmentData(this.initBytes_);

    const seqNum = this.bjsn_.seq_num;
    const reference = this.makeReference_(
        seqNum, this.t0_, this.t0_ + this.segmentDuration_, this.uri_);
    // The media-only slice, so the redundant ftyp+moov that every BJSN segment
    // carries is not appended a second time on top of the init segment.
    reference.setSegmentData(split.media || this.firstFileBytes_);

    this.segmentIndex_ = new shaka.media.SegmentIndex([reference]);
    this.stream_.segmentIndex = this.segmentIndex_;
    this.lastSeqNum_ = seqNum;
    this.lastEndTime_ = reference.endTime;
    // This one is already in hand, so it counts as received.
    this.receivedSeqNum_ = seqNum;
    this.receivedEndTime_ = reference.endTime;
    this.timeline_.notifySegments([reference]);
    this.fire_('onSegmentAdded', seqNum, reference.startTime, reference.endTime);

    if (this.timeline_.isLive()) {
      this.scheduleNextReference_(0);
    } else {
      this.timeline_.setDuration(reference.endTime);
    }
  }

  /**
   * @param {number} seqNum
   * @param {number} startTime
   * @param {number} endTime
   * @param {string} uri
   * @return {!shaka.media.SegmentReference}
   * @private
   */
  makeReference_(seqNum, startTime, endTime, uri) {
    return new shaka.media.SegmentReference(
        startTime,
        endTime,
        () => [uri],
        /* startByte= */ 0,
        /* endByte= */ null,
        this.initReference_,
        // Zero: the media timeline is left alone and the presentation timeline
        // was moved to meet it instead (plan section 3.4).
        /* timestampOffset= */ 0,
        /* appendWindowStart= */ 0,
        /* appendWindowEnd= */ Infinity);
  }

  /**
   * @param {number} seqNum
   * @return {string}
   * @private
   */
  uriForSeqNum_(seqNum) {
    const file = String(this.bjsn_.template_path)
        .replace('${num}', String(seqNum));
    return new URL(file, this.baseUri_).href;
  }

  /**
   * Grow the index one segment at a time, paced at roughly the segment
   * duration.  Adding references faster than the origin publishes them would
   * just make Shaka request segments that do not exist yet.
   *
   * @param {number} delayMs
   * @private
   */
  scheduleNextReference_(delayMs) {
    if (this.stopped_ || this.updateTimer_ !== null) {
      return;
    }
    this.updateTimer_ = setTimeout(() => {
      this.updateTimer_ = null;
      this.addNextReference_();
      if (!this.stopped_) {
        this.scheduleNextReference_(this.segmentDuration_ * 1000);
      }
    }, delayMs);
  }

  /** @private */
  addNextReference_() {
    if (this.stopped_ || !this.segmentIndex_ || !this.timeline_.isLive()) {
      return;
    }

    // Never advertise more than one segment the origin has not confirmed.
    //
    // Publishing a reference on a fixed timer regardless of what exists lets
    // the presentation timeline run away from the content: `notifySegments()`
    // pushes the live edge out with every reference, so the play head chases an
    // edge that has no media behind it while every fetch 404s.  A live origin
    // that pauses publication produces exactly that.  Instead we keep at most
    // one reference outstanding and wait for it to arrive, which is what the
    // standalone player does by only advancing seq_num on a successful fetch.
    if (this.receivedSeqNum_ !== null &&
        this.lastSeqNum_ > this.receivedSeqNum_) {
      this.waitingTicks_++;
      // Log sparsely: this is the normal state while waiting for the next
      // segment to be published, and it is also what a dead origin looks like.
      if (this.waitingTicks_ === 1 || this.waitingTicks_ % 10 === 0) {
        this.log_(`waiting for seq ${this.lastSeqNum_} to be published ` +
            `(${this.waitingTicks_} tick${this.waitingTicks_ === 1 ? '' : 's'})`);
      }
      return;
    }
    this.waitingTicks_ = 0;

    const seqNum = this.lastSeqNum_ + 1;
    // Anchor to the real media time of the last segment that arrived, so a long
    // run cannot accumulate error from the duration estimate.
    const startTime = this.receivedEndTime_ !== null ?
        this.receivedEndTime_ : this.lastEndTime_;
    const duration = this.reportedDuration_ || this.segmentDuration_;
    const reference = this.makeReference_(
        seqNum, startTime, startTime + duration, this.uriForSeqNum_(seqNum));

    this.segmentIndex_.merge([reference]);
    this.lastSeqNum_ = seqNum;
    this.lastEndTime_ = reference.endTime;
    // Moves the live edge to this segment's end time; see buildManifest_.
    this.timeline_.notifySegments([reference]);
    this.log_(`added reference seq=${seqNum} ` +
        `[${reference.startTime.toFixed(3)} - ` +
        `${reference.endTime.toFixed(3)}]`);
    this.fire_('onSegmentAdded', seqNum, reference.startTime,
        reference.endTime);

    if (this.playerInterface_) {
      this.playerInterface_.onManifestUpdated();
    }
  }

  // -------------------------------------------------------- response filter

  /**
   * Subsequent segments are downloaded by Shaka, not by us, so this is the one
   * place we get to see their bytes.  Two jobs, both from plan section 3.5:
   * strip the `bjsn` box plus the init that every segment repeats, and read the
   * in-band `bjsn` back out so `seq_num`/`template_path` stay fresh.
   *
   * @private
   */
  installResponseFilter_() {
    const RequestType = shaka.net.NetworkingEngine.RequestType;

    this.responseFilter_ = (type, response, context) => {
      if (this.stopped_ || type !== RequestType.SEGMENT) {
        return;
      }
      const bytes = BjsnTimingProbe.asUint8Array(response.data);
      const split = BjsnSegmentBytes.split(bytes);
      if (!split.bjsn && !split.init) {
        // Not a BJSN file; leave it alone.
        return;
      }

      this.readLastSegmentDuration_(response);

      if (split.bjsn) {
        // In-band manifest refresh.  Keep this write path as narrow as the
        // plan asks: seq_num and template_path only.
        this.bjsn_ = split.bjsn;
      }

      // Record that this segment really arrived, and where it sits on the media
      // clock, so the live loop can gate and anchor on facts rather than on a
      // timer.  See addNextReference_.
      this.noteSegmentArrived_(bytes, split);

      if (split.media) {
        response.data = split.media.slice().buffer;
      }

      this.fire_('onSegmentResponse', response.uri, {
        boxes: split.boxes.map((b) => b.type),
        originalBytes: bytes.byteLength,
        strippedBytes: split.media ? split.media.byteLength : bytes.byteLength,
        seqNum: split.bjsn ? split.bjsn.seq_num : null,
      });
    };

    this.playerInterface_.networkingEngine.registerResponseFilter(
        this.responseFilter_);
  }

  /**
   * A segment response arrived.  Note its seq_num and its real end time on the
   * media clock; both feed the live loop.
   *
   * @param {!Uint8Array} bytes The whole segment, before stripping.
   * @param {!Object} split The result of BjsnSegmentBytes.split().
   * @private
   */
  noteSegmentArrived_(bytes, split) {
    if (split.bjsn && typeof split.bjsn.seq_num === 'number') {
      this.receivedSeqNum_ = this.receivedSeqNum_ === null ?
          split.bjsn.seq_num :
          Math.max(this.receivedSeqNum_, split.bjsn.seq_num);
    } else if (this.lastSeqNum_ !== null) {
      // No `bjsn` box to identify it by.  The only reference outstanding is
      // lastSeqNum_, so treat that as the one that landed -- otherwise the gate
      // in addNextReference_ would never open.
      this.receivedSeqNum_ = this.lastSeqNum_;
    }

    if (!this.tracks_) {
      return;
    }
    const timescaleByTrackId = {};
    for (const track of this.tracks_) {
      timescaleByTrackId[track.id] = track.timescale;
    }
    const timing = BjsnSegmentBytes.timing(bytes, timescaleByTrackId);
    if (timing.t0 !== null && timing.duration !== null) {
      this.receivedEndTime_ = timing.t0 + timing.duration;
    }
  }

  /**
   * `Last-Segment-Duration` states the actual duration, in ms, of the
   * *previous* segment (plan section 2b).  It is authoritative where our `tfdt`
   * derivation is an estimate, but it arrives one segment late and so cannot
   * size the first one.  Segment durations are near-constant, so we use it as
   * the estimate for subsequent references.
   *
   * @param {!shaka.extern.Response} response
   * @private
   */
  readLastSegmentDuration_(response) {
    const headers = response.headers || {};
    const raw = headers['last-segment-duration'] ||
        headers['Last-Segment-Duration'];
    if (!raw) {
      return;
    }
    const ms = parseInt(raw, 10);
    if (!isFinite(ms) || ms <= 0) {
      return;
    }
    const seconds = ms / 1000;
    if (this.reportedDuration_ !== seconds) {
      this.reportedDuration_ = seconds;
      this.log_(`Last-Segment-Duration: ${ms}ms (previous segment)`);
    }
  }

  // ---------------------------------------------------------------- helpers

  /**
   * @param {string} message
   * @return {!shaka.util.Error}
   * @private
   */
  error_(message) {
    return new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.MANIFEST,
        shaka.util.Error.Code.UNABLE_TO_GUESS_MANIFEST_TYPE,
        message);
  }

  /**
   * @return {!shaka.util.Error}
   * @private
   */
  abortError_() {
    return new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.PLAYER,
        shaka.util.Error.Code.OPERATION_ABORTED);
  }

  /**
   * @param {string} name
   * @param {...*} args
   * @private
   */
  fire_(name, ...args) {
    const hook = this.hooks && this.hooks[name];
    if (typeof hook === 'function') {
      try {
        hook(...args);
      } catch (e) {
        console.warn(`BjsnShakaParser: hook ${name} threw`, e);
      }
    }
  }

  /**
   * @param {string} message
   * @param {...*} args
   * @private
   */
  log_(message, ...args) {
    this.fire_('onLog', `[parser] ${message}`, ...args);
  }

  /**
   * Register this parser with Shaka.  Call once `window.shaka` is available.
   *
   * @param {string=} mimeType
   */
  static register(mimeType = BJSN_MIME_TYPE) {
    shaka.media.ManifestParser.registerParserByMime(
        mimeType, () => new BjsnShakaParser());
  }
}

/**
 * Observer functions, shared by every parser instance so the page can set them
 * before a load begins.  See the `hooks` field on the instance.
 *
 * @type {!Object}
 */
BjsnShakaParser.hooks = {};

window.BjsnShakaParser = BjsnShakaParser;
window.BJSN_MIME_TYPE = BJSN_MIME_TYPE;
