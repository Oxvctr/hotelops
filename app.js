/**
 * app.js - Main Application Controller
 * 
 * Manages:
 * - Device activation flow (Staff, Founder, Admin).
 * - Application states (navigation, active rooms, online status).
 * - Renderers for Room Board, Slide-over Panel, Staff Console, Activity Heartbeat, Revenue, Settings.
 * - Time Machine navigation & Mode slider.
 * - Command Palette (Ctrl+K).
 * - Pending charges countdown timer.
 * - Tab synchronization and local presence broadcasting.
 */


// --- GLOBAL STATE ---
const state = {
  activeView: 'rooms', // rooms, activity, revenue, time-machine, settings
  deviceRole: null,    // staff, founder, admin
  deviceId: 'device_' + Math.random().toString(36).substring(2, 9),
  deviceName: '',
  sessionToken: localStorage.getItem('sessionToken') || null,
  simulatedOffline: false,
  inspectedRoom: null, // room number currently viewing in slide-panel
  detailActiveTab: 'timeline', // timeline, charges, notes
  
  // Pending actions queue (for auto-expiry countdowns)
  // list of { roomId, chargeId, type, amount, expiresAt, timerId }
  pendingCharges: [],

  // Time Machine States
  timeMachine: {
    active: false,
    timestamp: Date.now(),
    mode: 'Operational', // Operational, Financial, Staff
    sliderVal: 100
  }
};

// Backend API configuration
const API_BASE = '/.netlify/functions';

// Stats tracking function
async function trackStat(statType, value = 1) {
  if (!state.sessionToken) return;
  
  try {
    await fetch(`${API_BASE}/stats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'increment',
        deviceId: state.deviceId,
        sessionToken: state.sessionToken,
        statType,
        value
      })
    });
  } catch (error) {
    console.log('Stat tracking failed:', error);
  }
}

// Global instance of broadcast channel
window.broadcastChannel = new BroadcastChannel('hotel_ops_channel');
window.deviceId = state.deviceId;
window.state = state;


// --- INITIALIZATION ---
// Safe wrapper: fires immediately if DOM is already parsed (happens with defer),
// otherwise waits for DOMContentLoaded. Fixes the defer + DOMContentLoaded race.
function onReady(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn);
  } else {
    fn();
  }
}

onReady(() => {
  state.deviceName = getDeviceNameMock();

  window.appUpdateCallback = () => {
    if (state.deviceRole) {
      renderCurrentView();
      updateHeaderPresence();
    }
    updateSyncPillUI();
  };

  // Wire UI immediately — don't block on database seed
  setupLockScreenInputs();
  setupViewNavigation();
  setupCommandPalette();
  setupSyncToggle();
  setupBroadcastListener();
  setupSlidePanelListeners();
  updateSyncPillUI();
  setInterval(tickTimers, 1000);

  // Run initApp in background - don't block lock screen
  initApp().catch(err => console.error('[Init] Startup failed:', err));
});

async function initApp() {
  try {
    // Seed data first
    await seedMockData();
    
    // Run these in parallel for faster startup
    const [savedRole] = await Promise.all([
      getDeviceRegistration(),
      ProjectionManager.ensureReady()
    ]);

    if (savedRole) {
      state.deviceRole = savedRole;
      document.getElementById('lock-screen').classList.add('fade-blur');
      setupSidebarForRole();
      reconstructPendingCharges();
      renderCurrentView();

      if (typeof SUPABASE_CONFIGURED !== 'undefined' && SUPABASE_CONFIGURED) {
        performDeltaSync().then(result => {
          if (result.pulled > 0 || result.pushed > 0) {
            showToast(`Synced ↑${result.pushed} ↓${result.pulled} events from cloud`);
          }
        });
        subscribeToRemoteEvents();
      }
    }
  } catch (err) {
    console.error('[Init] Startup failed:', err);
  }
}

// Mock browser device name
function getDeviceNameMock() {
  const userAgent = navigator.userAgent;
  if (userAgent.includes('Mobi')) return 'Staff iPad';
  if (userAgent.includes('Macintosh')) return 'Founder MacBook';
  return 'Lobby Desktop';
}

// --- SIDEBAR SETUP FOR ROLES ---
function hasAdminClearance() {
  return state.deviceRole === 'admin' || state.deviceRole === 'founder';
}

function setupSidebarForRole() {
  const sidebarMenu = document.querySelector('.sidebar-menu');
  const roomsItem = document.getElementById('nav-rooms');
  const activityItem = document.getElementById('nav-activity');
  const revenueItem = document.getElementById('nav-revenue');
  const timemachineItem = document.getElementById('nav-timemachine');
  const settingsItem = document.getElementById('nav-settings');

  if (!sidebarMenu) {
    console.error('[setupSidebarForRole] .sidebar-menu element not found!');
    return;
  }

  // Clean active states
  document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
  roomsItem.classList.add('active');
  state.activeView = 'rooms';

  // Role visibility logic
  if (state.deviceRole === 'staff') {
    // Staff only sees Rooms and a dedicated Staff Console view (instead of full analytics)
    activityItem.style.display = 'none';
    revenueItem.style.display = 'none';
    timemachineItem.style.display = 'none';
    settingsItem.style.display = 'none';

    // Add a dedicated Staff Console button if not exists
    let staffConsoleBtn = document.getElementById('nav-staff-console');
    if (!staffConsoleBtn) {
      staffConsoleBtn = document.createElement('div');
      staffConsoleBtn.id = 'nav-staff-console';
      staffConsoleBtn.className = 'menu-item';
      staffConsoleBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>Staff Console</span>
      `;
      staffConsoleBtn.addEventListener('click', () => {
        switchView('staff-console', staffConsoleBtn);
      });
      sidebarMenu.appendChild(staffConsoleBtn);
    }
    staffConsoleBtn.style.display = 'flex';
  } else {
    // Founder / Admin see everything
    activityItem.style.display = 'flex';
    revenueItem.style.display = 'flex';
    timemachineItem.style.display = 'flex';
    settingsItem.style.display = 'flex';

    const staffConsoleBtn = document.getElementById('nav-staff-console');
    if (staffConsoleBtn) staffConsoleBtn.style.display = 'none';
  }

  // Update header role description
  document.getElementById('header-role-badge').innerText = state.deviceRole.toUpperCase();
}

// --- LOCK & ACTIVATION CODE INPUT ---
function setupLockScreenInputs() {
  const container = document.querySelector('.code-inputs');
  container.innerHTML = '';
  
  // Generate 8 boxes
  for (let i = 0; i < 8; i++) {
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 1;
    input.className = 'code-input-box';
    input.dataset.index = i;
    container.appendChild(input);
  }

  const boxes = document.querySelectorAll('.code-input-box');
  boxes.forEach(box => {
    box.addEventListener('input', (e) => {
      const val = e.target.value;
      if (val) {
        // Move focus to next box
        const nextIdx = parseInt(e.target.dataset.index) + 1;
        if (nextIdx < 8) {
          boxes[nextIdx].focus();
        } else {
          // All boxes filled, attempt registration
          submitActivationCode();
        }
      }
    });

    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !e.target.value) {
        const prevIdx = parseInt(e.target.dataset.index) - 1;
        if (prevIdx >= 0) {
          boxes[prevIdx].focus();
          boxes[prevIdx].value = '';
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        submitActivationCode();
      } else if (e.key === 'ArrowLeft') {
        const prevIdx = parseInt(e.target.dataset.index) - 1;
        if (prevIdx >= 0) boxes[prevIdx].focus();
      } else if (e.key === 'ArrowRight') {
        const nextIdx = parseInt(e.target.dataset.index) + 1;
        if (nextIdx < 8) boxes[nextIdx].focus();
      }
    });

    box.addEventListener('paste', (e) => {
      e.preventDefault();
      const pastedData = (e.clipboardData || window.clipboardData).getData('text');
      const cleanData = pastedData.replace(/\s/g, '').toUpperCase().substring(0, 8);
      
      for (let i = 0; i < cleanData.length; i++) {
        if (boxes[i]) {
          boxes[i].value = cleanData[i];
        }
      }

      if (cleanData.length === 8) {
        submitActivationCode();
      } else {
        const nextFocus = Math.min(cleanData.length, 7);
        if (boxes[nextFocus]) boxes[nextFocus].focus();
      }
    });
  });

  // Focus on first box
  boxes[0].focus();

  document.querySelectorAll('.lock-demo-chip').forEach(chip => {
    chip.disabled = false;
    chip.onclick = () => {
      const code = chip.dataset.code || '';
      for (let i = 0; i < code.length && i < 8; i++) {
        if (boxes[i]) boxes[i].value = code[i];
      }
      submitActivationCode();
    };
  });
}

async function submitActivationCode() {
  const boxes = document.querySelectorAll('.code-input-box');
  let code = '';
  boxes.forEach(box => code += box.value);
  code = code.toUpperCase();

  if (code.length < 8) return;

  document.querySelectorAll('.lock-demo-chip').forEach(c => c.disabled = true);

  // Ensure database is seeded before activation
  await seedMockData();

  // Try local validation first (instant, no network)
  const role = await validateInviteCode(code);
  if (role) {
    state.deviceRole = role;

    const container = document.querySelector('.code-inputs');
    container.innerHTML = '<div style="color: var(--text-primary); font-size: 14px;">Activating device...</div>';

    await saveDeviceRegistration(role);
    await ProjectionManager.ensureReady();

    document.getElementById('lock-screen').classList.add('fade-blur');
    setupSidebarForRole();
    await ProjectionManager.runProjections(true);
    renderCurrentView();

    const activationEvent = {
      id: `ev_act_${Date.now()}`,
      type: 'ACTIVATE_DEVICE',
      room_id: 'SYSTEM',
      session_id: 'SYSTEM',
      device_id: state.deviceId,
      payload: { role, device_name: state.deviceName },
      timestamp: Date.now(),
      revision: 1
    };
    await addEvent(activationEvent);

    showToast(`Device activated successfully as ${role.toUpperCase()}`);
    return;
  }

  // Fallback to backend authentication (for cloud-managed codes)
  try {
    const response = await fetch(`${API_BASE}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'validate',
        code,
        deviceId: state.deviceId,
        deviceName: state.deviceName
      })
    });

    const result = await response.json();

    if (result.success) {
      state.deviceRole = result.role;
      state.sessionToken = result.sessionToken;
      localStorage.setItem('sessionToken', result.sessionToken);

      const container = document.querySelector('.code-inputs');
      container.innerHTML = '<div style="color: var(--text-primary); font-size: 14px;">Activating device...</div>';

      await saveDeviceRegistration(result.role);
      await ProjectionManager.ensureReady();

      document.getElementById('lock-screen').classList.add('fade-blur');
      setupSidebarForRole();
      await ProjectionManager.runProjections(true);
      renderCurrentView();

      const activationEvent = {
        id: `ev_act_${Date.now()}`,
        type: 'ACTIVATE_DEVICE',
        room_id: 'SYSTEM',
        session_id: 'SYSTEM',
        device_id: state.deviceId,
        payload: { role: result.role, device_name: state.deviceName },
        timestamp: Date.now(),
        revision: 1
      };
      await addEvent(activationEvent);

      showToast(`Device activated successfully as ${result.role.toUpperCase()}`);
      return;
    }
  } catch (error) {
    console.log('Backend auth failed:', error);
  }

  // Both local and backend failed
  document.querySelectorAll('.lock-demo-chip').forEach(c => c.disabled = false);
  boxes.forEach(box => {
    box.style.borderColor = '#ff5252';
    box.value = '';
  });
  boxes[0].focus();
  setTimeout(() => {
    boxes.forEach(box => box.style.borderColor = 'rgba(255, 255, 255, 0.08)');
  }, 1000);
}

// --- VIEW NAVIGATION SYSTEM ---
function setupViewNavigation() {
  document.getElementById('nav-rooms').addEventListener('click', (e) => {
    switchView('rooms', e.currentTarget);
  });
  document.getElementById('nav-activity').addEventListener('click', (e) => {
    switchView('activity', e.currentTarget);
  });
  document.getElementById('nav-revenue').addEventListener('click', (e) => {
    switchView('revenue', e.currentTarget);
  });
  document.getElementById('nav-timemachine').addEventListener('click', (e) => {
    switchView('time-machine', e.currentTarget);
  });
  document.getElementById('nav-settings').addEventListener('click', (e) => {
    switchView('settings', e.currentTarget);
  });
  document.getElementById('nav-lock').addEventListener('click', () => {
    lockApplication();
  });
}

function switchView(viewName, navEl) {
  if (viewName !== 'time-machine') {
    state.timeMachine.active = false;
    document.getElementById('time-machine-bar').style.display = 'none';
  }

  state.activeView = viewName;
  document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
  if (navEl) navEl.classList.add('active');

  closeRoomDetailPanel();
  renderCurrentView();
}

async function lockApplication() {
  state.deviceRole = null;
  await saveDeviceRegistration(null);
  document.getElementById('lock-screen').classList.remove('fade-blur');
  setupLockScreenInputs();
}

// --- NEW SESSION DIALOG (from command palette) ---
function openNewSessionDialog() {
  toggleCommandPalette(false);

  // Switch to rooms view first
  switchView('rooms', document.getElementById('nav-rooms'));

  // Build modal HTML
  const modal = document.getElementById('invoice-modal');
  const rooms = ProjectionManager.cachedRooms;
  const vacantRooms = Object.keys(rooms).filter(r => rooms[r].status === 'Vacant');

  if (vacantRooms.length === 0) {
    showToast('No vacant rooms available for check-in.');
    return;
  }

  modal.innerHTML = `
    <div class="invoice-box">
      <h2 style="font-size:20px; font-weight:300; margin-bottom:20px; border-bottom:1px solid #333; padding-bottom:12px;">New Session Check-In</h2>
      <div class="form-group" style="margin-bottom:16px;">
        <label>Select Room</label>
        <select id="checkin-room-select" class="form-select" style="margin-top:8px;">
          ${vacantRooms.map(r => `<option value="${r}">Room ${r} - ${rooms[r].room_name}</option>`).join('')}
        </select>
      </div>
      <div class="form-group" style="margin-bottom:24px;">
        <label>Guest Name</label>
        <input type="text" id="checkin-guest-name" class="form-input" style="margin-top:8px;" placeholder="Full name..." autocomplete="off">
      </div>
      <div style="display:flex; gap:12px;">
        <button class="btn-secondary" style="flex:1; padding:12px;" onclick="closeInvoiceModal()">Cancel</button>
        <button class="btn-primary" style="flex:2; padding:12px;" onclick="submitNewSession()">Check In</button>
      </div>
    </div>
  `;
  modal.style.display = 'flex';

  // Focus guest name field
  setTimeout(() => {
    const el = document.getElementById('checkin-guest-name');
    if (el) el.focus();
  }, 50);
}

window.submitNewSession = async () => {
  const roomNum   = document.getElementById('checkin-room-select').value;
  const guestName = document.getElementById('checkin-guest-name').value.trim();

  if (!guestName) {
    alert('Please enter a guest name.');
    return;
  }

  const sessionId = `sess_${Date.now()}`;
  const checkinEv = {
    id:         `ev_chk_${Date.now()}`,
    type:       'ROOM_CHECKIN',
    room_id:    roomNum,
    session_id: sessionId,
    device_id:  state.deviceId,
    payload:    { guest_name: guestName },
    timestamp:  Date.now(),
    revision:   1
  };

  closeInvoiceModal();
  await addEvent(checkinEv);
  showToast(`Checked in ${guestName} → Room ${roomNum}`);

  // Open detail panel for the new session
  openRoomDetailPanel(roomNum);
};

// --- RENDER COORDINATOR ---
function renderCurrentView() {
  console.log('[renderCurrentView] Called with activeView:', state.activeView, 'deviceRole:', state.deviceRole);
  const container = document.getElementById('main-content-area');
  if (!container) {
    console.error('[renderCurrentView] main-content-area element not found!');
    return;
  }
  container.innerHTML = '';

  console.log('[renderCurrentView] Switching to view:', state.activeView);
  switch (state.activeView) {
    case 'rooms':
      renderRoomsView(container);
      break;
    case 'activity':
      renderActivityFeedView(container);
      break;
    case 'revenue':
      renderRevenueView(container);
      break;
    case 'time-machine':
      renderTimeMachineView(container);
      break;
    case 'settings':
      renderSettingsView(container);
      break;
    case 'staff-console':
      renderStaffConsoleView(container);
      break;
    default:
      console.error('[renderCurrentView] Unknown view:', state.activeView);
  }
  console.log('[renderCurrentView] Container children count after render:', container.children.length);
}

// --- OPTIMIZED ROOM CARD PATCHING ---
function patchRoomCard(rNum, room) {
  const card = document.getElementById(`room-card-${rNum}`);
  if (!card) return false; // card doesn't exist yet, fall back to full render
  
  // Update just the dynamic parts
  const badge = card.querySelector('.status-badge');
  const guest = card.querySelector('.card-guest');
  const cost = card.querySelector('.room-cost');
  const pulse = card.querySelector('.pulse-indicator');
  
  // Update status badge
  if (badge) badge.textContent = room.status;
  
  // Update guest name
  if (guest) {
    guest.textContent = room.guest_name || 'Vacant';
    guest.classList.toggle('empty', !room.guest_name);
  }
  
  // Update cost
  let totalCost = 0;
  room.charges.forEach(c => {
    if (c.status === 'Confirmed' || c.status === 'Pending') totalCost += c.amount;
  });
  if (cost) cost.textContent = totalCost > 0 ? '$' + totalCost : '--';
  
  // Update pulse indicator
  if (pulse) {
    pulse.className = 'pulse-indicator';
    if (room.status === 'Session Active') pulse.classList.add('pulse-active');
    else if (room.status === 'Checkout Ready') pulse.classList.add('pulse-green');
    else if (room.status === 'Offline') pulse.classList.add('pulse-amber');
  }
  
  return true;
}

// --- HEADER PRESENCE UPDATE ---
function updateHeaderPresence() {
  const presList = document.getElementById('presence-list-header');
  presList.innerHTML = '';

  // Filter out current device to show other active users
  const others = presenceList.filter(p => p.device_id !== state.deviceId);
  
  if (others.length === 0) {
    presList.innerHTML = `<span style="color: var(--text-muted); font-size:12px;">No other devices active</span>`;
    return;
  }

  others.forEach(p => {
    const pill = document.createElement('div');
    pill.className = 'sync-indicator-pill';
    pill.innerHTML = `
      <span class="sync-dot synced"></span>
      <span>${p.name} (${p.role}) - ${p.action === 'editing' ? 'Editing Room ' + p.room_id : 'Viewing'}</span>
    `;
    presList.appendChild(pill);
  });
}

// --- SYNC ENGINE UI TOGGLE ---
function setupSyncToggle() {
  const syncPill = document.getElementById('sync-status-pill');
  if (syncPill) {
    syncPill.addEventListener('click', () => {
      state.simulatedOffline = !state.simulatedOffline;
      
      updateSyncPillUI();

      if (state.simulatedOffline) {
        showToast('Offline Mode Activated. Operations will queue.');
      } else {
        showToast('Online. Synced pending actions.');
        if (typeof performDeltaSync === 'function' && typeof SUPABASE_CONFIGURED !== 'undefined' && SUPABASE_CONFIGURED) {
          performDeltaSync();
        } else {
          SyncEngine.triggerSync();
        }
      }
    });
  }
}

async function updateSyncPillUI() {
  const syncPill = document.getElementById('sync-status-pill');
  if (!syncPill) return;

  const dot = syncPill.querySelector('.sync-dot');
  const txt = syncPill.querySelector('span:nth-child(2)');
  if (!dot || !txt) return;

  if (state.simulatedOffline || !navigator.onLine) {
    dot.className = 'sync-dot offline';
    txt.innerText = state.simulatedOffline ? 'Offline Mode' : 'Offline';
    return;
  }

  const queue = await SyncEngine.getQueue();
  const pending = queue.filter(q => ['Pending', 'Queued', 'Uploading', 'Retrying'].includes(q.status));

  if (pending.length > 0) {
    dot.className = 'sync-dot syncing';
    txt.innerText = `Syncing (${pending.length})`;
  } else {
    dot.className = 'sync-dot synced';
    txt.innerText = 'Synced';
  }
}

// --- ROOM BOARD RENDERER (SCREEN 1) ---
function renderRoomsView(container) {
  console.log('[renderRoomsView] Starting render...');
  
  // Title / Info row
  const header = document.createElement('div');
  header.className = 'viewport-header';
  
  // Calculate active sessions count
  const rooms = state.timeMachine.active 
    ? window.historicalRoomsProjection || {}
    : ProjectionManager.cachedRooms;

  console.log('[renderRoomsView] Rooms data:', rooms);

  let activeCount = 0;
  let vacantCount = 0;
  for (const r in rooms) {
    if (rooms[r].status === 'Vacant') vacantCount++;
    else activeCount++;
  }

  header.innerHTML = `
    <div>
      <h1 class="text-hero">${state.timeMachine.active ? 'History Board' : 'Room Board'}</h1>
      <p style="margin-top: 8px;">${activeCount} active sessions • ${vacantCount} vacant rooms</p>
    </div>
  `;
  container.appendChild(header);

  // Main Room Grid
  const grid = document.createElement('div');
  grid.className = 'room-grid';
  container.appendChild(grid);

  // Load rooms data
  console.log('[renderRoomsView] Room keys:', Object.keys(rooms));
  
  for (const rNum in rooms) {
    const room = rooms[rNum];
    const card = document.createElement('div');
    card.id = `room-card-${rNum}`;
    card.className = `room-card status-${room.status.toLowerCase().replace(' ', '-')}`;
    
    // Pulse light check
    let pulseClass = '';
    if (room.status === 'Session Active') pulseClass = 'pulse-active';
    else if (room.status === 'Checkout Ready') pulseClass = 'pulse-green';
    else if (room.status === 'Offline') pulseClass = 'pulse-amber';

    // Total running cost calculation
    let cost = 0;
    room.charges.forEach(c => {
      if (c.status === 'Confirmed' || c.status === 'Pending') {
        cost += c.amount;
      }
    });

    // Check if there are charges syncing (optimistic UI)
    const syncingCount = room.charges.filter(c => c.status === 'Pending').length;
    const syncingTxt = syncingCount > 0 ? `<span class="charge-status-optimistic" style="font-size:10px; margin-left: 8px;">Syncing...</span>` : '';

    card.innerHTML = `
      <div class="pulse-indicator ${pulseClass}"></div>
      <div class="card-header">
        <span class="room-number">${rNum}</span>
        <span class="status-badge ${room.status.toLowerCase().replace(' ', '-')}">${room.status}</span>
      </div>
      <div class="card-guest ${room.guest_name ? '' : 'empty'}">
        ${room.guest_name || 'Vacant'}
        ${syncingTxt}
      </div>
      <div class="card-footer">
        <span class="room-timer" data-start="${room.timer_start || ''}">${room.timer_start ? formatTimer(Date.now() - room.timer_start) : '--:--:--'}</span>
        <span class="room-cost">${cost > 0 ? '$' + cost : '--'}</span>
      </div>
    `;

    // Click opens Screen 2 Room Detail
    card.addEventListener('click', () => {
      openRoomDetailPanel(rNum);
    });

    grid.appendChild(card);
  }

  console.log('[renderRoomsView] Grid children count:', grid.children.length);

  // Handle empty state if no rooms configured
  if (Object.keys(rooms).length === 0) {
    grid.innerHTML = `
      <div class="empty-state-wrapper" style="grid-column: span 4;">
        <span class="empty-state-icon">⚲</span>
        <h3 class="empty-state-title">No rooms configured</h3>
        <p class="empty-state-description">Please add rooms in settings to start operating.</p>
      </div>
    `;
  }
}

// --- SLIDE PANEL CONTROLLER (SCREEN 2) ---
function setupSlidePanelListeners() {
  document.getElementById('close-panel-btn').addEventListener('click', closeRoomDetailPanel);
  
  // Detail panel tab switcher
  document.getElementById('tab-timeline').addEventListener('click', (e) => {
    switchDetailTab('timeline', e.currentTarget);
  });
  document.getElementById('tab-charges').addEventListener('click', (e) => {
    switchDetailTab('charges', e.currentTarget);
  });
  document.getElementById('tab-notes').addEventListener('click', (e) => {
    switchDetailTab('notes', e.currentTarget);
  });
}

function switchDetailTab(tabName, el) {
  state.detailActiveTab = tabName;
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  el.classList.add('active');
  renderRoomDetailContent();
}

function openRoomDetailPanel(roomNum) {
  state.inspectedRoom = roomNum;
  const panel = document.getElementById('room-detail-panel');
  panel.classList.add('open');
  
  // Reset tab
  state.detailActiveTab = 'timeline';
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById('tab-timeline').classList.add('active');

  renderRoomDetailContent();
  
  // Update presence editing status
  if (state.deviceRole) {
    updateLocalPresence(state.deviceName, state.deviceRole, roomNum, 'editing');
  }
}

function closeRoomDetailPanel() {
  state.inspectedRoom = null;
  const panel = document.getElementById('room-detail-panel');
  panel.classList.remove('open');

  // Return presence to viewing
  if (state.deviceRole) {
    updateLocalPresence(state.deviceName, state.deviceRole, null, 'viewing');
  }
}

function renderRoomDetailContent() {
  const rNum = state.inspectedRoom;
  if (!rNum) return;

  const rooms = state.timeMachine.active 
    ? window.historicalRoomsProjection || {}
    : ProjectionManager.cachedRooms;

  const room = rooms[rNum];
  if (!room) return;

  // Header Details
  document.getElementById('detail-room-number').innerText = `Room ${rNum}`;
  document.getElementById('detail-room-type').innerText = room.room_name;
  
  let cost = 0;
  room.charges.forEach(c => {
    if (c.status === 'Confirmed' || c.status === 'Pending') {
      cost += c.amount;
    }
  });

  document.getElementById('detail-room-cost').innerText = cost > 0 ? `$${cost}` : '$0';
  document.getElementById('detail-room-timer').innerText = room.timer_start ? formatTimer(Date.now() - room.timer_start) : '00:00:00';
  document.getElementById('detail-room-timer').dataset.start = room.timer_start || '';

  // Sticky checkout footer
  const checkoutArea = document.getElementById('detail-checkout-area');
  if (room.status === 'Vacant') {
    checkoutArea.style.display = 'none';
  } else {
    checkoutArea.style.display = 'block';
    // If Time Machine is active, disable modifications
    const checkoutBtn = document.getElementById('btn-complete-checkout');
    const previewBtn = document.getElementById('btn-preview-bill');
    if (state.timeMachine.active) {
      checkoutBtn.disabled = true;
      previewBtn.disabled = true;
      checkoutBtn.innerText = 'Locked (Viewing History)';
    } else {
      checkoutBtn.disabled = false;
      previewBtn.disabled = false;
      checkoutBtn.innerText = 'Complete Checkout';
    }
  }

  // Body Scroll Content Tab-based rendering
  const scrollArea = document.getElementById('detail-scroll-area');
  scrollArea.innerHTML = '';

  // Disable forms if Time machine is active
  const isReadOnly = state.timeMachine.active;

  if (state.detailActiveTab === 'timeline') {
    // Session timeline events
    const timeline = document.createElement('div');
    timeline.className = 'timeline-container';
    
    // Reconstruct list of logs for this room session
    const logs = [];
    // Add Checkin
    if (room.timer_start) {
      logs.push({
        time: new Date(room.timer_start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        desc: `Checked In: ${room.guest_name}`
      });
    }

    // Add confirmed charges
    room.charges.forEach(c => {
      if (c.status === 'Confirmed') {
        logs.push({
          time: new Date(c.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          desc: `Added charge: ${c.type} (+$${c.amount}) by ${c.created_by}`
        });
      } else if (c.status === 'Voided') {
        logs.push({
          time: new Date(c.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          desc: `Voided charge: ${c.type} ($${c.amount}) - Reason: ${c.void_reason}`
        });
      }
    });

    logs.forEach(item => {
      const evItem = document.createElement('div');
      evItem.className = 'timeline-item';
      evItem.innerHTML = `
        <div class="timeline-dot"></div>
        <div class="timeline-item-header">
          <span>${item.time}</span>
        </div>
        <div class="timeline-item-content">${item.desc}</div>
      `;
      timeline.appendChild(evItem);
    });

    if (logs.length === 0) {
      timeline.innerHTML = `<p style="color: var(--text-muted); text-align: center; margin-top:20px;">No session timeline events</p>`;
    }
    scrollArea.appendChild(timeline);

  } else if (state.detailActiveTab === 'charges') {
    // Charges list + Add Charge Action
    const container = document.createElement('div');
    container.className = 'notebook-container';

    // Countdown banner for pending charges (if any)
    const activePendings = state.pendingCharges.filter(p => p.roomId === rNum);
    activePendings.forEach(p => {
      const banner = document.createElement('div');
      banner.className = 'pending-banner';
      banner.innerHTML = `
        <div>
          <span>Pending ${p.type} ($${p.amount}) expires in: </span>
          <span class="pending-timer-val" id="countdown-${p.chargeId}">--:--</span>
        </div>
        <div class="pending-actions">
          <button class="btn-confirm" onclick="confirmPendingCharge('${p.chargeId}')">Confirm</button>
          <button class="btn-cancel" onclick="cancelPendingCharge('${p.chargeId}')">Cancel</button>
        </div>
      `;
      container.appendChild(banner);
      updateCountdownDisplay(p);
    });

    // List of active charges
    const list = document.createElement('div');
    room.charges.forEach(c => {
      const item = document.createElement('div');
      item.className = 'charge-item-card';
      
      let statusMarkup = '';
      if (c.status === 'Pending') {
        statusMarkup = `<span class="charge-status-optimistic">Uploading...</span>`;
      } else if (c.status === 'Voided') {
        statusMarkup = `<span style="color:#ff5252; font-size:11px;">Voided</span>`;
      }

      // Void action visible only to admin or founder role
      const canVoid = (state.deviceRole === 'admin' || state.deviceRole === 'founder') && c.status === 'Confirmed' && !isReadOnly;
      const voidButton = canVoid 
        ? `<button class="void-btn" onclick="triggerVoidCharge('${rNum}', '${c.id}', ${c.amount}, '${c.type}')">Void</button>` 
        : '';

      item.innerHTML = `
        <div>
          <h4 style="font-weight:400; color:#fff;">+$${c.amount} ${c.type}</h4>
          <p style="font-size:12px; color: var(--text-muted); margin-top:2px;">
            ${new Date(c.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} • by ${c.created_by}
          </p>
        </div>
        <div>
          ${statusMarkup}
          ${voidButton}
        </div>
      `;
      list.appendChild(item);
    });

    if (room.charges.length === 0 && activePendings.length === 0) {
      list.innerHTML = `<p style="color: var(--text-muted); text-align: center; margin-top:20px;">No charges added yet</p>`;
    }

    container.appendChild(list);

    // Fast Add Charge block (if not vacant and not read only)
    if (room.status !== 'Vacant' && !isReadOnly) {
      const addBox = document.createElement('div');
      addBox.style.marginTop = '24px';
      addBox.style.paddingTop = '16px';
      addBox.style.borderTop = 'var(--border-glass-light)';
      addBox.innerHTML = `
        <h4 style="font-size:12px; text-transform:uppercase; color:var(--text-muted); margin-bottom:12px;">Quick Add Charge</h4>
        <div class="action-grid" style="grid-template-columns: repeat(5, 1fr); margin-bottom:12px;">
          <button class="action-btn-pill quick-c-btn" data-type="Spa">Spa</button>
          <button class="action-btn-pill quick-c-btn" data-type="Bar">Bar</button>
          <button class="action-btn-pill quick-c-btn" data-type="Laundry">Laundry</button>
          <button class="action-btn-pill quick-c-btn" data-type="Extend">Extend</button>
          <button class="action-btn-pill quick-c-btn" data-type="Custom">Custom</button>
        </div>
        <div style="display:flex; gap:12px;">
          <input type="number" id="quick-charge-amt" placeholder="Amount" class="form-input" style="padding:10px; width:60%;">
          <button class="btn-primary" style="padding:10px; flex-grow:1;" onclick="submitQuickCharge('${rNum}')">Submit</button>
        </div>
      `;
      container.appendChild(addBox);

      // Event listener for action buttons
      setTimeout(() => {
        const pills = addBox.querySelectorAll('.quick-c-btn');
        pills.forEach(pill => {
          pill.addEventListener('click', (e) => {
            pills.forEach(p => p.classList.remove('selected'));
            e.target.classList.add('selected');
          });
        });
      }, 50);
    }

    scrollArea.appendChild(container);

  } else if (state.detailActiveTab === 'notes') {
    // Notes block
    const container = document.createElement('div');
    container.className = 'notebook-container';

    // Add Note text field
    if (room.status !== 'Vacant' && !isReadOnly) {
      const form = document.createElement('div');
      form.innerHTML = `
        <textarea id="note-input-field" placeholder="Enter session note..." class="note-textarea"></textarea>
        <button class="btn-primary" style="margin-top:8px; width:100%; padding:10px;" onclick="submitSessionNote('${rNum}')">Add Note</button>
      `;
      container.appendChild(form);
    }

    // List of notes
    const list = document.createElement('div');
    list.style.marginTop = '20px';
    
    room.notes.forEach(n => {
      const item = document.createElement('div');
      item.className = 'note-log-item';
      item.innerHTML = `
        <p style="color:#fff; font-size:14px; font-weight:300;">${n.content}</p>
        <p style="font-size:11px; color: var(--text-muted); margin-top:6px;">
          ${new Date(n.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} • by ${n.created_by}
        </p>
      `;
      list.appendChild(item);
    });

    if (room.notes.length === 0) {
      list.innerHTML = `<p style="color: var(--text-muted); text-align: center; margin-top:20px;">No notes added yet</p>`;
    }

    container.appendChild(list);
    scrollArea.appendChild(container);
  }
}

// --- ADD QUICK CHARGE (PENDING LIFE CYCLE) ---
// Now writes an immediate ADD_CHARGE event to IndexedDB so pending charges
// survive page refresh and appear in the activity feed.
window.submitQuickCharge = async (roomId) => {
  const pills = document.querySelectorAll('.quick-c-btn');
  let selectedType = null;
  pills.forEach(p => { if (p.classList.contains('selected')) selectedType = p.dataset.type; });

  const amtInput = document.getElementById('quick-charge-amt');
  const amount = parseFloat(amtInput.value);

  if (!selectedType) {
    alert('Please select a charge type.');
    return;
  }
  if (isNaN(amount) || amount <= 0) {
    alert('Please enter a valid amount.');
    return;
  }

  const chargeId = `ch_pend_${Date.now()}`;
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

  const rooms = ProjectionManager.cachedRooms;
  const room  = rooms[roomId];
  const newRev = (room.revision || 0) + 1;

  // Write ADD_CHARGE event immediately (Pending status) — survives refresh
  const addEv = {
    id:         `ev_add_${Date.now()}`,
    type:       'ADD_CHARGE',
    room_id:    roomId,
    session_id: room.session_id,
    device_id:  state.deviceId,
    payload:    { charge_id: chargeId, type: selectedType, amount, created_by: state.deviceName, status: 'Pending' },
    timestamp:  Date.now(),
    revision:   newRev
  };
  await addEvent(addEv);

  // Auto-expire timeout
  const timerId = setTimeout(() => {
    autoExpirePendingCharge(chargeId);
  }, 5 * 60 * 1000);

  state.pendingCharges.push({ roomId, chargeId, type: selectedType, amount, expiresAt, timerId });

  // Clear inputs
  amtInput.value = '';
  pills.forEach(p => p.classList.remove('selected'));

  renderRoomDetailContent();
  showToast(`Pending ${selectedType} ($${amount}) queued. Confirm within 5 min.`);
};

// Confirm Pending Charge: Commits via CONFIRM_CHARGE only
window.confirmPendingCharge = async (chargeId) => {
  const idx = state.pendingCharges.findIndex(p => p.chargeId === chargeId);
  if (idx === -1) return;

  const pending = state.pendingCharges[idx];
  clearTimeout(pending.timerId);
  state.pendingCharges.splice(idx, 1);

  const rooms = ProjectionManager.cachedRooms;
  const room = rooms[pending.roomId];
  const newRev = (room.revision || 0) + 1;
  const sessionId = room.session_id;

  const confirmEv = {
    id: `ev_conf_${Date.now()}`,
    type: 'CONFIRM_CHARGE',
    room_id: pending.roomId,
    session_id: sessionId,
    device_id: state.deviceId,
    payload: { charge_id: chargeId, type: pending.type, amount: pending.amount },
    timestamp: Date.now(),
    revision: newRev
  };
  await addEvent(confirmEv);

  renderRoomDetailContent();
  showToast(`Charge Confirmed: ${pending.type} (+$${pending.amount})`);
};

// Cancel Pending Charge — persists EXPIRE_CHARGE event
window.cancelPendingCharge = async (chargeId) => {
  const idx = state.pendingCharges.findIndex(p => p.chargeId === chargeId);
  if (idx === -1) return;

  const pending = state.pendingCharges[idx];
  clearTimeout(pending.timerId);
  state.pendingCharges.splice(idx, 1);

  const rooms = ProjectionManager.cachedRooms;
  const room = rooms[pending.roomId];
  if (room && room.session_id) {
    const expEv = {
      id: `ev_exp_${Date.now()}`,
      type: 'EXPIRE_CHARGE',
      room_id: pending.roomId,
      session_id: room.session_id,
      device_id: state.deviceId,
      payload: { charge_id: chargeId, type: pending.type, amount: pending.amount },
      timestamp: Date.now(),
      revision: (room.revision || 0) + 1
    };
    await addEvent(expEv);
  }

  renderRoomDetailContent();
  showToast(`Pending charge canceled.`);
};

// Reconstruct Pending Charges on startup
function reconstructPendingCharges() {
  const rooms = ProjectionManager.cachedRooms;
  const now = Date.now();
  
  for (const rNum in rooms) {
    const room = rooms[rNum];
    if (!room || !room.charges) continue;
    room.charges.forEach(c => {
      if (c.status === 'Pending') {
        const timePassed = now - c.timestamp;
        const remaining = 5 * 60 * 1000 - timePassed;
        
        if (remaining > 0) {
          if (!state.pendingCharges.some(p => p.chargeId === c.id)) {
            const timerId = setTimeout(() => {
              autoExpirePendingCharge(c.id);
            }, remaining);
            
            const pending = {
              roomId: rNum,
              chargeId: c.id,
              type: c.type,
              amount: c.amount,
              expiresAt: now + remaining,
              timerId
            };
            state.pendingCharges.push(pending);
          }
        } else {
          if (room.session_id) {
            const expEv = {
              id: `ev_exp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
              type: 'EXPIRE_CHARGE',
              room_id: rNum,
              session_id: room.session_id,
              device_id: state.deviceId,
              payload: { charge_id: c.id, type: c.type, amount: c.amount },
              timestamp: Date.now(),
              revision: (room.revision || 0) + 1
            };
            addEvent(expEv);
          }
        }
      }
    });
  }
}

// Auto Expire Pending Charge
async function autoExpirePendingCharge(chargeId) {
  const idx = state.pendingCharges.findIndex(p => p.chargeId === chargeId);
  if (idx === -1) return;

  const pending = state.pendingCharges[idx];
  state.pendingCharges.splice(idx, 1);

  // Write EXPIRE_CHARGE event
  const rooms = ProjectionManager.cachedRooms;
  const room = rooms[pending.roomId];
  if (room && room.session_id) {
    const expEv = {
      id: `ev_exp_${Date.now()}`,
      type: 'EXPIRE_CHARGE',
      room_id: pending.roomId,
      session_id: room.session_id,
      device_id: state.deviceId,
      payload: { charge_id: chargeId, type: pending.type, amount: pending.amount },
      timestamp: Date.now(),
      revision: (room.revision || 0) + 1
    };
    await addEvent(expEv);
  }

  if (state.inspectedRoom === pending.roomId) {
    renderRoomDetailContent();
  }
}

function updateCountdownDisplay(pending) {
  setTimeout(() => {
    const el = document.getElementById(`countdown-${pending.chargeId}`);
    if (!el) return;

    const diff = pending.expiresAt - Date.now();
    if (diff <= 0) {
      el.innerText = '0:00';
      return;
    }

    const mins = Math.floor(diff / (1000 * 60));
    const secs = Math.floor((diff % (1000 * 60)) / 1000);
    el.innerText = `${mins}:${secs.toString().padStart(2, '0')}`;

    // Recursive trigger
    if (state.pendingCharges.some(p => p.chargeId === pending.chargeId)) {
      updateCountdownDisplay(pending);
    }
  }, 1000);
}

// --- SUBMIT NOTE ---
window.submitSessionNote = async (roomId) => {
  const el = document.getElementById('note-input-field');
  const txt = el.value.trim();

  if (!txt) return;

  const rooms = ProjectionManager.cachedRooms;
  const room = rooms[roomId];
  const sessionId = room.session_id;

  const noteEv = {
    id: `ev_note_${Date.now()}`,
    type: 'ADD_NOTE',
    room_id: roomId,
    session_id: sessionId,
    device_id: state.deviceId,
    payload: { content: txt, created_by: state.deviceName },
    timestamp: Date.now(),
    revision: (room.revision || 0) + 1
  };
  await addEvent(noteEv);
  
  el.value = '';
  renderRoomDetailContent();
  showToast('Note added.');
};

// --- VOID CHARGE DIALOG ---
window.triggerVoidCharge = async (roomId, chargeId, originalAmount, originalType) => {
  const reason = prompt("Enter reason for voiding charge:", "Duplicate Entry");
  if (reason === null) return; // cancel

  const rooms = ProjectionManager.cachedRooms;
  const room = rooms[roomId];

  const voidEv = {
    id: `ev_void_${Date.now()}`,
    type: 'VOID_CHARGE',
    room_id: roomId,
    session_id: room.session_id,
    device_id: state.deviceId,
    payload: {
      charge_id: chargeId,
      original_amount: originalAmount,
      original_type: originalType,
      reason: reason || 'Audit correction',
      void_by: state.deviceName
    },
    timestamp: Date.now(),
    revision: (room.revision || 0) + 1
  };
  await addEvent(voidEv);

  renderRoomDetailContent();
  showToast(`Voided ${originalType} ($${originalAmount})`);
};

// --- COMPLETE CHECKOUT ---
// Triggers the Invoice modal -> Card fold animation -> checkout completion
window.previewBill = () => {
  const rNum = state.inspectedRoom;
  const rooms = ProjectionManager.cachedRooms;
  const room = rooms[rNum];
  if (!room) return;

  let total = 0;
  const itemsList = room.charges.map(c => {
    if (c.status === 'Confirmed' || c.status === 'Pending') {
      total += c.amount;
      return `<div class="breakdown-row"><span>${c.type}</span><span>$${c.amount}</span></div>`;
    }
    return '';
  }).join('');

  const modal = document.getElementById('invoice-modal');
  modal.innerHTML = `
    <div class="invoice-box">
      <h2 style="font-size:24px; font-weight:300; margin-bottom:20px; border-bottom:1px solid #333; padding-bottom:12px; text-align:center;">INVOICE</h2>
      <div style="font-size:12px; margin-bottom:20px; color:var(--text-secondary);">
        <p>Room: ${rNum} (${room.room_name})</p>
        <p>Guest: ${room.guest_name}</p>
        <p>Checked In: ${new Date(room.timer_start).toLocaleString()}</p>
      </div>
      <div>
        ${itemsList || '<p style="text-align:center; color:var(--text-muted);">No charges incurred</p>'}
      </div>
      <div class="breakdown-row" style="margin-top:20px; border-top:1px solid #333; padding-top:12px; font-weight:600; color:#fff; font-size:18px;">
        <span>Total Bill</span>
        <span>$${total}</span>
      </div>
      <button class="btn-primary" style="margin-top:24px; width:100%;" onclick="closeInvoiceModal()">Close Preview</button>
    </div>
  `;
  modal.style.display = 'flex';
};

window.closeInvoiceModal = () => {
  document.getElementById('invoice-modal').style.display = 'none';
};

window.completeCheckout = async () => {
  const rNum = state.inspectedRoom;
  const rooms = ProjectionManager.cachedRooms;
  const room = rooms[rNum];
  if (!room) return;

  // 1. Fold card animation setup
  const card = document.getElementById(`room-card-${rNum}`);
  if (card) {
    card.classList.add('card-fold-animation');
  }

  // Close detail panel
  closeRoomDetailPanel();

  // Wait for animation to finish (400ms)
  await new Promise(r => setTimeout(r, 400));

  // 2. Commit CHECKOUT event
  const checkOutEv = {
    id: `ev_out_${Date.now()}`,
    type: 'CHECKOUT',
    room_id: rNum,
    session_id: room.session_id,
    device_id: state.deviceId,
    payload: {},
    timestamp: Date.now(),
    revision: (room.revision || 0) + 1
  };
  await addEvent(checkOutEv);

  showToast(`Checkout complete. Room ${rNum} is Vacant.`);
};

// --- STAFF CONSOLE VIEW (SCREEN 3) ---
function renderStaffConsoleView(container) {
  container.innerHTML = `
    <div class="staff-console-panel">
      <h2 class="text-section" style="font-size:24px; border-bottom:var(--border-glass-light); padding-bottom:12px;">Staff Console</h2>
      
      <div class="form-group">
        <label>Select Room</label>
        <select id="staff-room-picker" class="form-select">
          <option value="">-- Choose active room --</option>
        </select>
      </div>

      <div class="form-group">
        <label>Select Action Type</label>
        <div class="action-grid">
          <button class="action-btn-pill staff-action-btn" data-type="Spa">Spa</button>
          <button class="action-btn-pill staff-action-btn" data-type="Bar">Bar</button>
          <button class="action-btn-pill staff-action-btn" data-type="Laundry">Laundry</button>
          <button class="action-btn-pill staff-action-btn" data-type="Extend">Extend</button>
          <button class="action-btn-pill staff-action-btn" data-type="Custom">Custom</button>
        </div>
      </div>

      <div class="form-group">
        <label>Quick Amount</label>
        <div class="amount-quick-picker">
          <button class="amount-btn-pill" onclick="setConsoleAmount(20000)">₦20k</button>
          <button class="amount-btn-pill" onclick="setConsoleAmount(50000)">₦50k</button>
          <button class="amount-btn-pill" onclick="setConsoleAmount(100000)">₦100k</button>
          <button class="amount-btn-pill" onclick="setConsoleAmount(150000)">₦150k</button>
        </div>
        <input type="number" id="staff-amount-input" class="form-input" style="margin-top:12px;" placeholder="Custom amount (₦)">
      </div>

      <div class="form-group">
        <label>Session Notes</label>
        <textarea id="staff-note-input" class="note-textarea" placeholder="Add optional operational note..."></textarea>
      </div>

      <button class="btn-primary" style="margin-top:12px; padding:18px;" onclick="submitStaffConsoleAction()">Submit Action</button>
    </div>
  `;

  // Prepopulate rooms select with active rooms
  const rooms = ProjectionManager.cachedRooms;
  const select = document.getElementById('staff-room-picker');
  for (const rNum in rooms) {
    if (rooms[rNum].status !== 'Vacant') {
      const opt = document.createElement('option');
      opt.value = rNum;
      opt.innerText = `Room ${rNum} (${rooms[rNum].guest_name})`;
      select.appendChild(opt);
    }
  }

  // Setup click listener for action grids
  const pills = container.querySelectorAll('.staff-action-btn');
  pills.forEach(pill => {
    pill.addEventListener('click', (e) => {
      pills.forEach(p => p.classList.remove('selected'));
      e.target.classList.add('selected');
    });
  });
}

window.setConsoleAmount = (amt) => {
  document.getElementById('staff-amount-input').value = amt;
};

window.submitStaffConsoleAction = async () => {
  const rNum = document.getElementById('staff-room-picker').value;
  
  const pills = document.querySelectorAll('.staff-action-btn');
  let selectedType = null;
  pills.forEach(p => { if (p.classList.contains('selected')) selectedType = p.dataset.type; });

  const amtVal  = parseFloat(document.getElementById('staff-amount-input').value);
  const noteVal = document.getElementById('staff-note-input').value.trim();

  if (!rNum)         { alert('Please select a room.');        return; }
  if (!selectedType) { alert('Please select an action type.'); return; }
  if (isNaN(amtVal) || amtVal <= 0) { alert('Please enter a valid amount.'); return; }

  const chargeId = `ch_pend_${Date.now()}`;
  const expiresAt = Date.now() + 5 * 60 * 1000;

  const room   = ProjectionManager.cachedRooms[rNum];
  const newRev = (room.revision || 0) + 1;

  // Write ADD_CHARGE event immediately as Pending — survives refresh
  const addEv = {
    id:         `ev_add_${Date.now()}`,
    type:       'ADD_CHARGE',
    room_id:    rNum,
    session_id: room.session_id,
    device_id:  state.deviceId,
    payload:    { charge_id: chargeId, type: selectedType, amount: amtVal, created_by: state.deviceName, status: 'Pending' },
    timestamp:  Date.now(),
    revision:   newRev
  };
  await addEvent(addEv);

  const timerId = setTimeout(() => {
    autoExpirePendingCharge(chargeId);
  }, 5 * 60 * 1000);

  state.pendingCharges.push({ roomId: rNum, chargeId, type: selectedType, amount: amtVal, expiresAt, timerId });

  // Write note event immediately if provided
  if (noteVal) {
    const noteEv = {
      id:         `ev_note_${Date.now()}`,
      type:       'ADD_NOTE',
      room_id:    rNum,
      session_id: room.session_id,
      device_id:  state.deviceId,
      payload:    { content: noteVal, created_by: state.deviceName },
      timestamp:  Date.now(),
      revision:   newRev + 1
    };
    await addEvent(noteEv);
  }

  // Switch view back to Room Board
  const roomsNav = document.getElementById('nav-rooms');
  switchView('rooms', roomsNav);
  showToast(`Pending ${selectedType} charge queued for Room ${rNum}.`);
};

// --- LIVE HEARTBEAT ACTIVITY FEED (SCREEN 4) ---
function renderActivityFeedView(container) {
  const header = document.createElement('div');
  header.className = 'viewport-header';
  header.innerHTML = `
    <div>
      <h1 class="text-hero">Live Activity Center</h1>
      <p style="margin-top: 8px;">Operational heartbeat feed from all devices</p>
    </div>
  `;
  container.appendChild(header);

  const viewWrapper = document.createElement('div');
  viewWrapper.className = 'live-activity-container';
  container.appendChild(viewWrapper);

  // Left Feed Panel
  const feedPanel = document.createElement('div');
  feedPanel.className = 'activity-feed-panel';
  feedPanel.innerHTML = `
    <div class="activity-filters-row">
      <button class="filter-chip active" data-filter="All">All</button>
      <button class="filter-chip" data-filter="Revenue">Revenue</button>
      <button class="filter-chip" data-filter="Sessions">Sessions</button>
      <button class="filter-chip" data-filter="Staff">Staff</button>
      <button class="filter-chip" data-filter="Void">Corrections</button>
    </div>
    <div class="activity-feed-scroll scroll-container" id="feed-items-scroll"></div>
  `;
  viewWrapper.appendChild(feedPanel);

  // Right Side mini-stats block
  const sideBlock = document.createElement('div');
  sideBlock.className = 'notebook-container';
  sideBlock.style.background = 'var(--bg-card)';
  sideBlock.style.border = 'var(--border-glass)';
  sideBlock.style.borderRadius = '16px';
  sideBlock.style.padding = '24px';
  
  // Calculate active devices presence count
  const allActive = [{ device_id: state.deviceId, name: state.deviceName, role: state.deviceRole, action: 'Local' }, ...presenceList];

  sideBlock.innerHTML = `
    <h3 class="text-section" style="font-size:16px; margin-bottom:16px;">Active Devices</h3>
    <div style="display:flex; flex-direction:column; gap:12px;">
      ${allActive.map(p => `
        <div class="breakdown-row" style="border:none; padding:0;">
          <span>${p.name || p.device_id}${p.device_id === state.deviceId ? ' (You)' : ''}</span>
          <span style="color:#4caf50;">● ${p.role ? p.role.toUpperCase() : 'Online'}</span>
        </div>
      `).join('')}
    </div>
    <p style="font-size:11px; color:var(--text-muted); margin-top:16px;">${allActive.length} device${allActive.length !== 1 ? 's' : ''} connected</p>
  `;
  viewWrapper.appendChild(sideBlock);

  // Filter click binding
  const chips = feedPanel.querySelectorAll('.filter-chip');
  chips.forEach(chip => {
    chip.addEventListener('click', (e) => {
      chips.forEach(c => c.classList.remove('active'));
      e.target.classList.add('active');
      renderFeedItemsList(e.target.dataset.filter);
    });
  });

  renderFeedItemsList('All');
}

function renderFeedItemsList(filter) {
  const scroll = document.getElementById('feed-items-scroll');
  scroll.innerHTML = '';

  const logs = state.timeMachine.active 
    ? window.historicalTimelineLogs || []
    : ProjectionManager.cachedTimelineLogs;

  const filteredLogs = logs.filter(log => {
    if (filter === 'All') return true;
    return log.badge === filter;
  });

  filteredLogs.forEach(log => {
    const item = document.createElement('div');
    item.className = 'feed-item';
    
    let colorStyle = '';
    if (log.badge === 'Revenue') colorStyle = 'color: #4caf50;';
    if (log.badge === 'Void') colorStyle = 'color: #ff5252;';

    const amtText = log.amount !== null 
      ? `<span class="feed-amount" style="${colorStyle}">${log.amount > 0 ? '+$' + log.amount : '-$' + Math.abs(log.amount)}</span>` 
      : '';

    item.innerHTML = `
      <div class="feed-item-left">
        <span class="feed-badge">${log.badge}</span>
        <div>
          <p style="color:#fff; font-size:14px; font-weight:300;">${log.description}</p>
          <p style="font-size:11px; color:var(--text-muted); margin-top:2px;">
            ${new Date(log.timestamp).toLocaleTimeString()} • Device: ${log.device_id === state.deviceId ? 'Local' : log.device_id}
          </p>
        </div>
      </div>
      <div>
        ${amtText}
      </div>
    `;
    scroll.appendChild(item);
  });

  if (filteredLogs.length === 0) {
    scroll.innerHTML = `
      <div class="empty-state-wrapper">
        <span class="empty-state-icon">☁</span>
        <h3 class="empty-state-title">Hotel is quiet</h3>
        <p class="empty-state-description">No activity detected for this filter category.</p>
      </div>
    `;
  }
}

// --- FINANCIAL REVENUE VIEW (SCREEN 5) ---
function renderRevenueView(container) {
  const header = document.createElement('div');
  header.className = 'viewport-header';
  header.innerHTML = `
    <div>
      <h1 class="text-hero">Financial Revenue</h1>
      <p style="margin-top: 8px;">Consolidated earnings and stats overview</p>
    </div>
  `;
  container.appendChild(header);

  const wrapper = document.createElement('div');
  wrapper.className = 'revenue-grid';
  container.appendChild(wrapper);

  // Left Stats Panel
  const statsPanel = document.createElement('div');
  statsPanel.style.display = 'flex';
  statsPanel.style.flexDirection = 'column';
  wrapper.appendChild(statsPanel);

  // Load projection
  const rev = state.timeMachine.active 
    ? window.historicalRevenueProjection || {}
    : ProjectionManager.cachedRevenue;

  // Mini metrics row
  const metricsStrip = document.createElement('div');
  metricsStrip.className = 'revenue-cards-strip';
  metricsStrip.innerHTML = `
    <div class="revenue-card-metric">
      <span class="text-meta">Revenue</span>
      <div class="val">$${rev.todayRevenue || 0}</div>
    </div>
    <div class="revenue-card-metric">
      <span class="text-meta">Rooms Active</span>
      <div class="val">${rev.roomsActiveCount || 0}</div>
    </div>
    <div class="revenue-card-metric">
      <span class="text-meta">Avg Session</span>
      <div class="val">${rev.avgSessionHours || '0h'}</div>
    </div>
    <div class="revenue-card-metric">
      <span class="text-meta">Outbox</span>
      <div class="val" id="outbox-count-rev">--</div>
    </div>
  `;
  statsPanel.appendChild(metricsStrip);

  SyncEngine.getQueue().then(q => {
    const el = document.getElementById('outbox-count-rev');
    if (el) el.innerText = q.length;
  });

  // Graph card
  const graphCard = document.createElement('div');
  graphCard.className = 'revenue-graph-panel';
  graphCard.innerHTML = `
    <span class="text-meta">Rolling Revenue Progress</span>
    <svg class="thin-line-chart" viewBox="0 0 500 220" id="revenue-svg-chart"></svg>
    <div class="slider-labels-row" style="margin-top:8px;">
      <span>08:00</span>
      <span>12:00</span>
      <span>16:00</span>
      <span>20:00</span>
    </div>
  `;
  statsPanel.appendChild(graphCard);

  // Draw chart
  setTimeout(() => {
    drawRevenueChart(rev.timelineGraphData);
  }, 50);

  // Right Side breakdown rankings
  const breakdownPanel = document.createElement('div');
  breakdownPanel.className = 'breakdown-card';
  
  // Format services breakdown
  const dist = rev.serviceDistribution || {};
  const serviceList = Object.keys(dist)
    .sort((a,b) => dist[b] - dist[a])
    .map(key => `<div class="breakdown-row"><span>${key}</span><span>$${dist[key]}</span></div>`)
    .join('');

  breakdownPanel.innerHTML = `
    <h3 class="text-section" style="font-size:16px; margin-bottom:16px;">Top Services</h3>
    <div style="display:flex; flex-direction:column; gap:8px;">
      ${serviceList || '<p style="text-align:center; color:var(--text-muted);">No services sold</p>'}
    </div>
  `;
  wrapper.appendChild(breakdownPanel);
}

function drawRevenueChart(dataPoints) {
  const svg = document.getElementById('revenue-svg-chart');
  if (!svg) return;

  svg.innerHTML = '';

  // Background Grid Lines
  for (let i = 0; i <= 4; i++) {
    const y = 20 + i * 45;
    const grid = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    grid.setAttribute('x1', '0');
    grid.setAttribute('y1', y);
    grid.setAttribute('x2', '500');
    grid.setAttribute('y2', y);
    grid.setAttribute('class', 'grid-line');
    svg.appendChild(grid);
  }

  if (!dataPoints || dataPoints.length === 0) {
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', '250');
    text.setAttribute('y', '110');
    text.setAttribute('fill', 'var(--text-secondary)');
    text.setAttribute('text-anchor', 'middle');
    text.innerHTML = 'No earnings progress logs';
    svg.appendChild(text);
    return;
  }

  // Draw thin line path
  const maxVal = Math.max(...dataPoints.map(d => d.value), 100);
  const minVal = 0;
  const padding = 20;
  const height = 180;
  const width = 500;

  let pathD = '';
  dataPoints.forEach((pt, i) => {
    const x = (i / (dataPoints.length - 1)) * width;
    const y = height + padding - ((pt.value - minVal) / (maxVal - minVal)) * height;
    
    if (i === 0) {
      pathD += `M ${x} ${y}`;
    } else {
      pathD += ` L ${x} ${y}`;
    }

    // Dot indicator
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', x);
    dot.setAttribute('cy', y);
    dot.setAttribute('r', '3');
    dot.setAttribute('fill', '#ffffff');
    svg.appendChild(dot);
  });

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('d', pathD);
  svg.appendChild(line);
}

// --- HISTORY REPLAY (Time Machine) ---
let _tmScrollTimer = null;

function renderTimeMachineView(container) {
  const header = document.createElement('div');
  header.className = 'viewport-header';
  header.innerHTML = `
    <div>
      <h1 class="text-hero">History Replay</h1>
      <p style="margin-top: 8px;">Scrub the timeline to view rooms, revenue, and staff activity at any moment</p>
    </div>
    <div style="display:flex; gap:12px;">
      <button class="filter-chip tm-mode-btn ${state.timeMachine.mode === 'Operational' ? 'active' : ''}" data-mode="Operational">Operational</button>
      <button class="filter-chip tm-mode-btn ${state.timeMachine.mode === 'Financial' ? 'active' : ''}" data-mode="Financial">Financial</button>
      <button class="filter-chip tm-mode-btn ${state.timeMachine.mode === 'Staff' ? 'active' : ''}" data-mode="Staff">Staff Activity</button>
    </div>
  `;
  container.appendChild(header);

  // Replay Control Card
  const sliderCard = document.createElement('div');
  sliderCard.className = 'time-machine-controls';
  sliderCard.innerHTML = `
    <div class="time-machine-header">
      <span class="text-meta">Timeline</span>
      <span id="time-machine-date-label" style="font-size:18px; font-weight:400; color:#fff;">Now</span>
    </div>
    <div class="time-slider-wrapper">
      <input type="range" min="0" max="100" value="${state.timeMachine.sliderVal}" class="slider-line" id="tm-slider-control">
      <div class="slider-labels-row">
        <span>Yesterday (24h ago)</span>
        <span>12 Hours Ago</span>
        <span>Now</span>
      </div>
    </div>
  `;
  container.appendChild(sliderCard);

  // Bottom display zone (displays historical room grid, revenue or logs)
  const displayZone = document.createElement('div');
  displayZone.id = 'time-machine-display-zone';
  displayZone.style.marginTop = '24px';
  container.appendChild(displayZone);

  // Activate slider binding
  setTimeout(() => {
    const slider = document.getElementById('tm-slider-control');
    slider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      state.timeMachine.sliderVal = val;
      clearTimeout(_tmScrollTimer);
      _tmScrollTimer = setTimeout(() => triggerTimeMachineScroll(val), 80);
    });

    const modeBtns = container.querySelectorAll('.tm-mode-btn');
    modeBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        modeBtns.forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        state.timeMachine.mode = e.target.dataset.mode;
        triggerTimeMachineScroll(state.timeMachine.sliderVal);
      });
    });

    // Run initial slider point project
    triggerTimeMachineScroll(state.timeMachine.sliderVal);
  }, 50);
}

async function triggerTimeMachineScroll(sliderVal) {
  state.timeMachine.active = true;

  // sliderVal 0 = 24h ago, 100 = now
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const offsetPercent = (100 - sliderVal) / 100;
  const timestamp = now - offsetPercent * oneDay;

  state.timeMachine.timestamp = timestamp;

  // Format label
  const dateObj = new Date(timestamp);
  document.getElementById('time-machine-date-label').innerText = dateObj.toLocaleString();

  // Run projection
  const zone = document.getElementById('time-machine-display-zone');
  if (!zone) return;
  zone.innerHTML = '<p style="text-align:center; color:var(--text-secondary);">Recalculating projection...</p>';

  if (state.timeMachine.mode === 'Operational') {
    window.historicalRoomsProjection = await ProjectionManager.projectToTime(timestamp, 'Operational');
    zone.innerHTML = '';
    renderRoomsView(zone);
  } else if (state.timeMachine.mode === 'Financial') {
    window.historicalRevenueProjection = await ProjectionManager.projectToTime(timestamp, 'Financial');
    zone.innerHTML = '';
    renderRevenueView(zone);
  } else {
    window.historicalTimelineLogs = await ProjectionManager.projectToTime(timestamp, 'Staff');
    zone.innerHTML = '';
    renderActivityFeedView(zone);
  }

  // Show inline top Nexus replay notification bar
  const tmBar = document.getElementById('time-machine-bar');
  tmBar.style.display = 'block';
  tmBar.querySelector('span').innerText = `History replay — ${dateObj.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}

// --- SETTINGS VIEW & AUDIT RECOVERY (SCREEN 6) ---
function renderSettingsView(container) {
  const header = document.createElement('div');
  header.className = 'viewport-header';
  header.innerHTML = `
    <div>
      <h1 class="text-hero">Settings</h1>
      <p style="margin-top: 8px;">Administrative panels and system backups</p>
    </div>
  `;
  container.appendChild(header);

  const wrapper = document.createElement('div');
  wrapper.className = 'settings-container';
  container.appendChild(wrapper);

  // Left settings sidebar menu
  const settingsNav = document.createElement('div');
  settingsNav.className = 'settings-nav';
  settingsNav.innerHTML = `
    <button class="settings-tab-btn active" id="stab-general">General Settings</button>
    <button class="settings-tab-btn" id="stab-rooms">Rooms Inventory</button>
    <button class="settings-tab-btn" id="stab-codes">Access Codes</button>
    <button class="settings-tab-btn" id="stab-system">Backup &amp; System</button>
    <button class="settings-tab-btn" id="stab-audit">Audit Corrections Log</button>
    <button class="settings-tab-btn" id="stab-supabase">Cloud Sync</button>
  `;
  wrapper.appendChild(settingsNav);

  // Right contents panel
  const settingsContent = document.createElement('div');
  settingsContent.className = 'settings-panel-content';
  settingsContent.id = 'settings-panel-inner';
  wrapper.appendChild(settingsContent);

  // Settings tab switching
  setTimeout(() => {
    const btns = settingsNav.querySelectorAll('.settings-tab-btn');
    btns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        btns.forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        renderSettingsSubtab(e.target.id);
      });
    });
  }, 50);

  renderSettingsSubtab('stab-general');
}

function renderSettingsSubtab(tabId) {
  const inner = document.getElementById('settings-panel-inner');
  inner.innerHTML = '';

  const isReadOnly = state.timeMachine.active;
  const isAdmin = hasAdminClearance();

  if (tabId === 'stab-general') {
    inner.innerHTML = `
      <h2 class="text-section" style="margin-bottom:16px;">General Setup</h2>
      <div class="settings-row">
        <div>
          <h4>Device Identification</h4>
          <p style="font-size:12px;">Used to identify who added charges</p>
        </div>
        <input type="text" id="settings-device-name-input" class="form-input settings-row-input" value="${state.deviceName}">
      </div>
      <div class="settings-row" style="border:none;">
        <div>
          <h4>Device Role Permission</h4>
          <p style="font-size:12px;">Active clearance on this client</p>
        </div>
        <span style="font-weight:600; text-transform:uppercase;">${state.deviceRole}</span>
      </div>
      <button class="btn-primary" style="margin-top:24px; padding:12px 24px;" onclick="saveGeneralSettings()">Save General Settings</button>
    `;
  } else if (tabId === 'stab-rooms') {
    inner.innerHTML = `
      <h2 class="text-section" style="margin-bottom:16px;">Rooms Setup</h2>
      <p style="font-size:12px; margin-bottom:16px; color:var(--text-muted);">Configure room identifiers and categorization. (Founder/Admin clearance required)</p>
      <div id="rooms-inventory-list"></div>
    `;

    const list = document.getElementById('rooms-inventory-list');
    const rooms = ProjectionManager.cachedRooms;
    const sortedRooms = Object.keys(rooms).sort();

    for (const rNum of sortedRooms) {
      const room = rooms[rNum];
      const row = document.createElement('div');
      row.className = 'settings-row';
      const canRemove = isAdmin && room.status === 'Vacant';
      row.innerHTML = `
        <span style="font-weight:500; font-size:16px;">Room ${rNum}</span>
        <div style="display:flex; gap:12px; align-items:center; flex:1; justify-content:flex-end;">
          <input type="text" class="form-input settings-row-input room-rename-field" data-room="${rNum}" value="${room.room_name}" ${isAdmin ? '' : 'disabled'} style="max-width:220px;">
          ${canRemove ? `<button class="btn-cancel" style="padding:8px 12px; font-size:12px;" onclick="removeRoomFromInventory('${rNum}')">Remove</button>` : ''}
        </div>
      `;
      list.appendChild(row);
    }

    if (isAdmin) {
      const addSection = document.createElement('div');
      addSection.style.marginTop = '24px';
      addSection.style.paddingTop = '20px';
      addSection.style.borderTop = 'var(--border-glass-light)';
      addSection.innerHTML = `
        <h4 style="margin-bottom:12px; color:var(--text-primary);">Add New Room</h4>
        <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end;">
          <div>
            <label style="font-size:11px; color:var(--text-muted); display:block; margin-bottom:4px;">Room Number</label>
            <input type="text" id="add-room-number" class="form-input" placeholder="e.g. 401" style="width:100px;">
          </div>
          <div style="flex:1; min-width:160px;">
            <label style="font-size:11px; color:var(--text-muted); display:block; margin-bottom:4px;">Room Name</label>
            <input type="text" id="add-room-name" class="form-input" placeholder="e.g. Deluxe Suite">
          </div>
          <button class="btn-secondary" style="padding:10px 20px;" onclick="addRoomToInventory()">Add Room</button>
        </div>
      `;
      inner.appendChild(addSection);

      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn-primary';
      saveBtn.style.marginTop = '24px';
      saveBtn.style.padding = '12px 24px';
      saveBtn.innerText = 'Save Room Names';
      saveBtn.onclick = saveRoomsInventory;
      inner.appendChild(saveBtn);
    }

  } else if (tabId === 'stab-codes') {
    // Code rotation
    getServerCodes().then(codes => {
      inner.innerHTML = `
        <h2 class="text-section" style="margin-bottom:16px;">Invite & Activation Codes</h2>
        <p style="font-size:12px; margin-bottom:20px; color:var(--text-muted);">8-character codes used on the lock screen. Demo aliases STAFFINV / FOUNDINV / ADMININV always work.</p>
        
        <div class="settings-row">
          <div>
            <h4>Staff Invitation Code</h4>
            <p style="font-size:12px;">Valid for 24h. Grants Staff console access.</p>
          </div>
          <input type="text" id="code-staff-input" class="form-input settings-row-input" maxlength="8" value="${codes.staff_code}" ${isAdmin ? '' : 'disabled'}>
        </div>
        
        <div class="settings-row">
          <div>
            <h4>Founder Invitation Code</h4>
            <p style="font-size:12px;">Grants dashboard and metrics access.</p>
          </div>
          <input type="text" id="code-founder-input" class="form-input settings-row-input" maxlength="8" value="${codes.founder_code}" ${isAdmin ? '' : 'disabled'}>
        </div>

        <div class="settings-row" style="border:none;">
          <div>
            <h4>Admin Invitation Code</h4>
            <p style="font-size:12px;">Grants configuration and room editing privileges.</p>
          </div>
          <input type="text" id="code-admin-input" class="form-input settings-row-input" maxlength="8" value="${codes.admin_code}" ${isAdmin ? '' : 'disabled'}>
        </div>
      `;

      if (isAdmin) {
        const btn = document.createElement('button');
        btn.className = 'btn-primary';
        btn.style.marginTop = '24px';
        btn.style.padding = '12px 24px';
        btn.innerText = 'Rotate Access Codes';
        btn.onclick = saveAccessCodes;
        inner.appendChild(btn);
      }
    });

  } else if (tabId === 'stab-system') {
    // Backup restore recovery
    inner.innerHTML = `
      <h2 class="text-section" style="margin-bottom:16px;">Backup & Database Recovery</h2>
      <p style="font-size:12px; margin-bottom:20px; color:var(--text-muted);">Backup the event store log list or perform restore imports.</p>
      
      <div class="form-group" style="margin-bottom:20px;">
        <label>Select Backup Level</label>
        <select id="backup-level-select" class="form-select" style="max-width:300px;">
          <option value="Quick">Quick (Events only)</option>
          <option value="Standard">Standard (Events + Projections)</option>
          <option value="Full">Full (Database dump)</option>
        </select>
      </div>

      <div style="display:flex; gap:16px;">
        <button class="btn-primary" style="padding:12px 24px;" onclick="triggerBackupExport()">Export Backup</button>
        <button class="btn-secondary" style="padding:12px 24px;" onclick="triggerBackupImportPrompt()">Restore Database</button>
      </div>
    `;

  } else if (tabId === 'stab-audit') {
    // Audit log listings
    inner.innerHTML = `
      <h2 class="text-section" style="margin-bottom:16px;">Audit Correction Logs</h2>
      <p style="font-size:12px; margin-bottom:20px; color:var(--text-muted);">Historical corrections and voided charges list. Never deleted.</p>
      <div id="audit-list-logs-wrapper"></div>
    `;

    const wrapper = document.getElementById('audit-list-logs-wrapper');
    const audits = ProjectionManager.cachedAudits;
    
    audits.forEach(aud => {
      const item = document.createElement('div');
      item.className = 'audit-log-row';
      item.innerHTML = `
        <div style="display:flex; justify-content:between;">
          <span style="color:#ff5252;">Void Corrected: Room ${aud.room_id}</span>
          <span style="font-family:var(--font-display); font-weight:500;">-$${aud.amount} ${aud.type}</span>
        </div>
        <p style="font-size:12px; color:var(--text-secondary); margin-top:4px;">Reason: "${aud.reason}"</p>
        <p style="font-size:11px; color:var(--text-muted); margin-top:2px;">
          Authorized by ${aud.void_by} on ${new Date(aud.timestamp).toLocaleString()}
        </p>
      `;
      wrapper.appendChild(item);
    });

    if (audits.length === 0) {
      wrapper.innerHTML = `<p style="color:var(--text-muted); text-align:center; margin-top:30px;">No corrections recorded.</p>`;
    }

  } else if (tabId === 'stab-supabase') {
    const sbStatus = (typeof getSupabaseStatus === 'function')
      ? getSupabaseStatus()
      : { configured: false, url: null };
    const statusColor  = sbStatus.configured ? '#4caf50' : '#ef6c00';
    const statusLabel  = sbStatus.configured ? 'Connected' : 'Not Configured';
    const statusDetail = sbStatus.configured
      ? `Syncing to <code style="color:var(--text-secondary);">${sbStatus.url}</code>`
      : 'Open <code style="color:var(--text-secondary);">supabase.js</code> and replace <code style="color:var(--text-secondary);">YOUR_SUPABASE_URL</code> and <code style="color:var(--text-secondary);">YOUR_SUPABASE_ANON_KEY</code>.';

    inner.innerHTML = `
      <h2 class="text-section" style="margin-bottom:16px;">Cloud Sync — Supabase</h2>
      <p style="font-size:12px; margin-bottom:20px; color:var(--text-muted);">Configure your Supabase project to enable multi-device real-time sync, event push/pull, and live presence.</p>

      <div class="settings-row">
        <div>
          <h4>Connection Status</h4>
          <p style="font-size:12px; margin-top:4px;">${statusDetail}</p>
        </div>
        <span style="font-weight:600; color:${statusColor};">● ${statusLabel}</span>
      </div>

      <div class="settings-row">
        <div>
          <h4>Project URL</h4>
          <p style="font-size:12px;">Found in Project Settings → API</p>
        </div>
        <code style="font-size:11px; color:var(--text-secondary); max-width:220px; word-break:break-all; text-align:right;">${sbStatus.url || 'Not set'}</code>
      </div>

      <div class="settings-row" style="border:none;">
        <div>
          <h4>Realtime Subscription</h4>
          <p style="font-size:12px;">Live event push from other devices via Supabase Realtime</p>
        </div>
        <span style="color:${sbStatus.configured ? '#4caf50' : 'var(--text-muted)'};">${sbStatus.configured ? '● Active' : '○ Inactive'}</span>
      </div>

      <div style="margin-top:24px; padding:16px; background:rgba(255,255,255,0.02); border:var(--border-glass); border-radius:8px;">
        <h4 style="margin-bottom:8px; font-size:13px;">Setup Guide</h4>
        <ol style="font-size:12px; color:var(--text-secondary); line-height:2.2; padding-left:16px;">
          <li>Create a project at <strong style="color:#fff;">supabase.com</strong></li>
          <li>Run the SQL schema block from the top of <code>supabase.js</code> in the SQL Editor</li>
          <li>Copy your Project URL and anon key into <code>supabase.js</code> lines 47–48</li>
          <li>Reload — delta sync and realtime will activate automatically on login</li>
        </ol>
      </div>

      ${sbStatus.configured ? `
        <button class="btn-primary" style="margin-top:24px; padding:12px 24px;" onclick="triggerManualSync()">Run Manual Sync Now</button>
      ` : ''}
    `;
  }
}

window.triggerManualSync = async () => {
  if (typeof performDeltaSync !== 'function') {
    showToast('Supabase not configured.');
    return;
  }
  showToast('Running delta sync...');
  const result = await performDeltaSync();
  showToast(`Sync complete — ↑${result.pushed} pushed, ↓${result.pulled} pulled`);
  renderCurrentView();
};

window.saveGeneralSettings = () => {
  const val = document.getElementById('settings-device-name-input').value.trim();
  if (val) {
    state.deviceName = val;
    showToast('General Settings updated.');
  }
};

window.saveRoomsInventory = async () => {
  const fields = document.querySelectorAll('.room-rename-field');
  const inventory = await getRoomInventory();
  let changed = false;

  for (const f of fields) {
    const rNum = f.dataset.room;
    const newName = f.value.trim();
    if (newName) {
      const room = ProjectionManager.cachedRooms[rNum];
      if (room && room.room_name !== newName) {
        if (inventory[rNum]) {
          inventory[rNum].room_name = newName;
          changed = true;
        }
        const updateEv = {
          id: `ev_up_${Date.now()}_${rNum}`,
          type: 'UPDATE_ROOM_META',
          room_id: rNum,
          session_id: 'SYSTEM',
          device_id: state.deviceId,
          payload: { room_name: newName },
          timestamp: Date.now(),
          revision: (room.revision || 0) + 1
        };
        await addEvent(updateEv);
      }
    }
  }

  if (changed) {
    await saveRoomInventory(inventory);
    ProjectionManager.cachedRoomInventory = inventory;
  }
  showToast('Rooms Inventory updated.');
  renderCurrentView();
};

window.addRoomToInventory = async () => {
  const rNum = document.getElementById('add-room-number')?.value.trim();
  const rName = document.getElementById('add-room-name')?.value.trim();
  if (!rNum || !rName) {
    alert('Enter both room number and name.');
    return;
  }
  const inventory = await getRoomInventory();
  if (inventory[rNum]) {
    alert(`Room ${rNum} already exists.`);
    return;
  }
  inventory[rNum] = { room_name: rName };
  await saveRoomInventory(inventory);
  ProjectionManager.cachedRoomInventory = inventory;

  const addEv = {
    id: `ev_addroom_${Date.now()}`,
    type: 'ADD_ROOM',
    room_id: rNum,
    session_id: 'SYSTEM',
    device_id: state.deviceId,
    payload: { room_name: rName },
    timestamp: Date.now(),
    revision: 1
  };
  await addEvent(addEv);
  showToast(`Room ${rNum} added.`);
  renderSettingsSubtab('stab-rooms');
  renderCurrentView();
};

window.removeRoomFromInventory = async (rNum) => {
  const room = ProjectionManager.cachedRooms[rNum];
  if (!room) return;
  if (room.status !== 'Vacant') {
    alert('Cannot remove a room with an active session.');
    return;
  }
  if (!confirm(`Remove room ${rNum} from inventory?`)) return;

  const inventory = await getRoomInventory();
  delete inventory[rNum];
  await saveRoomInventory(inventory);
  ProjectionManager.cachedRoomInventory = inventory;

  const remEv = {
    id: `ev_remroom_${Date.now()}`,
    type: 'REMOVE_ROOM',
    room_id: rNum,
    session_id: 'SYSTEM',
    device_id: state.deviceId,
    payload: {},
    timestamp: Date.now(),
    revision: 1
  };
  await addEvent(remEv);
  showToast(`Room ${rNum} removed.`);
  renderSettingsSubtab('stab-rooms');
  renderCurrentView();
};

window.saveAccessCodes = async () => {
  const staff = document.getElementById('code-staff-input').value.trim();
  const founder = document.getElementById('code-founder-input').value.trim();
  const admin = document.getElementById('code-admin-input').value.trim();

  if (!staff || !founder || !admin) {
    alert("Codes cannot be empty.");
    return;
  }

  await updateServerCodes({ staff_code: staff, founder_code: founder, admin_code: admin });
  showToast('Access codes rotated.');
};

// Backup Export handler
window.triggerBackupExport = async () => {
  const level = document.getElementById('backup-level-select').value;
  const jsonStr = await exportHotelData(level);
  
  // Download file trigger
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hotel-ops-backup-${level.toLowerCase()}-${Date.now()}.json`;
  a.click();
  showToast(`Backup downloaded: level ${level}`);
};

// Backup Import handler
window.triggerBackupImportPrompt = () => {
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json';
  fileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = async (evt) => {
        const success = await restoreHotelData(evt.target.result);
        if (success) {
          showToast('Database restored successfully from backup.');
          renderCurrentView();
        }
      };
      reader.readAsText(file);
    }
  };
  fileInput.click();
};

// --- TIMERS TICKS (Timer element helper) ---
function tickTimers() {
  document.querySelectorAll('.room-timer').forEach(el => {
    const start = el.dataset.start;
    if (start) {
      const diff = Date.now() - parseInt(start);
      el.innerText = formatTimer(diff);
    }
  });
}

function formatTimer(diffMs) {
  const hrs = Math.floor(diffMs / (1000 * 60 * 60));
  const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  const secs = Math.floor((diffMs % (1000 * 60)) / 1000);
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// --- TAB TO TAB BROADCAST LISTENER ---
function setupBroadcastListener() {
  window.broadcastChannel.onmessage = async (e) => {
    const msg = e.data;
    if (msg.type === 'EVENT_ADDED') {
      // Only do a full replay if the event isn't already in our cache
      const alreadyHave = ProjectionManager._eventsCache?.some(ev => ev.id === msg.eventId);
      if (!alreadyHave) {
        ProjectionManager.invalidateCache();
        await ProjectionManager.runProjections(true);
      }
    } else if (msg.type === 'PRESENCE_UPDATE') {
      receivePresence(msg.presence);
    }
  };
}

// --- TOAST NOTIFICATIONS ---
function showToast(msg) {
  const toast = document.getElementById('success-toast');
  toast.innerText = msg;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// --- COMMAND PALETTE (CTRL+K) ---
function handleGlobalShortcut(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;

  const tag = e.target.tagName;
  const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  const paletteOpen = document.getElementById('command-palette-overlay').classList.contains('show');

  if (e.key.toLowerCase() === 'k') {
    e.preventDefault();
    toggleCommandPalette(!paletteOpen);
    return;
  }

  if (inField && !paletteOpen) return;

  const key = e.key.toLowerCase();
  if (key === 'r') {
    e.preventDefault();
    switchView('rooms', document.getElementById('nav-rooms'));
  } else if (key === 'f' && state.deviceRole !== 'staff') {
    e.preventDefault();
    switchView('revenue', document.getElementById('nav-revenue'));
  } else if (key === 'n' && state.deviceRole !== 'staff') {
    e.preventDefault();
    switchView('time-machine', document.getElementById('nav-timemachine'));
  } else if (key === 'a' && state.deviceRole !== 'staff') {
    e.preventDefault();
    switchView('settings', document.getElementById('nav-settings'));
    renderSettingsSubtab('stab-audit');
  } else if (key === 'l') {
    e.preventDefault();
    lockApplication();
  } else if ((key === '=' || key === '+') && e.shiftKey) {
    e.preventDefault();
    openNewSessionDialog();
  }
}

function setupCommandPalette() {
  window.addEventListener('keydown', handleGlobalShortcut);

  const search = document.getElementById('palette-search');
  search.addEventListener('input', (e) => {
    filterPaletteResults(e.target.value);
  });

  // Close palette on Esc
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      toggleCommandPalette(false);
    }
  });

  // Click outside to close
  document.getElementById('command-palette-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'command-palette-overlay') {
      toggleCommandPalette(false);
    }
  });
}

function toggleCommandPalette(show) {
  const overlay = document.getElementById('command-palette-overlay');
  const search = document.getElementById('palette-search');
  
  if (show) {
    overlay.classList.add('show');
    search.value = '';
    filterPaletteResults('');
    search.focus();
  } else {
    overlay.classList.remove('show');
  }
}

function filterPaletteResults(query) {
  const list = document.getElementById('palette-results');
  list.innerHTML = '';
  
  const actions = [
    { name: 'Rooms Board',       shortcut: '⌘R', act: () => switchView('rooms',        document.getElementById('nav-rooms')) },
    { name: 'Financial Revenue', shortcut: '⌘F', act: () => switchView('revenue',      document.getElementById('nav-revenue')) },
    { name: 'History Replay',    shortcut: '⌘N', act: () => switchView('time-machine', document.getElementById('nav-timemachine')) },
    { name: 'Audit Corrections', shortcut: '⌘A', act: () => { switchView('settings', document.getElementById('nav-settings')); renderSettingsSubtab('stab-audit'); } },
    { name: 'Lock Application',  shortcut: '⌘L', act: () => lockApplication() },
    // New Session — opens a room picker to start a check-in
    { name: 'New Session / Check In', shortcut: '⌘+', act: () => openNewSessionDialog() },
  ];

  // Append rooms actions dynamically if occupied
  const rooms = ProjectionManager.cachedRooms;
  for (const rNum in rooms) {
    if (rooms[rNum].status !== 'Vacant') {
      actions.push({
        name: `Inspect Room ${rNum} (${rooms[rNum].guest_name})`,
        shortcut: `Room ${rNum}`,
        act: () => {
          switchView('rooms', document.getElementById('nav-rooms'));
          openRoomDetailPanel(rNum);
        }
      });
      actions.push({
        name: `Checkout Room ${rNum}`,
        shortcut: `Out ${rNum}`,
        act: () => {
          openRoomDetailPanel(rNum);
          previewBill();
        }
      });
    }
  }

  const filtered = actions.filter(a => a.name.toLowerCase().includes(query.toLowerCase()));

  filtered.forEach(action => {
    const item = document.createElement('div');
    item.className = 'palette-item';
    item.innerHTML = `
      <span>${action.name}</span>
      <span class="palette-item-shortcut">${action.shortcut}</span>
    `;
    item.addEventListener('click', () => {
      action.act();
      toggleCommandPalette(false);
    });
    list.appendChild(item);
  });
}
