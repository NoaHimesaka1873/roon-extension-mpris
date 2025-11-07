'use strict';

const Player = require('mpris-service');
const RoonApi = require('node-roon-api');
const RoonApiStatus = require('node-roon-api-status');
const RoonApiTransport = require('node-roon-api-transport');
const RoonApiImage = require('node-roon-api-image');
const fs = require('fs');
const path = require('path');
const os = require('os');

const pkg = require('../package.json');

const ZONE_PREFERENCE = (process.env.ROON_MPRIS_ZONE || '').trim();
const DEFAULT_TRACK_ID_SUFFIX = 'track/0';

const player = Player({
  name: 'roon',
  identity: 'Roon MPRIS Bridge',
  supportedUriSchemes: ['file', 'http', 'https'],
  supportedMimeTypes: [
    'audio/mpeg', 'audio/flac', 'audio/wav', 'audio/ogg', 'audio/aac',
    'audio/mp4', 'audio/x-ms-wma', 'audio/x-wav', 'audio/x-flac'
  ],
  supportedInterfaces: ['player']
});

player.canQuit = false;
player.canRaise = true;
player.hasTrackList = false;
player.canSetFullscreen = false;
player.playbackStatus = 'Stopped';
player.minimumRate = 1;
player.maximumRate = 1;
player.rate = 1;
player.metadata = {
  'mpris:trackid': player.objectPath(DEFAULT_TRACK_ID_SUFFIX),
  'xesam:title': 'Roon',
  'xesam:album': '—',
  'xesam:artist': ['—']
};
player.canControl = false;
player.canPlay = false;
player.canPause = false;
player.canSeek = false;
player.canGoNext = false;
player.canGoPrevious = false;
player.loopStatus = 'None';
player.shuffle = false;

const roon = new RoonApi({
  extension_id: 'com.yuifunami.roon.mpris',
  display_name: 'Roon MPRIS Bridge',
  display_version: pkg.version,
  publisher: pkg.author || 'Roon MPRIS Bridge',
  email: 'mpris@localhost',
  website: 'https://github.com/yuifunami/roon-extension-mpris',
  core_paired: onCorePaired,
  core_unpaired: onCoreUnpaired
});

const statusService = new RoonApiStatus(roon);

roon.init_services({
  required_services: [RoonApiTransport, RoonApiImage],
  provided_services: [statusService]
});

const zonePreferenceLower = ZONE_PREFERENCE.toLowerCase();

let activeCore = null;
let transport = null;
let imageSvc = null;
let zones = {};
let activeZoneId = null;
let activeZone = null;
let lastSeekSeconds = 0;
let lastSeekUpdate = Date.now();
let activeLengthSeconds = null;
let lastKnownZoneState = 'stopped';

const logger = createLogger('mpris');

setStatus('Waiting for Roon Core authorisation...', false);

// Improve desktop integration on some DEs (icon/title mapping)
player.desktopEntry = 'roon-extension-mpris';

player.on('error', (err) => {
  logger.error('MPRIS/DBus error', { err: err && (err.stack || err.message || err) });
});

// Log the service name that was registered (helps debugging DEs)
setTimeout(() => {
  try {
    logger.info('MPRIS service started', { serviceName: player.serviceName });
  } catch (e) {}
}, 1000);

player.on('quit', () => {
  logger.info('Quit requested via MPRIS, shutting down.');
  process.exit(0);
});

player.on('raise', () => {
  logger.info('Raise requested via MPRIS');
});

player.on('play', () => sendTransportCommand('play'));
player.on('pause', () => sendTransportCommand('pause'));
player.on('playpause', () => sendTransportCommand('playpause'));
player.on('stop', () => sendTransportCommand('stop'));
player.on('next', () => sendTransportCommand('next'));
player.on('previous', () => sendTransportCommand('previous'));
player.on('seek', offset => {
  const zone = ensureActiveZone();
  if (!zone) return;
  const seconds = offset / 1_000_000;
  logger.debug('Seek request (relative)', { offsetSeconds: seconds });
  transport.seek(zone, 'relative', seconds, handleTransportResult('seek'));
});

player.on('position', event => {
  const zone = ensureActiveZone();
  if (!zone) return;
  if (event.trackId && event.trackId !== player.metadata['mpris:trackid']) {
    logger.debug('Ignoring SetPosition for non-current track', event);
    return;
  }
  const seconds = event.position / 1_000_000;
  logger.debug('SetPosition request', { positionSeconds: seconds });
  transport.seek(zone, 'absolute', seconds, handleTransportResult('seek'));
});

player.getPosition = function getPosition() {
  if (!activeZone) return 0;

  let seconds = lastSeekSeconds;
  if (lastKnownZoneState === 'playing') {
    seconds += (Date.now() - lastSeekUpdate) / 1000;
  }

  if (typeof activeLengthSeconds === 'number') {
    seconds = Math.min(seconds, activeLengthSeconds);
  }

  return Math.max(0, Math.floor(seconds * 1_000_000));
};

roon.start_discovery();

function onCorePaired(core) {
  activeCore = core;
  transport = core.services.RoonApiTransport;
  imageSvc = core.services.RoonApiImage;

  logger.info('Paired with Roon Core', {
    core_id: core.core_id,
    name: core.display_name,
    version: core.display_version
  });

  setStatus(`Connected to ${core.display_name}`, false);

  transport.subscribe_zones((command, payload) => {
    switch (command) {
      case 'Subscribed':
        onZonesSubscribed(payload.zones || []);
        break;
      case 'Changed':
        onZonesChanged(payload);
        break;
      case 'Unsubscribed':
        logger.warn('Transport subscription unsubscribed');
        zones = {};
        activateZone(null);
        break;
      default:
        logger.debug('Unhandled transport subscription message', { command, payload });
    }
  });
}

function onCoreUnpaired(core) {
  logger.warn('Lost connection to Roon Core', {
    core_id: core.core_id,
    name: core.display_name
  });

  activeCore = null;
  transport = null;
  zones = {};
  activateZone(null);

  setStatus('Waiting for Roon Core authorisation...', false);
}

function onZonesSubscribed(zoneList) {
  logger.info('Initial zone list received', { count: zoneList.length });
  zones = zoneList.reduce((acc, zone) => {
    acc[zone.zone_id] = zone;
    return acc;
  }, {});

  selectAndActivateZone();
}

function onZonesChanged(changeSet) {
  if (changeSet.zones_removed) {
    changeSet.zones_removed.forEach(zoneId => {
      delete zones[zoneId];
      if (activeZoneId === zoneId) {
        logger.info('Active zone removed', { zoneId });
        activateZone(null);
      }
    });
  }

  if (changeSet.zones_added) {
    changeSet.zones_added.forEach(zone => {
      zones[zone.zone_id] = zone;
      logger.debug('Zone added', { zone_id: zone.zone_id, name: zone.display_name });
    });
  }

  if (changeSet.zones_changed) {
    changeSet.zones_changed.forEach(zone => {
      zones[zone.zone_id] = zone;
      if (zone.zone_id === activeZoneId) {
        activateZone(zone);
      }
    });
  }

  if (changeSet.zones_seek_changed) {
    changeSet.zones_seek_changed.forEach(seekUpdate => {
      const zone = zones[seekUpdate.zone_id];
      if (!zone) return;
      if (!zone.now_playing) zone.now_playing = {};
      zone.now_playing.seek_position = seekUpdate.seek_position;
      zone.queue_time_remaining = seekUpdate.queue_time_remaining;

      if (seekUpdate.zone_id === activeZoneId) {
        updateSeekState(zone);
        player.seeked(Math.floor((seekUpdate.seek_position || 0) * 1_000_000));
      }
    });
  }

  // Only (re)select when we currently have no active zone
  if (!activeZoneId) selectAndActivateZone();
}

function selectAndActivateZone() {
  const zoneCandidates = Object.values(zones);
  if (!zoneCandidates.length) {
    activateZone(null);
    return;
  }

  const preferred = pickPreferredZone(zoneCandidates);
  if (preferred) {
    activateZone(preferred);
    return;
  }

  if (activeZoneId && zones[activeZoneId]) {
    activateZone(zones[activeZoneId]);
    return;
  }

  activateZone(zoneCandidates[0]);
}

function pickPreferredZone(zoneCandidates) {
  if (ZONE_PREFERENCE) {
    const matched = zoneCandidates.find(zone => matchesZonePreference(zone));
    if (matched) return matched;
  }

  const playingZone = zoneCandidates.find(zone => zone.state === 'playing');
  if (playingZone) return playingZone;

  return null;
}

function matchesZonePreference(zone) {
  if (!ZONE_PREFERENCE) return false;
  if (!zone) return false;
  if (zone.zone_id && zone.zone_id.toLowerCase() === zonePreferenceLower) return true;
  if (zone.display_name && zone.display_name.toLowerCase() === zonePreferenceLower) return true;
  if (Array.isArray(zone.outputs)) {
    return zone.outputs.some(output => {
      if (!output) return false;
      if (output.output_id && output.output_id.toLowerCase() === zonePreferenceLower) return true;
      if (output.display_name && output.display_name.toLowerCase() === zonePreferenceLower) return true;
      return false;
    });
  }
  return false;
}

function activateZone(zone) {
  if (!zone) {
    activeZoneId = null;
    activeZone = null;
    lastKnownZoneState = 'stopped';
    lastSeekSeconds = 0;
    activeLengthSeconds = null;
    player.metadata = {
      'mpris:trackid': player.objectPath(DEFAULT_TRACK_ID_SUFFIX),
      'xesam:title': 'Roon',
      'xesam:album': '—',
      'xesam:artist': ['—']
    };
    player.playbackStatus = 'Stopped';
    // Keep controllable so DE media widgets can remain visible
    player.canControl = !!transport;
    player.canPlay = false;
    player.canPause = false;
    player.canSeek = false;
    player.canGoNext = false;
    player.canGoPrevious = false;
    player.shuffle = false;
    player.loopStatus = 'None';

    if (activeCore) {
      setStatus(`Connected to ${activeCore.display_name} (no active zone)`, false);
    }
    return;
  }

  activeZoneId = zone.zone_id;
  activeZone = zone;

  logger.info('Active zone updated', {
    zone_id: zone.zone_id,
    name: zone.display_name,
    state: zone.state
  });

  updateFromActiveZone(zone);
}

function updateFromActiveZone(zone) {
  if (!zone) return;

  updateCapabilities(zone);
  updateMetadata(zone);
  updatePlaybackState(zone);
  updateSeekState(zone);

  if (activeCore) {
    setStatus(`Connected to ${activeCore.display_name} · Zone: ${zone.display_name}`, false);
  }
}

function updateCapabilities(zone) {
  player.canControl = true;
  // GNOME shell requires CanPlay=true to show the player.
  // Keep it true when playback is ongoing or can be started.
  player.canPlay = !!(zone && (zone.is_play_allowed || zone.state === 'playing' || zone.state === 'paused' || zone.state === 'loading'));
  player.canPause = !!zone.is_pause_allowed;
  player.canSeek = !!zone.is_seek_allowed && hasSeekInfo(zone);
  player.canGoNext = !!zone.is_next_allowed;
  player.canGoPrevious = !!zone.is_previous_allowed;

  if (zone.settings) {
    player.shuffle = !!zone.settings.shuffle;
    player.loopStatus = mapLoopStatus(zone.settings.loop);
  } else {
    player.shuffle = false;
    player.loopStatus = 'None';
  }
}

function updateMetadata(zone) {
  const metadata = {
    'mpris:trackid': player.objectPath(`zone/${zone.zone_id}`)
  };

  const nowPlaying = zone.now_playing || {};

  const length = normaliseNumber(nowPlaying.length);
  if (typeof length === 'number') {
    metadata['mpris:length'] = Math.floor(length * 1_000_000);
  }

  let title = pickText([
    nowPlaying.title,
    extractLine(nowPlaying.three_line, 'line1'),
    extractLine(nowPlaying.two_line, 'line2'),
    extractLine(nowPlaying.one_line, 'line1')
  ]);

  if (!title) title = zone.display_name || 'Roon';
  metadata['xesam:title'] = title;

  let artist = pickText([
    nowPlaying.artist,
    nowPlaying.artist_line,
    extractLine(nowPlaying.three_line, 'line2'),
    extractLine(nowPlaying.two_line, 'line1')
  ]);

  if (!artist) artist = 'Roon';
  metadata['xesam:artist'] = [artist];

  let album = pickText([
    nowPlaying.album,
    extractLine(nowPlaying.three_line, 'line3')
  ]);

  if (!album) album = '—';
  metadata['xesam:album'] = album;

  if (nowPlaying.image_key) {
    resolveArtFile(nowPlaying.image_key).then((fileUrl) => {
      if (!fileUrl) return;
      // Re-apply with artUrl once available
      const current = Object.assign({}, player.metadata);
      current['mpris:artUrl'] = fileUrl;
      player.metadata = current;
    }).catch((err) => {
      logger.warn('Failed to resolve album art', { err });
    });
  }

  player.metadata = metadata;
}

function updatePlaybackState(zone) {
  lastKnownZoneState = zone.state || 'stopped';
  player.playbackStatus = mapPlaybackStatus(zone.state);
}

function updateSeekState(zone) {
  const nowPlaying = zone.now_playing || {};
  const position = normaliseNumber(nowPlaying.seek_position);
  if (typeof position === 'number') {
    lastSeekSeconds = position;
    lastSeekUpdate = Date.now();
  } else {
    lastSeekSeconds = 0;
    lastSeekUpdate = Date.now();
  }

  const length = normaliseNumber(nowPlaying.length);
  activeLengthSeconds = typeof length === 'number' ? length : null;
}

function mapPlaybackStatus(state) {
  switch ((state || '').toLowerCase()) {
    case 'playing':
      return 'Playing';
    case 'paused':
      return 'Paused';
    case 'loading':
      return 'Playing';
    case 'stopped':
    default:
      return 'Stopped';
  }
}

function mapLoopStatus(loop) {
  switch ((loop || '').toLowerCase()) {
    case 'loop_one':
      return 'Track';
    case 'loop':
      return 'Playlist';
    default:
      return 'None';
  }
}

function sendTransportCommand(control) {
  const zone = ensureActiveZone();
  if (!zone) return;

  if (!transport) {
    logger.warn('Transport unavailable for command', { control });
    return;
  }

  logger.debug('Sending transport control', { control, zone: zone.zone_id });
  transport.control(zone, control, handleTransportResult(control));
}

function handleTransportResult(action) {
  return err => {
    if (err) {
      logger.error('Transport command failed', { action, err });
    }
  };
}

function ensureActiveZone() {
  if (activeZone) return activeZone;
  selectAndActivateZone();
  return activeZone;
}

function hasSeekInfo(zone) {
  const nowPlaying = zone && zone.now_playing;
  return nowPlaying && typeof normaliseNumber(nowPlaying.seek_position) === 'number';
}

function pickText(values) {
  for (const value of values) {
    const text = extractText(value);
    if (text) return text;
  }
  return null;
}

function extractLine(line, key) {
  if (!line) return null;
  if (typeof line === 'string') return line;
  if (typeof line === 'number') return line.toString();
  if (typeof line === 'object') {
    if (line[key] && typeof line[key] === 'string') return line[key];
    const candidate = Object.values(line).find(v => typeof v === 'string');
    if (candidate) return candidate;
  }
  return null;
}

function extractText(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toString();
  if (typeof value === 'object') {
    return extractLine(value, 'line1');
  }
  return null;
}

function normaliseNumber(value) {
  if (value === null || value === undefined) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function setStatus(message, isError) {
  try {
    statusService.set_status(message, !!isError);
  } catch (error) {
    logger.error('Failed to update status service', { error });
  }
}

// Settings UI removed: configuration is driven via environment variables only.

function createLogger(scope) {
  return {
    info: (message, meta) => logWithLevel('INFO', scope, message, meta),
    warn: (message, meta) => logWithLevel('WARN', scope, message, meta),
    error: (message, meta) => logWithLevel('ERROR', scope, message, meta),
    debug: (message, meta) => {
      if (process.env.ROON_MPRIS_DEBUG) {
        logWithLevel('DEBUG', scope, message, meta);
      }
    }
  };
}

function logWithLevel(level, scope, message, meta) {
  const line = `[${level}] [${scope}] ${message}`;
  if (meta) {
    console.log(line, meta);
  } else {
    console.log(line);
  }
}

// --- Album art caching ---
const artCacheDir = path.join(os.tmpdir(), 'roon-mpris-art');
ensureDir(artCacheDir);
const keyToFilePath = new Map();

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {}
}

function keyToFilename(key) {
  // Sanitize key for filesystem
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(artCacheDir, `${safe}.jpg`);
}

async function resolveArtFile(imageKey) {
  if (!imageSvc || !imageKey) return null;

  const existing = keyToFilePath.get(imageKey);
  if (existing && fs.existsSync(existing)) {
    return `file://${existing}`;
  }

  const targetBase = keyToFilename(imageKey).replace(/\.(jpg|png)$/i, '');
  try {
    await new Promise((resolve, reject) => {
      imageSvc.get_image(imageKey, { scale: 'fit', width: 512, height: 512, format: 'image/jpeg' }, (err, contentType, body) => {
        if (err) return reject(err);
        const ext = /png/i.test(String(contentType)) ? 'png' : 'jpg';
        const targetPath = `${targetBase}.${ext}`;
        fs.writeFile(targetPath, Buffer.from(body), (werr) => {
          if (werr) return reject(werr);
          return resolve();
        });
      });
    });
    const ext = fs.existsSync(`${targetBase}.png`) ? 'png' : 'jpg';
    const finalPath = `${targetBase}.${ext}`;
    keyToFilePath.set(imageKey, finalPath);
    return `file://${finalPath}`;
  } catch (e) {
    return null;
  }
}

process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down.');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down.');
  process.exit(0);
});

