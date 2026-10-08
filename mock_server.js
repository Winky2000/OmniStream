const express = require('express');
const app = express();

function nowEpochSec() {
  return Math.floor(Date.now() / 1000);
}

function clampInt(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

// -----------------------------
// Minimal Plex library endpoints
// -----------------------------

const plexData = (() => {
  const now = nowEpochSec();

  const mkMovie = ({ title, addedDaysAgo, genres, codec, res, sizeBytes, unwatched }) => ({
    type: 'movie',
    title,
    addedAt: now - (addedDaysAgo * 24 * 60 * 60),
    Genre: (genres || []).map(tag => ({ tag })),
    Media: [
      {
        videoCodec: codec,
        videoResolution: res,
        Part: [{ size: sizeBytes }]
      }
    ],
    _unwatched: !!unwatched
  });

  const mkEpisode = ({ show, epTitle, addedDaysAgo, genres, codec, res, sizeBytes, unwatched }) => ({
    type: 'episode',
    title: epTitle,
    grandparentTitle: show,
    addedAt: now - (addedDaysAgo * 24 * 60 * 60),
    Genre: (genres || []).map(tag => ({ tag })),
    Media: [
      {
        videoCodec: codec,
        videoResolution: res,
        Part: [{ size: sizeBytes }]
      }
    ],
    _unwatched: !!unwatched
  });

  const movies = [
    mkMovie({ title: 'Mock Movie A', addedDaysAgo: 1, genres: ['Action'], codec: 'h264', res: '1080', sizeBytes: 4_400_000_000, unwatched: true }),
    mkMovie({ title: 'Mock Movie B', addedDaysAgo: 2, genres: ['Drama'], codec: 'hevc', res: '2160', sizeBytes: 8_800_000_000, unwatched: false }),
    mkMovie({ title: 'Mock Movie C', addedDaysAgo: 3, genres: ['Comedy'], codec: 'h264', res: '720', sizeBytes: 2_200_000_000, unwatched: true }),
    mkMovie({ title: 'Mock Movie D', addedDaysAgo: 10, genres: ['Action'], codec: 'h264', res: '1080', sizeBytes: 3_300_000_000, unwatched: false }),
    mkMovie({ title: 'Mock Movie E', addedDaysAgo: 20, genres: ['Sci-Fi'], codec: 'hevc', res: '1080', sizeBytes: 5_500_000_000, unwatched: false })
  ];

  const shows = [
    { type: 'show', title: 'Mock Show One', addedAt: now - (100 * 24 * 60 * 60), Genre: [{ tag: 'Drama' }] },
    { type: 'show', title: 'Mock Show Two', addedAt: now - (120 * 24 * 60 * 60), Genre: [{ tag: 'Comedy' }] }
  ];

  const episodes = [
    mkEpisode({ show: 'Mock Show One', epTitle: 'S01E01 Pilot', addedDaysAgo: 1, genres: ['Drama'], codec: 'h264', res: '1080', sizeBytes: 1_100_000_000, unwatched: true }),
    mkEpisode({ show: 'Mock Show One', epTitle: 'S01E02 Second', addedDaysAgo: 2, genres: ['Drama'], codec: 'h264', res: '1080', sizeBytes: 1_050_000_000, unwatched: false }),
    mkEpisode({ show: 'Mock Show One', epTitle: 'S01E03 Third', addedDaysAgo: 4, genres: ['Drama'], codec: 'hevc', res: '2160', sizeBytes: 1_800_000_000, unwatched: true }),
    mkEpisode({ show: 'Mock Show Two', epTitle: 'S02E01 Return', addedDaysAgo: 1, genres: ['Comedy'], codec: 'h264', res: '720', sizeBytes: 750_000_000, unwatched: false }),
    mkEpisode({ show: 'Mock Show Two', epTitle: 'S02E02 Again', addedDaysAgo: 6, genres: ['Comedy'], codec: 'h264', res: '1080', sizeBytes: 900_000_000, unwatched: true }),
    mkEpisode({ show: 'Mock Show Two', epTitle: 'S02E03 Finale', addedDaysAgo: 12, genres: ['Comedy'], codec: 'h264', res: '1080', sizeBytes: 950_000_000, unwatched: false }),
    mkEpisode({ show: 'Mock Show One', epTitle: 'S01E04 Fourth', addedDaysAgo: 30, genres: ['Drama'], codec: 'h264', res: '1080', sizeBytes: 1_000_000_000, unwatched: false }),
    mkEpisode({ show: 'Mock Show One', epTitle: 'S01E05 Fifth', addedDaysAgo: 45, genres: ['Drama'], codec: 'h264', res: '720', sizeBytes: 800_000_000, unwatched: true }),
    mkEpisode({ show: 'Mock Show Two', epTitle: 'S01E01 Start', addedDaysAgo: 60, genres: ['Comedy'], codec: 'h264', res: '720', sizeBytes: 700_000_000, unwatched: false }),
    mkEpisode({ show: 'Mock Show Two', epTitle: 'S01E02 Next', addedDaysAgo: 75, genres: ['Comedy'], codec: 'h264', res: '1080', sizeBytes: 880_000_000, unwatched: false })
  ];

  const sumBytes = (items) => items.reduce((acc, it) => {
    const medias = Array.isArray(it.Media) ? it.Media : [];
    const parts = medias.length && Array.isArray(medias[0].Part) ? medias[0].Part : [];
    const bytes = parts.length ? Number(parts[0].size) : 0;
    return acc + (Number.isFinite(bytes) ? bytes : 0);
  }, 0);

  const movieBytes = sumBytes(movies);
  const tvBytes = sumBytes(episodes);

  return {
    libraries: [
      { key: '1', title: 'Mock Movies', type: 'movie', totalSizeBytes: movieBytes },
      { key: '2', title: 'Mock TV', type: 'show', totalSizeBytes: tvBytes }
    ],
    movies,
    shows,
    episodes
  };
})();

app.get('/library/sections', (req, res) => {
  res.json({
    MediaContainer: {
      size: plexData.libraries.length,
      Directory: plexData.libraries.map(l => ({
        key: l.key,
        title: l.title,
        type: l.type,
        totalSize: l.totalSizeBytes
      }))
    }
  });
});

app.get('/library/sections/:key/all', (req, res) => {
  const key = String(req.params.key || '');
  const lib = plexData.libraries.find(l => l.key === key);
  if (!lib) return res.status(404).json({ error: 'Library not found' });

  const start = clampInt(req.query['X-Plex-Container-Start'], 0, 1_000_000, 0);
  const size = clampInt(req.query['X-Plex-Container-Size'], 0, 10_000, 50);
  const sort = String(req.query.sort || '');
  const typeFilter = String(req.query.type || '').trim();
  const unwatched = String(req.query.unwatched || '').trim() === '1';

  let items;
  if (lib.type === 'movie') {
    items = plexData.movies;
  } else {
    // TV library: shows by default; episodes when type=4 is requested.
    items = typeFilter === '4' ? plexData.episodes : plexData.shows;
  }

  if (unwatched) {
    items = items.filter(it => it && it._unwatched === true);
  }

  if (sort.toLowerCase() === 'addedat:desc') {
    items = items.slice().sort((a, b) => (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0));
  }

  const totalSize = items.length;
  const page = size === 0 ? [] : items.slice(start, start + size);

  res.json({
    MediaContainer: {
      totalSize,
      size: page.length,
      Metadata: page.map(it => {
        const out = { ...it };
        delete out._unwatched;
        return out;
      })
    }
  });
});

// Mock endpoint that returns Plex-style sessions
app.get('/status/sessions', (req, res) => {
  res.json({
    MediaContainer: {
      size: 3,
      Metadata: [
        {
          title: 'Breaking Bad S1E1',
          grandparentTitle: 'Breaking Bad',
          year: 2008,
          User: { title: 'alice' },
          Player: { platform: 'Chrome', state: 'playing' },
          thumb: 'https://static.tvmaze.com/uploads/images/original_untouched/0/2400.jpg',
          duration: 2700000,
          viewOffset: 1350000
        },
        {
          title: 'The Office S3E5',
          grandparentTitle: 'The Office',
          year: 2007,
          User: { title: 'bob' },
          Player: { platform: 'Roku', state: 'paused' },
          thumb: 'https://static.tvmaze.com/uploads/images/original_untouched/85/213184.jpg',
          duration: 1320000,
          viewOffset: 660000
        },
        {
          title: 'Live News Channel',
          type: 'live',
          User: { title: 'carol' },
          Player: { platform: 'FireTV', state: 'playing' },
          thumb: 'https://static.tvmaze.com/uploads/images/original_untouched/1/2668.jpg',
          duration: 3600000,
          viewOffset: 1800000
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
      UserId: 'u1',
      NowPlayingItem: {
        Id: 'i1',
        Name: 'Inception',
        EpisodeTitle: null,
        ProductionYear: 2010,
        ImageTags: { Primary: 'mock' },
        RunTimeTicks: 145000000000
      },
      PlayState: {
        PositionTicks: 72500000000,
        PlayMethod: 'DirectPlay'
      },
      Client: 'Edge',
      DeviceName: 'Windows 10'
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
