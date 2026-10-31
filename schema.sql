CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY, name TEXT, provider TEXT, product TEXT,
  refresh TEXT, access TEXT, exp INTEGER, admin INTEGER DEFAULT 0, created INTEGER
);
CREATE TABLE IF NOT EXISTS rooms ( id TEXT PRIMARY KEY, name TEXT, created INTEGER, admin_ids TEXT );
CREATE TABLE IF NOT EXISTS room_members ( room TEXT, member TEXT, joined INTEGER, PRIMARY KEY (room, member) );
CREATE TABLE IF NOT EXISTS queue ( room TEXT, tid TEXT, added_by TEXT, pos INTEGER, at INTEGER, PRIMARY KEY (room, tid) );
CREATE TABLE IF NOT EXISTS plays ( room TEXT, tid TEXT, added_by TEXT, listened INTEGER, at INTEGER );
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY, isrc TEXT, title TEXT, artist TEXT, album TEXT, dur INTEGER,
  sp_id TEXT, yt_id TEXT, cover TEXT, conf REAL, how TEXT
);
CREATE TABLE IF NOT EXISTS lyrics ( track_id TEXT PRIMARY KEY, lrc TEXT, source TEXT, uploaded_by TEXT );
CREATE TABLE IF NOT EXISTS playlists ( id TEXT PRIMARY KEY, owner TEXT, name TEXT, created INTEGER );
CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist TEXT, tid TEXT, title TEXT, artist TEXT, dur INTEGER, cover TEXT, pos INTEGER,
  PRIMARY KEY (playlist, tid)
);
