/* global acquireVsCodeApi */
import { generateNmea, type TalkerId } from '../nmea/generator';
import { parseCsvCoordinates, parseNmeaTrack } from '../nmea/parse';
import {
  BUDAPEST,
  clamp,
  clonePoints,
  isValidLatLng,
  linePoints,
  pathLength,
  zoomForScale,
  type LatLng
} from '../shared/geo';
import type {
  FileKind,
  HostSettings,
  HostToWebview,
  MapProvider,
  WebviewToHost
} from '../shared/protocol';
import { parseCoordinateInput } from '../shared/coords';
import { DEFAULT_TILE_ATTRIBUTION, DEFAULT_TILE_URL } from '../shared/tiles';
import { searchPlaces, type PlaceResult } from './geocode';
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
  parsePersistedState,
  parseUtcDateTime,
  pointSpeedMps,
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
let searchAbort: AbortController | null = null;

const ui = {
  map: byId<HTMLDivElement>('map'),
  mapStatus: byId<HTMLDivElement>('map-status'),
  mapSearch: byId<HTMLFormElement>('map-search'),
  mapSearchInput: byId<HTMLInputElement>('map-search-input'),
  mapSearchGo: byId<HTMLButtonElement>('map-search-go'),
  mapSearchResults: byId<HTMLDivElement>('map-search-results'),
  toolGrid: byId<HTMLDivElement>('tool-grid'),
  stats: byId<HTMLDivElement>('stats'),
  frequency: byId<HTMLInputElement>('frequency'),
  speed: byId<HTMLInputElement>('speed'),
  startDate: byId<HTMLInputElement>('start-date'),
  startTime: byId<HTMLInputElement>('start-time'),
  talker: byId<HTMLSelectElement>('talker'),
  altitude: byId<HTMLInputElement>('altitude'),
  satellites: byId<HTMLInputElement>('satellites'),
  hdop: byId<HTMLInputElement>('hdop'),
  includeGga: byId<HTMLInputElement>('include-gga'),
  includeGsa: byId<HTMLInputElement>('include-gsa'),
  includeRmc: byId<HTMLInputElement>('include-rmc'),
  generate: byId<HTMLButtonElement>('generate'),
  importNmea: byId<HTMLButtonElement>('import-nmea'),
  importCsv: byId<HTMLButtonElement>('import-csv'),
  undo: byId<HTMLButtonElement>('undo'),
  redo: byId<HTMLButtonElement>('redo'),
  clear: byId<HTMLButtonElement>('clear'),
  basemapSwitch: byId<HTMLDivElement>('basemap-switch'),
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
  updateAll();
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
    updateProviderUi(provider);
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
    {
      tileUrl: hostSettings.tileUrl,
      tileAttribution: hostSettings.tileAttribution
    },
    mapHandlers
  );
  viewKind = effective;
  render();
  updateProviderUi(provider);

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

function updateProviderUi(configured: MapProvider): void {
  settings.provider = configured;
  updateBasemapUi(configured);
}

/** 高亮当前底图对应的分段按钮。 */
function updateBasemapUi(provider: MapProvider): void {
  const options = ui.basemapSwitch.querySelectorAll<HTMLButtonElement>('.basemap-option');
  options.forEach((option) => {
    const active = option.dataset.provider === provider;
    option.classList.toggle('active', active);
    option.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function chooseProvider(provider: MapProvider): void {
  settings.provider = provider;
  updateBasemapUi(provider);
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
    updateAll();
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
  if (tool === 'move') {
    selectedIndex = index;
    preview = [];
    updateAll();
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
  updateAll();
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
  updateAll();
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
}

function deletePointAt(index: number): void {
  if (index < 0 || index >= points.length) {
    return;
  }
  pushHistory();
  points.splice(index, 1);
  selectedIndex = points.length === 0 ? -1 : Math.min(index, points.length - 1);
  preview = [];
  updateAll();
  showToast('已删除 1 个点，可撤销。');
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
  updateAll();
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
  updateAll();
}

function clearTrack(): void {
  if (points.length === 0) {
    return;
  }
  pushHistory();
  points = [];
  selectedIndex = -1;
  preview = [];
  updateAll();
  showToast('已清空轨迹，可撤销。');
}

function updateAll(): void {
  render();
  updateStats();
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

  // 每段耗时相同，因此段速度直接用「段距离 × 频率」计算，取最大值即最高速度。
  let maxSpeed = 0;
  for (let i = 1; i < points.length; i++) {
    maxSpeed = Math.max(maxSpeed, pointSpeedMps(points, i, settings.frequencyHz));
  }

  ui.stats.innerHTML = [
    statCard('点数', String(points.length), 'third'),
    statCard('时长', formatDuration(duration), 'third'),
    statCard('距离', formatDistance(totalDistance), 'third'),
    statCard('时间', formatTimeRange(duration), 'wide'),
    statCard('平均速度', `${(averageSpeed * 3.6).toFixed(1)} km/h`, 'half'),
    statCard('最高速度', `${(maxSpeed * 3.6).toFixed(1)} km/h`, 'half'),
    statCard('海拔', formatAltitude(settings.altitudeMeters), 'half'),
    statCard('卫星数', String(settings.satellites), 'half')
  ].join('');
}

function updateMapStatus(): void {
  const suffix = `${points.length} 个点`;
  ui.mapStatus.textContent =
    lastPointer && isValidLatLng(lastPointer)
      ? `${lastPointer.lat.toFixed(5)}, ${lastPointer.lon.toFixed(5)} · ${suffix}`
      : `${settings.provider === 'google' ? 'Google 地图' : 'OpenStreetMap'} · ${suffix}`;
}

/**
 * 地图左上角搜索框：先按坐标解析，失败后再走地址检索。
 * 坐标可以离线识别，地址检索依赖 Photon；两者最终都只做「移动地图」，不修改轨迹。
 */
async function runMapSearch(): Promise<void> {
  const query = ui.mapSearchInput.value.trim();
  if (query === '') {
    ui.mapSearchInput.focus();
    return;
  }

  const coordinate = parseCoordinateInput(query);
  if (coordinate !== null) {
    cancelPendingSearch();
    hideSearchResults();
    focusLocation(coordinate);
    showToast(`已定位到 ${coordinate.lat.toFixed(5)}, ${coordinate.lon.toFixed(5)}。`);
    return;
  }

  cancelPendingSearch();
  const controller = new AbortController();
  searchAbort = controller;
  setSearchBusy(true);
  try {
    const results = await searchPlaces(query, controller.signal);
    if (controller.signal.aborted) {
      return;
    }
    if (results.length === 0) {
      hideSearchResults();
      showToast(`未找到「${query}」，请换一个更具体的地址，或直接输入坐标。`, true);
      return;
    }
    if (results.length === 1) {
      hideSearchResults();
      focusLocation(results[0].center);
      showToast(`已定位到 ${results[0].label}。`);
      return;
    }
    showSearchResults(results);
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    hideSearchResults();
    showToast(error instanceof Error ? error.message : '地址检索失败，请直接输入坐标。', true);
  } finally {
    if (searchAbort === controller) {
      searchAbort = null;
      setSearchBusy(false);
    }
  }
}

/**
 * 把地图移动到目标坐标，并放大到约 50 m 的比例尺（100 px 刻度，约 0.5 m/像素），
 * 缩放级别按纬度补偿，确保街道级细节可见。
 */
function focusLocation(center: LatLng): void {
  if (!isValidLatLng(center)) {
    return;
  }
  view?.setView(center, zoomForScale(center.lat));
  lastPointer = null;
  updateMapStatus();
}

function showSearchResults(results: readonly PlaceResult[]): void {
  ui.mapSearchResults.innerHTML = '';
  for (const result of results) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'map-search-result';
    button.textContent = result.label;
    button.title = result.label;
    button.addEventListener('click', () => {
      hideSearchResults();
      focusLocation(result.center);
    });
    ui.mapSearchResults.appendChild(button);
  }
  ui.mapSearchResults.hidden = false;
}

function hideSearchResults(): void {
  ui.mapSearchResults.hidden = true;
  ui.mapSearchResults.textContent = '';
}

function setSearchBusy(busy: boolean): void {
  ui.mapSearchGo.disabled = busy;
  ui.mapSearchGo.classList.toggle('busy', busy);
  ui.mapSearchGo.textContent = busy ? '…' : '🔍';
}

/** 取消仍在进行的地址检索，避免旧结果覆盖新的定位。 */
function cancelPendingSearch(): void {
  searchAbort?.abort();
  searchAbort = null;
  setSearchBusy(false);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
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
  render();
}

type StatSize = 'third' | 'half' | 'wide';

/** 统计卡片：标签在上、数值在下，尺寸对应网格列宽（1/3、1/2、整行）。 */
function statCard(label: string, value: string, size: StatSize = 'third'): string {
  const sizeClass = size === 'third' ? '' : ` ${size}`;
  return (
    `<div class="stat${sizeClass}">` +
    `<span class="stat-label">${label}</span>` +
    `<span class="stat-value">${value}</span>` +
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
  return `${(meters / 1000).toFixed(2)} km`;
}

/** 轨迹起止的 UTC 时间（时:分:秒），与生成的 NMEA 时间一致。 */
function formatTimeRange(durationSeconds: number): string {
  if (points.length === 0) {
    return '—';
  }
  const start = startEpochMs(settings);
  const end = start + Math.max(0, durationSeconds) * 1000;
  return `${utcTimeString(start)} - ${utcTimeString(end)} UTC`;
}

function formatAltitude(meters: number): string {
  if (!Number.isFinite(meters)) {
    return '0 m';
  }
  return `${Number.isInteger(meters) ? meters : meters.toFixed(1)} m`;
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

function fillForm(): void {
  ui.frequency.value = String(settings.frequencyHz);
  ui.speed.value = String(settings.speedKmh);
  ui.startDate.value = settings.startDate;
  ui.startTime.value = settings.startTime;
  ui.talker.value = settings.talkerId;
  ui.includeGga.checked = settings.includeGga;
  ui.includeGsa.checked = settings.includeGsa;
  ui.includeRmc.checked = settings.includeRmc;
  ui.altitude.value = String(settings.altitudeMeters);
  ui.satellites.value = String(settings.satellites);
  ui.hdop.value = String(settings.hdop);
  updateBasemapUi(settings.provider);
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
    settings.speedKmh = clamp(roundTo(result.speedMps * 3.6, 1), 0.1, 360);
  }
  selectedIndex = points.length - 1;
  preview = [];
  fillForm();
  updateAll();
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
  updateAll();
  fitView();

  const warning = result.warnings.length > 0 ? ` ${result.warnings.join(' ')}` : '';
  showToast(`已从 ${fileName} 导入 ${points.length} 个点。${warning}`);
}

function handleFileContent(kind: FileKind, fileName: string, content: string): void {
  if (kind === 'nmea') {
    importNmeaFile(fileName, content);
    return;
  }
  importCsvFile(fileName, content);
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

  ui.generate.addEventListener('click', generateAndSave);
  ui.importNmea.addEventListener('click', () =>
    vscode.postMessage({ type: 'openFile', kind: 'nmea' })
  );
  ui.importCsv.addEventListener('click', () =>
    vscode.postMessage({ type: 'openFile', kind: 'csv' })
  );
  ui.undo.addEventListener('click', undo);
  ui.redo.addEventListener('click', redo);
  ui.clear.addEventListener('click', clearTrack);

  ui.basemapSwitch.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const option = target.closest<HTMLButtonElement>('.basemap-option');
    const provider = option?.dataset.provider;
    if (provider === 'google' || provider === 'osm') {
      chooseProvider(provider);
    }
  });

  ui.mapSearch.addEventListener('submit', (event) => {
    event.preventDefault();
    void runMapSearch();
  });
  ui.mapSearchInput.addEventListener('input', hideSearchResults);
  ui.mapSearchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideSearchResults();
    }
  });
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (target instanceof Node && !ui.mapSearch.contains(target)) {
      hideSearchResults();
    }
  });

  ui.bannerClose.addEventListener('click', hideBanner);
  ui.bannerAction.addEventListener('click', () => {
    const action = bannerAction;
    hideBanner();
    action?.();
  });

  window.addEventListener('message', handleHostMessage);
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('resize', () => view?.invalidateSize());
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => view?.invalidateSize());
    observer.observe(ui.map);
  }
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
  settings.speedKmh = clamp(roundTo(value, 1), 0.1, 360);
  ui.speed.value = String(settings.speedKmh);
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
  if (event.key === 'Escape') {
    preview = [];
    render();
    hideBanner();
    hideSearchResults();
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








