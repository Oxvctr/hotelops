/**
 * db.js - IndexedDB and Event Sourced Engine
 * 
 * Provides:
 * - IndexedDB event store, sync queue, device settings, and snapshots.
 * - Split Projections (Room, Revenue, Audit, TimeMachine, Presence).
 * - ProjectionManager coordinating projections, snapshotting, and timeline queries.
 * - Auto-seeding of 48 hours of rich hospitality operations history.
 */

// --- CONSTANTS ---
const DB_NAME = 'HotelOpsDB';
const DB_VERSION = 1;

// Singleton DB connection — avoids reopening IndexedDB on every operation
let _dbInstance = null;

// --- INDEXEDDB SETUP ---
function openDB() {
  if (_dbInstance) return Promise.resolve(_dbInstance);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      
      // Event Store: holds all events (ROOM_CHECKIN, ADD_CHARGE, etc.)
      if (!db.objectStoreNames.contains('events')) {
        const eventStore = db.createObjectStore('events', { keyPath: 'id' });
        eventStore.createIndex('timestamp', 'timestamp', { unique: false });
        eventStore.createIndex('room_id', 'room_id', { unique: false });
        eventStore.createIndex('revision', 'revision', { unique: false });
      }

      // Snapshots: saved state projections
      if (!db.objectStoreNames.contains('snapshots')) {
        db.createObjectStore('snapshots', { keyPath: 'snapshot_id' });
      }

      // Device Registration & Server Settings
      if (!db.objectStoreNames.contains('device_registration')) {
        db.createObjectStore('device_registration', { keyPath: 'key' });
      }

      // Outbox Sync Queue: event IDs pending upload to cloud
      if (!db.objectStoreNames.contains('sync_queue')) {
        db.createObjectStore('sync_queue', { keyPath: 'event_id' });
      }
    };

    request.onsuccess = (e) => {
      _dbInstance = e.target.result;
      // Clear cached connection if the DB is closed externally
      _dbInstance.onclose = () => { _dbInstance = null; };
      resolve(_dbInstance);
    };
    request.onerror = (e) => reject(e.target.error);
  });
}

// --- DB HELPER METHODS ---
async function readStore(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function writeStore(storeName, item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.put(item);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAllStore(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function deleteStore(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function clearStore(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// --- DEVICE & CODE REGISTRATION SYSTEM ---
const DEMO_CODE_ALIASES = {
  'STAFFINV': 'staff',
  'ADMININV': 'admin'
};

const DEFAULT_SERVER_CODES = {
  staff_code: 'STAFF1234',
  admin_code: 'ADMIN9012'
};

function normalizeStoredCode(code) {
  return (code || '').trim().toUpperCase().slice(0, 8);
}

function migrateLegacyCode(fieldKey, code) {
  const c = normalizeStoredCode(code);
  if (c.length >= 8) return c;
  const prefixes = { staff_code: 'STAFF', admin_code: 'ADMIN' };
  if (/^\d+$/.test(c)) {
    return prefixes[fieldKey] + c.padStart(4, '0').slice(-4);
  }
  return c.padEnd(8, '0').slice(0, 8);
}

async function validateInviteCode(code) {
  const normalized = normalizeStoredCode(code);
  if (DEMO_CODE_ALIASES[normalized]) return DEMO_CODE_ALIASES[normalized];

  const codes = await getServerCodes();
  if (normalized === normalizeStoredCode(codes.staff_code)) return 'staff';
  if (normalized === normalizeStoredCode(codes.admin_code)) return 'admin';
  return null;
}

async function getDeviceRegistration() {
  const reg = await readStore('device_registration', 'current_device');
  return reg ? reg.value : null; // returns { device_id, role, activated, codes }
}

async function saveDeviceRegistration(value) {
  await writeStore('device_registration', { key: 'current_device', value });
}

// Initialize server-side codes in db settings
async function initServerSettings() {
  const settings = await readStore('device_registration', 'server_codes');
  if (!settings) {
    await writeStore('device_registration', {
      key: 'server_codes',
      value: { ...DEFAULT_SERVER_CODES }
    });
    return;
  }
  const v = settings.value;
  const migrated = {
    staff_code: migrateLegacyCode('staff_code', v.staff_code),
    admin_code: migrateLegacyCode('admin_code', v.admin_code)
  };
  if (JSON.stringify(migrated) !== JSON.stringify(v)) {
    await writeStore('device_registration', { key: 'server_codes', value: migrated });
  }
}

async function updateServerCodes(codes) {
  await writeStore('device_registration', {
    key: 'server_codes',
    value: {
      staff_code: normalizeStoredCode(codes.staff_code),
      admin_code: normalizeStoredCode(codes.admin_code)
    }
  });
}

async function getServerCodes() {
  const res = await readStore('device_registration', 'server_codes');
  return res ? res.value : { ...DEFAULT_SERVER_CODES };
}

// --- ROOM INVENTORY ---
function buildDefaultRoomInventory() {
  const inventory = {};
  for (let i = 1; i <= 3; i++) {
    for (let j = 1; j <= 4; j++) {
      const num = `${i}0${j}`;
      inventory[num] = {
        room_name: i === 3 ? 'Penthouse Suite' : (i === 2 ? 'Executive Room' : 'Standard Cozy')
      };
    }
  }
  return inventory;
}

async function getRoomInventory() {
  const res = await readStore('device_registration', 'room_inventory');
  return res ? res.value : buildDefaultRoomInventory();
}

async function initRoomInventory() {
  const existing = await readStore('device_registration', 'room_inventory');
  if (!existing) {
    await writeStore('device_registration', {
      key: 'room_inventory',
      value: buildDefaultRoomInventory()
    });
  }
}

async function saveRoomInventory(inventory) {
  await writeStore('device_registration', { key: 'room_inventory', value: inventory });
}

// --- EVENTS MANAGEMENT & COMPACTION ---
async function addEvent(event) {
  await writeStore('events', event);

  await writeStore('sync_queue', {
    event_id: event.id,
    status: 'Pending',
    timestamp: Date.now()
  });

  // Fast path: incremental projection + debounced UI (no full DB replay)
  await ProjectionManager.applyEvent(event);

  if (window.broadcastChannel) {
    window.broadcastChannel.postMessage({ type: 'EVENT_ADDED', eventId: event.id });
  }

  // Background sync — never blocks UI
  if (navigator.onLine && (!window.state || !window.state.simulatedOffline)) {
    if (typeof performDeltaSync === 'function' && typeof SUPABASE_CONFIGURED !== 'undefined' && SUPABASE_CONFIGURED) {
      performDeltaSync();
    } else if (typeof SyncEngine !== 'undefined') {
      SyncEngine.triggerSyncBackground();
    }
  }
}

async function getEvents() {
  return ProjectionManager.getEvents();
}

// Event Compaction: Combines note edits into NOTE_FINALIZED
async function compactEvents() {
  const events = await getEvents();
  const compacted = [];
  const noteEditsBySession = {}; // sessionId -> list of note events
  
  for (const ev of events) {
    // Critical: Never compact financial/session milestones
    if (['ROOM_CHECKIN', 'ADD_CHARGE', 'CONFIRM_CHARGE', 'EXPIRE_CHARGE', 'CHECKOUT', 'VOID_CHARGE', 'ADD_ROOM', 'REMOVE_ROOM'].includes(ev.type)) {
      compacted.push(ev);
      continue;
    }

    if (ev.type === 'ADD_NOTE') {
      const sessionId = ev.session_id;
      if (!noteEditsBySession[sessionId]) {
        noteEditsBySession[sessionId] = [];
      }
      noteEditsBySession[sessionId].push(ev);
    } else {
      compacted.push(ev);
    }
  }

  // Perform note compaction
  for (const sessionId in noteEditsBySession) {
    const list = noteEditsBySession[sessionId];
    if (list.length > 1) {
      // Compact into a single finalized note event with combined content
      const lastNote = list[list.length - 1];
      const mergedContent = list.map(n => n.payload.content).filter(Boolean).join('\n---\n');
      const compactedEvent = {
        ...lastNote,
        type: 'NOTE_FINALIZED',
        payload: {
          ...lastNote.payload,
          content: mergedContent,
          compactedCount: list.length
        }
      };
      compacted.push(compactedEvent);
    } else if (list.length === 1) {
      compacted.push(list[0]);
    }
  }

  // Save compacted events back
  const db = await openDB();
  const tx = db.transaction('events', 'readwrite');
  const store = tx.objectStore('events');
  store.clear();
  for (const ev of compacted.sort((a, b) => a.timestamp - b.timestamp)) {
    store.put(ev);
  }
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  
  // Re-run projections
  ProjectionManager.invalidateCache();
  await ProjectionManager.runProjections(true);
}

// --- PROJECTIONS ---

class RoomProjection {
  static seedFromInventory(roomInventory) {
    const inventory = roomInventory || buildDefaultRoomInventory();
    const rooms = {};
    for (const num of Object.keys(inventory).sort()) {
      const meta = inventory[num];
      rooms[num] = {
        room_number: num,
        room_name: meta.room_name || 'Standard Room',
        status: 'Vacant',
        guest_name: '',
        session_id: null,
        timer_start: null,
        charges: [],
        notes: [],
        presence: [],
        sync_state: 'Synced',
        revision: 0
      };
    }
    return rooms;
  }

  static createEmptyRoom(num, roomName) {
    return {
      room_number: num,
      room_name: roomName || 'Standard Room',
      status: 'Vacant',
      guest_name: '',
      session_id: null,
      timer_start: null,
      charges: [],
      notes: [],
      presence: [],
      sync_state: 'Synced',
      revision: 0
    };
  }

  static project(events, baselineRooms = null, roomInventory = null) {
    const rooms = baselineRooms
      ? JSON.parse(JSON.stringify(baselineRooms))
      : RoomProjection.seedFromInventory(roomInventory);

    for (const ev of events) {
      RoomProjection.applyEvent(rooms, ev);
    }

    return rooms;
  }

  static applyEvent(rooms, ev) {
    if (ev.type === 'ADD_ROOM') {
      if (!rooms[ev.room_id]) {
        rooms[ev.room_id] = RoomProjection.createEmptyRoom(
          ev.room_id,
          ev.payload.room_name
        );
      } else if (ev.payload.room_name) {
        rooms[ev.room_id].room_name = ev.payload.room_name;
      }
      return;
    }
    if (ev.type === 'REMOVE_ROOM') {
      const r = rooms[ev.room_id];
      if (r && r.status === 'Vacant') {
        delete rooms[ev.room_id];
      }
      return;
    }

    const room = rooms[ev.room_id];
    if (!room) return;

    room.revision = Math.max(room.revision, ev.revision || 0);

    switch (ev.type) {
      case 'UPDATE_ROOM_META':
        room.room_name = ev.payload.room_name;
        break;
      case 'ROOM_CHECKIN':
        room.status = 'Occupied';
        room.guest_name = ev.payload.guest_name;
        room.session_id = ev.session_id;
        room.timer_start = ev.timestamp;
        room.charges = [];
        room.notes = [];
        break;
      case 'ADD_CHARGE':
        room.charges.push({
          id: ev.payload.charge_id,
          type: ev.payload.type,
          amount: ev.payload.amount,
          timestamp: ev.timestamp,
          created_by: ev.payload.created_by || 'Staff',
          status: ev.payload.status || 'Pending',
          device_id: ev.device_id
        });
        if (room.status === 'Occupied') {
          room.status = 'Session Active';
        }
        break;
      case 'CONFIRM_CHARGE': {
        const charge = room.charges.find(c => c.id === ev.payload.charge_id);
        if (charge) charge.status = 'Confirmed';
        break;
      }
      case 'EXPIRE_CHARGE': {
        const expCharge = room.charges.find(c => c.id === ev.payload.charge_id);
        if (expCharge) expCharge.status = 'Expired';
        if (!room.charges.some(c => c.status === 'Pending' || c.status === 'Confirmed')) {
          room.status = 'Occupied';
        }
        break;
      }
      case 'ADD_NOTE':
      case 'NOTE_FINALIZED':
        room.notes.push({
          content: ev.payload.content,
          timestamp: ev.timestamp,
          created_by: ev.payload.created_by || 'Staff'
        });
        break;
      case 'VOID_CHARGE': {
        const voidCharge = room.charges.find(c => c.id === ev.payload.charge_id);
        if (voidCharge) {
          voidCharge.status = 'Voided';
          voidCharge.void_reason = ev.payload.reason;
          voidCharge.void_by = ev.payload.void_by;
        }
        break;
      }
      case 'CHECKOUT_PREVIEW':
        room.status = 'Checkout Ready';
        break;
      case 'CHECKOUT':
        room.status = 'Vacant';
        room.guest_name = '';
        room.session_id = null;
        room.timer_start = null;
        room.charges = [];
        room.notes = [];
        break;
    }
  }
}

class RevenueProjection {
  static emptyState() {
    return {
      todayRevenue: 0,
      roomsActiveCount: 0,
      avgSessionHours: '0h',
      serviceDistribution: { Spa: 0, Bar: 0, Laundry: 0, Extend: 0, Custom: 0 },
      roomEarnings: {},
      timelineGraphData: [],
      _sessionStarts: {},
      _totalSessionsCount: 0,
      _totalSessionDuration: 0,
      _hourlyRevenue: {}
    };
  }

  static project(events, baseline = null, roomInventory = null, precomputedRooms = null) {
    const state = baseline
      ? {
          todayRevenue: baseline.todayRevenue || 0,
          roomsActiveCount: 0,
          avgSessionHours: baseline.avgSessionHours || '0h',
          serviceDistribution: { ...{ Spa: 0, Bar: 0, Laundry: 0, Extend: 0, Custom: 0 }, ...baseline.serviceDistribution },
          roomEarnings: { ...baseline.roomEarnings },
          timelineGraphData: [],
          _sessionStarts: {},
          _totalSessionsCount: 0,
          _totalSessionDuration: 0,
          _hourlyRevenue: {}
        }
      : RevenueProjection.emptyState();

    const sessionStarts = state._sessionStarts;
    const hourlyRevenue = state._hourlyRevenue;
    let totalSessionsCount = state._totalSessionsCount;
    let totalSessionDuration = state._totalSessionDuration;

    for (const ev of events) {
      const hr = new Date(ev.timestamp).getHours();
      const dateStr = new Date(ev.timestamp).toLocaleDateString();
      const hourKey = `${dateStr} ${hr}:00`;

      if (!hourlyRevenue[hourKey]) hourlyRevenue[hourKey] = 0;

      if (ev.type === 'ROOM_CHECKIN') {
        sessionStarts[ev.session_id] = ev.timestamp;
      }

      if (ev.type === 'CONFIRM_CHARGE') {
        const amt = ev.payload.amount || 0;
        state.todayRevenue += amt;
        hourlyRevenue[hourKey] += amt;
        state.serviceDistribution[ev.payload.type] = (state.serviceDistribution[ev.payload.type] || 0) + amt;
        state.roomEarnings[ev.room_id] = (state.roomEarnings[ev.room_id] || 0) + amt;
      }

      if (ev.type === 'CHECKOUT') {
        const start = sessionStarts[ev.session_id];
        if (start) {
          totalSessionsCount++;
          totalSessionDuration += (ev.timestamp - start);
          delete sessionStarts[ev.session_id];
        }
      }
    }

    const keys = Object.keys(hourlyRevenue).sort();
    let rolling = baseline ? (baseline.timelineGraphData?.length
      ? baseline.timelineGraphData[baseline.timelineGraphData.length - 1].value
      : 0) : 0;
    const timelineGraphData = [];
    for (const k of keys) {
      rolling += hourlyRevenue[k];
      timelineGraphData.push({ label: k.split(' ')[1], value: rolling });
    }
    if (timelineGraphData.length === 0 && baseline?.timelineGraphData) {
      timelineGraphData.push(...baseline.timelineGraphData);
    }

    const rooms = precomputedRooms || RoomProjection.project(events, null, roomInventory);
    let roomsActiveCount = 0;
    for (const rNum in rooms) {
      if (rooms[rNum].status !== 'Vacant') roomsActiveCount++;
    }

    const avgSessionMs = totalSessionsCount > 0 ? (totalSessionDuration / totalSessionsCount) : 0;
    const avgSessionHours = totalSessionsCount > 0
      ? `${(avgSessionMs / (1000 * 60 * 60)).toFixed(1)}h`
      : (baseline?.avgSessionHours || '0h');

    return {
      todayRevenue: state.todayRevenue,
      roomsActiveCount,
      avgSessionHours,
      serviceDistribution: state.serviceDistribution,
      roomEarnings: state.roomEarnings,
      timelineGraphData
    };
  }

  static applyEvent(revenue, meta, ev, rooms) {
    const hr = new Date(ev.timestamp).getHours();
    const dateStr = new Date(ev.timestamp).toLocaleDateString();
    const hourKey = `${dateStr} ${hr}:00`;

    if (ev.type === 'ROOM_CHECKIN') {
      meta.sessionStarts[ev.session_id] = ev.timestamp;
    }

    if (ev.type === 'CONFIRM_CHARGE') {
      const amt = ev.payload.amount || 0;
      revenue.todayRevenue += amt;
      if (!meta.hourlyRevenue[hourKey]) meta.hourlyRevenue[hourKey] = 0;
      meta.hourlyRevenue[hourKey] += amt;
      revenue.serviceDistribution[ev.payload.type] = (revenue.serviceDistribution[ev.payload.type] || 0) + amt;
      revenue.roomEarnings[ev.room_id] = (revenue.roomEarnings[ev.room_id] || 0) + amt;

      let rolling = revenue.timelineGraphData.length
        ? revenue.timelineGraphData[revenue.timelineGraphData.length - 1].value
        : 0;
      rolling += amt;
      revenue.timelineGraphData.push({ label: `${hr}:00`, value: rolling });
    }

    if (ev.type === 'CHECKOUT') {
      const start = meta.sessionStarts[ev.session_id];
      if (start) {
        meta.totalSessionsCount++;
        meta.totalDuration += (ev.timestamp - start);
        delete meta.sessionStarts[ev.session_id];
        const avgMs = meta.totalDuration / meta.totalSessionsCount;
        revenue.avgSessionHours = `${(avgMs / (1000 * 60 * 60)).toFixed(1)}h`;
      }
    }

    if (rooms) {
      let active = 0;
      for (const rNum in rooms) {
        if (rooms[rNum].status !== 'Vacant') active++;
      }
      revenue.roomsActiveCount = active;
    }
  }

  static countActiveRooms(rooms) {
    let count = 0;
    for (const rNum in rooms) {
      if (rooms[rNum].status !== 'Vacant') count++;
    }
    return count;
  }
}

class AuditProjection {
  static project(events) {
    const audits = [];
    for (const ev of events) {
      if (ev.type === 'VOID_CHARGE') {
        audits.push({
          timestamp: ev.timestamp,
          room_id: ev.room_id,
          void_by: ev.payload.void_by,
          reason: ev.payload.reason,
          amount: ev.payload.original_amount,
          type: ev.payload.original_type
        });
      }
    }
    return audits.reverse(); // Newest first
  }
}

class TimelineProjection {
  static buildLogEntry(ev) {
    let description = '';
    let badge = 'info';
    let amount = null;

    switch (ev.type) {
      case 'ROOM_CHECKIN':
        description = `Room ${ev.room_id}: Checked In ${ev.payload.guest_name}`;
        badge = 'Sessions';
        break;
      case 'ADD_CHARGE':
        description = `Room ${ev.room_id}: Added Pending ${ev.payload.type} charge`;
        badge = 'Staff';
        amount = ev.payload.amount;
        break;
      case 'CONFIRM_CHARGE':
        description = `Room ${ev.room_id}: Confirmed ${ev.payload.type} charge`;
        badge = 'Revenue';
        amount = ev.payload.amount;
        break;
      case 'EXPIRE_CHARGE':
        description = `Room ${ev.room_id}: Expired Pending ${ev.payload.type} charge`;
        badge = 'Staff';
        break;
      case 'ADD_NOTE':
        description = `Room ${ev.room_id}: Added Note: "${ev.payload.content}"`;
        badge = 'Staff';
        break;
      case 'VOID_CHARGE':
        description = `Room ${ev.room_id}: Voided ${ev.payload.original_type} (₦${ev.payload.original_amount})`;
        badge = 'Void';
        amount = -ev.payload.original_amount;
        break;
      case 'CHECKOUT':
        description = `Room ${ev.room_id}: Checkout complete`;
        badge = 'Sessions';
        break;
      case 'ADD_ROOM':
        description = `Room ${ev.room_id}: Added to inventory (${ev.payload.room_name})`;
        badge = 'info';
        break;
      case 'REMOVE_ROOM':
        description = `Room ${ev.room_id}: Removed from inventory`;
        badge = 'info';
        break;
    }

    if (!description) return null;
    return {
      id: ev.id,
      timestamp: ev.timestamp,
      description,
      badge,
      amount,
      device_id: ev.device_id,
      type: ev.type
    };
  }

  static project(events, baselineLogs = null) {
    const newLogs = [];
    for (const ev of events) {
      const entry = TimelineProjection.buildLogEntry(ev);
      if (entry) newLogs.push(entry);
    }

    if (baselineLogs && baselineLogs.length > 0) {
      const seen = new Set();
      const combined = [...newLogs.reverse(), ...baselineLogs];
      return combined.filter(l => {
        if (seen.has(l.id)) return false;
        seen.add(l.id);
        return true;
      });
    }

    return newLogs.reverse();
  }
}

// --- PROJECTION MANAGER ---
class ProjectionManager {
  static cachedRooms = {};
  static cachedRevenue = {};
  static cachedAudits = [];
  static cachedTimelineLogs = [];
  static cachedRoomInventory = {};
  static lastAppliedEventId = null;

  static _eventsCache = null;
  static _revenueMeta = null;
  static _initialized = false;
  static _uiFlushScheduled = false;

  static invalidateCache() {
    this._eventsCache = null;
    this._initialized = false;
    this.lastAppliedEventId = null;
  }

  static async getEvents() {
    if (!this._eventsCache) {
      const events = await getAllStore('events');
      this._eventsCache = events.sort((a, b) => a.timestamp - b.timestamp);
    }
    return this._eventsCache;
  }

  static async ensureReady() {
    if (this._initialized) return;
    await initServerSettings();
    await initRoomInventory();
    this.cachedRoomInventory = await getRoomInventory();
    await this.getEvents();
    this._fullReplay();
    this._initialized = true;
  }

  static _newRevenueMeta() {
    return { sessionStarts: {}, hourlyRevenue: {}, totalSessionsCount: 0, totalDuration: 0 };
  }

  static _fullReplay() {
    const events = this._eventsCache || [];
    if (events.length === 0) return;

    this.cachedRooms = RoomProjection.project(events, null, this.cachedRoomInventory);
    this.cachedRevenue = RevenueProjection.project(events, null, this.cachedRoomInventory, this.cachedRooms);
    this.cachedAudits = AuditProjection.project(events);
    this.cachedTimelineLogs = TimelineProjection.project(events);

    this._revenueMeta = this._newRevenueMeta();
    for (const ev of events) {
      if (ev.type === 'ROOM_CHECKIN') {
        this._revenueMeta.sessionStarts[ev.session_id] = ev.timestamp;
      }
      if (ev.type === 'CHECKOUT') {
        const start = this._revenueMeta.sessionStarts[ev.session_id];
        if (start) {
          this._revenueMeta.totalSessionsCount++;
          this._revenueMeta.totalDuration += (ev.timestamp - start);
          delete this._revenueMeta.sessionStarts[ev.session_id];
        }
      }
      if (ev.type === 'CONFIRM_CHARGE') {
        const hr = new Date(ev.timestamp).getHours();
        const dateStr = new Date(ev.timestamp).toLocaleDateString();
        const hourKey = `${dateStr} ${hr}:00`;
        if (!this._revenueMeta.hourlyRevenue[hourKey]) this._revenueMeta.hourlyRevenue[hourKey] = 0;
        this._revenueMeta.hourlyRevenue[hourKey] += (ev.payload.amount || 0);
      }
    }

    this.lastAppliedEventId = events[events.length - 1].id;
  }

  static scheduleUIUpdate() {
    if (this._uiFlushScheduled) return;
    this._uiFlushScheduled = true;
    requestAnimationFrame(() => {
      this._uiFlushScheduled = false;
      if (window.appUpdateCallback) window.appUpdateCallback();
    });
  }

  static async applyEvent(event) {
    if (!this._initialized) await this.ensureReady(); // only blocks if truly not ready
    this._eventsCache.push(event);

    RoomProjection.applyEvent(this.cachedRooms, event);
    if (!this._revenueMeta) this._revenueMeta = this._newRevenueMeta();
    RevenueProjection.applyEvent(this.cachedRevenue, this._revenueMeta, event, this.cachedRooms);

    if (event.type === 'VOID_CHARGE') {
      this.cachedAudits.unshift({
        timestamp: event.timestamp,
        room_id: event.room_id,
        void_by: event.payload.void_by,
        reason: event.payload.reason,
        amount: event.payload.original_amount,
        type: event.payload.original_type
      });
    }

    const logEntry = TimelineProjection.buildLogEntry(event);
    if (logEntry) {
      this.cachedTimelineLogs.unshift(logEntry);
    }

    this.lastAppliedEventId = event.id;

    if (this._eventsCache.length % 500 === 0) {
      await this.saveSnapshot(this._eventsCache.length, event.id);
    }

    this.scheduleUIUpdate();
  }

  static async runProjections(force = false) {
    await this.ensureReady();

    const events = this._eventsCache || [];
    if (events.length === 0) return;

    const lastEvent = events[events.length - 1];
    if (lastEvent.id === this.lastAppliedEventId && !force) return;

    this.cachedRoomInventory = await getRoomInventory();

    // Defer full replay off the main thread so UI stays responsive
    setTimeout(() => {
      this._fullReplay();
      this.scheduleUIUpdate();
    }, 0);
  }

  static async saveSnapshot(eventCount, lastEventId) {
    const snapshot = {
      snapshot_id: `snap_${eventCount}`,
      created_at: Date.now(),
      last_event_id: lastEventId,
      projection: {
        rooms: this.cachedRooms,
        revenue: this.cachedRevenue,
        audits: this.cachedAudits,
        timeline: this.cachedTimelineLogs
      }
    };
    await writeStore('snapshots', snapshot);
    console.log(`[Snapshot] Created snapshot at event count: ${eventCount}`);
  }

  // Time Machine query logic: projects up to a specific timestamp
  static async projectToTime(targetTimestamp, mode = 'Operational') {
    const events = await this.getEvents();
    const roomInventory = this.cachedRoomInventory || await getRoomInventory();

    const snapshots = await getAllStore('snapshots');
    const validSnapshots = snapshots
      .filter(s => s.created_at <= targetTimestamp)
      .sort((a, b) => b.created_at - a.created_at);

    let startEvents = [];
    let baseline = null;

    if (validSnapshots.length > 0) {
      const snap = validSnapshots[0];
      baseline = snap.projection;
      startEvents = events.filter(e => e.timestamp > snap.created_at && e.timestamp <= targetTimestamp);
    } else {
      startEvents = events.filter(e => e.timestamp <= targetTimestamp);
    }

    if (mode === 'Operational') {
      return RoomProjection.project(startEvents, baseline ? baseline.rooms : null, roomInventory);
    } else if (mode === 'Financial') {
      const rooms = RoomProjection.project(startEvents, baseline ? baseline.rooms : null, roomInventory);
      return RevenueProjection.project(startEvents, baseline ? baseline.revenue : null, roomInventory, rooms);
    } else {
      return TimelineProjection.project(startEvents, baseline ? baseline.timeline : null);
    }
  }
}

// --- SYNC ENGINE OUTBOX MANAGER ---
class SyncEngine {
  static _syncRunning = false;

  static async getQueue() {
    return await getAllStore('sync_queue');
  }

  static async setStatus(eventId, status, notifyUI = false) {
    const item = await readStore('sync_queue', eventId);
    if (item) {
      item.status = status;
      await writeStore('sync_queue', item);
      if (notifyUI && window.appUpdateCallback) {
        ProjectionManager.scheduleUIUpdate();
      }
    }
  }

  static triggerSyncBackground() {
    if (this._syncRunning) return;
    this._syncRunning = true;
    this.triggerSync().finally(() => {
      this._syncRunning = false;
    });
  }

  static async triggerSync() {
    const queue = await this.getQueue();
    const pending = queue.filter(q => q.status === 'Pending' || q.status === 'Queued' || q.status === 'Retrying');

    if (pending.length === 0) return;
    if (!navigator.onLine) {
      console.log("[SyncEngine] Offline. Sync deferred.");
      return;
    }

    console.log(`[SyncEngine] Syncing ${pending.length} event(s) in background.`);

    for (const item of pending) {
      await this.setStatus(item.event_id, 'Uploading', false);

      try {
        const ev = await readStore('events', item.event_id);

        const serverVersion = await this.getMockServerVersion(ev.room_id);
        const localVersion = ev.revision || 0;

        if (serverVersion > localVersion) {
          await this.setStatus(item.event_id, 'Conflict', false);
          await this.resolveConflict(ev.room_id, serverVersion);
          continue;
        }

        await this.setStatus(item.event_id, 'Synced', false);
        await deleteStore('sync_queue', item.event_id);
      } catch (err) {
        console.error(`[SyncEngine] Sync failed for event ${item.event_id}:`, err);
        await this.setStatus(item.event_id, 'Retrying', false);
      }
    }

    ProjectionManager.scheduleUIUpdate();
  }

  static async getMockServerVersion(roomId) {
    // Simply mock that server matches local revision unless testing conflict
    return 0; 
  }

  static async resolveConflict(roomId, serverVersion) {
    // Merge server events down
    console.log(`[SyncEngine] Resolving conflict for Room ${roomId}...`);
  }
}

// Listen to browser network changes
window.addEventListener('online', () => {
  console.log("[Network] Connection restored.");
  SyncEngine.triggerSyncBackground();
});

// --- EPHEMERAL PRESENCE LAYER ---
// Ephemeral presence is stored in-memory in app.js / db.js and broadcasted.
// It has a 30s TTL.
const PRESENCE_TTL = 30000;
let presenceList = []; // Array of { device_id, name, role, room_id, action, timestamp }

function updateLocalPresence(name, role, roomId, action) {
  const deviceId = window.deviceId || 'dev_local';
  const updatedPresence = {
    device_id: deviceId,
    name,
    role,
    room_id: roomId,
    action, // viewing, editing, idle
    timestamp: Date.now()
  };

  // Broadcast to other tabs (not to ourselves)
  if (window.broadcastChannel) {
    window.broadcastChannel.postMessage({ type: 'PRESENCE_UPDATE', presence: updatedPresence });
  }

  // Update local presence directly (don't use receivePresence to avoid loop)
  presenceList = presenceList.filter(item => item.device_id !== deviceId);
  if (roomId) { // If roomId is null, user went idle
    presenceList.push(updatedPresence);
  }
  cleanPresence();
  if (window.appUpdateCallback) window.appUpdateCallback();
}

function receivePresence(p) {
  // Remove existing presence entry for this device
  presenceList = presenceList.filter(item => item.device_id !== p.device_id);
  if (p.room_id) { // If roomId is null, user went idle
    presenceList.push(p);
  }
  cleanPresence();
  if (window.appUpdateCallback) window.appUpdateCallback();
}

function cleanPresence() {
  const now = Date.now();
  presenceList = presenceList.filter(item => (now - item.timestamp) < PRESENCE_TTL);
}

// Periodically clean presence every 10s
setInterval(() => {
  const before = presenceList.length;
  cleanPresence();
  if (presenceList.length !== before && window.appUpdateCallback) {
    window.appUpdateCallback();
  }
}, 10000);

// Periodically compact note events every 6 hours
setInterval(async () => {
  console.log('[Compaction] Running scheduled note compaction...');
  await compactEvents();
}, 6 * 60 * 60 * 1000);

// --- BACKUP & RECOVERY ---
async function exportHotelData(level = 'Quick') {
  const events = await getEvents();
  const dbExport = {
    export_level: level,
    timestamp: Date.now(),
    device_id: window.deviceId || 'dev_local',
    events: events
  };

  if (level === 'Standard' || level === 'Full') {
    dbExport.projections = {
      rooms: ProjectionManager.cachedRooms,
      revenue: ProjectionManager.cachedRevenue,
      audits: ProjectionManager.cachedAudits
    };
  }

  if (level === 'Full') {
    dbExport.device_registration = await getDeviceRegistration();
    dbExport.snapshots = await getAllStore('snapshots');
  }

  return JSON.stringify(dbExport, null, 2);
}

async function restoreHotelData(jsonStr) {
  try {
    const data = JSON.parse(jsonStr);
    if (!data.events || !Array.isArray(data.events)) {
      throw new Error("Invalid backup format: missing events array");
    }

    // Wipe events store
    await clearStore('events');
    await clearStore('snapshots');
    await clearStore('sync_queue');

    // Restore events
    const db = await openDB();
    const tx = db.transaction('events', 'readwrite');
    const store = tx.objectStore('events');
    for (const ev of data.events) {
      store.put(ev);
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });

    // Re-run projections and rebuild cache
    ProjectionManager.invalidateCache();
    await ProjectionManager.runProjections(true);
    return true;
  } catch (e) {
    console.error("[Recovery] Restore failed:", e);
    alert("Recovery failed: " + e.message);
    return false;
  }
}

// --- MOCK DATABASE SEEDING ---
const SEED_VERSION = 2; // Increment to force re-seed
async function seedMockData() {
  const events = await getEvents();
  const storedVersion = localStorage.getItem('seedVersion');

  // Force re-seed if version changed or database is empty
  if (events.length > 0 && storedVersion == SEED_VERSION) {
    await initServerSettings();
    await initRoomInventory();
    // Don't call ensureReady here - initApp will handle it
    return;
  }

  // Clear old data if version changed
  if (events.length > 0) {
    console.log("[DB] Seed version changed, clearing old data...");
    const db = await openDB();
    const tx = db.transaction(['events', 'device_registration', 'snapshots', 'sync_queue'], 'readwrite');
    await tx.objectStore('events').clear();
    await tx.objectStore('device_registration').clear();
    await tx.objectStore('snapshots').clear();
    await tx.objectStore('sync_queue').clear();
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  console.log("[DB] Seeding mock operational logs for the past 48 hours...");

  const seedEvents = [];
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  const oneDay = 24 * oneHour;

  // Track event counter for ID generation
  let eventIdx = 1000;

  function pushEvent(type, roomId, sessionId, payload, offsetMs) {
    eventIdx++;
    seedEvents.push({
      id: `ev_${eventIdx}`,
      type,
      room_id: roomId,
      session_id: sessionId,
      device_id: 'seeder_daemon',
      payload,
      timestamp: now - offsetMs,
      revision: 1
    });
  }

  // --- SEED YESTERDAY ---
  // Room 101 Checked in 36h ago, checked out 24h ago
  pushEvent('ROOM_CHECKIN',    '101', 'sess_y1', { guest_name: 'Chinedu Okonkwo' },      36 * oneHour);
  pushEvent('ADD_CHARGE',      '101', 'sess_y1', { charge_id: 'ch_y1', type: 'Spa',    amount: 80000,  created_by: 'John' }, 34 * oneHour);
  pushEvent('CONFIRM_CHARGE',  '101', 'sess_y1', { charge_id: 'ch_y1', type: 'Spa',    amount: 80000  }, 34 * oneHour - 1000);
  pushEvent('ADD_CHARGE',      '101', 'sess_y1', { charge_id: 'ch_y2', type: 'Bar',    amount: 35000,  created_by: 'Mary' }, 30 * oneHour);
  pushEvent('CONFIRM_CHARGE',  '101', 'sess_y1', { charge_id: 'ch_y2', type: 'Bar',    amount: 35000  }, 30 * oneHour - 1000);
  pushEvent('ADD_NOTE',        '101', 'sess_y1', { content: 'Guest requested late checkout extension', created_by: 'John' }, 28 * oneHour);
  pushEvent('CHECKOUT',        '101', 'sess_y1', {},                                                24 * oneHour);

  // Room 202 Checked in 30h ago, checked out 20h ago
  pushEvent('ROOM_CHECKIN',    '202', 'sess_y2', { guest_name: 'Adewale Adeyemi' },        30 * oneHour);
  pushEvent('ADD_CHARGE',      '202', 'sess_y2', { charge_id: 'ch_y3', type: 'Extend', amount: 150000, created_by: 'Mary' }, 28 * oneHour);
  pushEvent('CONFIRM_CHARGE',  '202', 'sess_y2', { charge_id: 'ch_y3', type: 'Extend', amount: 150000 }, 28 * oneHour - 1000);
  pushEvent('ADD_CHARGE',      '202', 'sess_y2', { charge_id: 'ch_y9', type: 'Bar',    amount: 60000,  created_by: 'John' }, 26 * oneHour);
  pushEvent('CONFIRM_CHARGE',  '202', 'sess_y2', { charge_id: 'ch_y9', type: 'Bar',    amount: 60000  }, 26 * oneHour - 1000);
  pushEvent('CHECKOUT',        '202', 'sess_y2', {},                                                20 * oneHour);

  // Room 301 checked in 40h ago, checked out 22h ago
  pushEvent('ROOM_CHECKIN',    '301', 'sess_y3', { guest_name: 'Ngozi Okafor' },      40 * oneHour);
  pushEvent('ADD_CHARGE',      '301', 'sess_y3', { charge_id: 'ch_y4', type: 'Laundry', amount: 45000, created_by: 'John' }, 38 * oneHour);
  pushEvent('CONFIRM_CHARGE',  '301', 'sess_y3', { charge_id: 'ch_y4', type: 'Laundry', amount: 45000 }, 38 * oneHour - 1000);
  pushEvent('ADD_CHARGE',      '301', 'sess_y3', { charge_id: 'ch_y5', type: 'Spa',    amount: 120000, created_by: 'John' }, 32 * oneHour);
  pushEvent('CONFIRM_CHARGE',  '301', 'sess_y3', { charge_id: 'ch_y5', type: 'Spa',    amount: 120000 }, 32 * oneHour - 1000);
  pushEvent('CHECKOUT',        '301', 'sess_y3', {},                                                22 * oneHour);

  // Room 304 checked in 38h ago, checked out 18h ago
  pushEvent('ROOM_CHECKIN',    '304', 'sess_y4', { guest_name: 'Emeka Nwachukwu' },    38 * oneHour);
  pushEvent('ADD_CHARGE',      '304', 'sess_y4', { charge_id: 'ch_y6', type: 'Spa',    amount: 200000, created_by: 'Mary' }, 35 * oneHour);
  pushEvent('CONFIRM_CHARGE',  '304', 'sess_y4', { charge_id: 'ch_y6', type: 'Spa',    amount: 200000 }, 35 * oneHour - 1000);
  pushEvent('ADD_CHARGE',      '304', 'sess_y4', { charge_id: 'ch_y7', type: 'Custom', amount: 75000,  created_by: 'John' }, 31 * oneHour);
  pushEvent('CONFIRM_CHARGE',  '304', 'sess_y4', { charge_id: 'ch_y7', type: 'Custom', amount: 75000  }, 31 * oneHour - 1000);
  pushEvent('ADD_NOTE',        '304', 'sess_y4', { content: 'Minibar restocked on request', created_by: 'Mary' }, 30 * oneHour);
  pushEvent('CHECKOUT',        '304', 'sess_y4', {},                                                18 * oneHour);

  // Room 201 checked in 33h ago, checked out 16h ago
  pushEvent('ROOM_CHECKIN',    '201', 'sess_y5', { guest_name: 'Funke Akindele' },       33 * oneHour);
  pushEvent('ADD_CHARGE',      '201', 'sess_y5', { charge_id: 'ch_y8', type: 'Bar',    amount: 90000,  created_by: 'John' }, 29 * oneHour);
  pushEvent('CONFIRM_CHARGE',  '201', 'sess_y5', { charge_id: 'ch_y8', type: 'Bar',    amount: 90000  }, 29 * oneHour - 1000);
  pushEvent('CHECKOUT',        '201', 'sess_y5', {},                                                16 * oneHour);

  // Room 303 checked in 28h ago, checked out 14h ago
  pushEvent('ROOM_CHECKIN',    '303', 'sess_y6', { guest_name: 'Chioma Eze' },       28 * oneHour);
  pushEvent('ADD_CHARGE',      '303', 'sess_y6', { charge_id: 'ch_ya', type: 'Spa',    amount: 160000, created_by: 'Mary' }, 26 * oneHour);
  pushEvent('CONFIRM_CHARGE',  '303', 'sess_y6', { charge_id: 'ch_ya', type: 'Spa',    amount: 160000 }, 26 * oneHour - 1000);
  pushEvent('ADD_CHARGE',      '303', 'sess_y6', { charge_id: 'ch_yb', type: 'Laundry', amount: 40000, created_by: 'John' }, 24 * oneHour);
  pushEvent('CONFIRM_CHARGE',  '303', 'sess_y6', { charge_id: 'ch_yb', type: 'Laundry', amount: 40000 }, 24 * oneHour - 1000);
  pushEvent('CHECKOUT',        '303', 'sess_y6', {},                                                14 * oneHour);

  // Room 102 checked in 25h ago, checked out 12h ago
  pushEvent('ROOM_CHECKIN',    '102', 'sess_y7', { guest_name: 'Olumide Bankole' },        25 * oneHour);
  pushEvent('ADD_CHARGE',      '102', 'sess_y7', { charge_id: 'ch_yc', type: 'Extend', amount: 100000, created_by: 'Mary' }, 22 * oneHour);
  pushEvent('CONFIRM_CHARGE',  '102', 'sess_y7', { charge_id: 'ch_yc', type: 'Extend', amount: 100000 }, 22 * oneHour - 1000);
  pushEvent('CHECKOUT',        '102', 'sess_y7', {},                                                12 * oneHour);

  // --- SEED TODAY (active sessions) ---
  // Room 203 Checked in 8h ago, active session
  pushEvent('ROOM_CHECKIN',    '203', 'sess_t1', { guest_name: 'Tunde Bakare' },     8 * oneHour);
  pushEvent('ADD_CHARGE',      '203', 'sess_t1', { charge_id: 'ch_t1', type: 'Spa',    amount: 90000,  created_by: 'John' }, 7 * oneHour);
  pushEvent('CONFIRM_CHARGE',  '203', 'sess_t1', { charge_id: 'ch_t1', type: 'Spa',    amount: 90000  }, 7 * oneHour - 1000);
  pushEvent('ADD_CHARGE',      '203', 'sess_t1', { charge_id: 'ch_t2', type: 'Bar',    amount: 52000,  created_by: 'Mary' }, 6 * oneHour);
  pushEvent('CONFIRM_CHARGE',  '203', 'sess_t1', { charge_id: 'ch_t2', type: 'Bar',    amount: 52000  }, 6 * oneHour - 1000);
  pushEvent('ADD_NOTE',        '203', 'sess_t1', { content: 'Guest requested extra soft pillows', created_by: 'Mary' }, 5 * oneHour);

  // Room 302 Checked in 5h ago, active session
  pushEvent('ROOM_CHECKIN',    '302', 'sess_t2', { guest_name: 'Blessing Obi' }, 5 * oneHour);
  pushEvent('ADD_CHARGE',      '302', 'sess_t2', { charge_id: 'ch_t3', type: 'Spa',    amount: 140000, created_by: 'John' }, 4 * oneHour);
  pushEvent('CONFIRM_CHARGE',  '302', 'sess_t2', { charge_id: 'ch_t3', type: 'Spa',    amount: 140000 }, 4 * oneHour - 1000);
  pushEvent('ADD_NOTE',        '302', 'sess_t2', { content: 'AC fan speed restricted to Low', created_by: 'John' }, 3 * oneHour);

  // Room 301 Checked in 3h ago, active session
  pushEvent('ROOM_CHECKIN',    '301', 'sess_t3', { guest_name: 'Ifeanyi Nwosu' },        3 * oneHour);
  pushEvent('ADD_CHARGE',      '301', 'sess_t3', { charge_id: 'ch_t4', type: 'Laundry', amount: 30000, created_by: 'Mary' }, 2 * oneHour);
  pushEvent('CONFIRM_CHARGE',  '301', 'sess_t3', { charge_id: 'ch_t4', type: 'Laundry', amount: 30000 }, 2 * oneHour - 1000);

  // Room 103 Checked in 1h ago, session active
  pushEvent('ROOM_CHECKIN',    '103', 'sess_t4', { guest_name: 'Chidinma Okeke' },    1 * oneHour);

  // Room 201 Checked in 2h ago, active session
  pushEvent('ROOM_CHECKIN',    '201', 'sess_t5', { guest_name: 'Oluwaseun Adeyemi' },    2 * oneHour);
  pushEvent('ADD_CHARGE',      '201', 'sess_t5', { charge_id: 'ch_t5', type: 'Bar',    amount: 44000,  created_by: 'John' }, 90 * 60 * 1000);
  pushEvent('CONFIRM_CHARGE',  '201', 'sess_t5', { charge_id: 'ch_t5', type: 'Bar',    amount: 44000  }, 89 * 60 * 1000);

  // Room 303 Checked in 4h ago — Checkout Ready
  pushEvent('ROOM_CHECKIN',    '303', 'sess_t6', { guest_name: 'Nnamdi Kanu' },       4 * oneHour);
  pushEvent('ADD_CHARGE',      '303', 'sess_t6', { charge_id: 'ch_t6', type: 'Extend', amount: 200000, created_by: 'Mary' }, 3.5 * oneHour);
  pushEvent('CONFIRM_CHARGE',  '303', 'sess_t6', { charge_id: 'ch_t6', type: 'Extend', amount: 200000 }, 3.5 * oneHour - 1000);
  pushEvent('CHECKOUT_PREVIEW','303', 'sess_t6', {},                                                30 * 60 * 1000);

  // Room 204 Checked in 90 min ago
  pushEvent('ROOM_CHECKIN',    '204', 'sess_t7', { guest_name: 'Aisha Bello' },      90 * 60 * 1000);
  pushEvent('ADD_CHARGE',      '204', 'sess_t7', { charge_id: 'ch_t7', type: 'Spa',    amount: 110000, created_by: 'John' }, 75 * 60 * 1000);
  pushEvent('CONFIRM_CHARGE',  '204', 'sess_t7', { charge_id: 'ch_t7', type: 'Spa',    amount: 110000 }, 74 * 60 * 1000);

  // Room 104 — Void audit seed
  pushEvent('ROOM_CHECKIN',    '104', 'sess_v1', { guest_name: 'Yusuf Mohammed' },       12 * oneHour);
  pushEvent('ADD_CHARGE',      '104', 'sess_v1', { charge_id: 'ch_v1', type: 'Spa',    amount: 100000, created_by: 'Mary' }, 10 * oneHour);
  pushEvent('CONFIRM_CHARGE',  '104', 'sess_v1', { charge_id: 'ch_v1', type: 'Spa',    amount: 100000 }, 10 * oneHour - 1000);
  pushEvent('VOID_CHARGE',     '104', 'sess_v1', { charge_id: 'ch_v1', original_amount: 100000, original_type: 'Spa', reason: 'Duplicate spa check-in charge', void_by: 'Admin' }, 9 * oneHour);
  pushEvent('CHECKOUT',        '104', 'sess_v1', {},                                                8 * oneHour);

  // Save all seed events
  const db = await openDB();
  const tx = db.transaction('events', 'readwrite');
  const store = tx.objectStore('events');
  for (const ev of seedEvents.sort((a, b) => a.timestamp - b.timestamp)) {
    store.put(ev);
  }
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });

  // Save server settings codes and room inventory
  await initServerSettings();
  await initRoomInventory();

  // Create initial base snapshot at event 10
  const inventory = await getRoomInventory();
  const initialEvents = seedEvents.slice(0, 10);
  const snapRooms    = RoomProjection.project(initialEvents, null, inventory);
  const snapRev      = RevenueProjection.project(initialEvents, null, inventory, snapRooms);
  const snapAudits   = AuditProjection.project(initialEvents);
  const snapTimeline = TimelineProjection.project(initialEvents);

  const baselineSnapshot = {
    snapshot_id:   'snap_base_seed',
    created_at:    now - 20 * oneHour,
    last_event_id: initialEvents[initialEvents.length - 1].id,
    projection: {
      rooms:    snapRooms,
      revenue:  snapRev,
      audits:   snapAudits,
      timeline: snapTimeline
    }
  };
  await writeStore('snapshots', baselineSnapshot);

  // Run final projections
  ProjectionManager.invalidateCache();
  await ProjectionManager.ensureReady();

  // Clear sync queue for seed data (seed events don't need cloud upload)
  await clearStore('sync_queue');

  // Save seed version to prevent re-seeding
  localStorage.setItem('seedVersion', SEED_VERSION);

  console.log(`[DB] Seed complete. ${seedEvents.length} events, 15 sessions, initial snapshot created.`);
}
