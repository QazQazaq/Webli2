import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use('/hls', express.static(join(__dirname, 'hls')));

// Data storage (in production, replace with MongoDB)
const DATA_FILE = join(__dirname, 'data.json');

// Initialize data file if it doesn't exist
if (!fs.existsSync(DATA_FILE)) {
  const initialData = {
    overlays: [],
    settings: {
      rtspUrl: 'rtsp://wowzaec2demo.streamlock.net/vod/mp4:BigBuckBunny_115k.mp4',
      volume: 0.5,
      autoplay: false
    }
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
}

// Create HLS directory if it doesn't exist
const HLS_DIR = join(__dirname, 'hls');
if (!fs.existsSync(HLS_DIR)) {
  fs.mkdirSync(HLS_DIR, { recursive: true });
}

// RTSP to HLS conversion process
let streamState = {
  isRunning: false,
  rtspUrl: null,
  startTime: null,
  ffmpegProcess: null,
  hasFFmpeg: false
};

// Check if FFmpeg is available
const checkFFmpeg = () => {
  return new Promise((resolve) => {
    const ffmpeg = spawn('ffmpeg', ['-version']);
    ffmpeg.on('error', () => resolve(false));
    ffmpeg.on('close', (code) => resolve(code === 0));
  });
};

// Initialize FFmpeg check
checkFFmpeg().then(hasFFmpeg => {
  streamState.hasFFmpeg = hasFFmpeg;
  console.log(`FFmpeg ${hasFFmpeg ? 'is available' : 'is NOT available'}`);
  if (!hasFFmpeg) {
    console.log('RTSP streaming will run in demo mode without FFmpeg');
  }
});

const startRTSPStream = (rtspUrl) => {
  if (!streamState.hasFFmpeg) {
    // Mock stream start - in WebContainer, we can't run FFmpeg
    streamState = {
      ...streamState,
      isRunning: true,
      rtspUrl: rtspUrl,
      startTime: new Date().toISOString()
    };
    
    // Create a mock HLS playlist for demonstration
    const mockPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:2.0,
segment0.ts
#EXTINF:2.0,
segment1.ts
#EXTINF:2.0,
segment2.ts
#EXT-X-ENDLIST`;
    
    const playlistPath = join(HLS_DIR, 'stream.m3u8');
    fs.writeFileSync(playlistPath, mockPlaylist);
    
    console.log(`Mock RTSP stream started for: ${rtspUrl}`);
    throw new Error('FFmpeg not available in WebContainer environment');
  }

  // Stop existing stream if running
  if (streamState.ffmpegProcess) {
    streamState.ffmpegProcess.kill('SIGTERM');
  }

  return new Promise((resolve, reject) => {
    const outputPath = join(HLS_DIR, 'stream.m3u8');
    
    // FFmpeg command to convert RTSP to HLS
    const ffmpegArgs = [
      '-i', rtspUrl,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '5',
      '-hls_flags', 'delete_segments+append_list',
      '-hls_allow_cache', '0',
      '-hls_segment_filename', join(HLS_DIR, 'segment%03d.ts'),
      '-y',
      outputPath
    ];

    console.log(`Starting FFmpeg with args: ${ffmpegArgs.join(' ')}`);
    
    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    streamState.ffmpegProcess = ffmpeg;
    streamState.isRunning = true;
    streamState.rtspUrl = rtspUrl;
    streamState.startTime = new Date().toISOString();

    ffmpeg.stdout.on('data', (data) => {
      console.log(`FFmpeg stdout: ${data}`);
    });

    ffmpeg.stderr.on('data', (data) => {
      const output = data.toString();
      console.log(`FFmpeg stderr: ${output}`);
      
      // Check for successful stream start indicators
      if (output.includes('Opening') || output.includes('Stream mapping')) {
        console.log('FFmpeg stream conversion started successfully');
      }
    });

    ffmpeg.on('error', (error) => {
      console.error('FFmpeg error:', error);
      streamState.isRunning = false;
      streamState.ffmpegProcess = null;
      reject(error);
    });

    ffmpeg.on('close', (code) => {
      console.log(`FFmpeg process exited with code ${code}`);
      streamState.isRunning = false;
      streamState.ffmpegProcess = null;
      
      if (code !== 0 && code !== null) {
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });

    // Give FFmpeg a moment to start, then resolve
    setTimeout(() => {
      if (streamState.isRunning) {
        resolve(outputPath);
      } else {
        reject(new Error('FFmpeg failed to start'));
      }
    }, 3000);
  });
};

const stopRTSPStream = () => {
  if (streamState.ffmpegProcess) {
    console.log('Stopping FFmpeg process');
    streamState.ffmpegProcess.kill('SIGTERM');
    streamState.ffmpegProcess = null;
  }
  
  streamState.isRunning = false;
  streamState.rtspUrl = null;
  streamState.startTime = null;
  
  // Clean up HLS files
  try {
    const files = fs.readdirSync(HLS_DIR);
    files.forEach(file => {
      if (file.endsWith('.m3u8') || file.endsWith('.ts')) {
        fs.unlinkSync(join(HLS_DIR, file));
      }
    });
  } catch (error) {
    console.error('Error cleaning up HLS files:', error);
  }
};

// Helper functions
const readData = () => {
  const data = fs.readFileSync(DATA_FILE, 'utf8');
  return JSON.parse(data);
};

const writeData = (data) => {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
};

// API Routes

// Start RTSP stream
app.post('/api/stream/start', (req, res) => {
  try {
    const { rtspUrl } = req.body;
    if (!rtspUrl) {
      return res.status(400).json({ error: 'RTSP URL is required' });
    }
    
    if (!streamState.hasFFmpeg) {
      return res.status(500).json({ 
        error: 'FFmpeg not available',
        note: 'FFmpeg not available in WebContainer environment. RTSP streaming requires FFmpeg for web compatibility.',
        mode: 'demo'
      });
    }
    
    try {
      const hlsPath = startRTSPStream(rtspUrl);
      res.json({
        message: 'RTSP stream conversion started',
        hlsUrl: `http://localhost:${PORT}/hls/stream.m3u8`,
        rtspUrl: rtspUrl,
        mode: 'production'
      });
    } catch (error) {
      console.error('Stream start error:', error);
      
      if (error.message.includes('FFmpeg not available')) {
        res.status(500).json({ 
          error: 'FFmpeg not available',
          note: 'FFmpeg not available in WebContainer environment. RTSP streaming requires FFmpeg for web compatibility.',
          mode: 'demo'
        });
      } else {
        res.status(500).json({ 
          error: 'Failed to start RTSP stream conversion',
          details: error.message,
          rtspUrl: rtspUrl
        });
      }
    }
  } catch (error) {
    console.error('Stream start error:', error);
    res.status(500).json({ 
      error: 'Failed to start RTSP stream',
      details: error.message
    });
  }
});

// Stop RTSP stream
app.post('/api/stream/stop', (req, res) => {
  try {
    stopRTSPStream();
    res.json({ message: 'RTSP stream stopped' });
  } catch (error) {
    console.error('Stop stream error:', error);
    res.status(500).json({ 
      error: 'Failed to stop stream',
      details: error.message
    });
  }
});

// Get stream status
app.get('/api/stream/status', (req, res) => {
  const isRunning = streamState.isRunning;
  const hlsExists = fs.existsSync(join(HLS_DIR, 'stream.m3u8'));
  
  res.json({
    isRunning,
    hlsAvailable: hlsExists,
    hlsUrl: hlsExists ? `http://localhost:${PORT}/hls/stream.m3u8` : null,
    rtspUrl: streamState.rtspUrl,
    startTime: streamState.startTime,
    mode: streamState.hasFFmpeg ? 'production' : 'demo',
    hasFFmpeg: streamState.hasFFmpeg
  });
});

// Get all overlays
app.get('/api/overlays', (req, res) => {
  try {
    const data = readData();
    res.json(data.overlays);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve overlays' });
  }
});

// Get specific overlay
app.get('/api/overlays/:id', (req, res) => {
  try {
    const data = readData();
    const overlay = data.overlays.find(o => o.id === req.params.id);
    if (!overlay) {
      return res.status(404).json({ error: 'Overlay not found' });
    }
    res.json(overlay);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve overlay' });
  }
});

// Create new overlay
app.post('/api/overlays', (req, res) => {
  try {
    const data = readData();
    const newOverlay = {
      id: Date.now().toString(),
      ...req.body,
      createdAt: new Date().toISOString()
    };
    data.overlays.push(newOverlay);
    writeData(data);
    res.status(201).json(newOverlay);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create overlay' });
  }
});

// Update overlay
app.put('/api/overlays/:id', (req, res) => {
  try {
    const data = readData();
    const index = data.overlays.findIndex(o => o.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ error: 'Overlay not found' });
    }
    data.overlays[index] = { ...data.overlays[index], ...req.body };
    writeData(data);
    res.json(data.overlays[index]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update overlay' });
  }
});

// Delete overlay
app.delete('/api/overlays/:id', (req, res) => {
  try {
    const data = readData();
    const index = data.overlays.findIndex(o => o.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ error: 'Overlay not found' });
    }
    data.overlays.splice(index, 1);
    writeData(data);
    res.json({ message: 'Overlay deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete overlay' });
  }
});

// Get settings
app.get('/api/settings', (req, res) => {
  try {
    const data = readData();
    res.json(data.settings);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve settings' });
  }
});

// Update settings
app.put('/api/settings', (req, res) => {
  try {
    const data = readData();
    data.settings = { ...data.settings, ...req.body };
    writeData(data);
    res.json(data.settings);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});