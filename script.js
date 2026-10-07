// 時間と乗換情報は、2026年9月14日（月）朝8時ごろの調査結果。
const data = window.MAP_DATA;
const validationErrors = window.MapDataValidation.validateMapData(data);
if (validationErrors.length) throw new Error(`路線図データに問題があります:\n${validationErrors.join('\n')}`);

const stationById = new Map(data.stations.map(station => [station.id, station]));
const destinationById = new Map(data.destinations.map(destination => [destination.id, destination]));
const destinationByStationId = new Map(data.destinations.map(destination => [destination.stationId, destination]));
let selectedDestinationId = data.defaults.destinationId;
let selectedStationId = data.defaults.originStationId;

const stationLayer = document.querySelector('.station-layer');
const routeGroup = document.getElementById('active-route');
const networkNodes = document.getElementById('network-nodes');
const mapLines = document.getElementById('map-lines');
const mapRegion = document.querySelector('.map-region');
const destinationSelector = document.querySelector('.destination-selector');
const findRoutePath = window.RouteEngine.createRouteFinder(data);
const railColors = {
  '山手線': '#71DD33', '三田線': '#3F9BEC', '南北線': '#3FECC4', '丸の内線': '#F60A0A',
  '有楽町線': '#ECC135', '大江戸線': '#E62291', '中央線': '#FF7B42', '東西線': '#03CAF6',
  '総武線': '#F2F603', '浅草線': '#FF95EC', '半蔵門線': '#9D03FC', '千代田線': '#60C665',
  '銀座線': '#CD9836', '東横線': '#D5C7AC', '京浜東北線': '#05D9FA', '副都心線': '#CCAE06',
  '田園都市線': '#B76FB5', '日比谷線': '#918E91', '埼京線': '#1F9757', '東武東上線': '#09268E',
  '新宿線': '#30C217'
};
const railCoordinates = Object.entries(data.routes).flatMap(([line, route]) =>
  route.points.map(point => ({ point, line })));
const majorStations = new Set(['池袋', '新宿', '渋谷', '東京', '白山', '本駒込', '赤羽', '巣鴨', '上野', '北千住']);

function nearestRailPoint(station) {
  const centerX = station.x + station.width / 2;
  const centerY = station.y + station.height / 2;
  return railCoordinates.reduce((nearest, entry) => {
    const distance = (entry.point[0] - centerX) ** 2 + (entry.point[1] - centerY) ** 2;
    return distance < nearest.distance ? { ...entry, distance } : nearest;
  }, { point: [centerX, centerY], line: null, distance: Infinity });
}

Object.assign(mapLines.style, {
  left: `${data.image.x / 1352 * 100}%`,
  top: `${data.image.y / 1080 * 100}%`,
  width: `${data.image.width / 1352 * 100}%`,
  height: `${data.image.height / 1080 * 100}%`
});

// 駅名が2つ並ぶ、歩いて乗り換える駅の組。
const walkingTransfers = new Set([
  '板橋・新板橋', '後楽園・春日', '春日・後楽園', '小川町・淡路町',
  '東日本橋・馬喰横山', '馬喰町・馬喰横山', '有楽町・日比谷', '田町・三田'
]);
const plainStationName = name => name.replace('ツ', '');

function transferStationNames(journey) {
  if (!journey.transfers || !journey.transferStations) return [];
  const names = journey.transferStations.split('・');
  const groups = [];
  for (let index = 0; index < names.length; index++) {
    const pair = `${names[index]}・${names[index + 1]}`;
    if (walkingTransfers.has(pair)) {
      groups.push(pair);
      index++;
    } else {
      groups.push(names[index]);
    }
  }
  return groups;
}

// 駅ラベルの位置を、路線図の座標（1352×1080）で返す。
function stationLabelBoxes() {
  const bounds = mapRegion.getBoundingClientRect();
  const scale = 1352 / bounds.width;
  return [...stationLayer.querySelectorAll('.station-label')].map(label => {
    const rect = label.getBoundingClientRect();
    return {
      left: (rect.left - bounds.left) * scale,
      right: (rect.right - bounds.left) * scale,
      top: (rect.top - bounds.top) * scale,
      bottom: (rect.bottom - bounds.top) * scale
    };
  });
}

// 乗換地点の印が駅ラベルに隠れるときは、経路に沿ってラベルの外までずらす。
function markClearOfLabels(mark, routePoints, boxes) {
  const margin = 14;
  const isClear = point => !boxes.some(box =>
    point.x > box.left - margin && point.x < box.right + margin &&
    point.y > box.top - margin && point.y < box.bottom + margin);
  if (isClear(mark)) return mark;
  const distanceTo = point => Math.hypot(point.x - mark.x, point.y - mark.y);
  const nearest = routePoints
    .slice(Math.max(0, mark.order - 40), mark.order + 40)
    .filter(isClear)
    .sort((a, b) => distanceTo(a) - distanceTo(b))[0];
  return nearest ? { ...mark, x: nearest.x, y: nearest.y } : mark;
}

// 乗換駅名を、ほかの駅ラベルや印と重ならない向きに置く。
function placeTransferLabel(label) {
  const bounds = mapRegion.getBoundingClientRect();
  const others = [...stationLayer.querySelectorAll('.station-label'), ...routeGroup.querySelectorAll('.transfer-marker')]
    .filter(other => other !== label)
    .map(other => other.getBoundingClientRect());
  let best = { side: 'above', gap: '1.7cqh', overlap: Infinity };
  for (const gap of ['1.7cqh', '3.4cqh', '5.1cqh', '6.8cqh']) {
    label.style.setProperty('--transfer-gap', gap);
    for (const side of ['above', 'below', 'right', 'left', 'above-right', 'above-left', 'below-right', 'below-left']) {
      label.dataset.side = side;
      const rect = label.getBoundingClientRect();
      const inside = rect.left >= bounds.left && rect.right <= bounds.right &&
        rect.top >= bounds.top && rect.bottom <= bounds.bottom;
      if (!inside) continue;
      const overlap = others.reduce((sum, other) => sum +
        Math.max(0, Math.min(rect.right, other.right) - Math.max(rect.left, other.left)) *
        Math.max(0, Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top)), 0);
      if (overlap < best.overlap) best = { side, gap, overlap };
    }
  }
  label.dataset.side = best.side;
  label.style.setProperty('--transfer-gap', best.gap);
}

function drawRoute(station, destination, journey) {
  routeGroup.replaceChildren();
  stationLayer.querySelectorAll('.transfer-name').forEach(label => label.remove());
  stationLayer.querySelectorAll('.is-transfer').forEach(label => label.classList.remove('is-transfer'));
  let routePoints = journey
    ? findRoutePath(station.id, destination.stationId, journey.lines, journey.transferPoints, journey.originPoint)
    : [];
  // 経路の始点が駅ラベルから離れているときは、駅までつなぐ。
  if (routePoints.length && !journey.originPoint) {
    const [start] = routePoints;
    const outside = start.x < station.x - 8 || start.x > station.x + station.width + 8 ||
      start.y < station.y - 8 || start.y > station.y + station.height + 8;
    if (outside) {
      routePoints = [
        { x: station.x + station.width / 2, y: station.y + station.height / 2, transferFromPrevious: 0 },
        ...routePoints
      ];
    }
  }

  const transferMarks = [];
  const transferNames = journey ? transferStationNames(journey) : [];
  if (routePoints.length > 1) {
    const pathData = routePoints.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join(' ');
    for (const className of ['route-path-halo', 'route-path', 'route-path-sparkle']) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', className);
      path.setAttribute('data-route', 'registered');
      path.setAttribute('d', pathData);
      path.setAttribute('pathLength', '100');
      routeGroup.appendChild(path);
    }

    // 乗換地点を経路の順に集めて、印を出す。
    for (let index = 1; index < routePoints.length; index++) {
      if (routePoints[index].transferFromPrevious) {
        transferMarks.push({
          x: (routePoints[index - 1].x + routePoints[index].x) / 2,
          y: (routePoints[index - 1].y + routePoints[index].y) / 2,
          order: index
        });
      }
    }
    for (const [x, y] of journey.extraTransferPoints ?? []) {
      const distanceTo = point => Math.hypot(point.x - x, point.y - y);
      const order = routePoints.reduce((nearest, point, index) =>
        distanceTo(point) < distanceTo(routePoints[nearest]) ? index : nearest, 0);
      transferMarks.push({ x, y, order });
    }
    transferMarks.sort((a, b) => a.order - b.order);

    // 地図にある乗換駅はラベルを強調する。大きさが変わるので、印の位置を決める前に行う。
    if (transferNames.length === transferMarks.length) {
      transferMarks.forEach((mark, index) => {
        const names = transferNames[index].split('・').map(plainStationName);
        const existing = data.stations.find(candidate => names.includes(plainStationName(candidate.name)));
        if (existing) stationLayer.querySelector(`[data-station-id="${existing.id}"]`).classList.add('is-transfer');
        else mark.name = transferNames[index];
      });
    }
    const labelBoxes = stationLabelBoxes();
    for (const mark of transferMarks) Object.assign(mark, markClearOfLabels(mark, routePoints, labelBoxes));
    for (const { x, y } of transferMarks) {
      const marker = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      marker.setAttribute('class', 'transfer-marker');
      marker.setAttribute('transform', `translate(${x} ${y})`);
      for (const [className, radius] of [['transfer-marker-ring', 11], ['transfer-marker-core', 4.5]]) {
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('class', className);
        circle.setAttribute('r', radius);
        marker.appendChild(circle);
      }
      routeGroup.appendChild(marker);
    }
  }

  // 地図にない乗換駅は、印のそばに駅名のラベルを足す。
  for (const { x, y, name } of transferMarks) {
    if (!name) continue;
    const label = document.createElement('div');
    label.className = 'station-label transfer-name is-transfer';
    label.textContent = name;
    Object.assign(label.style, { left: `${x / 1352 * 100}%`, top: `${y / 1080 * 100}%` });
    stationLayer.appendChild(label);
    placeTransferLabel(label);
  }

  mapRegion.classList.toggle('has-active-route', routePoints.length > 1);
  document.getElementById('travel-route').textContent = routePoints.length ? '路線図上の経路を強調表示中' : '';
}

function updateTravelDisplay() {
  const station = stationById.get(selectedStationId);
  const destination = destinationById.get(selectedDestinationId);
  const journey = station && station.journeys ? station.journeys[selectedDestinationId] : null;
  const time = journey ? (journey.minutes ?? undefined) : undefined;

  const stationText = document.getElementById('travel-station');
  stationText.textContent = station.name;
  stationText.style.fontSize = `${Math.min(11.1111, 24.6 / Array.from(station.name).length)}cqh`;
  document.getElementById('travel-destination').textContent = destination.name;

  const timeNumber = document.getElementById('travel-time-number');
  timeNumber.textContent = time ?? '—';
  const timeDigits = Array.from(String(time ?? ''));
  timeNumber.classList.toggle('is-single-digit', timeDigits.length === 1);
  timeNumber.classList.toggle('is-wide-number', timeDigits.length > 1 && timeDigits[0] !== '1');
  document.querySelector('.time-line').classList.toggle('is-unregistered', time === undefined);
  document.getElementById('travel-status').textContent = time === undefined ? 'この駅の所要時間は未登録です' : '';
  document.getElementById('transfer-count').textContent = journey ? journey.transfers : '—';

  document.querySelectorAll('.station-label').forEach(button => {
    const active = button.dataset.destinationId
      ? button.dataset.destinationId === selectedDestinationId
      : button.dataset.stationId === selectedStationId;
    button.classList.toggle('is-selected', active);
    button.setAttribute('aria-pressed', String(active));
  });
  networkNodes.querySelectorAll('.network-node').forEach(node => {
    node.classList.toggle('is-selected', node.dataset.stationId === selectedStationId || node.dataset.stationId === destination.stationId);
  });

  drawRoute(station, destination, journey);
}

function selectStation(stationId) {
  selectedStationId = stationId;
  updateTravelDisplay();
}

function setDestination(destinationId) {
  selectedDestinationId = destinationId;
  document.querySelectorAll('.destination-button').forEach(button => {
    const active = button.dataset.destinationId === destinationId;
    button.classList.toggle('is-selected', active);
    button.setAttribute('aria-pressed', String(active));
  });
  updateTravelDisplay();
}

for (const destination of data.destinations) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'destination-button';
  button.dataset.destinationId = destination.id;
  button.textContent = destination.name;
  const active = destination.id === selectedDestinationId;
  button.classList.toggle('is-selected', active);
  button.setAttribute('aria-pressed', String(active));
  button.addEventListener('click', () => setDestination(destination.id));
  destinationSelector.appendChild(button);
}

for (const station of data.stations) {
  const destination = destinationByStationId.get(station.id);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'station-label';
  button.dataset.stationId = station.id;
  button.dataset.registered = String(Boolean(station.journeys));
  button.textContent = station.name;
  button.setAttribute('aria-label', `${station.name}${station.journeys ? 'からの所要時間を表示' : '（所要時間未登録）'}`);
  Object.assign(button.style, {
    left: `${station.x / 1352 * 100}%`,
    top: `${station.y / 1080 * 100}%`,
    width: `${station.width / 1352 * 100}%`,
    height: `${station.height / 1080 * 100}%`
  });
  button.style.setProperty('--station-center-x', `${(station.x + station.width / 2) / 1352 * 100}%`);
  button.style.setProperty('--station-width', `${station.width / 1352 * 100}%`);
  button.style.setProperty('--label-offset', station.y < 70 || station.id === 'tokiwadai' ? '3.2cqh' : '-3.2cqh');

  if (destination) {
    button.classList.add('destination');
    button.style.fontSize = `${destination.labelFontSize}cqh`;
    button.dataset.destinationId = destination.id;
    button.setAttribute('aria-label', `目的地を${destination.name}に変更`);
    button.addEventListener('click', () => setDestination(destination.id));
  } else {
    button.addEventListener('click', () => selectStation(station.id));
  }
  stationLayer.appendChild(button);

  const { point: [nodeX, nodeY], line } = nearestRailPoint(station);
  const major = majorStations.has(station.name);
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  node.setAttribute('class', `network-node${major ? ' is-major' : ''}`);
  node.setAttribute('transform', `translate(${nodeX} ${nodeY})`);
  node.dataset.stationId = station.id;
  node.style.setProperty('--node-color', railColors[line] || '#8bd2ff');
  for (const [className, radius] of [
    ['node-bloom', major ? 16 : 8],
    ['node-ring', major ? 9 : 4.6],
    ['node-core', major ? 5 : 2.5]
  ]) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('class', className);
    circle.setAttribute('r', radius);
    node.appendChild(circle);
  }
  networkNodes.appendChild(node);
}

updateTravelDisplay();
