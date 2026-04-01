# 🕳️ PotholeNet

**Community pothole detection and city reporting app**

A Progressive Web App (PWA) that uses your phone's accelerometer, GPS, and camera to automatically detect and report potholes to city authorities.

[![Live Demo](https://img.shields.io/badge/Live-potholes.vercel.app-orange?style=for-the-badge)](https://potholes.vercel.app)

---

## Features

### 🚗 Auto-Detection
- Uses `DeviceMotionEvent` to monitor Z-axis acceleration in real-time
- Detects jolts > 2.5g (configurable) as pothole events
- 3-second debounce to prevent duplicate detections
- Live G-force meter with color-coded severity bar

### 📍 GPS Tracking
- Continuous position tracking via `navigator.geolocation.watchPosition()`
- Captures lat/lng + accuracy for each detection
- Real-time speed display (km/h)

### 📸 Photo Verification
- Post-detection prompt to snap a verification photo
- Camera opens directly via `capture="environment"`
- Photos stored as base64 in localStorage
- +25 trust score boost for photo-verified reports

### 🗺️ Pothole Map
- Interactive Leaflet.js map (free, no API key)
- Color-coded markers: 🔴 Low / 🟡 Medium / 🟢 High confidence
- Dark CartoDB tile layer to match app theme
- Tap any marker for details

### ⚠️ Approach Alerts
- Checks GPS position every 2 seconds against known potholes
- Vibrates + shows warning banner when within 150m (configurable)
- Direction-aware: only alerts if heading toward the pothole (bearing check)

### 📊 Trust Score System
| Factor | Score |
|--------|-------|
| Accelerometer detected | +25 |
| Photo attached | +25 |
| Verified profile reporter | +20 |
| 3+ reports within 50m | +30 |

Displayed as: 🔴 Low (<40) · 🟡 Medium (40-70) · 🟢 High (70+)

### 🏙️ City Report Generator
One-tap generates a formatted report with:
- Address + GPS coordinates
- Timestamp + confidence score
- Reporter info + photo status
- Copy to clipboard + Web Share API
- Links to 311.gov, SeeClickFix, FixMyStreet

### 🚗 Tesla Easter Egg
- "Tesla Mode" toggle in Settings
- Tesla-themed alerts: *"🚗 Autopilot Advisory: Pothole detected ahead"*
- "Connect Tesla" button (UI only — real Fleet API requires OAuth)

### 👤 Profile / Verification
- Name + email stored in localStorage
- "Verified Reporter" badge on reports
- +20 trust score on all reports when verified

---

## Tech Stack

| Technology | Purpose |
|------------|---------|
| Vanilla HTML/CSS/JS | Zero-dependency frontend |
| Leaflet.js 1.9.4 | Interactive map |
| Nominatim (OpenStreetMap) | Free reverse geocoding |
| localStorage | Client-side persistence |
| DeviceMotionEvent API | Accelerometer access |
| Geolocation API | GPS tracking |
| Web Share API | Native share sheet |
| PWA Manifest | Install to home screen |

---

## App Screens

1. **Home** — Stats dashboard + START DRIVING button
2. **Drive Mode** — Full-screen G-force meter, speed, live pothole log
3. **Map View** — Leaflet map with all detected potholes
4. **My Reports** — List view with photos + tap to detail
5. **Report Detail** — Full info + city report generator + share
6. **Settings** — Profile, sensitivity, Tesla mode, data management

---

## Getting Started

### Install as PWA (recommended)
1. Open https://potholes.vercel.app in Safari (iOS) or Chrome (Android)
2. Tap Share → **Add to Home Screen**
3. Launch from your home screen for full-screen experience

### Local Development
```bash
git clone https://github.com/Pjavier23/potholes.git
cd potholes
# Open index.html in a browser (or serve with any static server)
npx serve .
```

---

## Privacy

- All data is stored **locally on your device** in localStorage
- No backend, no server, no data collection
- GPS and motion data never leaves your device
- Photos stored as base64 in localStorage only

---

## Contributing

PRs welcome! Ideas for improvement:
- [ ] IndexedDB for larger photo storage
- [ ] Offline sync queue for reporting
- [ ] Actual Tesla Fleet API OAuth integration
- [ ] Backend for community pothole database
- [ ] Machine learning pothole classification
- [ ] Integration with city 311 APIs

---

## License

MIT License — Use it, improve it, fix your city's roads 🛣️

---

*Built with 🧡 for safer roads everywhere*
