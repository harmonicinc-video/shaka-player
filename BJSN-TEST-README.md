# BJSN Test Page

This test page allows you to test the BJSN (Bytedance JSON) implementation for TikTok CMAF streaming.

## Quick Start

1. **Start the test server:**
   ```bash
   python3 serve-bjsn-test.py
   ```

2. **Open your browser to:**
   ```
   http://localhost:8080/bjsn-test.html
   ```

3. **Test BJSN assets:**
   - Enter a BJSN asset URL in the text box
   - Click "Load Asset" to play the stream
   - Click "Test BJSN Parser" to analyze the BJSN metadata

## Features

### 🎬 **Video Player**
- Full Shaka Player integration
- BJSN manifest parsing
- Real-time status logging
- Error handling and debugging

### ⚙️ **Configuration Options**
- **Enable BJSN Parser**: Toggle BJSN support on/off
- **Debug Logging**: Enable detailed logging for debugging

### 🧪 **Testing Tools**
- **Load Asset**: Play BJSN or standard streams
- **Test BJSN Parser**: Analyze BJSN metadata without playing
- **Clear Player**: Reset the player state

### 📊 **Status Monitoring**
- Real-time status updates
- BJSN metadata display
- Error reporting with timestamps
- Manifest information

## BJSN Asset Format

The test page expects BJSN assets with the following structure:

```json
{
  "type": "static|dynamic",
  "gear_num": 1,
  "seq_num": 10,
  "template_path": "media-${num}.mp4",
  "gear_list": [
    {
      "hd5": {
        "realtime_bitrate": 800000,
        "drm": {
          "key": "value"
        }
      }
    }
  ]
}
```

## Sample URLs

The test page includes sample URLs for testing:
- BJSN Stream: `https://example.com/stream/media-first.mp4`
- Standard DASH: `https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd`

## Configuration

### Enable BJSN Parser
```javascript
player.configure({
  manifest: {
    bjsn: {
      enabled: true,
      options: {
        debugLogging: true
      }
    }
  }
});
```

### Loading Assets
```javascript
// Load BJSN asset
await player.load('https://example.com/stream/media-first.mp4');

// The player will automatically detect BJSN content
// and use the appropriate parser
```

## Troubleshooting

### Common Issues

1. **"Browser not supported"**
   - Ensure you're using a modern browser with MSE support
   - Check browser console for detailed error messages

2. **"BJSN Parser not available"**
   - Verify the compiled Shaka Player includes BJSN support
   - Check that the configuration is properly set

3. **"No BJSN data found"**
   - Ensure the asset contains a valid BJSN box
   - Check that the MP4 segment structure is correct

4. **CORS errors**
   - Use the provided server script for local testing
   - Ensure proper CORS headers for remote assets

### Debug Tips

- Enable debug logging for detailed information
- Use browser developer tools to inspect network requests
- Check the status log for detailed error messages
- Use the "Test BJSN Parser" button to analyze assets

## Implementation Status

✅ **Complete Features:**
- BJSN box parsing
- Manifest generation
- Single-gear stream support
- Configuration integration
- Error handling

🔄 **Future Enhancements:**
- Multi-gear ABR support (Phase 2)
- Live streaming optimization (Phase 3)
- Advanced DRM integration

## Development

To modify the test page:

1. Edit `bjsn-test.html` for UI changes
2. Rebuild Shaka Player: `python3 build/all.py`
3. Restart the test server
4. Refresh the browser

The test page automatically includes the compiled Shaka Player with BJSN support.
