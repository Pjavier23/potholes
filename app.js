/* ==========================================================
   PotholeNet - app.js
   Community pothole detection and city reporting PWA
   ========================================================== */

'use strict';

// ============================================================
// CONSTANTS & CONFIG
// ============================================================
const APP_VERSION = '1.0.0';
const STORAGE_KEY = 'potholes_v1';
const PROFILE_KEY = 'potholes_profile_v1';
const SETTINGS_KEY = 'potholes_settings_v1';

const DEFAULT_SETTINGS = {
  sensitivity: 1.5,     // G-force threshold (lowered for better detection)
  alertDistance: 150,   // meters
  teslaMode: false,
};

const SCORE = {
  BASE: 25,
  PHOTO: 25,
  VERIFIED: 20,
  CLUSTER: 30,
};

const CLUSTER_RADIUS = 50; // meters for "same pothole" detection

// ============================================================
// STATE
// ============================================================
let potholes = [];
let profile = { name: '', email: '', verified: false };
let settings = { ...DEFAULT_SETTINGS };
let map = null;
let mapMarkers = {};
let currentLocation = null;
let currentSpeed = 0;
let currentHeading = null;
let currentGForce = 0;
let driving = false;
let lastDetectionTime = 0;
let sessionCount = 0;
let currentPendingPothole = null;
let approachAlertCooldown = {};
let geoWatchId = null;
let approachCheckInterval = null;
let permissionGranted = { motion: false, geo: false };

// ============================================================
// DATA PERSISTENCE
// ============================================================
function saveData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(potholes));
  } catch(e) {
    showToast('Storage full — old photos may not save', 'error');
  }
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    potholes = raw ? JSON.parse(raw) : [];
  } catch {
    potholes = [];
  }
  try {
    const p = localStorage.getItem(PROFILE_KEY);
    if (p) profile = { ...profile, ...JSON.parse(p) };
  } catch {}
  try {
    const s = localStorage.getItem(SETTINGS_KEY);
    if (s) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(s) };
  } catch {}
}

function saveProfile() {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// ============================================================
// NAVIGATION
// ============================================================
const screens = ['home','drive','map','reports','settings'];
let activeScreen = 'home';

function showScreen(name) {
  // Don't allow going to drive screen via nav when not driving
  if (name === 'drive' && !driving) {
    showToast('Press START DRIVING first', 'info');
    return;
  }

  screens.forEach(s => {
    document.getElementById('screen-' + s).classList.remove('active');
  });
  document.getElementById('screen-detail').classList.remove('active');

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.screen === name);
  });

  const el = document.getElementById('screen-' + name);
  if (el) el.classList.add('active');
  activeScreen = name;

  if (name === 'map') {
    initMap();
    refreshMapMarkers();
    // Fix blank map on mobile - invalidate after render
    setTimeout(() => { if (map) { map.invalidateSize(true); } }, 200);
    setTimeout(() => { if (map) { map.invalidateSize(true); } }, 600);
  }
  if (name === 'reports') renderReportsList();
  if (name === 'settings') renderSettings();
  if (name === 'home') updateHomeStats();
}

function showDetail(pothole) {
  renderDetail(pothole);
  document.getElementById('screen-detail').classList.add('active');
}

function hideDetail() {
  document.getElementById('screen-detail').classList.remove('active');
}

// ============================================================
// TOAST
// ============================================================
function showToast(msg, type = 'info', icon = '') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = (icon ? `<span>${icon}</span>` : '') + `<span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

// ============================================================
// VIBRATION
// ============================================================
function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

// ============================================================
// GEO-UTILS
// ============================================================
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function bearing(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function bearingDiff(a, b) {
  let diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

// ============================================================
// REVERSE GEOCODE
// ============================================================
const geocodeCache = {};

async function reverseGeocode(lat, lng) {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (geocodeCache[key]) return geocodeCache[key];
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
      { headers: { 'Accept-Language': 'en' } }
    );
    const data = await res.json();
    const addr = data.address;
    const parts = [
      addr.road || addr.pedestrian || addr.cycleway || '',
      addr.suburb || addr.neighbourhood || '',
      addr.city || addr.town || addr.village || '',
    ].filter(Boolean);
    const result = parts.join(', ') || data.display_name || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    geocodeCache[key] = result;
    return result;
  } catch {
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }
}

// ============================================================
// TRUST SCORE
// ============================================================
function calcScore(pothole) {
  let score = SCORE.BASE;
  if (pothole.photo) score += SCORE.PHOTO;
  if (pothole.verified) score += SCORE.VERIFIED;

  // Cluster: count other potholes within CLUSTER_RADIUS
  const nearby = potholes.filter(p =>
    p.id !== pothole.id &&
    p.lat && p.lng && pothole.lat && pothole.lng &&
    haversine(pothole.lat, pothole.lng, p.lat, p.lng) <= CLUSTER_RADIUS
  );
  if (nearby.length >= 2) score += SCORE.CLUSTER;

  return Math.min(100, score);
}

function scoreColor(score) {
  if (score >= 70) return 'var(--green)';
  if (score >= 40) return 'var(--yellow)';
  return 'var(--red)';
}

function scoreEmoji(score) {
  if (score >= 70) return '🟢';
  if (score >= 40) return '🟡';
  return '🔴';
}

function scoreClass(score) {
  if (score >= 70) return 'score-high';
  if (score >= 40) return 'score-med';
  return 'score-low';
}

// ============================================================
// ACCELEROMETER
// ============================================================
function setupMotion() {
  if (typeof DeviceMotionEvent === 'undefined') {
    showToast('Motion sensor not available on this device', 'error');
    permissionGranted.motion = true; // treat as granted to not block
    return;
  }

  // iOS 13+ requires permission
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    DeviceMotionEvent.requestPermission()
      .then(state => {
        if (state === 'granted') {
          permissionGranted.motion = true;
          window.addEventListener('devicemotion', handleMotion);
        } else {
          showToast('Motion permission denied', 'error');
        }
      })
      .catch(() => showToast('Motion permission error', 'error'));
  } else {
    permissionGranted.motion = true;
    window.addEventListener('devicemotion', handleMotion);
  }
}

function teardownMotion() {
  window.removeEventListener('devicemotion', handleMotion);
}

let motionBuffer = [];

function handleMotion(event) {
  if (!driving) return;

  const acc = event.accelerationIncludingGravity;
  if (!acc) return;

  const z = Math.abs(acc.z || 0);
  const gForce = z / 9.81;

  // Smooth with a small buffer
  motionBuffer.push(gForce);
  if (motionBuffer.length > 2) motionBuffer.shift(); // smaller buffer = faster response
  const smoothed = motionBuffer.reduce((a,b) => a+b, 0) / motionBuffer.length;

  currentGForce = smoothed;
  updateGForceMeter(smoothed);

  const now = Date.now();
  if (smoothed > settings.sensitivity && (now - lastDetectionTime) > 3000) {
    lastDetectionTime = now;
    onPotholeDetected();
  }
}

function updateGForceMeter(g) {
  const el = document.getElementById('gforce-value');
  const bar = document.getElementById('gforce-bar');
  if (!el || !bar) return;

  el.textContent = g.toFixed(2) + 'g';
  el.className = '';
  if (g > settings.sensitivity) el.classList.add('danger');
  else if (g > settings.sensitivity * 0.7) el.classList.add('warning');

  const pct = Math.min(100, (g / 3) * 100);
  bar.style.width = pct + '%';
}

// ============================================================
// POTHOLE DETECTION
// ============================================================
async function onPotholeDetected() {
  vibrate([200, 50, 200]);

  const pothole = {
    id: Date.now() + '_' + Math.random().toString(36).substr(2,5),
    timestamp: new Date().toISOString(),
    lat: currentLocation?.lat || null,
    lng: currentLocation?.lng || null,
    accuracy: currentLocation?.accuracy || null,
    speed: currentSpeed,
    gForce: currentGForce,
    photo: null,
    address: null,
    verified: profile.verified,
    reporterName: profile.name || 'Anonymous',
  };

  pothole.score = calcScore(pothole);
  potholes.push(pothole);
  saveData();

  sessionCount++;
  document.getElementById('drive-count').textContent = sessionCount;
  document.getElementById('session-count').textContent = sessionCount + ' pothole' + (sessionCount !== 1 ? 's' : '');

  // Show alert banner
  showPotholeAlert(pothole);

  // Add to live list
  addToLiveList(pothole);

  // Reverse geocode in background
  if (pothole.lat && pothole.lng) {
    reverseGeocode(pothole.lat, pothole.lng).then(addr => {
      pothole.address = addr;
      saveData();
    });
  }

  // Store reference for photo
  currentPendingPothole = pothole;

  updateHomeStats();
}

function showPotholeAlert(pothole) {
  const alertEl = document.getElementById('pothole-alert');
  const titleEl = document.getElementById('alert-title');
  const subtitleEl = document.getElementById('alert-subtitle');
  const iconEl = document.getElementById('alert-icon');

  if (settings.teslaMode) {
    alertEl.classList.add('tesla-mode');
    iconEl.textContent = '🚗';
    titleEl.textContent = 'Autopilot Advisory';
    subtitleEl.textContent = 'Pothole detected — road anomaly logged';
  } else {
    alertEl.classList.remove('tesla-mode');
    iconEl.textContent = '🕳️';
    titleEl.textContent = 'Pothole Detected!';
    subtitleEl.textContent = pothole.lat
      ? `${pothole.lat.toFixed(5)}, ${pothole.lng.toFixed(5)}`
      : 'GPS location pending...';
  }

  alertEl.classList.add('show');
  setTimeout(() => alertEl.classList.remove('show'), 8000);
}

function addToLiveList(pothole) {
  const list = document.getElementById('live-pothole-list');
  const empty = document.getElementById('live-empty');
  if (empty) empty.style.display = 'none';

  const item = document.createElement('div');
  item.className = 'live-pothole-item';
  const score = calcScore(pothole);
  item.innerHTML = `
    <span class="lp-icon">${scoreEmoji(score)}</span>
    <div class="lp-info">
      <div style="font-size:13px;font-weight:700;">Pothole #${sessionCount}</div>
      <div class="lp-time">${new Date(pothole.timestamp).toLocaleTimeString()}</div>
      ${pothole.lat ? `<div style="font-size:11px;color:var(--text2)">${pothole.lat.toFixed(4)}, ${pothole.lng.toFixed(4)}</div>` : ''}
    </div>
    <span class="lp-score score-badge ${scoreClass(score)}">${score}%</span>
  `;
  list.insertBefore(item, list.firstChild);
}

// ============================================================
// GPS
// ============================================================
function startGPS() {
  if (!navigator.geolocation) {
    showToast('GPS not available', 'error');
    return;
  }

  geoWatchId = navigator.geolocation.watchPosition(
    pos => {
      currentLocation = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: Math.round(pos.coords.accuracy),
      };
      currentSpeed = pos.coords.speed != null ? Math.round(pos.coords.speed * 2.237) : 0; // m/s to mph
      currentHeading = pos.coords.heading;

      const speedEl = document.getElementById('drive-speed');
      const accEl = document.getElementById('drive-accuracy');
      if (speedEl) speedEl.textContent = currentSpeed;
      if (accEl) accEl.textContent = currentLocation.accuracy;

      permissionGranted.geo = true;
    },
    err => {
      console.warn('GPS error', err);
      if (err.code === 1) showToast('Location permission denied', 'error');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 }
  );

  // Approach check every 2 seconds
  approachCheckInterval = setInterval(checkApproach, 2000);
}

function stopGPS() {
  if (geoWatchId != null) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }
  if (approachCheckInterval) {
    clearInterval(approachCheckInterval);
    approachCheckInterval = null;
  }
}

// ============================================================
// APPROACH ALERTS
// ============================================================
function checkApproach() {
  if (!currentLocation || !driving) return;
  const now = Date.now();

  for (const p of potholes) {
    if (!p.lat || !p.lng) continue;

    const dist = haversine(currentLocation.lat, currentLocation.lng, p.lat, p.lng);
    const alertDist = parseInt(settings.alertDistance);

    if (dist > alertDist) continue;

    // Direction check — only alert if heading toward the pothole
    if (currentHeading != null) {
      const bear = bearing(currentLocation.lat, currentLocation.lng, p.lat, p.lng);
      if (bearingDiff(currentHeading, bear) > 60) continue; // going away
    }

    // Cooldown: 30 seconds per pothole
    if (approachAlertCooldown[p.id] && now - approachAlertCooldown[p.id] < 30000) continue;
    approachAlertCooldown[p.id] = now;

    showApproachAlert(Math.round(dist), p);
    break;
  }
}

function showApproachAlert(distanceM, pothole) {
  vibrate([100, 50, 100]);

  const alertEl = document.getElementById('approach-alert');
  const textEl = document.getElementById('approach-text');

  if (settings.teslaMode) {
    textEl.textContent = `🚗 Autopilot Advisory: Pothole detected ahead in ${distanceM}m`;
  } else {
    textEl.textContent = `⚠️ Pothole ahead in ${distanceM}m — Confidence: ${pothole.score || 25}%`;
  }

  alertEl.classList.add('show');
  setTimeout(() => alertEl.classList.remove('show'), 8000);
}

// ============================================================
// DRIVE MODE START/STOP
// ============================================================
async function startDriving() {
  // Request iOS motion permission
  if (typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const state = await DeviceMotionEvent.requestPermission();
      if (state !== 'granted') {
        showToast('Motion sensor permission required', 'error');
        return;
      }
    } catch {
      showToast('Could not request motion permission', 'error');
      return;
    }
  }

  driving = true;
  sessionCount = 0;
  motionBuffer = [];
  document.getElementById('live-pothole-list').innerHTML = '';
  document.getElementById('live-empty').style.display = '';
  document.getElementById('drive-count').textContent = '0';
  document.getElementById('session-count').textContent = '0 potholes';
  // Add quick report button if not already there
  const driveScreen = document.getElementById('screen-drive');
  if (driveScreen && !document.getElementById('quickReportBtn')) {
    const btn = document.createElement('button');
    btn.id = 'quickReportBtn';
    btn.innerHTML = '🕳️ Report Pothole';
    btn.style.cssText = 'position:fixed;bottom:200px;left:50%;transform:translateX(-50%);background:#f97316;color:#000;border:none;border-radius:999px;padding:14px 28px;font-size:16px;font-weight:900;z-index:100;box-shadow:0 4px 20px rgba(249,115,22,0.5);cursor:pointer;opacity:0.85;';
    btn.onclick = () => onPotholeDetected();
    driveScreen.appendChild(btn);
  }
  document.getElementById('drive-speed').textContent = '--';
  document.getElementById('drive-accuracy').textContent = '--';
  updateGForceMeter(0);

  setupMotion();
  
  // Proactively request GPS permission before starting
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        currentLocation = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
        };
        showToast('📍 GPS locked!', 'success');
        startGPS();
      },
      err => {
        if (err.code === 1) {
          showToast('⚠️ Location denied — enable in browser settings', 'error');
        } else {
          showToast('📍 Acquiring GPS...', 'info');
          startGPS();
        }
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  } else {
    showToast('GPS not supported on this device', 'error');
  }

  // Force to drive screen
  activeScreen = 'drive';
  screens.forEach(s => document.getElementById('screen-' + s).classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.screen === 'drive'));
  document.getElementById('screen-drive').classList.add('active');

  showToast('Drive mode active — monitoring started', 'success', '🚗');
}

function stopDriving() {
  driving = false;
  teardownMotion();
  stopGPS();
  currentGForce = 0;
  updateGForceMeter(0);

  const count = sessionCount;
  showScreen('home');
  showToast(`Session ended — ${count} pothole${count !== 1 ? 's' : ''} detected`, 'success', '🏁');
  updateHomeStats();
}

// ============================================================
// PHOTO CAPTURE
// ============================================================
function showPhotoOverlay() {
  document.getElementById('photo-overlay').classList.add('show');
  document.getElementById('photo-preview').style.display = 'none';
}

function hidePhotoOverlay() {
  document.getElementById('photo-overlay').classList.remove('show');
  document.getElementById('photo-preview').style.display = 'none';
  currentPendingPothole = null;
}

function setupPhotoHandlers() {
  document.getElementById('btn-photo-prompt').addEventListener('click', showPhotoOverlay);
  document.getElementById('btn-take-photo').addEventListener('click', () => {
    document.getElementById('camera-input').click();
  });
  document.getElementById('btn-skip-photo').addEventListener('click', hidePhotoOverlay);

  document.getElementById('camera-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const base64 = ev.target.result;
      document.getElementById('photo-preview').src = base64;
      document.getElementById('photo-preview').style.display = 'block';

      // Attach to pending pothole
      if (currentPendingPothole) {
        currentPendingPothole.photo = base64;
        currentPendingPothole.score = calcScore(currentPendingPothole);
        saveData();
        showToast('+25 trust score! Photo verified 📸', 'success');

        // Refresh live list item
        updateHomeStats();
      }
    };
    reader.readAsDataURL(file);
  });
}

// ============================================================
// MAP
// ============================================================
let mapInitialized = false;

function initMap() {
  if (mapInitialized) return;
  mapInitialized = true;

  // Center on current location or default to NYC
  const lat = currentLocation?.lat || 40.7128;
  const lng = currentLocation?.lng || -74.0060;

  map = L.map('leaflet-map', {
    center: [lat, lng],
    zoom: 14,
    zoomControl: true,
  });

  // Try CartoDB dark first, fallback to OSM
  const darkTile = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© CartoDB © OpenStreetMap',
    maxZoom: 19,
    errorTileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  });
  const osmTile = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  });
  darkTile.addTo(map);
  darkTile.on('tileerror', () => { map.removeLayer(darkTile); osmTile.addTo(map); });
}

function potholeIcon(score) {
  const color = score >= 70 ? '#22c55e' : score >= 40 ? '#eab308' : '#ef4444';
  return L.divIcon({
    className: '',
    html: `<div style="width:18px;height:18px;background:${color};border:2px solid rgba(255,255,255,0.7);border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.5);"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function refreshMapMarkers() {
  if (!map) return;

  // Remove old markers
  Object.values(mapMarkers).forEach(m => map.removeLayer(m));
  mapMarkers = {};

  potholes.forEach(p => {
    if (!p.lat || !p.lng) return;
    const score = p.score || calcScore(p);
    const marker = L.marker([p.lat, p.lng], { icon: potholeIcon(score) });

    const popupHtml = `
      <div style="font-family:system-ui;min-width:200px;color:#333;">
        <b>${scoreEmoji(score)} Pothole — ${score}% confidence</b><br>
        📍 ${p.address || (p.lat ? p.lat.toFixed(5)+', '+p.lng.toFixed(5) : 'Unknown')}<br>
        🕐 ${new Date(p.timestamp).toLocaleString()}<br>
        💨 ${p.speed || 0} mph &nbsp;|&nbsp; ⚡ ${p.gForce ? p.gForce.toFixed(2)+'g' : 'N/A'}<br>
        📸 ${p.photo ? '<span style=color:green>Photo attached ✓</span>' : 'No photo'}<br>
        <div style="margin-top:8px;display:flex;gap:8px;">
          <button onclick="deletePothole('${p.id}')" style="background:#ef4444;color:#fff;border:none;border-radius:6px;padding:6px 12px;cursor:pointer;font-weight:700;">🗑️ Delete</button>
          <button onclick="reportPotholeToCity('${p.id}')" style="background:#f97316;color:#000;border:none;border-radius:6px;padding:6px 12px;cursor:pointer;font-weight:700;">📤 Report</button>
        </div>
        ${p.photo ? '<img src="'+p.photo+'" style="width:100%;margin-top:8px;border-radius:6px;" />' : ''}
      </div>
    `;
    marker.bindPopup(popupHtml, { maxWidth: 280 });

    marker.addTo(map);
    mapMarkers[p.id] = marker;
  });

  document.getElementById('map-total').textContent = potholes.length;
  // Force map to recalculate size (fixes blank map on mobile)
  setTimeout(() => { if (map) map.invalidateSize(); }, 100);

  // Fit to markers if any
  if (potholes.length > 0) {
    const lats = potholes.filter(p=>p.lat).map(p=>p.lat);
    const lngs = potholes.filter(p=>p.lng).map(p=>p.lng);
    if (lats.length) {
      const bounds = L.latLngBounds(
        potholes.filter(p=>p.lat).map(p=>[p.lat,p.lng])
      );
      map.fitBounds(bounds, { padding: [40, 40] });
    }
  } else if (currentLocation) {
    map.setView([currentLocation.lat, currentLocation.lng], 14);
  }
}

// ============================================================
// REPORTS LIST
// ============================================================
function renderReportsList() {
  const list = document.getElementById('reports-list');
  const badge = document.getElementById('reports-badge');
  badge.textContent = potholes.length;

  if (potholes.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="es-icon">🕳️</div>
        <h3>No Reports Yet</h3>
        <p>Start driving to automatically detect potholes</p>
      </div>
    `;
    return;
  }

  const sorted = [...potholes].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  list.innerHTML = sorted.map(p => {
    const score = p.score || calcScore(p);
    const time = new Date(p.timestamp);
    const timeStr = time.toLocaleDateString() + ' · ' + time.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    const addr = p.address || (p.lat ? `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}` : 'Unknown location');

    return `
      <div class="report-card" onclick="showDetail(potholes.find(x=>x.id==='${p.id}'))">
        <div class="report-card-header">
          ${p.photo
            ? `<img class="report-thumb" src="${p.photo}" alt="Pothole photo" loading="lazy" />`
            : `<div class="report-thumb-placeholder">🕳️</div>`
          }
          <div class="report-info">
            <h4>${addr}</h4>
            <div class="ri-time">${timeStr}</div>
            ${p.lat ? `<div class="ri-coords">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div>` : ''}
          </div>
          <span class="score-badge ${scoreClass(score)}">${scoreEmoji(score)} ${score}%</span>
        </div>
      </div>
    `;
  }).join('');
}

// ============================================================
// REPORT DETAIL
// ============================================================
function renderDetail(pothole) {
  const score = pothole.score || calcScore(pothole);
  const time = new Date(pothole.timestamp);
  const addr = pothole.address || (pothole.lat ? `${pothole.lat.toFixed(5)}, ${pothole.lng.toFixed(5)}` : 'Unknown');

  // Photo
  const photoEl = document.getElementById('detail-photo');
  const photoPlaceholder = document.getElementById('detail-photo-placeholder');
  if (pothole.photo) {
    photoEl.src = pothole.photo;
    photoEl.style.display = 'block';
    photoPlaceholder.style.display = 'none';
  } else {
    photoEl.style.display = 'none';
    photoPlaceholder.style.display = 'flex';
  }

  document.getElementById('detail-address').textContent = addr;
  document.getElementById('detail-gps').textContent = pothole.lat
    ? `${pothole.lat.toFixed(6)}, ${pothole.lng.toFixed(6)}`
    : 'Not available';
  document.getElementById('detail-time').textContent = time.toLocaleString();
  document.getElementById('detail-score').innerHTML = `
    <span style="color:${scoreColor(score)};font-weight:900;">${score}%</span>
    <span style="color:var(--text2);font-size:12px;margin-left:6px;">${scoreEmoji(score)} ${score >= 70 ? 'High confidence' : score >= 40 ? 'Medium confidence' : 'Low confidence'}</span>
  `;
  document.getElementById('detail-photo-status').textContent = pothole.photo ? '✅ Attached' : 'Not attached';
  document.getElementById('detail-reporter').innerHTML = pothole.verified
    ? `${pothole.reporterName || 'Anonymous'} <span class="verified-badge">✓ Verified</span>`
    : (pothole.reporterName || 'Anonymous');

  // Report text
  const reportText = generateReportText(pothole);
  document.getElementById('detail-report-text').textContent = reportText;

  // Copy button
  document.getElementById('btn-copy-report').onclick = () => {
    navigator.clipboard.writeText(reportText).then(() => {
      showToast('Report copied to clipboard!', 'success', '📋');
    }).catch(() => {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = reportText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      showToast('Report copied!', 'success', '📋');
    });
  };

  // Share button
  document.getElementById('btn-share-report').onclick = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'PotholeNet Report',
          text: reportText,
        });
      } catch {}
    } else {
      navigator.clipboard.writeText(reportText).then(() =>
        showToast('Report copied (no share API)', 'info')
      );
    }
  };
}

function generateReportText(pothole) {
  const time = new Date(pothole.timestamp);
  const addr = pothole.address || (pothole.lat ? `${pothole.lat.toFixed(6)}, ${pothole.lng.toFixed(6)}` : 'Unknown');
  const score = pothole.score || calcScore(pothole);
  return [
    'POTHOLE REPORT',
    '══════════════════════════════',
    `Location:    ${addr}`,
    `GPS:         ${pothole.lat ? `${pothole.lat.toFixed(6)}, ${pothole.lng.toFixed(6)}` : 'N/A'}`,
    `Date/Time:   ${time.toLocaleString()}`,
    `Confidence:  ${score}% ${scoreEmoji(score)}`,
    `Photo:       ${pothole.photo ? 'Attached' : 'Not attached'}`,
    `G-Force:     ${(pothole.gForce || 0).toFixed(2)}g`,
    `Reporter:    ${pothole.reporterName || 'Anonymous'}${pothole.verified ? ' ✓ Verified' : ''}`,
    '──────────────────────────────',
    'Reported via: PotholeNet',
    'https://potholes.vercel.app',
  ].join('\n');
}

// ============================================================
// HOME STATS
// ============================================================
function updateHomeStats() {
  const today = new Date().toDateString();
  const todayCount = potholes.filter(p => new Date(p.timestamp).toDateString() === today).length;
  const withPhoto = potholes.filter(p => p.photo).length;
  const scores = potholes.map(p => p.score || calcScore(p));
  const avg = scores.length ? Math.round(scores.reduce((a,b)=>a+b,0) / scores.length) : null;

  document.getElementById('stat-today').textContent = todayCount;
  document.getElementById('stat-total').textContent = potholes.length;
  document.getElementById('stat-verified').textContent = withPhoto;
  document.getElementById('stat-score').textContent = avg != null ? avg + '%' : '-';
}

// ============================================================
// SETTINGS
// ============================================================
function renderSettings() {
  document.getElementById('profile-name').value = profile.name || '';
  document.getElementById('profile-email').value = profile.email || '';

  const statusLabel = document.getElementById('profile-status-label');
  if (profile.name && profile.email) {
    statusLabel.innerHTML = `<span class="verified-badge">✓ Verified Reporter</span>`;
  } else {
    statusLabel.textContent = 'Fill in your profile to become a verified reporter';
  }

  const slider = document.getElementById('sensitivity-slider');
  slider.value = settings.sensitivity;
  document.getElementById('sensitivity-val').textContent = settings.sensitivity.toFixed(1) + 'g';
  slider.style.setProperty('--val', ((settings.sensitivity - 1) / 4 * 100) + '%');

  document.getElementById('alert-distance').value = settings.alertDistance;

  const teslaToggle = document.getElementById('tesla-toggle');
  teslaToggle.classList.toggle('on', settings.teslaMode);
  document.getElementById('tesla-banner').classList.toggle('show', settings.teslaMode);

  // Stats
  const withPhoto = potholes.filter(p => p.photo).length;
  const scores = potholes.map(p => p.score || calcScore(p));
  const avg = scores.length ? Math.round(scores.reduce((a,b)=>a+b,0) / scores.length) : null;
  document.getElementById('stats-total').textContent = potholes.length;
  document.getElementById('stats-photos').textContent = withPhoto;
  document.getElementById('stats-avg').textContent = avg != null ? avg + '%' : '-';
}

function setupSettingsHandlers() {
  document.getElementById('btn-save-profile').addEventListener('click', () => {
    profile.name = document.getElementById('profile-name').value.trim();
    profile.email = document.getElementById('profile-email').value.trim();
    profile.verified = !!(profile.name && profile.email);
    saveProfile();
    renderSettings();
    showToast(profile.verified ? '✓ Profile verified!' : 'Profile saved', 'success');
  });

  const slider = document.getElementById('sensitivity-slider');
  slider.addEventListener('input', () => {
    settings.sensitivity = parseFloat(slider.value);
    document.getElementById('sensitivity-val').textContent = settings.sensitivity.toFixed(1) + 'g';
    slider.style.setProperty('--val', ((settings.sensitivity - 1) / 4 * 100) + '%');
    saveSettings();
  });

  document.getElementById('alert-distance').addEventListener('change', (e) => {
    settings.alertDistance = parseInt(e.target.value);
    saveSettings();
  });

  document.getElementById('tesla-toggle').addEventListener('click', () => {
    settings.teslaMode = !settings.teslaMode;
    saveSettings();
    document.getElementById('tesla-toggle').classList.toggle('on', settings.teslaMode);
    document.getElementById('tesla-banner').classList.toggle('show', settings.teslaMode);
    showToast(settings.teslaMode ? '🚗 Tesla Mode enabled' : 'Tesla Mode disabled', 'info');
  });

  document.getElementById('btn-connect-tesla').addEventListener('click', () => {
    showToast('Tesla OAuth requires Fleet API setup — see Tesla developer docs', 'info', '🚗');
  });

  document.getElementById('btn-clear-data').addEventListener('click', () => {
    if (confirm('Delete all pothole data? This cannot be undone.')) {
      potholes = [];
      saveData();
      updateHomeStats();
      renderSettings();
      if (mapInitialized) refreshMapMarkers();
      showToast('All data cleared', 'success');
    }
  });
}

// ============================================================
// PWA / INSTALL PROMPT
// ============================================================
let deferredInstallPrompt = null;

function setupPWA() {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    document.getElementById('install-banner').classList.add('show');
  });

  // Show install banner on iOS (no beforeinstallprompt)
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isInStandalone = window.matchMedia('(display-mode: standalone)').matches;
  if (isIOS && !isInStandalone) {
    document.getElementById('install-banner').classList.add('show');
  }
}

// ============================================================
// NAVIGATION SETUP
// ============================================================
function setupNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showScreen(btn.dataset.screen));
  });

  document.getElementById('btn-start-driving').addEventListener('click', startDriving);
  document.getElementById('btn-stop-driving').addEventListener('click', stopDriving);
  document.getElementById('btn-back-detail').addEventListener('click', hideDetail);
}

// ============================================================
// DEMO DATA (first run)
// ============================================================
function injectDemoData() {
  if (potholes.length > 0) return;

  // Add a few demo potholes near a default location
  const demos = [
    { lat: 40.7128, lng: -74.0060, address: 'Broadway & Fulton St, New York', gForce: 3.1, photo: null },
    { lat: 40.7135, lng: -74.0072, address: 'Church St & Dey St, New York', gForce: 2.8, photo: null },
    { lat: 40.7115, lng: -74.0045, address: 'Wall St & William St, New York', gForce: 3.4, photo: null },
  ];

  const now = Date.now();
  demos.forEach((d, i) => {
    const p = {
      id: (now - i*1000) + '_demo' + i,
      timestamp: new Date(now - i * 3600000).toISOString(),
      lat: d.lat, lng: d.lng,
      accuracy: 5,
      speed: 30,
      gForce: d.gForce,
      photo: null,
      address: d.address,
      verified: false,
      reporterName: 'Demo Reporter',
    };
    p.score = calcScore(p);
    potholes.push(p);
  });
  saveData();
}

// ============================================================
// INIT
// ============================================================
function init() {
  loadData();
  injectDemoData();
  setupNav();
  setupPhotoHandlers();
  setupSettingsHandlers();
  setupPWA();
  updateHomeStats();

  // Load profile values into settings fields on startup
  if (activeScreen === 'settings') renderSettings();

  console.log(`🕳️ PotholeNet v${APP_VERSION} initialized — ${potholes.length} potholes in database`);
}

document.addEventListener('DOMContentLoaded', init);
