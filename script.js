// === ИНИЦИАЛИЗАЦИЯ КАРТЫ ===
const map = L.map("map").setView([55.75, 37.62], 4);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

// === ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ===
let airshipMarker = null;
let flagMarker = null;
let targetMarker = null;
let directionArrow = null;

const timeSteps = [0.1, 1, 2, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 1000];
let timeWarpFactor = 1;
let isPaused = false;

// === ТОПЛИВО (ДИЗЕЛЬ) ===
const MAX_FUEL_CAPACITY = 88000; // литров
const FUEL_CONSUMPTION_TABLE = [
  [10, 85, 63],
  [20, 170, 79],
  [30, 254, 90],
  [40, 339, 100],
  [50, 424, 107],
  [60, 508, 114],
  [70, 593, 120],
  [80, 678, 125],
  [90, 762, 130],
  [100, 847, 135],
];

// === МАСШТАБ ===
const ZOOM_SCALE_LEVELS = [2, 4, 6, 8, 9, 10, 11, 12];
let currentZoomScaleIndex = 7;

// === ФИЗИКА ===
const ENGINE_POWER_RATE = 1.0;
const MAX_TURN_RATE = 3;
const MIN_TURN_RATE = 0.3;
const PROPELLER_BASE_SCALE = 4.0;

// === ВЕТЕР ===
let windSpeedBf = 0;
let windDirection = 0;
let windMode = "auto";

// === ДАННЫЕ ДИРИЖАБЛЯ ===
let airshipData = {
  lat: 0,
  lng: 0,
  heading: 0,
  speed: 0,
  throttle: 0,
  rudder: 0,
  angularVelocity: 0,
  propRotationAngle: 0,
  flagEnabled: false,
  followEnabled: false,
  autopilotEnabled: false,
  fastBrakeEnabled: false,
  anchorEnabled: true,
  totalDistanceMeters: 0,
  fuelReserve: 100,
  totalFuelBurned: 0,
  hasTarget: false,
  targetLat: null,
  targetLng: null,
  enginePower: 0,
  groundSpeed: 0,
  windLastVirtualUpdate: 0,
  virtualTimeSeconds: 0,
  virtualStartDate: new Date(),
  lastSimulateTime: performance.now(),
  autopilotIsControlling: false, // ← ключевое поле для стабильности
};

// === ИКОНКИ ===
const flagIcon = L.divIcon({
  className: "",
  html: "🚩",
  iconSize: [20, 24],
  iconAnchor: [10, 24],
});

const targetIcon = L.divIcon({
  className: "",
  html: "🎯",
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===

function interpolateFuelAndSpeed(powerPercent) {
  if (powerPercent <= 0) return { fuelRate: 0, speed: 0 };
  if (powerPercent >= 100) return { fuelRate: 847, speed: 135 };
  for (let i = 0; i < FUEL_CONSUMPTION_TABLE.length; i++) {
    const [p, f, s] = FUEL_CONSUMPTION_TABLE[i];
    if (powerPercent <= p) {
      if (i === 0) return { fuelRate: f, speed: s };
      const [p0, f0, s0] = FUEL_CONSUMPTION_TABLE[i - 1];
      const t = (powerPercent - p0) / (p - p0);
      return {
        fuelRate: f0 + t * (f - f0),
        speed: s0 + t * (s - s0),
      };
    }
  }
  return { fuelRate: 847, speed: 135 };
}

function beaufortToMps(bf) {
  const scale = [
    0, 0.5, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7,
  ];
  return scale[Math.min(12, Math.max(0, Math.round(bf)))];
}

function calculatePropellerRPM() {
  if (Math.abs(airshipData.enginePower) < 0.1) return 0;
  return airshipData.enginePower * 16.5;
}

// === ГРАФИКА ===

function getAirshipSvg(zoom, heading, propRotationAngle) {
  if (zoom <= 8) {
    return `<svg viewBox="0 0 10 10" width="10" height="10">
              <circle cx="5" cy="5" r="4" fill="#ff3300" stroke="#000" stroke-width="1"/>
            </svg>`;
  }

  const metersPerPixel =
    (156543.03392 * Math.cos((airshipData.lat * Math.PI) / 180)) /
    Math.pow(2, zoom);
  const lengthPx = 500 / metersPerPixel;
  const widthPx = lengthPx * 0.22;

  const propSize = widthPx * 0.3;
  const centerY = lengthPx * 0.92;
  const offsetX = widthPx * 0.15;
  const leftPropX = widthPx / 2 - offsetX;
  const rightPropX = widthPx / 2 + offsetX;

  return `
    <svg viewBox="0 0 ${widthPx} ${lengthPx}" 
         width="${widthPx}" height="${lengthPx}"
         style="transform: rotate(${heading}deg); transform-origin: center;">
      <ellipse cx="${widthPx / 2}" cy="${lengthPx / 2}" 
               rx="${widthPx / 2}" ry="${lengthPx / 2}" 
               fill="#3a5ca0" stroke="#1a3a6a" stroke-width="1"/>
      <image href="https://cdn-icons-png.flaticon.com/512/166/166062.png"
             x="${leftPropX - propSize / 2}" y="${centerY - propSize / 2}"
             width="${propSize}" height="${propSize}"
             transform="rotate(${propRotationAngle} ${leftPropX} ${centerY})" />
      <image href="https://cdn-icons-png.flaticon.com/512/166/166062.png"
             x="${rightPropX - propSize / 2}" y="${centerY - propSize / 2}"
             width="${propSize}" height="${propSize}"
             transform="rotate(${-propRotationAngle} ${rightPropX} ${centerY})" />
    </svg>`;
}

function updateAirshipIcon() {
  if (!airshipMarker) return;
  const zoom = map.getZoom();
  const svgHtml = getAirshipSvg(
    zoom,
    airshipData.heading,
    airshipData.propRotationAngle,
  );
  const newIcon = L.divIcon({ className: "", html: svgHtml, iconSize: null });
  airshipMarker.setIcon(newIcon);
}

// === УПРАВЛЕНИЕ ===

function updateFlag() {
  const showFlag = document.getElementById("flagToggle").checked;
  if (showFlag && airshipMarker) {
    if (!flagMarker) {
      flagMarker = L.marker([airshipData.lat, airshipData.lng], {
        icon: flagIcon,
      }).addTo(map);
    } else {
      flagMarker.setLatLng([airshipData.lat, airshipData.lng]);
    }
  } else {
    if (flagMarker) {
      map.removeLayer(flagMarker);
      flagMarker = null;
    }
  }
}

function setTarget(lat, lng) {
  airshipData.hasTarget = true;
  airshipData.targetLat = lat;
  airshipData.targetLng = lng;
  if (targetMarker) map.removeLayer(targetMarker);
  targetMarker = L.marker([lat, lng], { icon: targetIcon }).addTo(map);
  document.getElementById("targetBtn").textContent = "Удалить маркер";
  document.getElementById("autopilotToggle").disabled = false;
  updateDirectionArrow();
}

function removeTarget() {
  airshipData.hasTarget = false;
  airshipData.targetLat = null;
  airshipData.targetLng = null;
  if (targetMarker) {
    map.removeLayer(targetMarker);
    targetMarker = null;
  }
  if (directionArrow) {
    map.removeLayer(directionArrow);
    directionArrow = null;
  }
  document.getElementById("targetBtn").textContent = "Добавить маркер";
  document.getElementById("autopilotToggle").checked = false;
  document.getElementById("autopilotToggle").disabled = true;
  airshipData.autopilotEnabled = false;
}

function updateDirectionArrow() {
  if (!airshipData.hasTarget || !airshipMarker) return;
  if (directionArrow) map.removeLayer(directionArrow);

  const R = 6378137;
  const lat1 = (airshipData.lat * Math.PI) / 180;
  const lon1 = (airshipData.lng * Math.PI) / 180;
  const lat2 = (airshipData.targetLat * Math.PI) / 180;
  const lon2 = (airshipData.targetLng * Math.PI) / 180;

  const dLon = lon2 - lon1;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const bearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;

  const dx = R * Math.cos(lat1) * Math.sin(dLon);
  const dy = R * (Math.sin(lat2) - Math.sin(lat1));
  const distance = Math.sqrt(dx * dx + dy * dy);

  let timeToTargetText = "~ ∞";
  if (Math.abs(airshipData.groundSpeed) > 5) {
    const speedMs = Math.abs(airshipData.groundSpeed) / 3.6;
    const seconds = distance / speedMs;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      timeToTargetText = `~ ${hours} ч. ${minutes} мин.`;
    } else {
      timeToTargetText = `~ ${minutes} мин.`;
    }
  }

  const arrowLength = 60;
  const arrowRad = ((bearing - 90) * Math.PI) / 180;
  const arrowEndX = arrowLength * Math.cos(arrowRad);
  const arrowEndY = arrowLength * Math.sin(arrowRad);

  const kmInt = Math.floor(distance / 1000);
  const kmText = kmInt.toString().padStart(4, "0") + " км";

  const size = 200;
  const centerX = size / 2;
  const centerY = size / 2;

  const arrowSvg = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="overflow:visible;">
      <line x1="${centerX}" y1="${centerY}" 
            x2="${centerX + arrowEndX}" y2="${centerY + arrowEndY}" 
            stroke="#000" stroke-width="3" marker-end="url(#arrowhead)"/>
      <defs>
        <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
          <polygon points="0 0, 10 3.5, 0 7" fill="#000"/>
        </marker>
      </defs>
      <rect x="${centerX + arrowEndX + 5}" y="${centerY + arrowEndY - 36}" 
            width="80" height="36" rx="5" ry="5" fill="#000" />
      <text x="${centerX + arrowEndX + 45}" y="${centerY + arrowEndY - 20}" 
            fill="#fff" font-size="12" text-anchor="middle" font-family="Arial">
        ${kmText}
      </text>
      <text x="${centerX + arrowEndX + 45}" y="${centerY + arrowEndY - 5}" 
            fill="#fff" font-size="11" text-anchor="middle" font-family="Arial">
        ${timeToTargetText}
      </text>
    </svg>`;

  const arrowIcon = L.divIcon({
    className: "",
    html: arrowSvg,
    iconSize: [size, size],
    iconAnchor: [centerX, centerY],
  });

  directionArrow = L.marker([airshipData.lat, airshipData.lng], {
    icon: arrowIcon,
  }).addTo(map);
}

function focusOnAirship(optimalZoom = 12) {
  if (airshipMarker) {
    map.setView([airshipData.lat, airshipData.lng], optimalZoom);
  }
}

// === ФОРМАТИРОВАНИЕ ===

function formatDistance(meters) {
  const km = Math.floor(meters / 1000);
  const m = Math.floor(meters % 1000);
  return `${km} км ${m} м`;
}

function formatFuel(liters) {
  return liters.toFixed(3);
}

function calculateFuelTimeRemaining() {
  if (airshipData.fuelReserve <= 0) return "00:00";
  const powerPercent = Math.abs(airshipData.enginePower);
  if (powerPercent < 0.1) return "∞";

  const { fuelRate } = interpolateFuelAndSpeed(powerPercent);
  if (fuelRate <= 0) return "∞";

  const hours = airshipData.fuelReserve / fuelRate;
  if (hours > 24) return "∞";

  const h = Math.floor(hours).toString().padStart(2, "0");
  const m = Math.floor((hours % 1) * 60)
    .toString()
    .padStart(2, "0");
  return `${h}:${m}`;
}

function formatVirtualDateTime() {
  const virtualDate = new Date(airshipData.virtualStartDate);
  virtualDate.setSeconds(
    virtualDate.getSeconds() + Math.floor(airshipData.virtualTimeSeconds),
  );
  return virtualDate.toLocaleString("ru-RU", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function updateStats() {
  const fuelTime = calculateFuelTimeRemaining();
  document.getElementById("stats").innerHTML =
    `Пройдено: ${formatDistance(airshipData.totalDistanceMeters)}<br>` +
    `Дизель: ${formatFuel(airshipData.totalFuelBurned)} / ${formatFuel(airshipData.fuelReserve)} л (${fuelTime})<br>` +
    `Время: ${formatVirtualDateTime()}`;
}

function updateDisplays() {
  const throttleSlider = document.getElementById("throttleSlider");
  const rudderSlider = document.getElementById("rudderSlider");
  const rudderValue = document.getElementById("rudderValue");
  const throttleValue = document.getElementById("throttleValue");

  rudderSlider.value = Math.round(airshipData.rudder * 10);
  throttleSlider.value = airshipData.throttle;

  const throttleLabels = {
    "-5": "ASTERN FULL",
    "-4": "ASTERN HALF",
    "-3": "ASTERN SLOW",
    "-2": "ASTERN DEAD SLOW",
    "-1": "DEAD SLOW (astern)",
    0: "STOP",
    1: "DEAD SLOW",
    2: "SLOW",
    3: "HALF",
    4: "FULL",
    5: "FULL",
  };
  rudderValue.textContent = airshipData.rudder.toFixed(1) + "°";
  throttleValue.textContent = throttleLabels[airshipData.throttle] || "STOP";

  const speedDisplay =
    airshipData.groundSpeed >= 0
      ? airshipData.groundSpeed.toFixed(1) + " км/ч"
      : "← " + Math.abs(airshipData.groundSpeed).toFixed(1) + " км/ч";
  document.getElementById("speedometer").textContent = speedDisplay;

  const sign = airshipData.enginePower >= 0 ? "" : "-";
  document.getElementById("enginePowerDisplay").textContent =
    sign + Math.abs(Math.round(airshipData.enginePower)) + "%";

  let courseDeviation = 0;
  if (airshipData.hasTarget) {
    const R = 6378137;
    const lat1 = (airshipData.lat * Math.PI) / 180;
    const lon1 = (airshipData.lng * Math.PI) / 180;
    const lat2 = (airshipData.targetLat * Math.PI) / 180;
    const lon2 = (airshipData.targetLng * Math.PI) / 180;
    const dLon = lon2 - lon1;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x =
      Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    const bearingToTarget = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    courseDeviation = bearingToTarget - airshipData.heading;
    if (courseDeviation > 180) courseDeviation -= 360;
    if (courseDeviation < -180) courseDeviation += 360;
  }
  document.getElementById("compass").textContent =
    `${Math.round(airshipData.heading)}° (${Math.abs(Math.round(courseDeviation))}°)`;

  document.getElementById("timeWarpValue").textContent = timeWarpFactor + "x";
  const zoomLabels = ["1000x", "500x", "200x", "100x", "10x", "5x", "2x", "1x"];
  document.getElementById("zoomScaleValue").textContent =
    zoomLabels[currentZoomScaleIndex];
  document.getElementById("pauseBtn").textContent = isPaused ? "▶️" : "⏸️";

  const isAnchored = airshipData.anchorEnabled;
  document.getElementById("rudderSlider").disabled = isAnchored;
  document.getElementById("throttleSlider").disabled = isAnchored;
  document.getElementById("fastBrakeToggle").disabled = isAnchored;
  document.getElementById("autopilotToggle").disabled =
    isAnchored || !airshipData.hasTarget;

  document.getElementById("autopilotToggle").checked =
    airshipData.autopilotEnabled;
  document.getElementById("fastBrakeToggle").checked =
    airshipData.fastBrakeEnabled;
  document.getElementById("anchorToggle").checked = airshipData.anchorEnabled;
}

// === КОМПАС ВЕТРА ===

function updateWindCompass() {
  const size = 120;
  const centerX = size / 2;
  const centerY = size / 2;
  const arrowLength = size * 0.35;
  const arrowRad = ((windDirection - 90) * Math.PI) / 180;
  const arrowX = centerX + arrowLength * Math.cos(arrowRad);
  const arrowY = centerY + arrowLength * Math.sin(arrowRad);

  const windSpeedKmh = beaufortToMps(windSpeedBf) * 3.6;
  const windSpeedText =
    windSpeedBf === 0 ? "(Штиль)" : `(${windSpeedKmh.toFixed(0)} км/ч)`;

  const compassSvg = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${centerX}" cy="${centerY}" r="${size / 2}" fill="#000" stroke="#ccc" stroke-width="2"/>
      <line x1="${centerX}" y1="${centerY}" x2="${arrowX}" y2="${arrowY}" stroke="#ff0" stroke-width="3" marker-end="url(#arrowhead-wind)"/>
      <text x="${centerX}" y="16" text-anchor="middle" fill="#fff" font-size="12" font-family="Arial">N</text>
      <text x="${size - 8}" y="${centerY + 6}" text-anchor="end" fill="#fff" font-size="12" font-family="Arial">E</text>
      <text x="${centerX}" y="${size - 4}" text-anchor="middle" fill="#fff" font-size="12" font-family="Arial">S</text>
      <text x="8" y="${centerY + 6}" text-anchor="start" fill="#fff" font-size="12" font-family="Arial">W</text>
      <text x="${centerX}" y="${centerY + 30}" text-anchor="middle" fill="#ff0" font-size="10" font-family="Arial">${windSpeedText}</text>
    </svg>
    <defs>
      <marker id="arrowhead-wind" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
        <polygon points="0,0 8,3 0,6" fill="#ff0"/>
      </marker>
    </defs>`;

  document.getElementById("windCompass").innerHTML = compassSvg;
}

// === ФИЗИКА И ВЕТЕР ===

function applyWindEffect(dt) {
  const windSpeedMs = beaufortToMps(windSpeedBf);
  const windAngleRad = (windDirection * Math.PI) / 180;

  const driftX = windSpeedMs * Math.sin(windAngleRad) * dt;
  const driftY = windSpeedMs * Math.cos(windAngleRad) * dt;

  const earthRadius = 6378137;
  airshipData.lat += (driftY / earthRadius) * (180 / Math.PI);
  airshipData.lng +=
    ((driftX / earthRadius) * (180 / Math.PI)) /
    Math.cos((airshipData.lat * Math.PI) / 180);

  const shipSpeedMs = airshipData.speed / 3.6;
  const shipAngleRad = (airshipData.heading * Math.PI) / 180;
  const shipX = shipSpeedMs * Math.sin(shipAngleRad);
  const shipY = shipSpeedMs * Math.cos(shipAngleRad);

  const totalX = shipX + windSpeedMs * Math.sin(windAngleRad);
  const totalY = shipY + windSpeedMs * Math.cos(windAngleRad);

  const groundSpeedMs = Math.sqrt(totalX * totalX + totalY * totalY);
  const groundSpeedKmh = groundSpeedMs * 3.6;

  const courseAngleRad = (airshipData.heading * Math.PI) / 180;
  const dotProduct =
    totalX * Math.sin(courseAngleRad) + totalY * Math.cos(courseAngleRad);

  airshipData.groundSpeed = dotProduct >= 0 ? groundSpeedKmh : -groundSpeedKmh;
}

function runAutopilot() {
  if (!airshipData.hasTarget || airshipData.fuelReserve <= 0) {
    airshipData.autopilotIsControlling = true;
    document.getElementById("throttleSlider").value = 0;
    throttleSlider.dispatchEvent(new Event("input"));
    airshipData.autopilotIsControlling = false;
    return;
  }

  const R = 6378137;
  const lat1 = (airshipData.lat * Math.PI) / 180;
  const lon1 = (airshipData.lng * Math.PI) / 180;
  const lat2 = (airshipData.targetLat * Math.PI) / 180;
  const lon2 = (airshipData.targetLng * Math.PI) / 180;

  const dLon = lon2 - lon1;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const bearingToTarget = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;

  const dx = R * Math.cos(lat1) * Math.sin(dLon);
  const dy = R * (Math.sin(lat2) - Math.sin(lat1));
  const distanceToTarget = Math.sqrt(dx * dx + dy * dy);

  // === ФАЗА 1: ПОЛЁТ (> 1 км) ===
  if (distanceToTarget > 1000) {
    let headingError = bearingToTarget - airshipData.heading;
    if (headingError > 180) headingError -= 360;
    if (headingError < -180) headingError += 360;

    let rudderCommand = headingError * 0.01;
    rudderCommand = Math.max(-0.5, Math.min(0.5, rudderCommand));
    airshipData.rudder = rudderCommand;

    airshipData.autopilotIsControlling = true;
    document.getElementById("rudderSlider").value = Math.round(
      rudderCommand * 10,
    );
    document.getElementById("throttleSlider").value = 5;
    throttleSlider.dispatchEvent(new Event("input"));
    airshipData.autopilotIsControlling = false;
  }
  // === ФАЗА 2: ТОРМОЖЕНИЕ (≤ 1 км, скорость > 15) ===
  else if (Math.abs(airshipData.groundSpeed) > 15) {
    airshipData.autopilotIsControlling = true;
    document.getElementById("rudderSlider").value = 0;
    document.getElementById("throttleSlider").value = -5;
    throttleSlider.dispatchEvent(new Event("input"));
    airshipData.autopilotIsControlling = false;
  }
  // === ФАЗА 3: ОСТАНОВКА И ЯКОРЬ (≤ 15 км/ч) ===
  else {
    airshipData.autopilotIsControlling = true;
    document.getElementById("throttleSlider").value = 0;
    throttleSlider.dispatchEvent(new Event("input"));
    airshipData.autopilotIsControlling = false;

    airshipData.anchorEnabled = true;
    document.getElementById("anchorToggle").checked = true;

    airshipData.autopilotEnabled = false;
    document.getElementById("autopilotToggle").checked = false;

    updateDisplays();
  }
}

// === ОСНОВНОЙ ЦИКЛ ===

function simulateStep() {
  // === ВРЕМЯ И ПАУЗА (работает всегда) ===
  const now = performance.now();
  const dtReal = (now - airshipData.lastSimulateTime) / 1000;
  airshipData.lastSimulateTime = now;

  if (!isPaused) {
    const dtSimulated = dtReal * timeWarpFactor;
    airshipData.virtualTimeSeconds += dtSimulated;
  }

  if (!airshipMarker) return;

  // === ЯКОРЬ ===
  if (airshipData.anchorEnabled) {
    airshipData.throttle = 0;
    airshipData.enginePower = 0;
    airshipData.speed = 0;
    airshipData.groundSpeed = 0;
    airshipData.autopilotEnabled = false;
    airshipData.fastBrakeEnabled = false;
    document.getElementById("fastBrakeToggle").checked = false;
    document.getElementById("throttleSlider").value = 0;
    throttleSlider.dispatchEvent(new Event("input"));
  }

  // === АВТОПИЛОТ ===
  if (airshipData.autopilotEnabled && !airshipData.anchorEnabled) {
    runAutopilot();
  }

  // === АВТОМАТИЧЕСКИЙ ВЕТЕР ===
  if (windMode === "auto") {
    if (
      airshipData.virtualTimeSeconds -
        (airshipData.windLastVirtualUpdate || 0) >=
      60
    ) {
      let changed = false;
      if (Math.random() < 0.1) {
        windDirection = Math.floor(Math.random() * 360);
        changed = true;
      }
      if (Math.random() < 0.1) {
        const windWeights = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1.5, 1, 0.5, 0.2];
        const totalWeight = windWeights.reduce((a, b) => a + b, 0);
        let rand = Math.random() * totalWeight;
        let bf = 0;
        for (let i = 0; i < windWeights.length; i++) {
          if (rand < windWeights[i]) {
            bf = i;
            break;
          }
          rand -= windWeights[i];
        }
        windSpeedBf = bf;
        changed = true;
      }
      if (!changed) {
        windSpeedBf += (Math.random() - 0.5) * 0.3;
        windDirection += (Math.random() - 0.5) * 8;
      }
      windSpeedBf = Math.max(0, Math.min(12, windSpeedBf));
      windDirection = ((windDirection % 360) + 360) % 360;
      airshipData.windLastVirtualUpdate = airshipData.virtualTimeSeconds;
      updateWindCompass();
    }
  }

  // === ЗАПРЕТ ДВИГАТЕЛЯ БЕЗ ТОПЛИВА ===
  if (airshipData.fuelReserve <= 0) {
    airshipData.throttle = 0;
    airshipData.enginePower = 0;
    airshipData.speed = 0;
    airshipData.groundSpeed = 0;
  }

  // === АВТОМАТИЧЕСКОЕ ОТКЛЮЧЕНИЕ БЫСТРОГО ТОРМОЖЕНИЯ ===
  if (airshipData.fastBrakeEnabled && Math.abs(airshipData.speed) <= 5) {
    airshipData.fastBrakeEnabled = false;
    document.getElementById("fastBrakeToggle").checked = false;
    document.getElementById("throttleSlider").value = 0;
    throttleSlider.dispatchEvent(new Event("input"));
  }

  // === ФИЗИКА ДВИЖЕНИЯ ===
  if (!airshipData.anchorEnabled) {
    const currentSign = Math.sign(airshipData.enginePower);
    const targetSign = Math.sign(airshipData.throttle);

    if (currentSign !== targetSign && airshipData.enginePower !== 0) {
      if (airshipData.enginePower > 0) {
        airshipData.enginePower = Math.max(
          0,
          airshipData.enginePower - ENGINE_POWER_RATE * dtReal * timeWarpFactor,
        );
      } else {
        airshipData.enginePower = Math.min(
          0,
          airshipData.enginePower + ENGINE_POWER_RATE * dtReal * timeWarpFactor,
        );
      }
      if (Math.abs(airshipData.enginePower) <= 0.1) {
        airshipData.enginePower = 0;
      }
    } else {
      const targetEnginePower = airshipData.throttle * 20;
      if (airshipData.enginePower < targetEnginePower) {
        airshipData.enginePower = Math.min(
          targetEnginePower,
          airshipData.enginePower + ENGINE_POWER_RATE * dtReal * timeWarpFactor,
        );
      } else if (airshipData.enginePower > targetEnginePower) {
        airshipData.enginePower = Math.max(
          targetEnginePower,
          airshipData.enginePower - ENGINE_POWER_RATE * dtReal * timeWarpFactor,
        );
      }
    }

    let fuelUsed = 0;
    if (
      airshipData.throttle !== 0 &&
      airshipData.enginePower !== 0 &&
      airshipData.fuelReserve > 0
    ) {
      const powerPercent = Math.abs(airshipData.enginePower);
      const { fuelRate } = interpolateFuelAndSpeed(powerPercent);
      const fuelRatePerSec = fuelRate / 3600;
      fuelUsed = fuelRatePerSec * dtReal * timeWarpFactor;
      if (airshipData.fuelReserve >= fuelUsed) {
        airshipData.fuelReserve -= fuelUsed;
        airshipData.totalFuelBurned += fuelUsed;
      } else {
        airshipData.fuelReserve = 0;
        airshipData.throttle = 0;
        airshipData.enginePower = 0;
      }
    }

    const { speed: targetSpeed } = interpolateFuelAndSpeed(
      Math.abs(airshipData.enginePower),
    );
    const sign = Math.sign(airshipData.enginePower);
    let finalTargetSpeed = sign * targetSpeed;

    if (Math.abs(airshipData.speed - finalTargetSpeed) > 0.01) {
      let acceleration = 0.08;
      if (Math.abs(airshipData.enginePower) < 0.1) {
        acceleration = 0.3;
      } else if (
        (airshipData.enginePower < 0 && airshipData.speed > 0) ||
        (airshipData.enginePower > 0 && airshipData.speed < 0)
      ) {
        acceleration = 0.8;
      }

      if (airshipData.speed < finalTargetSpeed) {
        airshipData.speed = Math.min(
          finalTargetSpeed,
          airshipData.speed + acceleration * dtReal * timeWarpFactor,
        );
      } else {
        airshipData.speed = Math.max(
          finalTargetSpeed,
          airshipData.speed - acceleration * dtReal * timeWarpFactor,
        );
      }
    } else {
      airshipData.speed = finalTargetSpeed;
    }

    if (
      Math.abs(airshipData.enginePower) < 0.1 &&
      Math.abs(airshipData.speed) > 0.1
    ) {
      const drag = 0.3 * dtReal * timeWarpFactor;
      if (airshipData.speed > 0) {
        airshipData.speed = Math.max(0, airshipData.speed - drag);
      } else {
        airshipData.speed = Math.min(0, airshipData.speed + drag);
      }
    }

    if (Math.abs(airshipData.speed) > 0.1) {
      const turnRate =
        MIN_TURN_RATE +
        (Math.abs(airshipData.speed) / 135) * (MAX_TURN_RATE - MIN_TURN_RATE);
      const targetAngularVelocity = airshipData.rudder * turnRate;
      const angularAccel = 0.5;
      if (airshipData.angularVelocity < targetAngularVelocity) {
        airshipData.angularVelocity = Math.min(
          targetAngularVelocity,
          airshipData.angularVelocity + angularAccel * dtReal * timeWarpFactor,
        );
      } else if (airshipData.angularVelocity > targetAngularVelocity) {
        airshipData.angularVelocity = Math.max(
          targetAngularVelocity,
          airshipData.angularVelocity - angularAccel * dtReal * timeWarpFactor,
        );
      }
      airshipData.heading +=
        airshipData.angularVelocity * dtReal * timeWarpFactor;
      airshipData.heading = ((airshipData.heading % 360) + 360) % 360;
    } else {
      airshipData.angularVelocity *= 0.95;
      if (Math.abs(airshipData.angularVelocity) < 0.01)
        airshipData.angularVelocity = 0;
    }

    const rpm = calculatePropellerRPM();
    if (rpm !== 0) {
      const rotationPerSecond = (Math.abs(rpm) * 360) / 60;
      airshipData.propRotationAngle +=
        rotationPerSecond * dtReal * timeWarpFactor * Math.sign(rpm);
      airshipData.propRotationAngle %= 360;
    }

    applyWindEffect(dtReal * timeWarpFactor);
    const distanceKm =
      (Math.abs(airshipData.groundSpeed) * dtReal * timeWarpFactor) / 3600;
    const distanceMeters = distanceKm * 1000;
    airshipData.totalDistanceMeters += distanceMeters;

    const headingRad = (airshipData.heading * Math.PI) / 180;
    const dx =
      distanceMeters * Math.sin(headingRad) * Math.sign(airshipData.speed);
    const dy =
      distanceMeters * Math.cos(headingRad) * Math.sign(airshipData.speed);
    const earthRadius = 6378137;
    const newLat = airshipData.lat + (dy / earthRadius) * (180 / Math.PI);
    const newLng =
      airshipData.lng +
      ((dx / earthRadius) * (180 / Math.PI)) /
        Math.cos((airshipData.lat * Math.PI) / 180);
    airshipData.lat = newLat;
    airshipData.lng = newLng;
    airshipMarker.setLatLng([newLat, newLng]);
    if (flagMarker) flagMarker.setLatLng([newLat, newLng]);

    if (airshipData.followEnabled) {
      map.panTo([newLat, newLng], { animate: false });
    }

    if (airshipData.hasTarget) {
      updateDirectionArrow();
    }
  }

  updateDisplays();
  updateAirshipIcon();
  updateStats();
}

// === ЗАПУСК И УПРАВЛЕНИЕ ===

function loadFuel() {
  const add = parseFloat(prompt("Сколько литров дизеля заправить?", "1000"));
  if (!isNaN(add) && add > 0) {
    airshipData.fuelReserve = Math.min(
      MAX_FUEL_CAPACITY,
      airshipData.fuelReserve + add,
    );
    updateStats();
    localStorage.setItem("airshipState", JSON.stringify(airshipData));
  }
}

let gameStarted = false;
let awaitingSpawn = false;
let awaitingTarget = false;

function spawnAirship(lat, lng) {
  if (gameStarted || !lat || !lng) return;
  gameStarted = true;
  awaitingSpawn = false;

  if (airshipMarker) map.removeLayer(airshipMarker);
  airshipMarker = L.marker([lat, lng], {
    icon: L.divIcon({ className: "" }),
  }).addTo(map);
  Object.assign(airshipData, {
    lat,
    lng,
    heading: 0,
    speed: 0,
    throttle: 0,
    rudder: 0,
    angularVelocity: 0,
    propRotationAngle: 0,
    flagEnabled: false,
    followEnabled: false,
    autopilotEnabled: false,
    fastBrakeEnabled: false,
    anchorEnabled: true,
    totalDistanceMeters: 0,
    fuelReserve: 100,
    totalFuelBurned: 0,
    hasTarget: false,
    targetLat: null,
    targetLng: null,
    enginePower: 0,
    groundSpeed: 0,
    windLastVirtualUpdate: 0,
    virtualTimeSeconds: 0,
    virtualStartDate: new Date(),
    lastSimulateTime: performance.now(),
    autopilotIsControlling: false,
  });

  document.getElementById("controls").style.display = "flex";
  document.getElementById("toggleControlsBtn").style.display = "block";
  document.getElementById("stats").style.display = "block";
  document.getElementById("autopilotToggle").disabled = true;

  updateDisplays();
  updateAirshipIcon();
  updateFlag();
  updateStats();
  updateWindCompass();
  startAutoSave();
}

let autoSaveInterval = null;
function startAutoSave() {
  if (autoSaveInterval) clearInterval(autoSaveInterval);
  autoSaveInterval = setInterval(() => {
    if (airshipMarker) {
      localStorage.setItem("airshipState", JSON.stringify(airshipData));
    }
  }, 15000);
}

// === ЗАГРУЗКА ===

function loadFromUrl() {
  try {
    const urlParams = new URLSearchParams(window.location.search);

    const lat = parseFloat(urlParams.get("lat"));
    const lng = parseFloat(urlParams.get("lng"));
    if (isNaN(lat) || isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return false;
    }

    airshipData.lat = lat;
    airshipData.lng = lng;

    const safeFloat = (key, def) => {
      const val = parseFloat(urlParams.get(key));
      return isNaN(val) ? def : val;
    };
    const safeInt = (key, def) => {
      const val = parseInt(urlParams.get(key), 10);
      return isNaN(val) ? def : val;
    };
    const safeBool = (key) => urlParams.get(key) === "1";

    airshipData.heading = safeFloat("hdg", 0);
    airshipData.speed = safeFloat("spd", 0);
    airshipData.throttle = safeInt("thr", 0);
    airshipData.rudder = safeFloat("rud", 0);
    airshipData.enginePower = safeFloat("eng", 0);
    airshipData.hasTarget = safeBool("tgt");

    if (airshipData.hasTarget) {
      const tlt = safeFloat("tlt", NaN);
      const tlg = safeFloat("tlg", NaN);
      if (
        isNaN(tlt) ||
        isNaN(tlg) ||
        Math.abs(tlt) > 90 ||
        Math.abs(tlg) > 180
      ) {
        airshipData.hasTarget = false;
      } else {
        airshipData.targetLat = tlt;
        airshipData.targetLng = tlg;
      }
    }

    airshipData.autopilotEnabled = safeBool("apl");
    airshipData.fastBrakeEnabled = safeBool("fbr");

    airshipData.virtualStartDate = new Date();
    airshipData.lastSimulateTime = performance.now();

    if (airshipMarker) map.removeLayer(airshipMarker);
    airshipMarker = L.marker([lat, lng], {
      icon: L.divIcon({ className: "" }),
    }).addTo(map);

    if (airshipData.hasTarget) {
      setTarget(airshipData.targetLat, airshipData.targetLng);
    }

    updateAirshipIcon();
    updateDisplays();
    updateStats();
    updateWindCompass();
    startAutoSave();

    document.getElementById("controls").style.display = "flex";
    document.getElementById("toggleControlsBtn").style.display = "block";
    document.getElementById("stats").style.display = "block";

    gameStarted = true;
    awaitingSpawn = false;
    document.getElementById("start-menu").style.display = "none";
    return true;
  } catch (e) {
    console.warn("Ошибка при загрузке из URL:", e);
    return false;
  }
}

function loadSavedState() {
  try {
    const saved = localStorage.getItem("airshipState");
    const btnContinue = document.getElementById("btn-continue");
    if (saved) {
      const parsed = JSON.parse(saved);
      if (typeof parsed.lat === "number" && typeof parsed.lng === "number") {
        btnContinue.disabled = false;
        btnContinue.onclick = () => {
          try {
            document.getElementById("start-menu").style.display = "none";
            spawnAirship(parsed.lat, parsed.lng);
            Object.assign(airshipData, parsed);
            airshipData.virtualStartDate = new Date();
            airshipData.lastSimulateTime = performance.now();
            gameStarted = true;
            awaitingSpawn = false;

            document.getElementById("controls").style.display = "flex";
            document.getElementById("toggleControlsBtn").style.display =
              "block";
            document.getElementById("stats").style.display = "block";

            updateDisplays();
            updateAirshipIcon();
            if (airshipData.flagEnabled) {
              document.getElementById("flagToggle").checked = true;
              updateFlag();
            }
            if (airshipData.followEnabled) {
              document.getElementById("followToggle").checked = true;
            }
            if (airshipData.hasTarget) {
              setTarget(airshipData.targetLat, airshipData.targetLng);
            }
            focusOnAirship(12);
            updateWindCompass();
            startAutoSave();
          } catch (e) {
            console.warn("Ошибка при загрузке из localStorage:", e);
            alert("Не удалось загрузить сохранение.");
          }
        };
        return;
      }
    }
  } catch (e) {
    console.warn("Ошибка парсинга localStorage:", e);
  }
  document.getElementById("btn-continue").disabled = true;
}

// === ОБРАБОТЧИКИ ===

const timeWarpSlider = document.getElementById("timeWarpSlider");
timeWarpSlider.addEventListener("input", () => {
  const index = parseInt(timeWarpSlider.value);
  timeWarpFactor = timeSteps[index];
  updateDisplays();
});

const zoomScaleSlider = document.getElementById("zoomScaleSlider");
let zoomDebounceTimer = null;
zoomScaleSlider.addEventListener("input", () => {
  if (zoomDebounceTimer) clearTimeout(zoomDebounceTimer);
  currentZoomScaleIndex = parseInt(zoomScaleSlider.value);
  updateDisplays();
  zoomDebounceTimer = setTimeout(() => {
    const zoomLevel = ZOOM_SCALE_LEVELS[currentZoomScaleIndex];
    map.setZoom(zoomLevel);
    zoomDebounceTimer = null;
  }, 500);
});

document.getElementById("pauseBtn").addEventListener("click", () => {
  isPaused = !isPaused;
  updateDisplays();
  startAutoSave();
});

const rudderSlider = document.getElementById("rudderSlider");
const throttleSlider = document.getElementById("throttleSlider");
const rudderValue = document.getElementById("rudderValue");
const throttleValue = document.getElementById("throttleValue");

rudderSlider.addEventListener("input", () => {
  if (airshipData.anchorEnabled) return;
  airshipData.autopilotEnabled = false;
  document.getElementById("autopilotToggle").checked = false;
  const sliderVal = parseInt(rudderSlider.value);
  airshipData.rudder = sliderVal * 0.1;
  rudderValue.textContent = airshipData.rudder.toFixed(1) + "°";
});

throttleSlider.addEventListener("input", () => {
  if (airshipData.anchorEnabled) return;
  if (airshipData.fuelReserve <= 0 && parseInt(throttleSlider.value) !== 0) {
    throttleSlider.value = 0;
    alert("Невозможно запустить двигатель: нет топлива!");
    return;
  }

  const newThrottle = parseInt(throttleSlider.value);
  airshipData.throttle = newThrottle;

  // Только если НЕ автопилот управляет
  if (!airshipData.autopilotIsControlling) {
    airshipData.autopilotEnabled = false;
    document.getElementById("autopilotToggle").checked = false;
  }

  airshipData.fastBrakeEnabled = newThrottle === -5;
  document.getElementById("fastBrakeToggle").checked =
    airshipData.fastBrakeEnabled;

  const throttleLabels = {
    "-5": "ASTERN FULL",
    "-4": "ASTERN HALF",
    "-3": "ASTERN SLOW",
    "-2": "ASTERN DEAD SLOW",
    "-1": "DEAD SLOW (astern)",
    0: "STOP",
    1: "DEAD SLOW",
    2: "SLOW",
    3: "HALF",
    4: "FULL",
    5: "FULL",
  };
  throttleValue.textContent = throttleLabels[airshipData.throttle] || "STOP";
});

document
  .getElementById("fastBrakeToggle")
  .addEventListener("change", function () {
    if (airshipData.anchorEnabled) {
      this.checked = false;
      return;
    }

    airshipData.fastBrakeEnabled = this.checked;

    if (airshipData.fastBrakeEnabled) {
      document.getElementById("throttleSlider").value = -5;
      throttleSlider.dispatchEvent(new Event("input"));
    } else {
      document.getElementById("throttleSlider").value = 0;
      throttleSlider.dispatchEvent(new Event("input"));
    }
  });

document.getElementById("flagToggle").addEventListener("change", function () {
  airshipData.flagEnabled = this.checked;
  updateFlag();
});

document.getElementById("followToggle").addEventListener("change", function () {
  airshipData.followEnabled = this.checked;
});

document
  .getElementById("autopilotToggle")
  .addEventListener("change", function () {
    if (airshipData.anchorEnabled) {
      this.checked = false;
      alert("Нельзя включить автопилот: дирижабль на якоре.");
      return;
    }
    if (!airshipData.hasTarget) {
      this.checked = false;
      alert("Сначала установите цель!");
      return;
    }
    airshipData.autopilotEnabled = this.checked;
  });

document.getElementById("anchorToggle").addEventListener("change", function () {
  if (this.checked) {
    if (Math.abs(airshipData.groundSpeed) > 15) {
      this.checked = false;
      alert("Нельзя бросить якорь на скорости выше 15 км/ч!");
      return;
    }
    airshipData.anchorEnabled = true;
  } else {
    airshipData.anchorEnabled = false;
  }
  updateDisplays();
});

document.querySelectorAll('input[name="windMode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    windMode = radio.value;
    document.getElementById("manualWindInputs").style.display =
      windMode === "manual" ? "block" : "none";
    updateWindCompass();
  });
});

document.getElementById("windSpeedSelect").addEventListener("change", () => {
  windSpeedBf = parseInt(document.getElementById("windSpeedSelect").value);
  updateWindCompass();
});

const windDirectionSlider = document.getElementById("windDirectionSlider");
const windDirectionValue = document.getElementById("windDirectionValue");
windDirectionSlider.addEventListener("input", () => {
  windDirection = parseInt(windDirectionSlider.value);
  windDirectionValue.textContent = windDirection + "°";
  updateWindCompass();
});

document.getElementById("randomWindBtn").addEventListener("click", () => {
  windSpeedBf += (Math.random() - 0.5) * 0.6;
  windDirection += (Math.random() - 0.5) * 15;
  windSpeedBf = Math.max(0, Math.min(12, windSpeedBf));
  windDirection = ((windDirection % 360) + 360) % 360;
  document.getElementById("windSpeedSelect").value = Math.round(windSpeedBf);
  windDirectionSlider.value = Math.round(windDirection);
  windDirectionValue.textContent = Math.round(windDirection) + "°";
  updateWindCompass();
});

document.getElementById("focusBtn").addEventListener("click", () => {
  focusOnAirship(12);
});

document.getElementById("targetBtn").addEventListener("click", () => {
  if (airshipData.hasTarget) {
    removeTarget();
  } else {
    awaitingTarget = true;
    alert("Кликните по карте, чтобы установить точку назначения.");
  }
});

document.getElementById("fuelBtn").addEventListener("click", loadFuel);

document.getElementById("newGameBtn").addEventListener("click", () => {
  if (confirm("Вы уверены? Текущий полёт будет сброшен.")) {
    window.history.replaceState(null, "", window.location.pathname);
    location.reload();
  }
});

document.getElementById("toggleControlsBtn").addEventListener("click", () => {
  const controls = document.getElementById("controls");
  const btn = document.getElementById("toggleControlsBtn");
  if (controls.style.display === "none") {
    controls.style.display = "flex";
    btn.textContent = "^";
  } else {
    controls.style.display = "none";
    btn.textContent = "⌄";
  }
});

map.on("click", (e) => {
  if (awaitingSpawn) {
    spawnAirship(e.latlng.lat, e.latlng.lng);
  } else if (awaitingTarget) {
    awaitingTarget = false;
    setTarget(e.latlng.lat, e.latlng.lng);
  }
});

map.on("zoomend", () => {
  if (airshipMarker) updateAirshipIcon();
});

document.getElementById("btn-new").onclick = () => {
  document.getElementById("start-menu").style.display = "none";
  awaitingSpawn = true;
};

if (!loadFromUrl()) {
  loadSavedState();
}

setInterval(simulateStep, 50);
