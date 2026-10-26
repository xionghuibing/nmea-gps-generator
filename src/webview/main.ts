/* global acquireVsCodeApi */
import { generateNmea, type TalkerId } from '../nmea/generator';
import { exportCsv, parseCsvCoordinates, parseNmeaTrack } from '../nmea/parse';
import {
  BUDAPEST,
  clamp,
  clonePoints,
  isValidLatLng,
  linePoints,
  pathLength,
  type LatLng
} from '../shared/geo';
import type {
  FileKind,
  HostSettings,
  HostToWebview,
  MapProvider,
  WebviewToHost
} from '../shared/protocol';
import { DEFAULT_TILE_ATTRIBUTION, DEFAULT_TILE_URL } from '../shared/tiles';
import { GoogleMapView } from './googleView';
import { LeafletMapView } from './leafletView';
import {
  BUDAPEST_ZOOM,
  loadGoogleMaps,
  type MapEventHandlers,
  type MapView,
  type Tool
} from './mapView';
import {
  createDefaultSettings,
  formatUtcStamp,
  parsePersistedState,
  parseProject,
  parseUtcDateTime,
  pointDistanceMeters,
  pointSpeedMps,
  pointTimeMs,
  serializeProject,
  spacingMeters,
  startEpochMs,
  TALKER_IDS,
  utcDateString,
  utcTimeString,
  type Settings
} from './settings';

interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

declare global {
  interface Window {
    gm_authFailure?: () => void;
  }
}

const TOOL_HINTS: Record<Tool, string> = {
  add: '点击地图在轨迹末尾追加点',
  delete: '点击轨迹点将其删除',
  move: '点击选择点，然后拖动橙色标记调整位置',
  edit: '点击轨迹点，在左侧输入精确经纬度',
  line: '从最后一个点开始：移动鼠标预览，点击地图添加等间距点',
  pan: '拖动 / 滚轮浏览地图，不会添加点'
};

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`缺少页面元素 #${id}`);
  }
  return element as T;
}

const vscode = acquireVsCodeApi();
const restored = parsePersistedState(vscode.getState());

let settings: Settings = restored?.settings ?? createDefaultSettings();
let points: LatLng[] = restored?.points ?? [];
let selectedIndex = restored?.selectedIndex ?? -1;
let tool: Tool = 'add';
let preview: LatLng[] = [];
let history: LatLng[][] = [];
let future: LatLng[][] = [];
let view: MapView | null = null;
let viewKind: MapProvider | null = null;
let providerRequest = 0;
let hostReady = false;
let hostSettings: HostSettings = {
  provider: 'osm',
  apiKey: null,
  tileUrl: DEFAULT_TILE_URL,
  tileAttribution: DEFAULT_TILE_ATTRIBUTION
};
let lastPointer: LatLng | null = null;
let pendingPointer: LatLng | null = null;
let pointerFrame = 0;
let toastTimer = 0;
let bannerAction: (() => void) | null = null;
let lastFilledIndex = -2;

const ui = {
  map: byId<HTMLDivElement>('map'),
  mapStatus: byId<HTMLDivElement>('map-status'),
  toolGrid: byId<HTMLDivElement>('tool-grid'),
  toolHint: byId<HTMLParagraphElement>('tool-hint'),
  stats: byId<HTMLDivElement>('stats'),
  statsHint: byId<HTMLParagraphElement>('stats-hint'),
  pointTitle: byId<HTMLParagraphElement>('point-title'),
  pointLat: byId<HTMLInputElement>('point-lat'),
  pointLon: byId<HTMLInputElement>('point-lon'),
  pointMeta: byId<HTMLParagraphElement>('point-meta'),
  applyPoint: byId<HTMLButtonElement>('apply-point'),
  deletePoint: byId<HTMLButtonElement>('delete-point'),
  prevPoint: byId<HTMLButtonElement>('prev-point'),
  nextPoint: byId<HTMLButtonElement>('next-point'),
  frequency: byId<HTMLInputElement>('frequency'),
  speed: byId<HTMLInputElement>('speed'),
  spacingHint: byId<HTMLParagraphElement>('spacing-hint'),
  startDate: byId<HTMLInputElement>('start-date'),
  startTime: byId<HTMLInputElement>('start-time'),
  talker: byId<HTMLSelectElement>('talker'),
  altitude: byId<HTMLInputElement>('altitude'),
  satellites: byId<HTMLInputElement>('satellites'),
  hdop: byId<HTMLInputElement>('hdop'),
  includeGga: byId<HTMLInputElement>('include-gga'),
  includeGsa: byId<HTMLInputElement>('include-gsa'),
  includeRmc: byId<HTMLInputElement>('include-rmc'),
  nmeaHint: byId<HTMLParagraphElement>('nmea-hint'),
  generate: byId<HTMLButtonElement>('generate'),
  copyNmea: byId<HTMLButtonElement>('copy-nmea'),
  exportCsv: byId<HTMLButtonElement>('export-csv'),
  importNmea: byId<HTMLButtonElement>('import-nmea'),
  importCsv: byId<HTMLButtonElement>('import-csv'),
  saveProject: byId<HTMLButtonElement>('save-project'),
  openProject: byId<HTMLButtonElement>('open-project'),
  undo: byId<HTMLButtonElement>('undo'),
  redo: byId<HTMLButtonElement>('redo'),
  clear: byId<HTMLButtonElement>('clear'),
  provider: byId<HTMLSelectElement>('provider'),
  providerHint: byId<HTMLParagraphElement>('provider-hint'),
  apiKey: byId<HTMLButtonElement>('api-key'),
  banner: byId<HTMLDivElement>('banner'),
  bannerText: byId<HTMLSpanElement>('banner-text'),
  bannerAction: byId<HTMLButtonElement>('banner-action'),
  bannerClose: byId<HTMLButtonElement>('banner-close'),
  loading: byId<HTMLDivElement>('loading'),
  toast: byId<HTMLDivElement>('toast')
};

function initialize(): void {
  fillForm();
  bindEvents();
  setTool('add');
  updateAll(true);
  void switchProvider(settings.provider, false);
  vscode.postMessage({ type: 'ready' });
}

async function switchProvider(provider: MapProvider, announce = true): Promise<void> {
  const request = ++providerRequest;
  let effective: MapProvider = provider;
  let failure: string | null = null;

  if (provider === 'google') {
    if (!hostSettings.apiKey) {
      effective = 'osm';
      failure = 'Google 地图需要 API Key；当前仍使用 OpenStreetMap。';
    } else {
      setLoading(true);
      try {
        await loadGoogleMaps(hostSettings.apiKey);
      } catch (error) {
        effective = 'osm';
        failure = `${error instanceof Error ? error.message : String(error)}；已回退到 OpenStreetMap。`;
      } finally {
        setLoading(false);
      }
    }
  }

  if (request !== providerRequest) {
    return;
  }

  if (effective === viewKind) {
    view?.setTileSource(hostSettings.tileUrl, hostSettings.tileAttribution);
    updateProviderUi(provider, effective);
    if (failure && announce && hostReady) {
      showGoogleFailure(failure);
    }
    return;
  }

  const current = view?.getView();
  view?.destroy();
  view = null;
  viewKind = null;
  ui.map.innerHTML = '';

  const center = current?.center ?? BUDAPEST;
  const zoom = current?.zoom ?? BUDAPEST_ZOOM;
  view = effective === 'google' ? new GoogleMapView() : new LeafletMapView();
  view.init(
    ui.map,
    center,
    zoom,
    { tileUrl: hostSettings.tileUrl, tileAttribution: hostSettings.tileAttribution },
    mapHandlers
  );
  viewKind = effective;
  render();
  updateProviderUi(provider, effective);

  if (failure && announce) {
    showGoogleFailure(failure);
  } else if (announce) {
    hideBanner();
  }
}

function showGoogleFailure(message: string): void {
  if (!hostSettings.apiKey) {
    showBanner(message, '设置 API Key', () => vscode.postMessage({ type: 'setApiKey' }));
  } else {
    showBanner(message, '重试', () => void switchProvider('google'));
  }
}

function updateProviderUi(configured: MapProvider, effective: MapProvider): void {
  settings.provider = configured;
  ui.provider.value = configured;
  ui.providerHint.textContent =
    effective === 'google' ? 'Google Maps · 浅色底图' : 'OpenStreetMap · 浅色底图';
  if (configured === 'google' && effective !== 'google') {
    ui.providerHint.textContent += '（未加载 Google，暂用 OSM）';
  }
  ui.apiKey.textContent = hostSettings.apiKey
    ? '更新 Google Maps API Key'
    : '设置 Google Maps API Key';
}

function chooseProvider(provider: MapProvider): void {
  settings.provider = provider;
  ui.provider.value = provider;
  persist();
  vscode.postMessage({ type: 'setProvider', provider });
  void switchProvider(provider);
}

function handleHostSettings(incoming: HostSettings): void {
  hostSettings = incoming;
  hostReady = true;
  settings.provider = incoming.provider;
  fillForm();
  persist();
  void switchProvider(incoming.provider);
}

function setLoading(visible: boolean): void {
  ui.loading.hidden = !visible;
}

const mapHandlers: MapEventHandlers = {
  click: handleMapClick,
  pointClick: handlePointClick,
  pointDragStart: () => pushHistory(),
  pointDragEnd: (index, latlng) => {
    if (!isValidLatLng(latlng) || index < 0 || index >= points.length) {
      return;
    }
    points[index] = { lat: latlng.lat, lon: latlng.lon };
    selectedIndex = index;
    preview = [];
    updateAll(true);
  },
  pointerMove: handlePointerMove,
  tileError: () => {
    if (viewKind === 'osm') {
      showBanner('OSM 瓦片加载失败，请检查网络、代理或瓦片地址。', '重试', () => {
        view?.refreshTiles();
        hideBanner();
      });
    }
  }
};

function handleMapClick(latlng: LatLng): void {
  if (!isValidLatLng(latlng)) {
    return;
  }
  switch (tool) {
    case 'add':
      addPoint(latlng);
      break;
    case 'line':
      commitLine(latlng);
      break;
    case 'delete':
    case 'edit':
    case 'move':
      selectedIndex = -1;
      preview = [];
      updateAll();
      break;
    case 'pan':
      break;
  }
}

function handlePointClick(index: number): void {
  if (index < 0 || index >= points.length) {
    return;
  }
  if (tool === 'delete') {
    deletePointAt(index);
    return;
  }
  if (tool === 'move' || tool === 'edit') {
    selectedIndex = index;
    preview = [];
    updateAll(true);
  }
}

function handlePointerMove(latlng: LatLng): void {
  lastPointer = latlng;
  updateMapStatus();
  if (tool !== 'line') {
    return;
  }
  pendingPointer = latlng;
  if (pointerFrame !== 0) {
    return;
  }
  pointerFrame = window.requestAnimationFrame(() => {
    pointerFrame = 0;
    if (pendingPointer !== null) {
      updatePreview(pendingPointer);
    }
  });
}

function addPoint(latlng: LatLng): void {
  pushHistory();
  points.push({ lat: latlng.lat, lon: latlng.lon });
  selectedIndex = points.length - 1;
  preview = [];
  updateAll(true);
}

function commitLine(target: LatLng): void {
  if (points.length === 0) {
    addPoint(target);
    showToast('已添加起点，移动鼠标预览后再点击提交。');
    return;
  }
  const generated = linePoints(
    points[points.length - 1],
    target,
    spacingMeters(settings)
  );
  if (generated.length === 0) {
    showToast('距离小于点间距，未添加新点。', true);
    return;
  }
  pushHistory();
  points.push(...generated);
  selectedIndex = points.length - 1;
  preview = [];
  updateAll(true);
  showToast(`已添加 ${generated.length} 个等间距点。`);
}

function updatePreview(target: LatLng): void {
  if (points.length === 0) {
    preview = [];
    render();
    return;
  }
  preview = linePoints(points[points.length - 1], target, spacingMeters(settings));
  view?.renderPreview(points, preview);
  ui.toolHint.textContent =
    preview.length > 0
      ? `预览 ${preview.length} 个点 · 点击地图提交`
      : '移动鼠标预览等间距点，点击提交';
}

function deletePointAt(index: number): void {
  if (index < 0 || index >= points.length) {
    return;
  }
  pushHistory();
  points.splice(index, 1);
  selectedIndex = points.length === 0 ? -1 : Math.min(index, points.length - 1);
  preview = [];
  updateAll(true);
  showToast('已删除 1 个点，可撤销。');
}

function deleteSelectedPoint(): void {
  if (selectedIndex >= 0) {
    deletePointAt(selectedIndex);
  }
}

function pushHistory(): void {
  history.push(clonePoints(points));
  if (history.length > 100) {
    history.shift();
  }
  future = [];
  updateHistoryButtons();
}

function undo(): void {
  const previous = history.pop();
  if (previous === undefined) {
    return;
  }
  future.push(clonePoints(points));
  points = previous;
  selectedIndex = points.length === 0 ? -1 : Math.min(selectedIndex, points.length - 1);
  preview = [];
  updateAll(true);
}

function redo(): void {
  const next = future.pop();
  if (next === undefined) {
    return;
  }
  history.push(clonePoints(points));
  points = next;
  selectedIndex = points.length === 0 ? -1 : Math.min(selectedIndex, points.length - 1);
  preview = [];
  updateAll(true);
}

function clearTrack(): void {
  if (points.length === 0) {
    return;
  }
  pushHistory();
  points = [];
  selectedIndex = -1;
  preview = [];
  updateAll(true);
  showToast('已清空轨迹，可撤销。');
}

function updateAll(forcePointPanel = false): void {
  render();
  updateStats();
  updatePointPanel(forcePointPanel);
  updateNmeaHint();
  updateSpacingHint();
  updateHistoryButtons();
  updateMapStatus();
  persist();
}

function render(): void {
  view?.render({ points, selectedIndex, tool, preview });
}

function persist(): void {
  vscode.setState({ points, settings, selectedIndex });
}

function updateStats(): void {
  const totalDistance = pathLength(points);
  const duration =
    points.length > 1 ? (points.length - 1) / Math.max(0.01, settings.frequencyHz) : 0;
  const averageSpeed = duration > 0 ? totalDistance / duration : 0;

  ui.stats.innerHTML = [
    statCard('点数', String(points.length)),
    statCard('路径长度', formatDistance(totalDistance)),
    statCard('时长', formatDuration(duration)),
    statCard('平均速度', `${(averageSpeed * 3.6).toFixed(1)} km/h`)
  ].join('');
  ui.statsHint.textContent =
    points.length > 1
      ? `${settings.frequencyHz} Hz 采样 · 轨迹越密，NMEA 文件越大`
      : '添加至少两个点即可计算距离与速度。';
}

function updateSpacingHint(): void {
  const spacing = spacingMeters(settings);
  ui.spacingHint.textContent =
    `点间距 ${formatDistance(spacing)} · ${(settings.speedMps * 3.6).toFixed(1)} km/h · ` +
    `${settings.frequencyHz} Hz`;
}

function updateMapStatus(): void {
  const suffix = `${points.length} 个点`;
  ui.mapStatus.textContent =
    lastPointer && isValidLatLng(lastPointer)
      ? `${lastPointer.lat.toFixed(5)}, ${lastPointer.lon.toFixed(5)} · ${suffix}`
      : `布达佩斯 · 浅色底图 · ${suffix}`;
}

function updateHistoryButtons(): void {
  ui.undo.disabled = history.length === 0;
  ui.redo.disabled = future.length === 0;
}

function setTool(next: Tool): void {
  tool = next;
  preview = [];
  for (const button of Array.from(
    ui.toolGrid.querySelectorAll<HTMLButtonElement>('button[data-tool]')
  )) {
    button.classList.toggle('active', button.dataset.tool === tool);
  }
  ui.toolHint.textContent = TOOL_HINTS[tool];
  render();
}

function statCard(label: string, value: string): string {
  return (
    `<div class="stat">` +
    `<span class="stat-value">${value}</span>` +
    `<span class="stat-label">${label}</span>` +
    `</div>`
  );
}

function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) {
    return '0 m';
  }
  if (meters < 1000) {
    return `${meters.toFixed(meters < 10 ? 2 : 1)} m`;
  }
  return `${(meters / 1000).toFixed(3)} km`;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  if (hours > 0) {
    return `${hours} 小时 ${minutes} 分`;
  }
  if (minutes > 0) {
    return `${minutes} 分 ${remaining} 秒`;
  }
  return `${remaining} 秒`;
}

function updatePointPanel(force = false): void {
  const valid = selectedIndex >= 0 && selectedIndex < points.length;
  ui.pointLat.disabled = !valid;
  ui.pointLon.disabled = !valid;
  ui.applyPoint.disabled = !valid;
  ui.deletePoint.disabled = !valid;
  ui.prevPoint.disabled = points.length === 0;
  ui.nextPoint.disabled = points.length === 0;

  if (!valid) {
    ui.pointTitle.textContent = points.length === 0 ? '尚未添加轨迹点' : '未选择点';
    ui.pointMeta.textContent =
      points.length === 0
        ? '点击地图开始添加轨迹点。'
        : '点击轨迹上的点进行选择；改坐标后按 Enter 或“应用坐标”。';
    if (lastFilledIndex !== -1) {
      ui.pointLat.value = '';
      ui.pointLon.value = '';
      lastFilledIndex = -1;
    }
    return;
  }

  const point = points[selectedIndex];
  const time = pointTimeMs(settings, selectedIndex);
  const speed = pointSpeedMps(points, selectedIndex, settings.frequencyHz);
  const distance = pointDistanceMeters(points, selectedIndex);
  const meta = [formatUtcStamp(time), `${(speed * 3.6).toFixed(1)} km/h`];
  if (selectedIndex > 0) {
    meta.push(`距上一点 ${formatDistance(distance)}`);
  }
  ui.pointTitle.textContent = `点 ${selectedIndex + 1} / ${points.length}`;
  ui.pointMeta.textContent = meta.join(' · ');

  if (force || lastFilledIndex !== selectedIndex) {
    ui.pointLat.value = point.lat.toFixed(7);
    ui.pointLon.value = point.lon.toFixed(7);
    lastFilledIndex = selectedIndex;
  }
}

function applyPointCoordinates(): void {
  if (selectedIndex < 0 || selectedIndex >= points.length) {
    return;
  }
  const lat = Number(ui.pointLat.value);
  const lon = Number(ui.pointLon.value);
  if (ui.pointLat.value.trim() === '' || ui.pointLon.value.trim() === '') {
    showToast('请输入完整的纬度和经度。', true);
    return;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    showToast('经纬度必须是数字。', true);
    return;
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    showToast('纬度范围 -90..90，经度范围 -180..180。', true);
    return;
  }
  const current = points[selectedIndex];
  if (Math.abs(current.lat - lat) < 1e-10 && Math.abs(current.lon - lon) < 1e-10) {
    showToast('坐标未改变。');
    return;
  }

  pushHistory();
  points[selectedIndex] = { lat, lon };
  preview = [];
  updateAll(true);
  showToast('已更新点坐标。');
}

function updateNmeaHint(): void {
  if (points.length === 0) {
    ui.nmeaHint.textContent = '尚未添加轨迹点。';
    return;
  }
  const sentences: string[] = [];
  if (settings.includeGga) {
    sentences.push('GGA');
  }
  if (settings.includeGsa) {
    sentences.push('GSA');
  }
  if (settings.includeRmc) {
    sentences.push('RMC');
  }
  if (sentences.length === 0) {
    ui.nmeaHint.textContent = '请至少选择 GGA / GSA / RMC 中的一种语句。';
    return;
  }
  ui.nmeaHint.textContent =
    `每点输出 ${sentences.join(' + ')}，共 ${points.length} 个点 → ` +
    `${points.length * sentences.length} 条语句。`;
}

function fillForm(): void {
  ui.frequency.value = String(settings.frequencyHz);
  ui.speed.value = String(settings.speedMps);
  ui.startDate.value = settings.startDate;
  ui.startTime.value = settings.startTime;
  ui.talker.value = settings.talkerId;
  ui.includeGga.checked = settings.includeGga;
  ui.includeGsa.checked = settings.includeGsa;
  ui.includeRmc.checked = settings.includeRmc;
  ui.altitude.value = String(settings.altitudeMeters);
  ui.satellites.value = String(settings.satellites);
  ui.hdop.value = String(settings.hdop);
  ui.provider.value = settings.provider;
}

function buildNmea(): string | null {
  if (points.length === 0) {
    showToast('请先在地图上添加轨迹点。', true);
    return null;
  }
  if (!settings.includeGga && !settings.includeGsa && !settings.includeRmc) {
    showToast('请至少选择一种 NMEA 语句。', true);
    return null;
  }
  return generateNmea(points, {
    frequencyHz: settings.frequencyHz,
    startEpochMs: startEpochMs(settings),
    talkerId: settings.talkerId,
    includeGga: settings.includeGga,
    includeGsa: settings.includeGsa,
    includeRmc: settings.includeRmc,
    altitudeMeters: settings.altitudeMeters,
    satellites: settings.satellites,
    hdop: settings.hdop
  });
}

function generateAndSave(): void {
  const content = buildNmea();
  if (content === null) {
    return;
  }
  vscode.postMessage({
    type: 'saveFile',
    kind: 'nmea',
    content,
    suggestedName: timestampedName('nmea-track', 'nmea')
  });
}

function copyNmea(): void {
  const content = buildNmea();
  if (content === null) {
    return;
  }
  vscode.postMessage({ type: 'copy', text: content, label: ' NMEA 语句' });
}

function exportCsvFile(): void {
  if (points.length === 0) {
    showToast('请先在地图上添加轨迹点。', true);
    return;
  }
  vscode.postMessage({
    type: 'saveFile',
    kind: 'csv',
    content: exportCsv(points),
    suggestedName: timestampedName('nmea-track', 'csv')
  });
}

function saveProjectFile(): void {
  vscode.postMessage({
    type: 'saveFile',
    kind: 'project',
    content: serializeProject(points, settings),
    suggestedName: timestampedName('nmea-project', 'json')
  });
}

function importNmeaFile(fileName: string, content: string): void {
  const result = parseNmeaTrack(content);
  if (result.points.length === 0) {
    showToast(result.warnings.join(' ') || '未找到有效的定位语句。', true);
    return;
  }

  pushHistory();
  points = result.points;
  if (result.startEpochMs !== null) {
    settings.startDate = utcDateString(result.startEpochMs);
    settings.startTime = utcTimeString(result.startEpochMs);
  }
  if (result.frequencyHz !== null) {
    settings.frequencyHz = clamp(roundTo(result.frequencyHz, 2), 0.1, 50);
  }
  if (result.speedMps !== null && result.speedMps > 0) {
    settings.speedMps = clamp(roundTo(result.speedMps, 2), 0.01, 100);
  }
  selectedIndex = points.length - 1;
  preview = [];
  fillForm();
  updateAll(true);
  fitView();

  const warning = result.warnings.length > 0 ? ` ${result.warnings.join(' ')}` : '';
  showToast(`已从 ${fileName} 导入 ${points.length} 个点。${warning}`);
}

function importCsvFile(fileName: string, content: string): void {
  const result = parseCsvCoordinates(content);
  if (result.points.length === 0) {
    showToast(result.warnings.join(' ') || 'CSV 中没有可用坐标。', true);
    return;
  }

  pushHistory();
  points = result.points;
  selectedIndex = points.length - 1;
  preview = [];
  updateAll(true);
  fitView();

  const warning = result.warnings.length > 0 ? ` ${result.warnings.join(' ')}` : '';
  showToast(`已从 ${fileName} 导入 ${points.length} 个点。${warning}`);
}

function openProjectFile(fileName: string, content: string): void {
  const project = parseProject(content);
  if (project === null) {
    showToast(`${fileName} 不是有效的 NMEA GPS Generator 工程文件。`, true);
    return;
  }

  pushHistory();
  points = project.points;
  settings = { ...project.settings, provider: hostSettings.provider };
  selectedIndex =
    project.selectedIndex >= 0
      ? project.selectedIndex
      : points.length > 0
        ? points.length - 1
        : -1;
  preview = [];
  fillForm();
  updateAll(true);
  fitView();
  showToast(`已打开工程 ${fileName}（${points.length} 个点）。`);
}

function handleFileContent(kind: FileKind, fileName: string, content: string): void {
  if (kind === 'nmea') {
    importNmeaFile(fileName, content);
    return;
  }
  if (kind === 'csv') {
    importCsvFile(fileName, content);
    return;
  }
  openProjectFile(fileName, content);
}

function fitView(): void {
  if (points.length === 0) {
    return;
  }
  if (points.length === 1) {
    view?.setView(points[0], 16);
    return;
  }
  view?.fit(points);
}

function timestampedName(prefix: string, extension: string): string {
  const now = new Date();
  const stamp =
    `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(now.getUTCDate()).padStart(2, '0')}-` +
    `${String(now.getUTCHours()).padStart(2, '0')}` +
    `${String(now.getUTCMinutes()).padStart(2, '0')}` +
    `${String(now.getUTCSeconds()).padStart(2, '0')}`;
  return `${prefix}-${stamp}.${extension}`;
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function bindEvents(): void {
  ui.toolGrid.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>('button[data-tool]');
    if (button?.dataset.tool) {
      setTool(button.dataset.tool as Tool);
    }
  });

  ui.frequency.addEventListener('change', commitFrequency);
  ui.speed.addEventListener('change', commitSpeed);
  ui.startDate.addEventListener('change', commitStartTime);
  ui.startTime.addEventListener('change', commitStartTime);
  ui.talker.addEventListener('change', commitNmeaOptions);
  ui.altitude.addEventListener('change', commitNmeaOptions);
  ui.satellites.addEventListener('change', commitNmeaOptions);
  ui.hdop.addEventListener('change', commitNmeaOptions);
  ui.includeGga.addEventListener('change', commitNmeaOptions);
  ui.includeGsa.addEventListener('change', commitNmeaOptions);
  ui.includeRmc.addEventListener('change', commitNmeaOptions);

  ui.pointLat.addEventListener('keydown', handlePointInputKey);
  ui.pointLon.addEventListener('keydown', handlePointInputKey);
  ui.applyPoint.addEventListener('click', applyPointCoordinates);
  ui.deletePoint.addEventListener('click', deleteSelectedPoint);
  ui.prevPoint.addEventListener('click', () => selectRelativePoint(-1));
  ui.nextPoint.addEventListener('click', () => selectRelativePoint(1));

  ui.generate.addEventListener('click', generateAndSave);
  ui.copyNmea.addEventListener('click', copyNmea);
  ui.exportCsv.addEventListener('click', exportCsvFile);
  ui.importNmea.addEventListener('click', () =>
    vscode.postMessage({ type: 'openFile', kind: 'nmea' })
  );
  ui.importCsv.addEventListener('click', () =>
    vscode.postMessage({ type: 'openFile', kind: 'csv' })
  );
  ui.saveProject.addEventListener('click', saveProjectFile);
  ui.openProject.addEventListener('click', () =>
    vscode.postMessage({ type: 'openFile', kind: 'project' })
  );
  ui.undo.addEventListener('click', undo);
  ui.redo.addEventListener('click', redo);
  ui.clear.addEventListener('click', clearTrack);

  ui.provider.addEventListener('change', () => {
    chooseProvider(ui.provider.value === 'google' ? 'google' : 'osm');
  });
  ui.apiKey.addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));

  ui.bannerClose.addEventListener('click', hideBanner);
  ui.bannerAction.addEventListener('click', () => {
    const action = bannerAction;
    hideBanner();
    action?.();
  });

  window.addEventListener('message', handleHostMessage);
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('resize', () => view?.invalidateSize());
  window.gm_authFailure = () => {
    showBanner(
      'Google Maps 鉴权失败：请检查 API Key、Maps JavaScript API 与结算设置。',
      '改用 OSM',
      () => chooseProvider('osm')
    );
  };
}

function commitFrequency(): void {
  const value = Number(ui.frequency.value);
  if (!Number.isFinite(value)) {
    fillForm();
    return;
  }
  settings.frequencyHz = clamp(roundTo(value, 3), 0.1, 50);
  ui.frequency.value = String(settings.frequencyHz);
  preview = [];
  updateAll();
}

function commitSpeed(): void {
  const value = Number(ui.speed.value);
  if (!Number.isFinite(value)) {
    fillForm();
    return;
  }
  settings.speedMps = clamp(roundTo(value, 3), 0.01, 100);
  ui.speed.value = String(settings.speedMps);
  preview = [];
  updateAll();
}

function commitStartTime(): void {
  const date = ui.startDate.value;
  const time = ui.startTime.value;
  if (parseUtcDateTime(date, time) === null) {
    fillForm();
    showToast('UTC 开始日期或时间无效。', true);
    return;
  }
  settings.startDate = date;
  settings.startTime = time;
  updateAll();
}

function commitNmeaOptions(): void {
  if (TALKER_IDS.includes(ui.talker.value as TalkerId)) {
    settings.talkerId = ui.talker.value as TalkerId;
  }
  settings.includeGga = ui.includeGga.checked;
  settings.includeGsa = ui.includeGsa.checked;
  settings.includeRmc = ui.includeRmc.checked;
  settings.altitudeMeters = clamp(roundTo(numberValue(ui.altitude, 0), 1), -500, 9000);
  settings.satellites = Math.round(clamp(numberValue(ui.satellites, 8), 0, 32));
  settings.hdop = roundTo(clamp(numberValue(ui.hdop, 0.9), 0.1, 99), 1);
  ui.altitude.value = String(settings.altitudeMeters);
  ui.satellites.value = String(settings.satellites);
  ui.hdop.value = String(settings.hdop);
  updateAll();
}

function numberValue(input: HTMLInputElement, fallback: number): number {
  const value = Number(input.value);
  return Number.isFinite(value) && input.value.trim() !== '' ? value : fallback;
}

function handlePointInputKey(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    applyPointCoordinates();
  }
}

function selectRelativePoint(delta: number): void {
  if (points.length === 0) {
    return;
  }
  if (selectedIndex < 0) {
    selectedIndex = delta < 0 ? points.length - 1 : 0;
  } else {
    selectedIndex = (selectedIndex + delta + points.length) % points.length;
  }
  preview = [];
  updateAll(true);
}

function handleHostMessage(event: MessageEvent<HostToWebview>): void {
  const message = event.data;
  if (message === null || typeof message !== 'object') {
    return;
  }
  switch (message.type) {
    case 'settings':
      handleHostSettings(message.settings);
      break;
    case 'fileContent':
      handleFileContent(message.kind, message.fileName, message.content);
      break;
    case 'notice':
      showToast(message.message, message.level === 'error');
      break;
  }
}

function handleKeyDown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (
    target !== null &&
    (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')
  ) {
    return;
  }

  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) {
      redo();
    } else {
      undo();
    }
    return;
  }
  if (modifier && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    redo();
    return;
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && selectedIndex >= 0) {
    event.preventDefault();
    deleteSelectedPoint();
    return;
  }
  if (event.key === 'Escape') {
    preview = [];
    render();
    hideBanner();
  }
}

function showToast(message: string, isError = false): void {
  ui.toast.textContent = message;
  ui.toast.classList.toggle('error', isError);
  ui.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(
    () => {
      ui.toast.hidden = true;
    },
    isError ? 7000 : 4000
  );
}

function showBanner(message: string, actionLabel?: string, action?: () => void): void {
  ui.bannerText.textContent = message;
  ui.banner.hidden = false;
  bannerAction = action ?? null;
  const hasAction = actionLabel !== undefined && action !== undefined;
  ui.bannerAction.hidden = !hasAction;
  ui.bannerAction.textContent = actionLabel ?? '';
}

function hideBanner(): void {
  ui.banner.hidden = true;
  bannerAction = null;
  ui.bannerAction.hidden = true;
}

initialize();








