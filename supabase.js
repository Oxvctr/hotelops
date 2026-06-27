/**
 * supabase.js — Cloud Sync & Remote Database Layer
 *
 * Provides:
 * - Supabase client initialization (configure SUPABASE_URL + SUPABASE_ANON_KEY below).
 * - pushEventToCloud()  — uploads a single event from the outbox to Supabase.
 * - pullRemoteEvents()  — fetches events from cloud that are newer than local watermark.
 * - syncPresenceToCloud() — pushes ephemeral presence heartbeat via Supabase Realtime channel.
 * - subscribeToRemoteEvents() — live subscription to new events pushed by other devices.
 *
 * SQL Schema (run once in your Supabase project > SQL Editor):
 * -----------------------------------------------------------
 *
 * -- 1. Events table (append-only, immutable)
 * create table if not exists public.hotel_events (
 *   id              text primary key,
 *   type            text not null,
 *   room_id         text,
 *   session_id      text,
 *   device_id       text not null,
 *   payload         jsonb not null default '{}',
 *   timestamp       bigint not null,
 *   revision        integer not null default 1,
 *   created_at      timestamptz not null default now()
 * );
 * create index if not exists idx_hotel_events_timestamp on public.hotel_events (timestamp);
 * create index if not exists idx_hotel_events_room_id   on public.hotel_events (room_id);
 * alter table public.hotel_events enable row level security;
 * -- Allow all authenticated + anon reads/inserts (lock down further with proper auth later)
 * create policy "allow_all_hotel_events" on public.hotel_events
 *   for all using (true) with check (true);
 *
 * -- 2. Sync watermark table (tracks last pulled timestamp per device)
 * create table if not exists public.sync_watermarks (
 *   device_id       text primary key,
 *   last_pulled_ts  bigint not null default 0,
 *   updated_at      timestamptz not null default now()
 * );
 * alter table public.sync_watermarks enable row level security;
 * create policy "allow_all_sync_watermarks" on public.sync_watermarks
 *   for all using (true) with check (true);
 *
 * -- 3. Enable Realtime for live subscription
 * alter publication supabase_realtime add table public.hotel_events;
 *
 * -----------------------------------------------------------
 */

// ─── CONFIGURATION ─────────────────────────────────────────────────────────────
// Replace these with your actual project values from:
// https://supabase.com → Project Settings → API
const SUPABASE_URL     = 'YOUR_SUPABASE_URL';      // e.g. https://xxxx.supabase.co
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY'; // public anon/service key

// Feature flag — auto-disables all cloud operations if not configured.
const SUPABASE_CONFIGURED = (
  SUPABASE_URL      !== 'YOUR_SUPABASE_URL' &&
  SUPABASE_ANON_KEY !== 'YOUR_SUPABASE_ANON_KEY' &&
  SUPABASE_URL.startsWith('https://')
);

// ─── CLIENT SINGLETON ──────────────────────────────────────────────────────────
let _supabase = null;

/**
 * Returns a lazily-initialized Supabase client.
 * Requires the @supabase/supabase-js CDN bundle to be loaded in index.html.
 */
function getSupabaseClient() {
  if (!SUPABASE_CONFIGURED) return null;
  if (_supabase) return _supabase;
  if (typeof window.supabase === 'undefined' || typeof window.supabase.createClient !== 'function') {
    console.warn('[Supabase] SDK not loaded yet. Ensure the CDN script is in index.html.');
    return null;
  }
  _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    realtime: { params: { eventsPerSecond: 10 } }
  });
  console.log('[Supabase] Client initialized →', SUPABASE_URL);
  return _supabase;
}

// ─── CONNECTION STATUS ─────────────────────────────────────────────────────────
/**
 * Returns { configured, url } for the Settings panel to display.
 */
function getSupabaseStatus() {
  return {
    configured: SUPABASE_CONFIGURED,
    url: SUPABASE_CONFIGURED ? SUPABASE_URL : null
  };
}

// ─── EVENT PUSH (Outbox → Cloud) ───────────────────────────────────────────────
/**
 * Uploads a single event object to the cloud hotel_events table.
 * Returns { success: bool, error: string|null }.
 */
async function pushEventToCloud(event) {
  const client = getSupabaseClient();
  if (!client) {
    return { success: false, error: 'Supabase not configured' };
  }

  try {
    const { error } = await client
      .from('hotel_events')
      .upsert({
        id:         event.id,
        type:       event.type,
        room_id:    event.room_id   || null,
        session_id: event.session_id || null,
        device_id:  event.device_id,
        payload:    event.payload,
        timestamp:  event.timestamp,
        revision:   event.revision  || 1
      }, { onConflict: 'id' });

    if (error) {
      console.error('[Supabase] pushEventToCloud error:', error.message);
      return { success: false, error: error.message };
    }

    console.log('[Supabase] Event pushed:', event.id, event.type);
    return { success: true, error: null };
  } catch (err) {
    console.error('[Supabase] pushEventToCloud exception:', err);
    return { success: false, error: err.message };
  }
}

// ─── BATCH PUSH (multiple events) ─────────────────────────────────────────────
/**
 * Pushes multiple events in a single upsert call.
 * Used during initial full-sync or recovery scenarios.
 */
async function pushEventsToCloud(events) {
  const client = getSupabaseClient();
  if (!client || events.length === 0) return { success: false, pushed: 0 };

  const rows = events.map(ev => ({
    id:         ev.id,
    type:       ev.type,
    room_id:    ev.room_id    || null,
    session_id: ev.session_id || null,
    device_id:  ev.device_id,
    payload:    ev.payload,
    timestamp:  ev.timestamp,
    revision:   ev.revision   || 1
  }));

  try {
    const { error } = await client
      .from('hotel_events')
      .upsert(rows, { onConflict: 'id' });

    if (error) {
      console.error('[Supabase] Batch push error:', error.message);
      return { success: false, pushed: 0, error: error.message };
    }

    console.log(`[Supabase] Batch pushed ${rows.length} events.`);
    return { success: true, pushed: rows.length };
  } catch (err) {
    return { success: false, pushed: 0, error: err.message };
  }
}

// ─── EVENT PULL (Cloud → Local) ────────────────────────────────────────────────
/**
 * Fetches all cloud events newer than `sinceTimestamp` (exclusive).
 * Used during the online-restore and startup delta-sync flow.
 * Returns { events: Array, error: string|null }.
 */
async function pullRemoteEvents(sinceTimestamp = 0) {
  const client = getSupabaseClient();
  if (!client) return { events: [], error: 'Supabase not configured' };

  try {
    const { data, error } = await client
      .from('hotel_events')
      .select('*')
      .gt('timestamp', sinceTimestamp)
      .order('timestamp', { ascending: true })
      .limit(2000); // safety cap — increase if needed

    if (error) {
      console.error('[Supabase] pullRemoteEvents error:', error.message);
      return { events: [], error: error.message };
    }

    console.log(`[Supabase] Pulled ${data.length} remote events since ts=${sinceTimestamp}`);
    return { events: data || [], error: null };
  } catch (err) {
    return { events: [], error: err.message };
  }
}

// ─── SYNC WATERMARK ───────────────────────────────────────────────────────────
/**
 * Updates the per-device pull watermark in Supabase so other sessions
 * know what this device has already received.
 */
async function updateSyncWatermark(deviceId, lastPulledTs) {
  const client = getSupabaseClient();
  if (!client) return;

  try {
    await client
      .from('sync_watermarks')
      .upsert({ device_id: deviceId, last_pulled_ts: lastPulledTs, updated_at: new Date().toISOString() },
               { onConflict: 'device_id' });
  } catch (err) {
    console.warn('[Supabase] updateSyncWatermark failed:', err.message);
  }
}

async function getLocalSyncWatermark() {
  // Stored in IndexedDB device_registration store for persistence
  const res = await readStore('device_registration', 'sync_watermark');
  return res ? res.value : 0;
}

async function setLocalSyncWatermark(ts) {
  await writeStore('device_registration', { key: 'sync_watermark', value: ts });
}

// ─── REALTIME SUBSCRIPTION ────────────────────────────────────────────────────
let _realtimeChannel = null;

/**
 * Subscribes to new rows inserted into hotel_events by other devices.
 * When a new event arrives, it is saved locally and projections are re-run.
 * Call this once after init when the user is authenticated.
 */
function subscribeToRemoteEvents() {
  const client = getSupabaseClient();
  if (!client) return;

  // Avoid duplicate subscriptions
  if (_realtimeChannel) {
    client.removeChannel(_realtimeChannel);
    _realtimeChannel = null;
  }

  _realtimeChannel = client
    .channel('hotel_events_realtime')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'hotel_events' },
      async (payload) => {
        const remoteEvent = payload.new;

        // Skip events originated from this device (already local)
        if (remoteEvent.device_id === window.deviceId) return;

        console.log('[Supabase Realtime] Incoming event from', remoteEvent.device_id, '→', remoteEvent.type);

        // Merge into local IndexedDB without triggering another outbox entry
        await mergeRemoteEvent(remoteEvent);
      }
    )
    .subscribe((status) => {
      console.log('[Supabase Realtime] Status:', status);
      if (window.appUpdateCallback) window.appUpdateCallback();
    });
}

/**
 * Writes a remote event into local IndexedDB (events store only, no outbox).
 * Re-runs projections and triggers UI refresh.
 */
async function mergeRemoteEvent(remoteEvent) {
  try {
    // Normalize payload (Supabase returns jsonb as object already)
    const ev = {
      id:         remoteEvent.id,
      type:       remoteEvent.type,
      room_id:    remoteEvent.room_id,
      session_id: remoteEvent.session_id,
      device_id:  remoteEvent.device_id,
      payload:    remoteEvent.payload,
      timestamp:  remoteEvent.timestamp,
      revision:   remoteEvent.revision
    };

    // Only write if not already present
    const existing = await readStore('events', ev.id);
    if (existing) return;

    await writeStore('events', ev);
    await ProjectionManager.runProjections(true);

    // Update watermark
    await setLocalSyncWatermark(ev.timestamp);

    // Notify other tabs
    if (window.broadcastChannel) {
      window.broadcastChannel.postMessage({ type: 'EVENT_ADDED', eventId: ev.id });
    }

    if (window.appUpdateCallback) window.appUpdateCallback();
    console.log('[Supabase] Merged remote event:', ev.id);
  } catch (err) {
    console.error('[Supabase] mergeRemoteEvent failed:', err);
  }
}

// ─── DELTA SYNC ON RECONNECT ──────────────────────────────────────────────────
/**
 * Called when the device comes back online.
 * 1. Pushes all locally-queued outbox events to cloud.
 * 2. Pulls any remote events that arrived while offline.
 */
async function performDeltaSync() {
  const client = getSupabaseClient();
  if (!client) {
    console.log('[Supabase] Delta sync skipped — not configured.');
    return { pushed: 0, pulled: 0 };
  }

  console.log('[Supabase] Starting delta sync...');

  // --- PUSH phase ---
  let pushed = 0;
  const queue = await getAllStore('sync_queue');
  const pending = queue.filter(q => ['Pending', 'Queued', 'Retrying'].includes(q.status));

  for (const item of pending) {
    const ev = await readStore('events', item.event_id);
    if (!ev) continue;

    await SyncEngine.setStatus(item.event_id, 'Uploading');
    const result = await pushEventToCloud(ev);

    if (result.success) {
      await SyncEngine.setStatus(item.event_id, 'Synced');
      await deleteStore('sync_queue', item.event_id);
      pushed++;
    } else {
      await SyncEngine.setStatus(item.event_id, 'Retrying');
    }
  }

  // --- PULL phase ---
  const watermark = await getLocalSyncWatermark();
  const { events: remoteEvents, error } = await pullRemoteEvents(watermark);

  let pulled = 0;
  if (!error && remoteEvents.length > 0) {
    for (const remoteEvent of remoteEvents) {
      await mergeRemoteEvent(remoteEvent);
      pulled++;
    }
    // Update watermark to latest
    const latest = remoteEvents[remoteEvents.length - 1];
    await setLocalSyncWatermark(latest.timestamp);
    await updateSyncWatermark(window.deviceId || 'unknown', latest.timestamp);
  }

  console.log(`[Supabase] Delta sync complete. Pushed: ${pushed}, Pulled: ${pulled}`);
  return { pushed, pulled };
}

// ─── AUTO-INIT ON NETWORK RESTORE ─────────────────────────────────────────────
window.addEventListener('online', async () => {
  if (!SUPABASE_CONFIGURED) return;
  console.log('[Network] Online. Triggering Supabase delta sync...');
  const result = await performDeltaSync();
  if (window.appUpdateCallback) window.appUpdateCallback();
  if (result.pulled > 0 || result.pushed > 0) {
    if (window.showToast) showToast(`Synced ↑${result.pushed} ↓${result.pulled} events`);
  }
});
