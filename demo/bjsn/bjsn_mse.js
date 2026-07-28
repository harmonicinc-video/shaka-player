/**
 * BJSN Media Source Extensions Module
 * 
 * This module contains all MSE-related functionality for the BJSN player,
 * including playback state management, timestamp handling, download
 * scheduling, and session orchestration.
 * 
 * @author Harmonic Inc
 */

/**
 * Manages download scheduling with adaptive retry logic
 */
class SegmentDownloadManager {
  constructor(normalInterval) {
    this.state = 'NORMAL';  // NORMAL, RETRY, RECOVERING
    this.normalInterval = normalInterval; // Passed from segmentDurationMs
    this.retryInterval = 100;   // 100ms for failed downloads
    this.maxRetryAttempts = 10; // Maximum consecutive retries before backing off
    this.consecutiveFailures = 0;
    this.lastSuccessTime = Date.now();
  }

  // Calculate next download delay based on current state and fetch result
  calculateNextDelay(fetchSuccess, fetchStartTime, fetchEndTime) {
    const fetchDuration = fetchEndTime - fetchStartTime;
    
    if (fetchSuccess) {
      return this.handleSuccessfulFetch(fetchDuration);
    } else {
      return this.handleFailedFetch();
    }
  }

  handleSuccessfulFetch(fetchDuration) {
    if (this.state === 'RETRY') {
      // Transitioning from retry to normal - start recovery
      this.state = 'RECOVERING';
      this.consecutiveFailures = 0;
      this.lastSuccessTime = Date.now();
      
      // Start with normal interval minus fetch time
      const delay = Math.max(0, this.normalInterval - fetchDuration);
      console.log(`Download successful after retries. Entering RECOVERING state. Next fetch in ${delay}ms`);
      return delay;
      
    } else if (this.state === 'RECOVERING') {
      // Already in recovery, continue with normal timing
      this.state = 'NORMAL';
      this.lastSuccessTime = Date.now();
      
      const delay = Math.max(0, this.normalInterval - fetchDuration);
      console.log(`Recovery complete. Returning to NORMAL state. Next fetch in ${delay}ms`);
      return delay;
      
    } else {
      // Normal successful fetch
      this.consecutiveFailures = 0;
      this.lastSuccessTime = Date.now();
      
      const delay = Math.max(0, this.normalInterval - fetchDuration);
      console.log(`Normal successful fetch. Next fetch in ${delay}ms`);
      return delay;
    }
  }

  handleFailedFetch() {
    this.consecutiveFailures++;
    
    if (this.state === 'NORMAL' || this.state === 'RECOVERING') {
      // Enter retry state
      this.state = 'RETRY';
      console.log(`Download failed. Entering RETRY state. Consecutive failures: ${this.consecutiveFailures}`);
    }
    
    // Progressive backoff for excessive failures
    let delay = this.retryInterval;
    if (this.consecutiveFailures > this.maxRetryAttempts) {
      delay = Math.min(this.retryInterval * Math.pow(2, this.consecutiveFailures - this.maxRetryAttempts), 5000);
      console.log(`Excessive failures (${this.consecutiveFailures}). Using progressive backoff: ${delay}ms`);
    } else {
      console.log(`Retry attempt ${this.consecutiveFailures}. Next retry in ${delay}ms`);
    }
    
    return delay;
  }

  getState() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      timeSinceLastSuccess: Date.now() - this.lastSuccessTime
    };
  }
}

/**
 * State machine for managing operations on a single SourceBuffer
 * States: UNINITIALIZED -> IDLE -> APPENDING/REMOVING -> IDLE (or ERROR)
 * Now also handles init segment detection and codec setup
 */
class SourceBufferStateMachine {
  constructor(mediaSource, bufferType, parentOrchestrator) {
    this.mediaSource = mediaSource;
    this.bufferType = bufferType; // 'video' or 'audio'
    this.parent = parentOrchestrator;
    
    // SourceBuffer will be created after codec detection
    this.sourceBuffer = null;
    this.codecString = null;
    this.isInitialized = false;
    
    // State machine states
    this.state = 'UNINITIALIZED';  // UNINITIALIZED, IDLE, APPENDING, REMOVING, ERROR
    this.operationQueue = [];
    this.currentOperation = null;
    
    // Init segment handling
    this.initSegmentData = null;
    this.hasAppendedInitSegment = false;
  }

  /**
   * Initialize this state machine with init segment data
   * This will detect codec and create the SourceBuffer
   */
  async initialize(initSegmentData) {
    if (this.isInitialized) {
      throw new Error(`${this.bufferType} buffer already initialized`);
    }

    this.initSegmentData = initSegmentData;
    
    try {
      // Detect codec from init segment
      const codecInfo = BjsnUtils.BjsnCodecDetector.detectCodecsFromSegment(initSegmentData);
      this.codecString = this.bufferType === 'video' ? codecInfo.video : codecInfo.audio;
      
      if (!this.codecString) {
        throw new Error(`Could not detect ${this.bufferType} codec from init segment`);
      }

      // Create SourceBuffer with detected codec
      const mimeType = `${this.bufferType}/mp4; codecs="${this.codecString}"`;
      this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
      this.sourceBuffer.mode = 'segments';

      // Set up event handlers for state transitions
      this.sourceBuffer.addEventListener('updateend', () => this.onUpdateEnd());
      this.sourceBuffer.addEventListener('error', (e) => this.onError(e));

      this.isInitialized = true;
      this.state = 'IDLE';

      console.log(`✅ ${this.bufferType} buffer initialized with codec: ${this.codecString}`);

      // Automatically append init segment first
      this.enqueueInitSegment();
      
      return this.codecString;

    } catch (error) {
      this.state = 'ERROR';
      throw new Error(`Failed to initialize ${this.bufferType} buffer: ${error.message}`);
    }
  }

  /**
   * Private method to enqueue init segment append
   */
  enqueueInitSegment() {
    if (!this.initSegmentData || this.hasAppendedInitSegment) {
      return;
    }

    const initOperation = {
      type: 'append',
      data: this.initSegmentData,
      timestampOffset: 0, // Init segments always start at 0
      isInitSegment: true,
      callback: (error) => {
        if (error) {
          console.error(`Failed to append ${this.bufferType} init segment:`, error);
        } else {
          console.log(`${this.bufferType} init segment appended successfully`);
          this.hasAppendedInitSegment = true;
          // Notify parent that init segment is complete
          this.parent.onInitSegmentAppended(this.bufferType, this.codecString);
        }
      }
    };

    // Insert init operation at the front of the queue
    this.operationQueue.unshift(initOperation);
    this.processNextOperation();
  }

  // Public API - enqueue operation and trigger state machine
  enqueue(operation) {
    if (!this.isInitialized) {
      throw new Error(`${this.bufferType} buffer not initialized. Call initialize() first.`);
    }

    this.operationQueue.push(operation);
    this.processNextOperation();
  }

  // State machine logic - process operations based on current state
  processNextOperation() {
    // Can only start new operation when IDLE
    if (this.state !== 'IDLE')
    {
      return;
    } 
    if (this.operationQueue.length === 0) {
      return;
    }
    
    this.currentOperation = this.operationQueue.shift();
    const { type, data, timestampOffset, callback, isInitSegment } = this.currentOperation;
    
    try {
      if (type === 'append') {
        this.transitionToAppending(data, timestampOffset, isInitSegment);
      } else if (type === 'remove') {
        this.transitionToRemoving(data.start, data.end);
      }
    } catch (e) {
      this.transitionToError(e, callback);
    }
  }

  // State transitions
  transitionToAppending(data, timestampOffset, isInitSegment = false) {
    // Only set timestampOffset for non-init segments
    if (!isInitSegment && timestampOffset !== undefined) {
      //this.sourceBuffer.timestampOffset = timestampOffset;
    }
    
    if (this.sourceBuffer.updating) {
      // SourceBuffer busy - defer operation with cloned buffer data
      console.log(`${this.bufferType} SourceBuffer busy, deferring operation with cloned data`);
      
      // CRITICAL FIX: Clone the buffer data to prevent corruption during deferral
      const clonedData = new Uint8Array(data);
      const clonedOperation = {
        ...this.currentOperation,
        data: clonedData // Use cloned data to prevent ArrayBuffer detachment issues
      };
      
      this.operationQueue.unshift(clonedOperation);
      this.currentOperation = null;
      return;
    }
    this.sourceBuffer.appendBuffer(data);
    this.state = 'APPENDING';
  }

  transitionToRemoving(start, end) {
    this.sourceBuffer.remove(start, end);
    this.state = 'REMOVING';
  }

  transitionToError(error, callback) {
    console.log(`Error in ${this.bufferType} operation:`, error.message);
    if (callback) callback(error);
    this.currentOperation = null;
    this.state = 'ERROR';
    this.processNextOperation(); // Try to recover with next operation
  }

  transitionToIdle() {
    this.state = 'IDLE';
    this.processNextOperation(); // Process next queued operation
  }

  // Event handlers - trigger state transitions
  onUpdateEnd() {
    if (!this.currentOperation) return;
    
    // Notify parent orchestrator
    this.parent.onBufferUpdated(this.bufferType, this.sourceBuffer);
    
    // Complete current operation
    const { callback } = this.currentOperation;
    if (callback) callback(null);
    
    this.currentOperation = null;
    this.transitionToIdle();
  }

  onError(error) {
    console.log(`${this.bufferType} SourceBuffer error:`, error);
    const callback = this.currentOperation?.callback;
    this.transitionToError(error, callback);
  }

  // State inspection
  getState() {
    return {
      bufferType: this.bufferType,
      state: this.state,
      isInitialized: this.isInitialized,
      codecString: this.codecString,
      hasAppendedInitSegment: this.hasAppendedInitSegment,
      queueLength: this.operationQueue.length,
      currentOperation: this.currentOperation?.type || null,
      updating: this.sourceBuffer?.updating || false
    };
  }

  // Getter for codec string (for external use)
  getCodecString() {
    return this.codecString;
  }
}

/**
 * Orchestrator for coordinating multiple SourceBuffer state machines
 * Now handles init segment coordination
 */
class MediaSourceOrchestrator {
  constructor(videoElement, mediaSource) {
    this.video = videoElement;
    this.mediaSource = mediaSource;
    this.hasSetInitialCurrentTime = false;
    
    // Create uninitialized state machines
    this.bufferStateMachines = {
      video: new SourceBufferStateMachine(mediaSource, 'video', this),
      audio: new SourceBufferStateMachine(mediaSource, 'audio', this)
    };
    
    // Track initialization progress
    this.initializationComplete = {
      video: false,
      audio: false
    };
  }

  /**
   * Initialize buffer state machines with init segments
   */
  async initializeBuffers(initSegments, tracks) {
    const videoTrack = tracks.find(t => t.handlerType === 'vide');
    const audioTrack = tracks.find(t => t.handlerType === 'soun');
    
    if (!videoTrack || !audioTrack) {
      throw new Error('Could not find both video and audio tracks');
    }

    const videoInit = initSegments[videoTrack.id];
    const audioInit = initSegments[audioTrack.id];

    if (!videoInit || !audioInit) {
      throw new Error('Missing init segments for video or audio');
    }

    try {
      // Initialize both buffers concurrently
      const [videoCodec, audioCodec] = await Promise.all([
        this.bufferStateMachines.video.initialize(videoInit),
        this.bufferStateMachines.audio.initialize(audioInit)
      ]);

      console.log('Buffer initialization complete:', { video: videoCodec, audio: audioCodec });
      
      return { video: videoCodec, audio: audioCodec };

    } catch (error) {
      throw new Error(`Buffer initialization failed: ${error.message}`);
    }
  }

  /**
   * Called by SourceBufferStateMachine when init segment is appended
   */
  onInitSegmentAppended(bufferType, codecString) {
    console.log(`${bufferType} init segment appended with codec: ${codecString}`);
    this.initializationComplete[bufferType] = true;
    
    // Handle timing metrics for init segments
    if (this.parent) {
      if (bufferType === 'video' && !this.parent.timingMetrics.videoInitAppendTime) {
        this.parent.timingMetrics.videoInitAppendTime = Date.now() - this.parent.startTime;
        this.parent.log('Video init segment appended');
      } else if (bufferType === 'audio' && !this.parent.timingMetrics.audioInitAppendTime) {
        this.parent.timingMetrics.audioInitAppendTime = Date.now() - this.parent.startTime;
        this.parent.log('Audio init segment appended');
      }
    }
    
    // Check if both buffers are initialized
    if (this.initializationComplete.video && this.initializationComplete.audio) {
      console.log('✅ All init segments appended - ready for media segments');
      // Notify parent that we're ready for media segments
      if (this.parent && this.parent.onAllInitSegmentsAppended) {
        this.parent.onAllInitSegmentsAppended();
      }
    }
  }

  // Route operations to appropriate state machine
  enqueue(operation) {
    const bufferType = operation.bufferType || this.inferBufferTypeFromOperation(operation);
    
    if (!bufferType || !this.bufferStateMachines[bufferType]) {
      console.error('Unknown buffer type in operation:', operation);
      if (operation.callback) operation.callback(new Error('Unknown buffer type'));
      return;
    }
    
    // Remove bufferType from operation since state machine knows its type
    const { bufferType: _, ...operationForStateMachine } = operation;
    
    // Route to appropriate state machine
    this.bufferStateMachines[bufferType].enqueue(operationForStateMachine);
  }

  // Helper to infer buffer type from operation (for backward compatibility)
  inferBufferTypeFromOperation(operation) {
    // For backward compatibility with existing sourceBuffer-based operations
    if (operation.sourceBuffer) {
      // Check which buffer this sourceBuffer corresponds to
      const videoSB = this.bufferStateMachines.video.sourceBuffer;
      const audioSB = this.bufferStateMachines.audio.sourceBuffer;
      
      if (operation.sourceBuffer === videoSB) {
        return 'video';
      } else if (operation.sourceBuffer === audioSB) {
        return 'audio';
      }
    }
    return null;
  }

  // Check if orchestrator is fully initialized
  isInitialized() {
    return this.bufferStateMachines.video.isInitialized && 
           this.bufferStateMachines.audio.isInitialized;
  }

  // Get codec strings for both buffers
  getCodecStrings() {
    return {
      video: this.bufferStateMachines.video.getCodecString(),
      audio: this.bufferStateMachines.audio.getCodecString()
    };
  }

  // For backward compatibility - expose sourceBuffers
  get sourceBuffers() {
    return {
      video: this.bufferStateMachines.video.sourceBuffer,
      audio: this.bufferStateMachines.audio.sourceBuffer
    };
  }

  // Called by SourceBufferStateMachine when a buffer is updated
  onBufferUpdated(bufferType, sourceBuffer) {
    // Set current time to the start of video buffer range only once when video buffer is first updated
    if (bufferType === 'video' && !this.hasSetInitialCurrentTime && this.video.buffered.length > 0) {
      const bufferStart = this.video.buffered.start(0);
      console.log(`🕐 Setting video currentTime to buffer start: ${bufferStart.toFixed(3)}s (one-time setup)`);
      this.video.currentTime = bufferStart;
      this.hasSetInitialCurrentTime = true;
    }
  }

  // Get state of all buffer state machines
  getState() {
    const state = {};
    Object.entries(this.bufferStateMachines).forEach(([type, stateMachine]) => {
      state[type] = stateMachine.getState();
    });
    return state;
  }

  formatTimeRanges(ranges) {
    if (!ranges || ranges.length === 0) {
        return '[]';
    }
    const parts = [];
    for (let i = 0; i < ranges.length; i++) {
        parts.push(`[${ranges.start(i).toFixed(2)} - ${ranges.end(i).toFixed(2)}]`);
    }
    return `(${ranges.length}) ${parts.join(', ')}`;
  }
}

/**
 * Manages timestamp synchronization for A/V tracks
 */
class TimestampManager {
  constructor() {
    this.trackTimestampOffsets = {}; // Store the calculated timestampOffset per track
    this.trackInitialized = {}; // Track whether we've set the offset for each track
    this.trackMediaTimes = {}; // Store media time in seconds for each track
    this.initialBaseTime = null; // Minimum base time as reference for alignment
  }

  // Calculate and set timestampOffset once per track based on first segment
  initializeTrackTimestamp(segmentData, trackType, timescale) {
    // Only calculate once per track
    if (this.trackInitialized[trackType]) {
      return this.trackTimestampOffsets[trackType];
    }

    const baseMediaDecodeTime = BjsnUtils.Mp4BoxUtils.extractBaseMediaDecodeTime(segmentData);
    
    if (baseMediaDecodeTime === null) {
      console.log(`Warning: Could not extract baseMediaDecodeTime for ${trackType} first segment, using offset 0`);
      this.trackTimestampOffsets[trackType] = 0;
      this.trackInitialized[trackType] = true;
      return 0;
    }

    // Convert media time to seconds and store it
    const mediaTimeInSeconds = baseMediaDecodeTime / timescale;
    this.trackMediaTimes[trackType] = mediaTimeInSeconds;
    
    console.log(`${trackType} track media time: ${mediaTimeInSeconds.toFixed(3)}s (baseMediaDecodeTime: ${baseMediaDecodeTime}, timescale: ${timescale})`);
    
    // Determine initialBaseTime as minimum of all available track media times
    this.updateInitialBaseTime();
    
    // Since segments are on a common timeline, timestampOffset should be the same for all tracks
    // This shifts all tracks by the same amount to start from presentation time 0
    const timestampOffset = -this.initialBaseTime;
    
    // Store the offset for this track
    this.trackTimestampOffsets[trackType] = timestampOffset;
    this.trackInitialized[trackType] = true;

    console.log(`${trackType} track timestamp initialization:
  baseMediaDecodeTime: ${baseMediaDecodeTime}
  mediaTimeInSeconds: ${mediaTimeInSeconds.toFixed(3)}s
  initialBaseTime: ${this.initialBaseTime.toFixed(3)}s
  timestampOffset: ${timestampOffset.toFixed(3)}s (common for all tracks)`);

    return timestampOffset;
  }

  // Update initialBaseTime to be the minimum of all collected media times
  updateInitialBaseTime() {
    const mediaTimes = Object.values(this.trackMediaTimes);
    if (mediaTimes.length > 0) {
      const newInitialBaseTime = Math.min(...mediaTimes);
      
      if (this.initialBaseTime === null) {
        this.initialBaseTime = newInitialBaseTime;
        console.log(`Setting initial base time reference to minimum: ${newInitialBaseTime.toFixed(3)}s`);
      } else if (newInitialBaseTime < this.initialBaseTime) {
        // Update to new minimum and recalculate offsets for already initialized tracks
        const oldBaseTime = this.initialBaseTime;
        this.initialBaseTime = newInitialBaseTime;
        console.log(`Updated initial base time reference from ${oldBaseTime.toFixed(3)}s to ${newInitialBaseTime.toFixed(3)}s (new minimum)`);
        
        // Recalculate offsets for already initialized tracks
        this.recalculateExistingOffsets();
      }
    }
  }

  // Recalculate timestamp offsets for already initialized tracks when initialBaseTime changes
  recalculateExistingOffsets() {
    for (const [trackType, mediaTime] of Object.entries(this.trackMediaTimes)) {
      if (this.trackInitialized[trackType]) {
        const oldOffset = this.trackTimestampOffsets[trackType];
        // All tracks use the same offset since they're on a common timeline
        const newOffset = -this.initialBaseTime;
        this.trackTimestampOffsets[trackType] = newOffset;
        
        console.log(`Recalculated ${trackType} timestampOffset: ${oldOffset.toFixed(3)}s → ${newOffset.toFixed(3)}s (common offset)`);
      }
    }
  }

  // Get the pre-calculated timestampOffset for a track
  getTrackTimestampOffset(trackType) {
    return this.trackTimestampOffsets[trackType] || 0;
  }

  // Check if track has been initialized
  isTrackInitialized(trackType) {
    return this.trackInitialized[trackType] || false;
  }

  // Check timestamp alignment between video and audio (for debugging)
  checkAlignment() {
    if (!this.trackInitialized.video || !this.trackInitialized.audio) {
      return { aligned: true, message: 'Tracks not yet initialized' };
    }

    const videoOffset = this.trackTimestampOffsets.video;
    const audioOffset = this.trackTimestampOffsets.audio;
    const offsetDiff = Math.abs(videoOffset - audioOffset);
    
    // Since tracks are on a common timeline, offsets should be identical
    const aligned = offsetDiff < 0.001; // Very tight tolerance since they should be exactly equal
    const message = aligned 
      ? `Track offsets properly aligned (both: ${videoOffset.toFixed(3)}s)` 
      : `Track offsets unexpectedly different (video: ${videoOffset.toFixed(3)}s, audio: ${audioOffset.toFixed(3)}s, diff: ${(offsetDiff * 1000).toFixed(1)}ms)`;

    return { aligned, offsetDiff, message };
  }

  // Get current status for debugging
  getStatus() {
    return {
      initialBaseTime: this.initialBaseTime,
      trackMediaTimes: this.trackMediaTimes,
      trackTimestampOffsets: this.trackTimestampOffsets,
      trackInitialized: this.trackInitialized,
      alignment: this.checkAlignment()
    };
  }
}
/**
 * Main playback session orchestrator
 */
class PlaybackSession {
  constructor(videoElement, initialUrl, logCallback, updateStatusCallback, 
              updateMediaInfoCallback, updatePerfMetricsCallback) {
    this.video = videoElement;
    this.initialUrl = initialUrl;
    this.ms = new MediaSource();
    this.fetchInterval = null;
    this.logInterval = null;
    this.isActive = true;
    
    // Callback functions for UI updates
    this.log = logCallback;
    this.updateStatus = updateStatusCallback;
    this.updateMediaInfo = updateMediaInfoCallback;
    this.updatePerfMetrics = updatePerfMetricsCallback;
    
    // Create progressive parser with all three callbacks
    this.progressiveParser = new BjsnUtils.ProgressiveMp4Parser(
      (trackId, segmentData) => this.onMediaSegmentAvailable(trackId, segmentData),
      (bjsnData) => this.onBjsnDataAvailable(bjsnData),
      (initSegments, tracks) => this.onInitSegmentsAvailable(initSegments, tracks)
    );
    this.stateMachine = null;
    this.videoTrack = null;
    this.audioTrack = null;
    this.currentSeqNum = null;
    this.templateUrl = null;
    this.baseUrl = null;
    this.downloadManager = null;
    this.initialDataProcessed = false;
    this.startTime = null;
    this.playingTime = null;
    this.timingMetrics = {
      sourceOpenTime: null,
      firstByteTime: null,
      bjsnParseTime: null,
      initSegmentTime: null,
      firstAppendTime: null,
      firstMediaSegmentTime: null,
      videoPlayTime: null,
      videoInitAppendTime: null,
      audioInitAppendTime: null,
      allMediaChunksAppendedTime: null
    };
    this.firstMediaSegmentAppended = false;
    this.mediaSegmentCount = { video: 0, audio: 0 };
    this.initialFileChunksFromParser = 0; // Chunks from initial file progressive parsing
    this.initialFileChunksAppended = 0; // How many of those have been appended
    this.initialFileProcessingComplete = false;
    
    // Timestamp management for segments mode
    this.timestampManager = new TimestampManager();
    this.timescale = { video: 90000, audio: 44100 }; // Default timescales, will be updated from track info
    this.segmentTimingData = {}; // Store timing data for comparison between tracks per downloaded segment file
    this.currentSegmentIndex = 0;
  }

  async start() {
    this.startTime = Date.now();
    this.log('Session start time recorded');
    
    // Register event listeners early to catch autoplay events.
    this.video.addEventListener('playing', () => this.onPlaying());
    this.video.addEventListener('play', () => this.onPlay());
    
    // Track when video actually starts playing (for accurate videoPlayTime)
    this.video.addEventListener('play', () => {
      if (!this.timingMetrics.videoPlayTime) {
        this.timingMetrics.videoPlayTime = Date.now() - this.startTime;
        this.log(`🎬 Video play event fired at ${this.timingMetrics.videoPlayTime}ms`);
      }
    });
    
    // Add canplay event listener as alternative trigger for playback
    this.video.addEventListener('canplay', () => {
      this.log('🎵 canplay event fired - video has enough data to start playing');
      
      if (this.video.paused && !this.timingMetrics.videoPlayTime) {
        this.log('🚀 Attempting to play video on canplay event');
        this.video.play().then(() => {
          if (!this.timingMetrics.videoPlayTime) {
            this.timingMetrics.videoPlayTime = Date.now() - this.startTime;
            this.log(`✅ video.play() from canplay succeeded at ${this.timingMetrics.videoPlayTime}ms`);
          }
        }).catch(e => {
          this.log('❌ video.play() from canplay failed:', e.message);
        });
      }
    });

    // Start elapsed time display update
    this.updateElapsedTime();
    
    this.video.src = window.URL.createObjectURL(this.ms);
    this.ms.addEventListener('sourceopen', () => this.onSourceOpen());
    this.updateStatus(true, 'Initializing');
  }

  onPlaying() {
    if (this.playingTime) return; // Already handled
    this.playingTime = Date.now();
    const loadTime = this.playingTime - this.startTime;
    this.log(`Video reached playing state. Total load time: ${loadTime}ms`);
    
    // Update media info with detailed timing
    const perfDetails = `Time to Playing: ${loadTime}ms
Status: Playing

Detailed Timing Breakdown:
  Load Stream to video.play(): ${this.timingMetrics.videoPlayTime || 'N/A'}ms
  Source Open: ${this.timingMetrics.sourceOpenTime}ms
  First Byte: ${this.timingMetrics.firstByteTime}ms
  BJSN Parse: ${this.timingMetrics.bjsnParseTime}ms
  Init Segment: ${this.timingMetrics.initSegmentTime}ms
  Video Init Append: ${this.timingMetrics.videoInitAppendTime || 'N/A'}ms
  Audio Init Append: ${this.timingMetrics.audioInitAppendTime || 'N/A'}ms
  First Append: ${this.timingMetrics.firstAppendTime}ms
  First Media Segment: ${this.timingMetrics.firstMediaSegmentTime || 'N/A'}ms
  All Media Chunks: ${this.timingMetrics.allMediaChunksAppendedTime || 'N/A'}ms
  Playing State: ${loadTime}ms

Note: "All Media Chunks" refers to all chunks from the initial file only (not live segments).`;
    this.updatePerfMetrics(perfDetails);
    
    this.updateStatus(true, 'Playing');
  }

  onPlay() {
    if (this.playingTime) return; // Already handled
    // This might fire before 'playing', so we handle it similarly
    // but without the detailed perf breakdown which depends on 'playing'.
    this.playingTime = Date.now();
    this.updateStatus(true, 'Playing');
  }

  updateElapsedTime() {
    if (!this.isActive) return;
    
    let status = this.playingTime ? 'Playing' : 'Loading...';
    let details = `Status: ${status}`;

    // Add video start latency if available
    if (this.timingMetrics.videoPlayTime) {
      details += `\n  Video Start Latency: ${this.timingMetrics.videoPlayTime}ms`;
    }
    // Add completed timing details if available
    if (this.timingMetrics.sourceOpenTime) {
      details += `\n\nTiming Progress:`;
      details += `\n  Source Open: ${this.timingMetrics.sourceOpenTime}ms`;
    } 
    if (this.timingMetrics.firstByteTime) {
      details += `\n  First Byte: ${this.timingMetrics.firstByteTime}ms`;
    }
    if (this.timingMetrics.bjsnParseTime) {
      details += `\n  BJSN Parse: ${this.timingMetrics.bjsnParseTime}ms`;
    }
    if (this.timingMetrics.videoInitAppendTime) {
      details += `\n  Video Init: ${this.timingMetrics.videoInitAppendTime}ms`;
    }
    if (this.timingMetrics.audioInitAppendTime) {
      details += `\n  Audio Init: ${this.timingMetrics.audioInitAppendTime}ms`;
    }
    if (this.timingMetrics.firstMediaSegmentTime) {
      details += `\n  First Media: ${this.timingMetrics.firstMediaSegmentTime}ms`;
    }
    
    if (this.timingMetrics.allMediaChunksAppendedTime) {
      details += `\n  All Initial Chunks: ${this.timingMetrics.allMediaChunksAppendedTime}ms`;
    }
    
    this.updatePerfMetrics(details);
    
    // Continue updating to catch late timing metrics
    setTimeout(() => this.updateElapsedTime(), 100);
  }

  stop() {
    this.isActive = false;
    this.updateStatus(false);
    if (this.fetchInterval) {
      clearTimeout(this.fetchInterval);
      this.fetchInterval = null;
    }
    if (this.logInterval) {
      clearInterval(this.logInterval);
      this.logInterval = null;
    }
    try {
      if (this.ms && this.ms.readyState === 'open') {
        this.ms.endOfStream();
      }
    } catch (e) {
      this.log('Error during endOfStream:', e.message);
    }
    if (this.video.src) {
      window.URL.revokeObjectURL(this.video.src);
      this.video.removeAttribute('src');
      this.video.load();
    }
  }
  async onSourceOpen() {
    if (!this.isActive) return;

    try {
      this.log('MediaSource opened');
      this.timingMetrics.sourceOpenTime = Date.now() - this.startTime;
      this.updateStatus(true, 'Loading');
      
      // Start progressive download with fetch API
      this.log('Starting progressive fetch:', this.initialUrl);
      const response = await fetch(this.initialUrl);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const reader = response.body.getReader();
      let receivedLength = 0;
      let firstByte = true;
      
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;
        if (!this.isActive) {
          reader.cancel();
          return;
        }
        
        if (firstByte) {
          this.timingMetrics.firstByteTime = Date.now() - this.startTime;
          firstByte = false;
        }
        
        receivedLength += value.length;
        this.log(`Received chunk: ${value.length} bytes, total: ${receivedLength}`);
        
        // Feed data to progressive parser
        this.progressiveParser.appendData(value);
        
        // Process parsed data as soon as available
        await this.processAvailableData();
      }
      
      // Process any remaining data
      await this.processFinalData();
      
      // Start fetching subsequent segments
      if (this.isActive) {
        this.scheduleNextSegmentFetch();
      }
      
    } catch (error) {
      if (this.isActive) {
        this.log('Error in playback session:', error);
        this.updateStatus(false);
      }
    }
  }

  // New callback for BJSN data
  onBjsnDataAvailable(bjsnData) {
    this.log('BJSN data available via callback');
    this.timingMetrics.bjsnParseTime = Date.now() - this.startTime;
    
    this.currentSeqNum = bjsnData.seq_num;
    this.templateUrl = bjsnData.template_path;
    this.baseUrl = new URL(this.initialUrl, window.location.href);
    
    // Update media info display
    this.updateMediaInfo(`BJSN Info:\n${JSON.stringify(bjsnData, null, 2)}`);
    this.updatePerfMetrics(`Status: Loading...`);
  }

  // New callback for init segments
  async onInitSegmentsAvailable(initSegments, tracks) {
    this.log('Init segments available via callback');
    this.timingMetrics.initSegmentTime = Date.now() - this.startTime;
    
    this.videoTrack = tracks.find(t => t.handlerType === 'vide');
    this.audioTrack = tracks.find(t => t.handlerType === 'soun');
    
    if (!this.videoTrack || !this.audioTrack) {
      throw new Error('Could not find both video and audio tracks.');
    }

    // Update timescales from track information
    this.timescale.video = this.videoTrack.timescale || 90000;
    this.timescale.audio = this.audioTrack.timescale || 44100;
    this.log('Track timescales:', this.timescale);
    
    if (!this.isActive || this.ms.readyState !== 'open') return;
    
    // Create orchestrator and initialize buffers
    this.stateMachine = new MediaSourceOrchestrator(this.video, this.ms);
    this.stateMachine.parent = this; // For callback
    
    try {
      const codecs = await this.stateMachine.initializeBuffers(initSegments, tracks);
      this.log('Codecs detected and buffers initialized:', codecs);
      
      // Update media info
      const currentContent = this.progressiveParser.bjsnData ? 
        `BJSN Info:\n${JSON.stringify(this.progressiveParser.bjsnData, null, 2)}` : '';
      this.updateMediaInfo(currentContent + `\n\nCodec Information:\n  Video: ${codecs.video}\n  Audio: ${codecs.audio}`);
      
      // Start buffer logging
      this.startBufferLogging();
      
    } catch (error) {
      throw new Error(`Failed to initialize buffers: ${error.message}`);
    }
  }

  onMediaSegmentAvailable(trackId, segmentData) {
    if (!this.stateMachine || !this.isActive) 
    {
      this.log('No active state machine or playback session is inactive');
      return;
    }

    
    // Get the appropriate source buffer
    let sourceBuffer;
    let trackType;
    let timescale;
    if (this.videoTrack && trackId === this.videoTrack.id) {
      sourceBuffer = this.stateMachine.sourceBuffers.video;
      trackType = 'video';
      timescale = this.timescale.video;
    } else if (this.audioTrack && trackId === this.audioTrack.id) {
      sourceBuffer = this.stateMachine.sourceBuffers.audio;
      trackType = 'audio';
      timescale = this.timescale.audio;
    } else {
      this.log(`Unknown track ID: ${trackId} for segment data`);
      return; // Unknown track
    }
    
    // Record first media segment time
    if (!this.firstMediaSegmentAppended && !this.timingMetrics.firstMediaSegmentTime) {
      this.timingMetrics.firstMediaSegmentTime = Date.now() - this.startTime;
      this.log(`First media segment (${trackType}) available at ${this.timingMetrics.firstMediaSegmentTime}ms`);
    }
    
    // Extract and log base media decode time for comparison
    const baseMediaDecodeTime = BjsnUtils.Mp4BoxUtils.extractBaseMediaDecodeTime(segmentData);
    const mediaTimeInSeconds = baseMediaDecodeTime ? (baseMediaDecodeTime / timescale) : null;
    
    // Check if we can compare with the other track's timing
    if (mediaTimeInSeconds !== null) {
      this.logTrackTimingDifference(trackType, mediaTimeInSeconds, baseMediaDecodeTime, timescale);
    }
    
    // Initialize timestampOffset only for the first segment of each track
    let timestampOffset = 0;
    if (!this.timestampManager.isTrackInitialized(trackType)) {
      timestampOffset = this.timestampManager.initializeTrackTimestamp(
        segmentData, trackType, timescale
      );
      this.log(`✅ Initialized ${trackType} timestampOffset: ${timestampOffset.toFixed(3)}s`);
      
      // Check alignment after both tracks are initialized
      const alignment = this.timestampManager.checkAlignment();
      this.log(`🔄 Track alignment status: ${alignment.message}`);
    } else {
      // Use the pre-calculated offset for subsequent segments
      timestampOffset = this.timestampManager.getTrackTimestampOffset(trackType);
    }
    
    // Enqueue the segment for appending
    this.mediaSegmentCount[trackType]++;
    this.initialFileChunksFromParser++; // Count chunks from initial file parsing
    const segmentIndex = this.mediaSegmentCount[trackType] - 1;
    
    this.stateMachine.enqueue({
      type: 'append',
      sourceBuffer: sourceBuffer,
      data: segmentData,
      timestampOffset: timestampOffset,
      callback: () => {
        this.initialFileChunksAppended++; // Count appended chunks from initial file
        if (!this.firstMediaSegmentAppended) {
          this.firstMediaSegmentAppended = true;
          this.log(`🎯 First media segment appended was ${trackType} segment ${segmentIndex}`);
          this.onFirstSegmentAppended();
        }
        this.checkAllInitialFileChunksAppended();
      }
    });
  }

  // Callback from MediaSourceOrchestrator when all init segments are appended
  onAllInitSegmentsAppended() {
    this.log('🎬 All init segments appended - ready for media segments');
    if (!this.timingMetrics.firstAppendTime) {
      this.timingMetrics.firstAppendTime = Date.now() - this.startTime;
    }
  }

  // Helper method to start buffer logging
  startBufferLogging() {
    if (this.logInterval) return; // Already started

    this.logInterval = setInterval(() => {
      if (!this.isActive || !this.stateMachine) return;
      try {
        const sourceBuffers = this.stateMachine.sourceBuffers;
        if (sourceBuffers.video && sourceBuffers.audio) {
          this.log('Video Buffer:', this.stateMachine.formatTimeRanges(sourceBuffers.video.buffered));
          this.log('Audio Buffer:', this.stateMachine.formatTimeRanges(sourceBuffers.audio.buffered));
        }
      } catch (e) {
        this.log('Error logging buffer state:', e.message);
      }
    }, 2000);
  }

  // Helper method to log timing differences between tracks
  logTrackTimingDifference(currentTrackType, currentMediaTime, currentBaseTime, currentTimescale) {
    // Initialize segment tracking if not exists
    if (!this.segmentTimingData) {
      this.segmentTimingData = {};
      this.currentSegmentIndex = 0;
    }
    
    // For downloaded segments (not individual moofs), we want to compare the first moof of each track type
    // within the same HTTP-downloaded file. Since we process moofs as they come from the progressive parser,
    // we need to track which "segment file" we're currently processing.
    
    // Get current segment file index - this represents the HTTP-downloaded file
    let segmentFileIndex;
    
    if (this.initialFileProcessingComplete) {
      // We're processing live segments now - each new segment gets its own index
      segmentFileIndex = `live_${this.currentSeqNum || 'unknown'}`;
    } else {
      // We're still processing the initial file - all moofs belong to segment 0
      segmentFileIndex = 0;
    }
    
    // Initialize this segment file's data if not exists
    if (!this.segmentTimingData[segmentFileIndex]) {
      this.segmentTimingData[segmentFileIndex] = {
        video: null,
        audio: null,
        firstMoofSeen: { video: false, audio: false }
      };
    }
    
    const segmentData = this.segmentTimingData[segmentFileIndex];
    
    // Only record the FIRST moof of each track type per segment file
    if (!segmentData.firstMoofSeen[currentTrackType]) {
      segmentData[currentTrackType] = {
        mediaTime: currentMediaTime,
        baseTime: currentBaseTime,
        timescale: currentTimescale
      };
      segmentData.firstMoofSeen[currentTrackType] = true;
      
      this.log(`📋 Segment file ${segmentFileIndex} - First ${currentTrackType} moof: ${currentMediaTime.toFixed(3)}s (baseTime: ${currentBaseTime})`);
    } else {
      // This is not the first moof of this track type in this segment file, skip comparison logging
      return;
    }
    
    // Check if we have both track types for this segment file now
    if (segmentData.video && segmentData.audio) {
      const videoTime = segmentData.video.mediaTime;
      const audioTime = segmentData.audio.mediaTime;
      const timeDiff = videoTime - audioTime;
      const timeDiffMs = timeDiff * 1000;
      
      // Also show the raw baseMediaDecodeTime difference
      const videoBaseTime = segmentData.video.baseTime;
      const audioBaseTime = segmentData.audio.baseTime;
      const videoTimescale = segmentData.video.timescale;
      const audioTimescale = segmentData.audio.timescale;
      
      this.log(`🎯 SEGMENT FILE ${segmentFileIndex} timing comparison (first moof of each track):
  Video: ${videoTime.toFixed(3)}s (baseTime: ${videoBaseTime}, timescale: ${videoTimescale})
  Audio: ${audioTime.toFixed(3)}s (baseTime: ${audioBaseTime}, timescale: ${audioTimescale})
  Difference: ${timeDiff.toFixed(3)}s (${timeDiffMs.toFixed(1)}ms) [Video - Audio]
  Raw baseTime diff: ${videoBaseTime - audioBaseTime} ticks`);
      
      // Warn about significant differences that might indicate sync issues
      if (Math.abs(timeDiffMs) > 40) { // 40ms threshold
        this.log(`⚠️  Warning: Significant timing difference in segment file ${segmentFileIndex} (${timeDiffMs.toFixed(1)}ms) - potential A/V sync issue`);
      } else {
        this.log(`✅ Segment file ${segmentFileIndex} timing looks good (${timeDiffMs.toFixed(1)}ms difference)`);
      }
    }
  }

  async processAvailableData() {
    // This method is now much simpler since callbacks handle the data
    // We might still need it for any final processing or state checks
    // but the main data processing is handled by callbacks
  }
  async processFinalData() {
    // Check if there are any remaining unpaired moof boxes
    if (this.progressiveParser.pendingMoof) {
      this.log('Warning: Unpaired moof box at end of stream');
    }
    
    // Mark initial data as processed
    this.initialFileProcessingComplete = true;
    this.log(`Initial media file fully processed. Found ${this.initialFileChunksFromParser} media chunks from progressive parsing.`);
    
    // Check if we can mark completion now
    this.checkAllInitialFileChunksAppended();
    
    // Also check again after a short delay to ensure all pending append operations complete
    setTimeout(() => {
      if (this.isActive) {
        this.checkAllInitialFileChunksAppended();
      }
    }, 100);
  }

  onFirstSegmentAppended() {
    this.log('🎬 onFirstSegmentAppended called - relying on canplay event for playback');
    
    // Check if video is already playing (due to autoplay or previous play() call)
    if (!this.video.paused) {
      this.log('📺 Video is already playing, no need to call play()');
      if (!this.timingMetrics.videoPlayTime) {
        this.timingMetrics.videoPlayTime = Date.now() - this.startTime;
        this.log(`✓ Video already playing, recorded time: ${this.timingMetrics.videoPlayTime}ms`);
      }
      return;
    }
    
    // Add debug logging for buffer state
    this.log('🔍 Debug: video.buffered.length =', this.video.buffered.length);
    this.log('🔍 Debug: video.readyState =', this.video.readyState);
    this.log('🔍 Debug: MediaSource.readyState =', this.ms.readyState);
    
    // Check SourceBuffer states
    if (this.stateMachine && this.stateMachine.sourceBuffers) {
      const videoSB = this.stateMachine.sourceBuffers.video;
      const audioSB = this.stateMachine.sourceBuffers.audio;
      this.log('🔍 Debug: video SourceBuffer.buffered =', this.stateMachine.formatTimeRanges(videoSB.buffered));
      this.log('🔍 Debug: audio SourceBuffer.buffered =', this.stateMachine.formatTimeRanges(audioSB.buffered));
      this.log('🔍 Debug: video SourceBuffer.updating =', videoSB.updating);
      this.log('🔍 Debug: audio SourceBuffer.updating =', audioSB.updating);
    }
    
    this.log('⏳ Waiting for canplay event to trigger playback...');
  }

  checkAllInitialFileChunksAppended() {
    // Check if all chunks from initial file have been appended
    if (this.initialFileProcessingComplete && 
        this.initialFileChunksAppended >= this.initialFileChunksFromParser && 
        this.initialFileChunksFromParser > 0 &&
        !this.timingMetrics.allMediaChunksAppendedTime) {
      this.timingMetrics.allMediaChunksAppendedTime = Date.now() - this.startTime;
      this.log(`✓ All media chunks from initial file appended at ${this.timingMetrics.allMediaChunksAppendedTime}ms (${this.initialFileChunksFromParser} chunks)`);
    }
    
    // Alternative check: if processing is complete but no chunks were found in progressive parsing,
    // it might mean all chunks were in the media segments parsed at the end
    if (this.initialFileProcessingComplete && 
        this.initialFileChunksFromParser === 0 && 
        this.mediaSegmentCount.video > 0 && 
        this.mediaSegmentCount.audio > 0 &&
        !this.timingMetrics.allMediaChunksAppendedTime) {
      this.timingMetrics.allMediaChunksAppendedTime = Date.now() - this.startTime;
      this.log(`✓ All media chunks from initial file appended at ${this.timingMetrics.allMediaChunksAppendedTime}ms (fallback: no progressive chunks, using segment count)`);
    }
  }

  scheduleNextSegmentFetch() {
    const segmentDurationMs = 2000; // Assume 2-second segments
    this.downloadManager = new SegmentDownloadManager(segmentDurationMs);
    
    // The first fetch should be immediate after processing the init segment.
    this.fetchNextSegment();
  }

  async fetchNextSegment() {
    if (!this.isActive || !this.stateMachine) return;
    
    const startTime = Date.now();
    let fetchSuccess = false;
    this.currentSeqNum++;
    
    const nextSegmentFile = this.templateUrl.replace('${num}', this.currentSeqNum);
    const nextUrl = new URL(nextSegmentFile, this.baseUrl).href;
    
    try {
      this.log('Fetching next segment:', nextUrl);
      const response = await fetch(nextUrl);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.arrayBuffer();
      const nextData = new Uint8Array(data);
      
      if (!this.isActive) return;
      
      this.log('Fetched segment', this.currentSeqNum, 'size:', nextData.length);
      
      // Process the segment
      const nextProcessed = BjsnUtils.BjsnMp4Processor.processMediaSegment(nextData, [this.videoTrack.id, this.audioTrack.id]);
      
      // Analyze timing for the first moof of each track in this live segment
      this.analyzeLiveSegmentTiming(nextProcessed, this.currentSeqNum);
      
      // Append segments with proper timestampOffset
      const videoSB = this.stateMachine.sourceBuffers.video;
      const audioSB = this.stateMachine.sourceBuffers.audio;
      
      if (nextProcessed.mediaSegments[this.videoTrack.id]) {
        nextProcessed.mediaSegments[this.videoTrack.id].forEach((seg, segmentIndex) => {
          // Use the pre-calculated timestampOffset for video track
          const timestampOffset = this.timestampManager.getTrackTimestampOffset('video');
          
          // Extract timing information for detailed logging
          const baseMediaDecodeTime = BjsnUtils.Mp4BoxUtils.extractBaseMediaDecodeTime(seg);
          const mediaTimeInSeconds = baseMediaDecodeTime ? (baseMediaDecodeTime / this.timescale.video) : null;
          const finalPresentationTime = mediaTimeInSeconds !== null ? (mediaTimeInSeconds + timestampOffset) : null;
          const finalTimeStr = finalPresentationTime !== null ? finalPresentationTime.toFixed(3) : 'N/A';
          
          this.stateMachine.enqueue({
            type: 'append',
            sourceBuffer: videoSB,
            data: seg,
            timestampOffset: timestampOffset,
            callback: () => {
              // Live video segment appended
            }
          });
        });
      }
      
      if (nextProcessed.mediaSegments[this.audioTrack.id]) {
        nextProcessed.mediaSegments[this.audioTrack.id].forEach((seg, segmentIndex) => {
          // Use the pre-calculated timestampOffset for audio track
          const timestampOffset = this.timestampManager.getTrackTimestampOffset('audio');
          
          // Extract timing information for detailed logging
          const baseMediaDecodeTime = BjsnUtils.Mp4BoxUtils.extractBaseMediaDecodeTime(seg);
          const mediaTimeInSeconds = baseMediaDecodeTime ? (baseMediaDecodeTime / this.timescale.audio) : null;
          const finalPresentationTime = mediaTimeInSeconds !== null ? (mediaTimeInSeconds + timestampOffset) : null;
          const finalTimeStr = finalPresentationTime !== null ? finalPresentationTime.toFixed(3) : 'N/A';
          
          this.stateMachine.enqueue({
            type: 'append',
            sourceBuffer: audioSB,
            data: seg,
            timestampOffset: timestampOffset,
            callback: () => {
              // Live audio segment appended
            }
          });
        });
      }
      
      fetchSuccess = true;
    } catch (e) {
      this.log('Failed to fetch segment', this.currentSeqNum, e.message);
      this.currentSeqNum--;
    } finally {
      if (this.isActive) {
        const endTime = Date.now();
        const delay = this.downloadManager.calculateNextDelay(fetchSuccess, startTime, endTime);
        this.fetchInterval = setTimeout(() => this.fetchNextSegment(), delay);
      }
    }
  }

  // Analyze timing of live segments (downloaded via HTTP)
  analyzeLiveSegmentTiming(processedSegment, segmentNumber) {
    const segmentFileIndex = `live_${segmentNumber}`;
    
    // Initialize timing data for this segment file
    if (!this.segmentTimingData[segmentFileIndex]) {
      this.segmentTimingData[segmentFileIndex] = {
        video: null,
        audio: null,
        firstMoofSeen: { video: false, audio: false }
      };
    }
    
    const segmentData = this.segmentTimingData[segmentFileIndex];
    
    // Analyze video track if present
    if (processedSegment.mediaSegments[this.videoTrack.id] && processedSegment.mediaSegments[this.videoTrack.id].length > 0) {
      const firstVideoSegment = processedSegment.mediaSegments[this.videoTrack.id][0];
      const baseMediaDecodeTime = BjsnUtils.Mp4BoxUtils.extractBaseMediaDecodeTime(firstVideoSegment);
      if (baseMediaDecodeTime !== null) {
        const mediaTimeInSeconds = baseMediaDecodeTime / this.timescale.video;
        segmentData.video = {
          mediaTime: mediaTimeInSeconds,
          baseTime: baseMediaDecodeTime,
          timescale: this.timescale.video
        };
        segmentData.firstMoofSeen.video = true;
      }
    }
    
    // Analyze audio track if present
    if (processedSegment.mediaSegments[this.audioTrack.id] && processedSegment.mediaSegments[this.audioTrack.id].length > 0) {
      const firstAudioSegment = processedSegment.mediaSegments[this.audioTrack.id][0];
      const baseMediaDecodeTime = BjsnUtils.Mp4BoxUtils.extractBaseMediaDecodeTime(firstAudioSegment);
      if (baseMediaDecodeTime !== null) {
        const mediaTimeInSeconds = baseMediaDecodeTime / this.timescale.audio;
        segmentData.audio = {
          mediaTime: mediaTimeInSeconds,
          baseTime: baseMediaDecodeTime,
          timescale: this.timescale.audio
        };
        segmentData.firstMoofSeen.audio = true;
      }
    }
    
    // Compare if we have both tracks
    if (segmentData.video && segmentData.audio) {
      const videoTime = segmentData.video.mediaTime;
      const audioTime = segmentData.audio.mediaTime;
      const timeDiff = videoTime - audioTime;
      const timeDiffMs = timeDiff * 1000;
      
      const videoBaseTime = segmentData.video.baseTime;
      const audioBaseTime = segmentData.audio.baseTime;
      
      // Silent timing analysis - no logging
    }
  }
}

// Export classes for use in HTML file
window.BjsnMSE = {
  SegmentDownloadManager,
  SourceBufferStateMachine,
  MediaSourceOrchestrator,
  TimestampManager,
  PlaybackSession
};
