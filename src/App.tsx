import { BridgethingClient, type ConnectionState } from '@bridgething/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconPause, IconPlay, IconStop } from './icons';
import {
  cachedIps,
  discover,
  fetchArtwork,
  findSpeakersOnLan,
  getFavorites,
  getNowPlaying,
  getTransportState,
  getVolume,
  setVolume,
  pause,
  play,
  playFavorite,
  stop,
  type Favorite,
  type Discovery,
  type NowPlaying,
  type SonosGroup,
  type TransportState,
} from './sonos';

const wsUrl =
  import.meta.env.VITE_BRIDGETHING_URL ??
  (typeof window !== 'undefined' ? `ws://${window.location.host}/` : 'ws://127.0.0.1:8891/');

type RoomState = { transport: TransportState; now: NowPlaying; polledAt: number; volume?: number };
type View = 'rooms' | 'now' | 'favorites';

const POLL_MS = 4000;
const RETRY_MS = 15_000;
// one rotary detent emits deltaX ~120; a step per detent, not per 60px
const WHEEL_STEP = 120;
const SWIPE_STEP_ROOMS = 80;
const SWIPE_STEP_FAVS = 48;

// Dev-only demo mode (`?demo` in the URL): renders fixtures so the UI can be
// screenshotted without a daemon or speakers. Never set on the device.
const DEMO = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('demo');

const DEMO_GROUPS: SonosGroup[] = [
  { coordinator: { uuid: 'RINCON_1', name: 'Living Room', ip: '192.168.1.10' }, members: [{ uuid: 'RINCON_1', name: 'Living Room', ip: '192.168.1.10' }] },
  {
    coordinator: { uuid: 'RINCON_2', name: 'Kitchen', ip: '192.168.1.11' },
    members: [
      { uuid: 'RINCON_2', name: 'Kitchen', ip: '192.168.1.11' },
      { uuid: 'RINCON_3', name: 'Kitchen', ip: '192.168.1.12' },
    ],
  },
  { coordinator: { uuid: 'RINCON_4', name: 'Garage', ip: '192.168.1.13' }, members: [{ uuid: 'RINCON_4', name: 'Garage', ip: '192.168.1.13' }] },
];

const EMPTY_NOW: NowPlaying = { title: '', artist: '', album: '', artUri: '', durationMs: 0, positionMs: 0 };

const DEMO_STATES: Record<string, RoomState> = {
  RINCON_1: {
    transport: 'PLAYING',
    now: { title: 'buttercup', artist: 'Quiet Houses', album: 'buttercup', artUri: '', durationMs: 270000, positionMs: 74000 },
    polledAt: Date.now(),
    volume: 42,
  },
  RINCON_2: { transport: 'PAUSED_PLAYBACK', now: { ...EMPTY_NOW, title: 'VIANO', artist: 'RK' }, polledAt: Date.now(), volume: 22 },
  RINCON_4: { transport: 'STOPPED', now: EMPTY_NOW, polledAt: Date.now(), volume: 15 },
};

const DEMO_FAVORITES: Favorite[] = [
  'A Perfect Day',
  'Ambient Radio',
  'beatverliebt.',
  'Brown Noise',
  'Café del Mar Radio',
  'Chill Beats',
  'Chill Sounds',
  'Chilltronics',
].map(title => ({ title, uri: `x-sonosapi-radio:demo-${title}`, metadata: '' }));

/**
 * Drag list scrolling: drag moves selection step-wise, taps pass through as
 * clicks. Touch events handle the device touchscreen (its chromium doesn't
 * deliver pointer events for touch); pointer events cover mouse/pen in dev.
 */
function useSwipeList(axis: 'x' | 'y', step: number, onStep: (delta: number) => void) {
  const drag = useRef<{ last: number; acc: number } | null>(null);
  const suppressClick = useRef(false);

  const posOf = (p: { clientX: number; clientY: number }) => (axis === 'x' ? p.clientX : p.clientY);
  const start = (pos: number) => {
    drag.current = { last: pos, acc: 0 };
  };
  const move = (pos: number) => {
    const d = drag.current;
    if (!d) return;
    d.acc += pos - d.last;
    d.last = pos;
    const steps = Math.trunc(d.acc / step);
    if (steps === 0) return;
    d.acc -= steps * step;
    suppressClick.current = true;
    onStep(-steps); // finger left/up = next item
  };
  const end = () => {
    drag.current = null;
    setTimeout(() => (suppressClick.current = false), 0);
  };
  /** Wrap a click handler so drags that end on a row don't fire it. */
  const guard = (fn: () => void) => () => {
    if (!suppressClick.current) fn();
  };

  return {
    onTouchStart: (e: React.TouchEvent) => start(posOf(e.touches[0])),
    onTouchMove: (e: React.TouchEvent) => move(posOf(e.touches[0])),
    onTouchEnd: end,
    onTouchCancel: end,
    onPointerDown: (e: React.PointerEvent) => e.pointerType !== 'touch' && start(posOf(e)),
    onPointerMove: (e: React.PointerEvent) => e.pointerType !== 'touch' && move(posOf(e)),
    onPointerUp: (e: React.PointerEvent) => e.pointerType !== 'touch' && end(),
    onPointerCancel: (e: React.PointerEvent) => e.pointerType !== 'touch' && end(),
    guard,
  };
}

function formatMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export default function App() {
  const client = useMemo(() => new BridgethingClient({ url: wsUrl }), []);
  const [conn, setConn] = useState<ConnectionState>(client.connectionState);
  const [speakerIp, setSpeakerIp] = useState<string | null>(null);
  const [bakedIps, setBakedIps] = useState<string[] | null>(null);
  const [groups, setGroups] = useState<SonosGroup[]>([]);
  const [roomStates, setRoomStates] = useState<Record<string, RoomState>>({});
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<View>('rooms');
  const [roomIndex, setRoomIndex] = useState(0);
  const [favIndex, setFavIndex] = useState(0);
  const [artUrl, setArtUrl] = useState<string | null>(null);

  const selected = groups[Math.min(roomIndex, groups.length - 1)] ?? null;
  const selectedState = selected ? roomStates[selected.coordinator.uuid] : undefined;

  // demo mode: seed fixtures once, skip all daemon traffic
  useEffect(() => {
    if (!DEMO) return;
    setSpeakerIp('demo');
    setGroups(DEMO_GROUPS);
    setRoomStates(DEMO_STATES);
    setFavorites(DEMO_FAVORITES);
  }, []);

  // daemon connection state
  useEffect(() => {
    return client.on(event => {
      if (event.type === 'open' || event.type === 'close' || event.type === 'connecting') {
        setConn(client.connectionState);
      }
    });
  }, [client]);

  // speaker seed IP from user config
  useEffect(() => {
    if (DEMO) return;
    client.config.get({ key: 'speaker_ip' }).then(r => r.ok && setSpeakerIp((r.response.value ?? '').trim()));
    return client.config.onChanged(c => {
      if (c.key === 'speaker_ip') setSpeakerIp((c.value ?? '').trim());
    });
  }, [client]);

  // speaker IPs baked into the bundle by `push` (SSDP on the pushing machine)
  useEffect(() => {
    if (DEMO) return;
    fetch('sonos-seeds.json')
      .then(r => (r.ok ? r.json() : null))
      .then((j: { ips?: unknown } | null) =>
        setBakedIps(Array.isArray(j?.ips) ? j.ips.filter((v): v is string => typeof v === 'string') : []),
      )
      .catch(() => setBakedIps([]));
  }, []);

  // discovery + favorites whenever the seed IP or connection changes.
  // Order: configured/baked/cached seed IPs (raced concurrently), then a
  // one-shot subnet scan for users who never entered an IP. Failures retry —
  // the phone tunnel may just be off the home Wi-Fi for a while.
  useEffect(() => {
    if (DEMO || conn !== 'open' || speakerIp === null || bakedIps === null) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;

    const finish = async (found: Discovery) => {
      if (cancelled) return;
      setGroups(found.groups);
      setRoomIndex(i => Math.min(i, found.groups.length - 1));
      // favorites live per household (S1 and S2 keep separate lists): merge
      // one list per household coordinator, deduped by title + uri
      const favs: Favorite[] = [];
      const seenFavs = new Set<string>();
      let favErr: unknown = null;
      for (const household of found.households) {
        try {
          for (const fav of await getFavorites(client, household.ip)) {
            const key = `${fav.title}${fav.uri}`;
            if (seenFavs.has(key)) continue;
            seenFavs.add(key);
            favs.push(fav);
          }
        } catch (err) {
          favErr ??= err;
        }
      }
      if (cancelled) return;
      if (favs.length > 0) setFavorites(favs);
      else if (favErr) setError(`favorites: ${favErr instanceof Error ? favErr.message : String(favErr)}`);
    };

    const attempt = async () => {
      tries += 1;
      setLoading(true);
      setError(null);
      let lastErr: unknown = new Error('no speakers found automatically');
      try {
        const seeds = [...new Set([speakerIp, ...bakedIps, ...(await cachedIps(client))].filter(Boolean))];
        if (seeds.length > 0) {
          try {
            await finish(await discover(client, seeds));
            return;
          } catch (err) {
            lastErr = err;
          }
        }
        // every 4th retry, probe common home subnets for speakers. Any hits
        // become seeds; discover() merges every household they belong to.
        // This also covers users who installed a shared zip and never
        // configured anything.
        if (tries === 1 || tries % 4 === 0) {
          setNotice('searching your network for speakers…');
          const found = await findSpeakersOnLan(client, prefix =>
            setNotice(`searching your network for speakers… (${prefix}.0/24)`),
          );
          setNotice(null);
          if (cancelled) return;
          if (found.length > 0) {
            await finish(await discover(client, found));
            return;
          }
        }
        throw lastErr;
      } catch (err) {
        if (!cancelled) {
          setNotice(null);
          setGroups([]);
          setError(err instanceof Error ? err.message : String(err));
          retryTimer = setTimeout(() => void attempt(), RETRY_MS);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void attempt();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [client, conn, speakerIp, bakedIps]);

  // dial-adjusted volume: optimistic UI, debounced send to the speaker
  const pendingVolume = useRef<{ uuid: string; volume: number } | null>(null);
  const volumeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const roomStatesRef = useRef(roomStates);
  roomStatesRef.current = roomStates;

  // poll transport + now playing + volume for every group coordinator
  useEffect(() => {
    if (DEMO || groups.length === 0) return;
    let cancelled = false;
    const poll = async () => {
      for (const group of groups) {
        if (cancelled) return;
        try {
          const [transport, now, volume] = await Promise.all([
            getTransportState(client, group.coordinator.ip),
            getNowPlaying(client, group.coordinator.ip),
            getVolume(client, group.coordinator.ip),
          ]);
          if (!cancelled) {
            setRoomStates(prev => ({
              ...prev,
              [group.coordinator.uuid]: {
                transport,
                now,
                polledAt: Date.now(),
                // don't clobber a volume change the user is mid-dial on
                volume: pendingVolume.current?.uuid === group.coordinator.uuid ? pendingVolume.current.volume : volume,
              },
            }));
          }
        } catch {
          // a room that drops off the network keeps its last known state
        }
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, groups]);

  const adjustVolume = useCallback(
    (steps: number) => {
      if (!selected) return;
      const { uuid, ip } = selected.coordinator;
      const base =
        pendingVolume.current?.uuid === uuid ? pendingVolume.current.volume : (roomStatesRef.current[uuid]?.volume ?? 0);
      const volume = Math.max(0, Math.min(100, base + steps * 2));
      pendingVolume.current = { uuid, volume };
      setRoomStates(prev => (prev[uuid] ? { ...prev, [uuid]: { ...prev[uuid], volume } } : prev));
      clearTimeout(volumeTimer.current);
      volumeTimer.current = setTimeout(() => {
        const pending = pendingVolume.current;
        pendingVolume.current = null;
        if (pending) void setVolume(client, ip, pending.volume).catch(() => {});
      }, 150);
    },
    [client, selected],
  );

  // artwork for the room on screen (now-playing view)
  const artUri = selectedState?.now.artUri ?? '';
  const selectedIp = selected?.coordinator.ip ?? '';
  useEffect(() => {
    if (DEMO || view !== 'now' || !artUri || !selectedIp) {
      setArtUrl(null);
      return;
    }
    let revoked = false;
    let blobUrl: string | null = null;
    (async () => {
      const art = await fetchArtwork(client, selectedIp, artUri).catch(() => null);
      if (revoked || !art) return;
      blobUrl = URL.createObjectURL(new Blob([art.bytes as BlobPart], { type: art.mime }));
      setArtUrl(blobUrl);
    })();
    return () => {
      revoked = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [client, view, artUri, selectedIp]);

  // 1s ticker so the now-playing progress extrapolates between polls
  const [, setTick] = useState(0);
  useEffect(() => {
    if (view !== 'now') return;
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, [view]);

  const sendToSelected = useCallback(
    async (fn: (client: BridgethingClient, ip: string) => Promise<unknown>) => {
      if (!selected) return;
      setError(null);
      try {
        await fn(client, selected.coordinator.ip);
        const transport = await getTransportState(client, selected.coordinator.ip).catch(() => null);
        if (transport) {
          setRoomStates(prev => ({
            ...prev,
            [selected.coordinator.uuid]: {
              ...(prev[selected.coordinator.uuid] ?? { now: EMPTY_NOW, polledAt: Date.now() }),
              transport,
            },
          }));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [client, selected],
  );

  // dial press in now playing: decide from the speaker's live state, not the
  // UI's — the polled state can be stale or TRANSITIONING right after the
  // opposite command, which would send the wrong one
  const togglePlayPause = useCallback(async () => {
    if (!selected) return;
    // flip the icon immediately so a press feels instant; the real state is
    // reconciled by sendToSelected below (or the next poll if that fails)
    const uuid = selected.coordinator.uuid;
    setRoomStates(prev => {
      const cur = prev[uuid];
      if (!cur) return prev;
      const next = cur.transport === 'PLAYING' ? 'PAUSED_PLAYBACK' : 'PLAYING';
      return { ...prev, [uuid]: { ...cur, transport: next } };
    });
    const transport = await getTransportState(client, selected.coordinator.ip).catch(() => null);
    // unknown state (tunnel hiccup): don't guess a command, just say so
    if (transport === null) {
      setError('could not reach the speaker — try again');
      return;
    }
    const playing = transport === 'PLAYING' || transport === 'TRANSITIONING';
    void sendToSelected(playing ? pause : play);
  }, [client, selected, sendToSelected]);

  const playFavoriteOnSelected = useCallback(
    async (fav: Favorite) => {
      if (!selected) return;
      setError(null);
      setNotice(`starting ${fav.title} on ${selected.coordinator.name}…`);
      try {
        await playFavorite(client, selected.coordinator, fav);
        setNotice(null);
      } catch (err) {
        setNotice(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [client, selected],
  );

  const pauseAll = useCallback(async () => {
    for (const group of groups) {
      await pause(client, group.coordinator.ip).catch(() => {});
    }
  }, [client, groups]);

  // physical controls: wheel moves selection / volume, dial press (Enter)
  // opens the selected room, plays the highlighted favorite, or toggles
  // play/pause in now playing; m cycles now playing -> favorites, Escape goes
  // back to rooms, 1-4 fire favorites at the room
  useEffect(() => {
    let wheelAcc = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      wheelAcc += e.deltaX;
      const steps = Math.trunc(wheelAcc / WHEEL_STEP);
      if (steps === 0) return;
      wheelAcc -= steps * WHEEL_STEP;
      if (view === 'rooms') {
        setRoomIndex(i => Math.max(0, Math.min(groups.length - 1, i + steps)));
      } else if (view === 'favorites') {
        setFavIndex(i => Math.max(0, Math.min(favorites.length - 1, i + steps)));
      } else {
        adjustVolume(steps);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'm') setView(v => (v === 'rooms' ? 'now' : v === 'now' ? 'favorites' : 'now'));
      else if (e.key === 'Escape') setView('rooms');
      else if (e.key === 'Enter') {
        // dial press: open the selected room, play the highlighted favorite,
        // or toggle play/pause in now playing
        if (view === 'rooms') setView('now');
        else if (view === 'favorites') {
          const fav = favorites[favIndex];
          if (fav) void playFavoriteOnSelected(fav);
        } else {
          void togglePlayPause();
        }
      } else if (/^[1-4]$/.test(e.key)) {
        const fav = favorites[Number(e.key) - 1];
        if (fav) void playFavoriteOnSelected(fav);
      }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    };
  }, [view, groups.length, favorites, favIndex, playFavoriteOnSelected, togglePlayPause, adjustVolume]);

  // keep the selected card/row scrolled into view
  const selectedRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [roomIndex, favIndex, view]);

  const setSelectedRef = (el: HTMLElement | null) => {
    selectedRef.current = el;
  };

  const playing = selectedState?.transport === 'PLAYING';
  const positionMs = selectedState
    ? Math.min(
        selectedState.now.durationMs || Number.MAX_SAFE_INTEGER,
        selectedState.now.positionMs + (playing ? Date.now() - selectedState.polledAt : 0),
      )
    : 0;

  return (
    <div className="flex h-full w-full flex-col bg-bg text-off-white">
      <header className="flex items-baseline justify-between border-b border-rule px-6 py-3">
        <div className="font-display text-title font-medium tracking-display">
          Sonos{view !== 'rooms' && selected ? ` — ${selected.coordinator.name}` : ''}
        </div>
        <div className="flex items-center gap-4 font-mono text-eyebrow tracking-[0.25em] text-dim uppercase">
          {view === 'now' && <span className="text-accent">m: favorites — esc: back</span>}
          {view === 'favorites' && <span className="text-accent">favorites — esc: back</span>}
          <span>{conn}</span>
        </div>
      </header>

      {error && (
        <div className="border-b border-rule bg-err-soft px-6 py-2 font-mono text-hint text-warn">{error}</div>
      )}
      {notice && !error && (
        <div className="border-b border-rule bg-accent-soft px-6 py-2 font-mono text-hint text-accent">{notice}</div>
      )}

      {conn !== 'open' && !DEMO ? (
        <Placeholder>waiting for the daemon{conn === 'connecting' ? '…' : ` (${conn})`}</Placeholder>
      ) : loading && groups.length === 0 ? (
        <Placeholder>finding your speakers…</Placeholder>
      ) : groups.length === 0 ? (
        <Placeholder>
          {error
            ? "can't reach your speakers — make sure the phone is on your home Wi-Fi. retrying automatically; you can also set a speaker IP in this app's settings"
            : 'no speakers found'}
        </Placeholder>
      ) : view === 'rooms' ? (
        <RoomsView
          groups={groups}
          roomStates={roomStates}
          selectedIndex={Math.min(roomIndex, groups.length - 1)}
          onSelect={setRoomIndex}
          onOpenNow={() => setView('now')}
          onStep={d => setRoomIndex(i => Math.max(0, Math.min(groups.length - 1, i + d)))}
          selectedRef={setSelectedRef}
          onPlay={() => void sendToSelected(play)}
          onPause={() => void sendToSelected(pause)}
          onStop={() => void sendToSelected(stop)}
          onPauseAll={() => void pauseAll()}
        />
      ) : view === 'now' ? (
        selected && (
          <NowPlayingView
            group={selected}
            state={selectedState}
            artUrl={artUrl}
            positionMs={positionMs}
            onPlay={() => void sendToSelected(play)}
            onPause={() => void sendToSelected(pause)}
            onStop={() => void sendToSelected(stop)}
          />
        )
      ) : (
        <FavoritesView
          favorites={favorites}
          selectedIndex={Math.min(favIndex, Math.max(0, favorites.length - 1))}
          roomName={selected?.coordinator.name ?? ''}
          onSelect={setFavIndex}
          onPlay={fav => void playFavoriteOnSelected(fav)}
          onStep={d => setFavIndex(i => Math.max(0, Math.min(favorites.length - 1, i + d)))}
          selectedRef={setSelectedRef}
        />
      )}
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid flex-1 place-items-center p-12 text-center text-title text-soft">{children}</div>
  );
}

function transportLabel(transport?: string): string {
  switch (transport) {
    case 'PLAYING':
      return 'playing';
    case 'PAUSED_PLAYBACK':
      return 'paused';
    case 'STOPPED':
      return 'stopped';
    case 'TRANSITIONING':
      return '…';
    default:
      return transport ?? '…';
  }
}

function RoomsView(props: {
  groups: SonosGroup[];
  roomStates: Record<string, RoomState>;
  selectedIndex: number;
  onSelect: (index: number) => void;
  onOpenNow: () => void;
  onStep: (delta: number) => void;
  selectedRef: (el: HTMLElement | null) => void;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onPauseAll: () => void;
}) {
  const { groups, roomStates, selectedIndex, onSelect, onOpenNow, onStep, selectedRef } = props;
  const swipe = useSwipeList('x', SWIPE_STEP_ROOMS, onStep);
  const selected = groups[selectedIndex];
  const state = selected ? roomStates[selected.coordinator.uuid] : undefined;
  const playing = state?.transport === 'PLAYING';

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div
        className="flex flex-1 cursor-grab touch-none items-center gap-4 overflow-x-hidden px-6 select-none active:cursor-grabbing"
        onTouchStart={swipe.onTouchStart}
        onTouchMove={swipe.onTouchMove}
        onTouchEnd={swipe.onTouchEnd}
        onTouchCancel={swipe.onTouchCancel}
        onPointerDown={swipe.onPointerDown}
        onPointerMove={swipe.onPointerMove}
        onPointerUp={swipe.onPointerUp}
        onPointerCancel={swipe.onPointerCancel}>
        {groups.map((group, i) => {
          const roomState = roomStates[group.coordinator.uuid];
          const isSelected = i === selectedIndex;
          return (
            <button
              key={group.coordinator.uuid}
              ref={isSelected ? selectedRef : undefined}
              onClick={swipe.guard(() => (isSelected ? onOpenNow() : onSelect(i)))}
              className={`flex h-48 w-56 shrink-0 flex-col justify-between border p-4 text-left transition ${
                isSelected ? 'border-accent bg-accent-soft' : 'border-edge bg-screen'
              }`}>
              <div>
                <div className="font-display text-2xl font-medium leading-tight tracking-display">
                  {group.coordinator.name}
                </div>
                <div className="mt-1 font-mono text-hint text-dim">
                  {group.members.length > 1 ? `${group.members.length} speakers` : '1 speaker'}
                </div>
              </div>
              <div className="min-h-10">
                <div
                  className={`font-mono text-eyebrow tracking-[0.25em] uppercase ${
                    roomState?.transport === 'PLAYING' ? 'text-ok' : 'text-dim'
                  }`}>
                  {transportLabel(roomState?.transport)}
                </div>
                {roomState?.now.title ? (
                  <div className="mt-1 truncate text-body text-soft">
                    {roomState.now.title}
                    {roomState.now.artist ? ` — ${roomState.now.artist}` : ''}
                  </div>
                ) : null}
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-4 border-t border-rule px-6 py-4">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-eyebrow tracking-[0.25em] text-dim uppercase">controlling</div>
          <div className="truncate text-row-lg text-near">{selected?.coordinator.name}</div>
        </div>
        <TransportButton
          accent={!playing}
          icon={playing ? 'pause' : 'play'}
          label={playing ? 'pause' : state?.transport === 'STOPPED' ? 'play' : 'resume'}
          onClick={playing ? props.onPause : props.onPlay}
        />
        <TransportButton icon="stop" label="stop" onClick={props.onStop} />
        <TransportButton label="pause all" onClick={props.onPauseAll} />
        <div className="font-mono text-hint text-dim">dial press or m: now playing</div>
      </div>
    </div>
  );
}

function NowPlayingView(props: {
  group: SonosGroup;
  state: RoomState | undefined;
  artUrl: string | null;
  positionMs: number;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
}) {
  const { group, state, artUrl, positionMs } = props;
  const now = state?.now ?? EMPTY_NOW;
  const playing = state?.transport === 'PLAYING';

  return (
    <div className="flex flex-1 flex-col items-center overflow-hidden px-10 pt-3 pb-4">
      {artUrl ? (
        <img src={artUrl} alt="" className="h-48 w-48 shrink-0 border border-rule object-cover" />
      ) : (
        <div className="grid h-48 w-48 shrink-0 place-items-center border border-rule bg-screen font-mono text-body text-dim">
          {now.title ? 'no artwork' : 'nothing queued'}
        </div>
      )}

      <div className="mt-2 max-w-full truncate text-center font-display text-3xl font-medium leading-tight tracking-display">
        {now.title || group.coordinator.name}
      </div>
      {now.artist && <div className="max-w-full truncate text-center text-xl text-soft">{now.artist}</div>}
      {now.album && <div className="max-w-full truncate text-center font-mono text-body text-dim">{now.album}</div>}

      {now.durationMs > 0 && (
        <div className="mt-2 w-[560px] max-w-full">
          <div className="h-1.5 w-full bg-neutral-soft">
            <div
              className="h-1.5 bg-accent"
              style={{ width: `${Math.min(100, (positionMs / now.durationMs) * 100)}%` }}
            />
          </div>
          <div className="mt-1 flex justify-between font-mono text-hint text-dim">
            <span>{formatMs(positionMs)}</span>
            <span>{formatMs(now.durationMs)}</span>
          </div>
        </div>
      )}

      <div className="relative mt-auto flex w-full items-center justify-center gap-5">
        <TransportButton
          accent={!playing}
          big
          icon={playing ? 'pause' : 'play'}
          label={playing ? 'pause' : state?.transport === 'STOPPED' ? 'play' : 'resume'}
          onClick={playing ? props.onPause : props.onPlay}
        />
        <TransportButton big icon="stop" label="stop" onClick={props.onStop} />
        <div className="absolute right-0 flex flex-col items-end gap-1.5">
          {state?.volume !== undefined && (
            <div className="relative h-1.5 w-40 bg-neutral-soft">
              <div className="h-1.5 bg-accent" style={{ width: `${state.volume}%` }} />
              <div
                className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white"
                style={{ left: `${state.volume}%` }}
              />
            </div>
          )}
          <span className="font-mono text-hint text-dim">dial: volume · press: play/pause</span>
        </div>
      </div>
    </div>
  );
}

function FavoritesView(props: {
  favorites: Favorite[];
  selectedIndex: number;
  roomName: string;
  onSelect: (index: number) => void;
  onPlay: (fav: Favorite) => void;
  onStep: (delta: number) => void;
  selectedRef: (el: HTMLElement | null) => void;
}) {
  const { favorites, selectedIndex, roomName, onSelect, onPlay, onStep, selectedRef } = props;
  const swipe = useSwipeList('y', SWIPE_STEP_FAVS, onStep);
  if (favorites.length === 0) {
    return <Placeholder>no Sonos favorites saved — add some in the Sonos app</Placeholder>;
  }
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="px-6 pt-3 font-mono text-eyebrow tracking-[0.25em] text-dim uppercase">
        tap to play on {roomName} — keys 1-4 fire the first four
      </div>
      <div
        className="flex-1 cursor-grab touch-none overflow-y-hidden py-2 select-none active:cursor-grabbing"
        onTouchStart={swipe.onTouchStart}
        onTouchMove={swipe.onTouchMove}
        onTouchEnd={swipe.onTouchEnd}
        onTouchCancel={swipe.onTouchCancel}
        onPointerDown={swipe.onPointerDown}
        onPointerMove={swipe.onPointerMove}
        onPointerUp={swipe.onPointerUp}
        onPointerCancel={swipe.onPointerCancel}>
        {favorites.map((fav, i) => {
          const isSelected = i === selectedIndex;
          return (
            <button
              key={`${fav.uri}-${i}`}
              ref={isSelected ? selectedRef : undefined}
              onClick={swipe.guard(() => (isSelected ? onPlay(fav) : onSelect(i)))}
              className={`flex w-full items-center gap-4 px-6 py-3 text-left transition ${
                isSelected ? 'bg-accent-soft' : ''
              }`}>
              <span className={`w-8 font-mono text-row ${i < 4 ? 'text-accent' : 'text-dim'}`}>
                {i < 4 ? i + 1 : ''}
              </span>
              <span className={`truncate text-row-lg ${isSelected ? 'text-off-white' : 'text-soft'}`}>
                {fav.title}
              </span>
              {isSelected && <span className="ml-auto font-mono text-hint text-dim">dial press to play</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TransportButton(props: {
  label: string;
  onClick: () => void;
  accent?: boolean;
  icon?: 'play' | 'pause' | 'stop';
  big?: boolean;
}) {
  const size = props.big ? 30 : 22;
  const icon =
    props.icon === 'play' ? (
      <IconPlay size={size} />
    ) : props.icon === 'pause' ? (
      <IconPause size={size} />
    ) : props.icon === 'stop' ? (
      <IconStop size={size} />
    ) : null;
  return (
    <button
      onClick={props.onClick}
      aria-label={props.label}
      title={props.label}
      className={`flex items-center justify-center gap-2 border font-mono text-row whitespace-nowrap transition ${
        icon ? (props.big ? 'px-8 py-4' : 'px-5 py-3') : 'px-6 py-3'
      } ${
        props.accent
          ? 'border-accent bg-accent text-screen active:opacity-80'
          : 'border-edge text-near active:bg-neutral-soft'
      }`}>
      {icon ?? props.label}
    </button>
  );
}
