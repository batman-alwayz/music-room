// every player: position() -> ms (or null), seek(ms), play(videoId, ms), pause(), end(durMs) -> Promise, cancel()

// ytm: native shell (Android / iOS) plays YouTube Music in a hidden WebView
export const ytm = send => ({
  setMuted: m => send('mute', !!m),
  position: async () => Number(await send('position')) || 0,
  seek: ms => send('seek', ms),
  play: (id, ms) => send('load', { id, ms }),
  pause: () => send('pause'),
  end: () => new Promise(r => { window.onYtmEnd = r; }),
  cancel: () => { window.onYtmEnd = null; }
});

// web: YouTube's official iframe player, for a laptop/desktop browser tab (also handy for testing)
let ytApi;
const loadYT = () => ytApi ||= new Promise(res => {
  if (window.YT?.Player) return res();
  window.onYouTubeIframeAPIReady = res;
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.append(s);
});
// browsers only allow sound after you have touched the page once; until then we play MUTED
// (always allowed) and show a "tap for sound" button
let userActed = false;
for (const ev of ['pointerdown', 'keydown', 'touchstart']) addEventListener(ev, () => { userActed = true; }, { capture: true, passive: true });
const activated = () => userActed || !!navigator.userActivation?.hasBeenActive;

export const web = (elId, cb = {}) => {
  let p, endRes = null, userMuted = false, policyMuted = false, watch;
  const ready = loadYT().then(() => new Promise(res => {
    p = new YT.Player(elId, {
      height: '120', width: '200', playerVars: { playsinline: 1, controls: 0 },
      events: {
        onReady: res,
        onStateChange: e => {
          if (e.data === 0 && endRes) { endRes(); endRes = null; }
          if (e.data === 1) report();
          if (e.data === 2) cb.onLive?.(false);
        },
        onAutoplayBlocked: () => cb.onBlocked?.(),
        onError: e => cb.onError?.(e.data)
      }
    });
  }));
  const applyMute = () => {
    policyMuted = !activated();
    if (userMuted || policyMuted) p.mute(); else p.unMute();
  };
  const report = () => {                                   // "live" = really playing AND audible
    const playing = p.getPlayerState() === 1;
    cb.onLive?.(playing && !policyMuted);
    if (playing && policyMuted) cb.onBlocked?.();
  };
  return {
    position: async () => { await ready; return p.getPlayerState() === 1 ? p.getCurrentTime() * 1000 : null; },
    seek: async ms => { await ready; p.seekTo(ms / 1000, true); },
    play: async (id, ms) => {
      await ready; applyMute();
      p.loadVideoById({ videoId: id, startSeconds: ms / 1000 });
      if (policyMuted) cb.onBlocked?.();
      clearTimeout(watch);
      watch = setTimeout(() => { if (p.getPlayerState() !== 1) cb.onBlocked?.(); }, 3000);
    },
    pause: async () => { await ready; p.pauseVideo(); },
    setMuted: async m => { await ready; userMuted = !!m; applyMute(); report(); },
    resume: async () => { await ready; userActed = true; applyMute(); p.playVideo(); report(); },   // the tap button
    end: () => new Promise(r => { endRes = r; }),
    cancel: () => { endRes = null; }
  };
};

// manual (add ?manual to the URL): countdown only, you press play in your own app
export const manual = (getState, now) => {
  let timer = null;
  return {
    setMuted: () => {},
    position: () => now() - getState().startAt,
    seek: () => {}, play: () => {}, pause: () => {},
    end: dur => new Promise(r => {
      timer = setTimeout(r, Math.max(0, getState().startAt + dur - now()));
    }),
    cancel: () => clearTimeout(timer)
  };
};

// everyone, free or Premium, plays through YouTube now
export function routeFor() {
  return { player: window.NativeBridge || window.webkit?.messageHandlers?.native ? 'ytm' : 'web', ads: true, skip: true };
}
