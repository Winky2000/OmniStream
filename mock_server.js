const express = require('express');
const app = express();

// Mock endpoint that returns Plex-style sessions
app.get('/status/sessions', (req, res) => {
  res.json({
    MediaContainer: {
      size: 2,
      Metadata: [
        {
          title: 'Breaking Bad S1E1',
          grandparentTitle: 'Breaking Bad',
          User: { title: 'alice' },
          duration: 2700000,
          viewOffset: 1350000
        },
        {
          title: 'The Office S3E5',
          grandparentTitle: 'The Office',
          User: { title: 'bob' },
          duration: 1320000,
          viewOffset: 660000
        }
      ]
    }
  });
});

// Mock endpoint that returns Jellyfin/Emby-style sessions
app.get('/Sessions', (req, res) => {
  res.json([
    {
      UserName: 'charlie',
      NowPlayingItem: {
        Name: 'Inception',
        RunTimeTicks: 145000000000
      },
      PlayState: {
        PositionTicks: 72500000000
      }
    }
  ]);
});

app.get('/System/Info', (req, res) => {
  res.json({
    Id: 'mock-server',
    Name: 'MockServer',
    Version: '1.0.0',
    MachineName: 'mock-host'
  });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Mock server listening on :${PORT}`));
