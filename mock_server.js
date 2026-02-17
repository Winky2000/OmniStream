const express = require('express');
const app = express();

// Simple mock endpoints that resemble Plex, Jellyfin, and Emby basics
app.get('/status/sessions', (req, res) => {
  res.json({
    MediaContainer: {
      size: 1,
      Metadata: [
        {
          title: 'Mock Stream',
          user: 'tester',
          state: 'playing'
        }
      ]
    }
  });
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
