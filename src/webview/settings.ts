import { clamp, haversineMeters, isValidLatLng, type LatLng } from '../shared/geo';
import type { MapProvider } from '../shared/protocol';
import type { TalkerId } from '../nmea/generator';

export interface Settings {
  frequencyHz: number;
  /** 对象速度，单位 km/h（用于推算点间距）。 */
  speedKmh: number;
  /** UTC 起始日期，格式 YYYY-MM-DD。 */
  startDate: string;
  /** UTC 起始时间，格式 HH:MM:SS。 */
  startTime: string;
  talkerId: TalkerId;
  includeGga: boolean;
  includeGsa: boolean;
  includeRmc: boolean;
  altitudeMeters: number;
  satellites: number;
  hdop: number;
  provider: MapProvider;
}

export interface PersistedState {
  points: LatLng[];
  settings: Settings;
  selectedIndex: number;
}

export const TALKER_IDS: TalkerId[] = ['GP', 'GN', 'GL', 'GA'];

export function createDefaultSettings(): Settings {
  const now = new Date();
  return {
    frequencyHz: 1,
    speedKmh: 50,
    startDate: utcDateString(now.getTime()),
    startTime: utcTimeString(now.getTime()),
    talkerId: 'GP',
    includeGga: true,
    includeGsa: true,
    includeRmc: true,
    altitudeMeters: 120,
    satellites: 8,
    hdop: 0.9,
    provider: 'osm'
  };
}

/** 点间距 = 速度 / 频率；多点直线工具使用该值。 */
/** 点间距 = 速度（km/h 换算为 m/s）/ 频率；多点直线工具使用该值。 */
export function spacingMeters(settings: Settings): number {
  if (!Number.isFinite(settings.frequencyHz) || settings.frequencyHz <= 0) {
    return 0;
  }
  return Math.max(0.01, settings.speedKmh / 3.6 / settings.frequencyHz);
}

export function startEpochMs(settings: Settings): number {
  const time = parseUtcDateTime(settings.startDate, settings.startTime);
  return time ?? Date.now();
}

export function pointTimeMs(settings: Settings, index: number): number {
  const frequency = clamp(settings.frequencyHz, 0.01, 100);
  return startEpochMs(settings) + (index * 1000) / frequency;
}

export function pointSpeedMps(
  points: readonly LatLng[],
  index: number,
  frequencyHz: number
): number {
  if (points.length < 2 || index < 0 || index >= points.length) {
    return 0;
  }
  const from = index === 0 ? 0 : index - 1;
  const to = Math.min(points.length - 1, from + 1);
  if (from === to) {
    return 0;
  }
  return haversineMeters(points[from], points[to]) * clamp(frequencyHz, 0.01, 100);
}

export function pointDistanceMeters(points: readonly LatLng[], index: number): number {
  if (index <= 0 || index >= points.length) {
    return 0;
  }
  return haversineMeters(points[index - 1], points[index]);
}

export function utcDateString(epochMs: number): string {
  const date = new Date(epochMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function utcTimeString(epochMs: number): string {
  const date = new Date(epochMs);
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

export function formatUtcStamp(epochMs: number): string {
  return `${utcDateString(epochMs)} ${utcTimeString(epochMs)} UTC`;
}

export function parseUtcDateTime(date: string, time: string): number | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!dateMatch || !timeMatch) {
    return null;
  }
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  const seconds = Number(timeMatch[3] ?? '0');
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hours > 23 ||
    minutes > 59 ||
    seconds > 59
  ) {
    return null;
  }
  const epoch = Date.UTC(year, month - 1, day, hours, minutes, seconds);
  return Number.isFinite(epoch) ? epoch : null;
}

/** 从 vscode.getState() 恢复并校验状态，避免旧版本/损坏数据导致脚本崩溃。 */
export function parsePersistedState(value: unknown): PersistedState | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.points)) {
    return null;
  }

  const points: LatLng[] = [];
  for (const raw of record.points) {
    if (raw === null || typeof raw !== 'object') {
      continue;
    }
    const point = raw as Record<string, unknown>;
    const candidate = { lat: Number(point.lat), lon: Number(point.lon) };
    if (isValidLatLng(candidate)) {
      points.push(candidate);
    }
  }

  const settings = parseSettings(record.settings);
  if (settings === null) {
    return null;
  }

  const rawIndex = Number(record.selectedIndex);
  const selectedIndex =
    Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < points.length ? rawIndex : -1;

  return { points, settings, selectedIndex };
}

function parseSettings(value: unknown): Settings | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const defaults = createDefaultSettings();
  const raw = value as Record<string, unknown>;

  const provider: MapProvider = raw.provider === 'google' ? 'google' : 'osm';
  const talkerId = TALKER_IDS.includes(raw.talkerId as TalkerId)
    ? (raw.talkerId as TalkerId)
    : defaults.talkerId;

  const startDate =
    typeof raw.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.startDate)
      ? raw.startDate
      : defaults.startDate;
  const startTime =
    typeof raw.startTime === 'string' && /^\d{2}:\d{2}(?::\d{2})?$/.test(raw.startTime)
      ? normalizeTime(raw.startTime)
      : defaults.startTime;
  const validStart = parseUtcDateTime(startDate, startTime) !== null;

  return {
    frequencyHz: round(clamp(numberOr(raw.frequencyHz, defaults.frequencyHz), 0.1, 50), 3),
    speedKmh: round(clamp(numberOr(raw.speedKmh, defaults.speedKmh), 0.1, 360), 1),
    startDate: validStart ? startDate : defaults.startDate,
    startTime: validStart ? startTime : defaults.startTime,
    talkerId,
    includeGga: booleanOr(raw.includeGga, defaults.includeGga),
    includeGsa: booleanOr(raw.includeGsa, defaults.includeGsa),
    includeRmc: booleanOr(raw.includeRmc, defaults.includeRmc),
    altitudeMeters: round(
      clamp(numberOr(raw.altitudeMeters, defaults.altitudeMeters), -500, 9000),
      1
    ),
    satellites: Math.round(clamp(numberOr(raw.satellites, defaults.satellites), 0, 32)),
    hdop: round(clamp(numberOr(raw.hdop, defaults.hdop), 0.1, 99), 1),
    provider
  };
}

function normalizeTime(value: string): string {
  return value.length === 5 ? `${value}:00` : value;
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

