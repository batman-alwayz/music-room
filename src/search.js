// YouTube search for the queue. Needs the YT_API_KEY secret (YouTube Data API v3, free quota).
const ISO = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
const secs = s => {
  const m = ISO.exec(s || '');
  return m ? (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) : 0;
};
const track = i => ({
  tid: i.id,
  title: i.snippet.title,
  artist: (i.snippet.channelTitle || '').replace(/ - Topic$/, ''),
  dur: secs(i.contentDetails.duration),
  cover: i.snippet.thumbnails?.default?.url || null
});
const API = 'https://www.googleapis.com/youtube/v3/';

async function details(ids, env) {
  const v = await fetch(API + 'videos?' + new URLSearchParams({
    part: 'contentDetails,snippet', id: ids.join(','), key: env.YT_API_KEY
  })).then(r => r.json());
  return (v.items || []).map(track).filter(t => t.dur >= 20 && t.dur <= 1200);
}

export async function ytSearch(q, env) {
  const s = await fetch(API + 'search?' + new URLSearchParams({
    part: 'snippet', type: 'video', videoCategoryId: '10', maxResults: '10', q, key: env.YT_API_KEY
  })).then(r => r.json());
  const ids = (s.items || []).map(i => i.id?.videoId).filter(Boolean);
  return ids.length ? details(ids, env) : [];
}

export const ytLookup = (id, env) => details([id], env);

// a pasted YouTube / YouTube Music link costs 1 quota unit instead of 100
export const linkId = q => q.match(/(?:[?&]v=|youtu\.be\/)([\w-]{11})/)?.[1] || null;
