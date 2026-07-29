/**
 * BJSN timing probe.
 *
 * Player-agnostic startup instrumentation for the BJSN test players.
 *
 * `bjsn_mse.js` measures its own startup because it owns every step: it opens
 * the MediaSource, fetches, parses and appends, so it can stamp a timestamp at
 * each one.  Shaka owns those steps instead, and exposes only some of them as
 * events.  Rather than reporting a different, smaller set of numbers for the
 * Shaka player, this probe observes the same instants from the outside by
 * wrapping the MSE entry points that *any* MSE player must go through:
 *
 *   - `new MediaSource()`      -> the `sourceopen` event
 *   - `addSourceBuffer()`      -> which buffers exist, and with what mime type
 *   - `appendBuffer()`         -> every append, classified init vs media by
 *                                 sniffing the box types in the data
 *
 * Because it hooks the platform rather than the player, the same probe measures
 * `bjsn_player.html` and `bjsn_shaka_player.html` on identical axes, which is
 * what makes the two comparable (Phase 6 of the integration plan).  Steps the
 * platform cannot see -- first byte, `bjsn` parsed, `moov` parsed -- are marked
 * explicitly by the caller via `mark()`.
 *
 * The patches are global but scoped to a session: `stop()` restores every
 * original.  This is deliberately a test-harness technique and has no business
 * anywhere near `lib/`.
 *
 * @author Harmonic Inc
 */

class BjsnTimingProbe {
  constructor() {
    /** Wall-clock origin for every mark, from `performance.now()`. */
    this.startedAt_ = null;
    /** @type {!Map<string, number>} name -> ms since session start */
    this.marks_ = new Map();
    /** @type {!Map<string, string>} name -> free-text annotation */
    this.notes_ = new Map();
    /** @type {!Map<string, number>} name -> running total */
    this.counters_ = new Map();
    /** @type {!Array<{mime: string, at: number, appends: number}>} */
    this.buffers_ = [];
    /** @type {!Array<function()>} undo actions for the installed patches */
    this.restore_ = [];
    this.installed_ = false;
    this.onChange_ = null;
  }

  /**
   * Begin a session: reset all state, install the MSE patches and start the
   * clock.  Every mark from here on is relative to this instant.
   *
   * @param {?function()=} onChange Called whenever a mark or counter changes,
   *   so the UI can redraw.
   */
  start(onChange = null) {
    this.stop();
    this.marks_.clear();
    this.notes_.clear();
    this.counters_.clear();
    this.buffers_ = [];
    this.onChange_ = onChange;
    this.startedAt_ = performance.now();
    this.install();
  }

  /** End the session and restore every patched global. */
  stop() {
    this.uninstall();
    this.onChange_ = null;
  }

  /** @return {number} ms since `start()`, or 0 if not started. */
  now() {
    return this.startedAt_ === null ? 0 : performance.now() - this.startedAt_;
  }

  /**
   * Record the first occurrence of `name`.  Later calls are ignored, which is
   * what makes these "time to first X" numbers: callers can mark
   * unconditionally from inside a loop or an event handler.
   *
   * @param {string} name
   * @param {?string=} note
   * @return {boolean} True if this call was the one that recorded the mark.
   */
  mark(name, note = null) {
    if (this.marks_.has(name)) {
      return false;
    }
    this.marks_.set(name, this.now());
    if (note !== null) {
      this.notes_.set(name, note);
    }
    this.changed_();
    return true;
  }

  /**
   * Annotate an existing (or future) mark without changing its time.
   *
   * @param {string} name
   * @param {string} note
   */
  note(name, note) {
    this.notes_.set(name, note);
    this.changed_();
  }

  /**
   * @param {string} name
   * @param {number=} by
   */
  count(name, by = 1) {
    this.counters_.set(name, (this.counters_.get(name) || 0) + by);
    this.changed_();
  }

  /**
   * @param {string} name
   * @return {?number} ms since session start, or null if never marked.
   */
  get(name) {
    return this.marks_.has(name) ? this.marks_.get(name) : null;
  }

  /**
   * @param {string} name
   * @return {number}
   */
  counter(name) {
    return this.counters_.get(name) || 0;
  }

  /**
   * @param {string} name
   * @return {?string}
   */
  getNote(name) {
    return this.notes_.has(name) ? this.notes_.get(name) : null;
  }

  /** @return {!Object} A plain snapshot, for logging or serialising. */
  snapshot() {
    const marks = {};
    for (const [name, at] of this.marks_) {
      marks[name] = Math.round(at * 10) / 10;
    }
    const counters = {};
    for (const [name, value] of this.counters_) {
      counters[name] = value;
    }
    return {
      marks,
      counters,
      sourceBuffers: this.buffers_.map((b) => ({
        mime: b.mime,
        createdAt: Math.round(b.at * 10) / 10,
        appends: b.appends,
      })),
    };
  }

  /** @private */
  changed_() {
    if (this.onChange_) {
      this.onChange_();
    }
  }

  /**
   * Patch the MSE entry points.  Idempotent.
   */
  install() {
    if (this.installed_) {
      return;
    }
    this.installed_ = true;

    // Remember the native prototypes before swapping the constructors out, so
    // the method patches below land on the real objects rather than on a proxy.
    const nativeMediaSources = ['MediaSource', 'ManagedMediaSource']
        .map((name) => ({name, ctor: window[name]}))
        .filter((entry) => typeof entry.ctor === 'function');

    // 1. Constructor -> `sourceopen`.  A Proxy keeps `new` working and
    //    forwards statics such as `isTypeSupported` untouched.
    for (const {name, ctor} of nativeMediaSources) {
      window[name] = new Proxy(ctor, {
        construct: (target, args) => {
          const mediaSource = new target(...args);
          mediaSource.addEventListener('sourceopen', () => {
            this.mark('sourceOpen');
          }, {once: true});
          return mediaSource;
        },
      });
      this.restore_.push(() => {
        window[name] = ctor;
      });
    }

    const probe = this;

    // 2. addSourceBuffer -> buffer count and mime types.  Option A should
    //    produce exactly one buffer carrying both codecs; seeing two here is
    //    the signal that something demuxed the stream after all.
    for (const {ctor} of nativeMediaSources) {
      const proto = ctor.prototype;
      const nativeAdd = proto.addSourceBuffer;
      if (typeof nativeAdd !== 'function') {
        continue;
      }
      // A plain function, not an arrow, so `this` is the MediaSource instance.
      proto.addSourceBuffer = function(mime) {
        const sourceBuffer = nativeAdd.call(this, mime);
        probe.onAddSourceBuffer_(sourceBuffer, mime);
        return sourceBuffer;
      };
      this.restore_.push(() => {
        proto.addSourceBuffer = nativeAdd;
      });
    }

    // 3. appendBuffer -> the init/media append timeline.  Classifying by box
    //    type rather than by call order means we do not have to assume the
    //    player appends init first, or appends it at all.
    const sourceBufferProto =
        window.SourceBuffer && window.SourceBuffer.prototype;
    if (sourceBufferProto &&
        typeof sourceBufferProto.appendBuffer === 'function') {
      const nativeAppend = sourceBufferProto.appendBuffer;
      sourceBufferProto.appendBuffer = function(data) {
        probe.onAppend_(this, data);
        return nativeAppend.call(this, data);
      };
      this.restore_.push(() => {
        sourceBufferProto.appendBuffer = nativeAppend;
      });
    }
  }

  /**
   * @param {!SourceBuffer} sourceBuffer
   * @param {string} mime
   * @private
   */
  onAddSourceBuffer_(sourceBuffer, mime) {
    this.buffers_.push({
      sourceBuffer,
      mime: String(mime),
      at: this.now(),
      appends: 0,
    });
    this.mark('sourceBufferCreated', String(mime));
    this.count('sourceBuffers');
  }

  /** Restore every patched global.  Idempotent. */
  uninstall() {
    while (this.restore_.length) {
      try {
        this.restore_.pop()();
      } catch (e) {
        console.warn('BjsnTimingProbe: failed to restore a patch', e);
      }
    }
    this.installed_ = false;
  }

  /**
   * @param {!SourceBuffer} sourceBuffer
   * @param {!BufferSource} data
   * @private
   */
  onAppend_(sourceBuffer, data) {
    const bytes = BjsnTimingProbe.asUint8Array(data);
    const boxes = BjsnTimingProbe.topLevelBoxTypes(bytes);
    const isInit = boxes.includes('ftyp') || boxes.includes('moov');
    const kind = isInit ? 'init' : 'media';

    const entry = this.buffers_.find((b) => b.sourceBuffer === sourceBuffer);
    if (entry) {
      entry.appends++;
    }

    this.count('appends');
    this.count(kind === 'init' ? 'initAppends' : 'mediaAppends');
    this.count('appendedBytes', bytes.byteLength);

    this.mark('firstAppend', boxes.join('+'));
    if (kind === 'init') {
      this.mark('initAppend', boxes.join('+'));
    } else {
      this.mark('firstMediaAppend', boxes.join('+'));
    }

    // Time the completion of these first appends too: "append issued" and
    // "append accepted by the decoder" can differ by a lot on a cold start.
    const doneMark = kind === 'init' ? 'initAppendDone' : 'firstMediaAppendDone';
    if (!this.marks_.has(doneMark)) {
      const onDone = () => {
        this.mark(doneMark);
        sourceBuffer.removeEventListener('updateend', onDone);
      };
      sourceBuffer.addEventListener('updateend', onDone);
    }
  }

  /**
   * @param {!BufferSource} data
   * @return {!Uint8Array}
   */
  static asUint8Array(data) {
    if (data instanceof Uint8Array) {
      return data;
    }
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return new Uint8Array(data);
  }

  /**
   * Walk the top-level MP4 box headers and return their types.  Tolerant by
   * design: it stops at the first header it cannot read, because it is handed
   * arbitrary append payloads.
   *
   * @param {!Uint8Array} bytes
   * @param {number=} limit Stop after this many boxes.
   * @return {!Array<string>}
   */
  static topLevelBoxTypes(bytes, limit = 8) {
    const types = [];
    let offset = 0;
    while (offset + 8 <= bytes.byteLength && types.length < limit) {
      const size = (bytes[offset] << 24) | (bytes[offset + 1] << 16) |
          (bytes[offset + 2] << 8) | bytes[offset + 3];
      const type = String.fromCharCode(
          bytes[offset + 4], bytes[offset + 5],
          bytes[offset + 6], bytes[offset + 7]);
      if (!/^[\x20-\x7e]{4}$/.test(type)) {
        break;
      }
      types.push(type);
      if (size <= 0) {
        break;
      }
      offset += size;
    }
    return types;
  }
}

window.BjsnTimingProbe = BjsnTimingProbe;
