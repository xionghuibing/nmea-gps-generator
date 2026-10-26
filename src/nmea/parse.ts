import { clamp, isValidLatLng, pathLength, type LatLng } from '../shared/geo';
import { nmeaChecksum } from './generator';

export interface NmeaImportResult {
  points: LatLng[];
  startEpochMs: number | null;
  frequencyHz: number | null;
  speedMps: number | null;
  warnings: string[];
}

export interface CsvImportResult {
  points: LatLng[];
  warnings: string[];
}

interface UtcDate {
  year: number;
  month: number;
  day: number;
}

interface GgaRecord {
  lat: number;
  lon: number;
  timeSeconds: number;
}

interface RmcRecord {
  lat: number;
  lon: number;
  timeSeconds: number;
  date: UtcDate | null;
}

/**
 * 解析 NMEA 日志中的 GGA / RMC 定位语句。
 * 有 GGA 时优先使用 GGA 的位置（与 nmeagen 一致），日期从 RMC 获取；
 * 没有 GGA 时使用 RMC 的位置与日期。校验和存在但错误的语句会被跳过。
 */
export function parseNmeaTrack(text: string): NmeaImportResult {
  const ggaRecords: GgaRecord[] = [];
  const rmcRecords: RmcRecord[] = [];
  let invalidChecksums = 0;
  let skippedSentences = 0;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('$')) {
      continue;
    }

    const starIndex = trimmed.lastIndexOf('*');
    let payload: string;
    if (starIndex >= 0) {
      payload = trimmed.slice(1, starIndex);
      const provided = trimmed.slice(starIndex + 1, starIndex + 3).toUpperCase();
      if (/^[0-9A-F]{2}$/.test(provided) && nmeaChecksum(payload) !== provided) {
        invalidChecksums++;
        continue;
      }
    } else {
      payload = trimmed.slice(1);
    }

    const fields = payload.split(',');
    if (fields.length < 2) {
      continue;
    }
    const id = fields[0].toUpperCase();

    if (id.endsWith('GGA')) {
      const timeSeconds = parseTimeOfDay(fields[1] ?? '');
      const lat = parseNmeaCoordinate(fields[2] ?? '', fields[3] ?? '', 2);
      const lon = parseNmeaCoordinate(fields[4] ?? '', fields[5] ?? '', 3);
      const fixQuality = Number(fields[6] ?? '0');
      if (timeSeconds === null || lat === null || lon === null || fixQuality <= 0) {
        skippedSentences++;
        continue;
      }
      ggaRecords.push({ lat, lon, timeSeconds });
      continue;
    }

    if (id.endsWith('RMC')) {
      const timeSeconds = parseTimeOfDay(fields[1] ?? '');
      const status = (fields[2] ?? '').toUpperCase();
      const lat = parseNmeaCoordinate(fields[3] ?? '', fields[4] ?? '', 2);
      const lon = parseNmeaCoordinate(fields[5] ?? '', fields[6] ?? '', 3);
      if (timeSeconds === null || lat === null || lon === null || status !== 'A') {
        skippedSentences++;
        continue;
      }
      const date = parseNmeaDate(fields[9] ?? '');
      rmcRecords.push({ lat, lon, timeSeconds, date });
    }
  }

  const warnings: string[] = [];
  if (invalidChecksums > 0) {
    warnings.push(`${invalidChecksums} 条语句校验和无效，已跳过。`);
  }

  if (ggaRecords.length === 0 && rmcRecords.length === 0) {
    warnings.push('未找到有效的 GGA 或 RMC 定位语句。');
    return { points: [], startEpochMs: null, frequencyHz: null, speedMps: null, warnings };
  }

  let points: LatLng[];
  let timestamps: number[];

  if (ggaRecords.length > 0) {
    const dateFromRmc = rmcRecords.find((record) => record.date !== null)?.date ?? null;
    if (dateFromRmc === null) {
      warnings.push('NMEA 文件不包含 RMC 日期，已使用今天的 UTC 日期。');
    }
    timestamps = buildTimestamps(
      ggaRecords.map((record) => ({ timeSeconds: record.timeSeconds, date: null })),
      dateFromRmc ?? todayUtc()
    );
    points = ggaRecords.map((record) => ({ lat: record.lat, lon: record.lon }));
  } else {
    if (!rmcRecords.every((record) => record.date !== null)) {
      warnings.push('NMEA 文件缺少部分日期信息，缺失处已使用今天的 UTC 日期。');
    }
    timestamps = buildTimestamps(
      rmcRecords.map((record) => ({ timeSeconds: record.timeSeconds, date: record.date })),
      todayUtc()
    );
    points = rmcRecords.map((record) => ({ lat: record.lat, lon: record.lon }));
  }

  if (skippedSentences > 0) {
    warnings.push(`${skippedSentences} 条定位语句不完整，已跳过。`);
  }

  const validPoints = points.filter((point) => isValidLatLng(point));
  if (validPoints.length !== points.length) {
    points = validPoints;
    warnings.push('部分坐标超出合法范围，已跳过。');
  }

  const frequencyHz = estimateFrequency(timestamps);
  const speedMps = estimateAverageSpeed(points, timestamps, frequencyHz);

  return {
    points,
    startEpochMs: timestamps.length > 0 ? timestamps[0] : null,
    frequencyHz,
    speedMps,
    warnings
  };
}

/** 解析 CSV 坐标：每行 `latitude,longitude`（可带第三列海拔），支持表头与注释。 */
export function parseCsvCoordinates(text: string): CsvImportResult {
  const points: LatLng[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  let sawData = false;

  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }

    const parts = trimmed.split(/[,;\t ]+/).filter((part) => part.length > 0);
    const lat = Number(parts[0]);
    const lon = Number(parts[1]);
    const valid =
      parts.length >= 2 &&
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180;

    if (!valid) {
      // 数据开始前的行通常是表头或说明，不视为错误。
      if (!sawData) {
        continue;
      }
      skipped++;
      continue;
    }

    sawData = true;
    points.push({ lat, lon });
  }

  if (skipped > 0) {
    warnings.push(`${skipped} 行不是有效坐标，已跳过。`);
  }
  if (points.length === 0) {
    warnings.push('CSV 中没有可用的经纬度坐标。');
  }

  return { points, warnings };
}

/** 导出 CSV（含表头，7 位小数，约 1 cm 精度）。 */
export function exportCsv(points: readonly LatLng[]): string {
  const lines = ['latitude,longitude'];
  for (const point of points) {
    lines.push(`${point.lat.toFixed(7)},${point.lon.toFixed(7)}`);
  }
  return `${lines.join('\n')}\n`;
}

function buildTimestamps(
  records: ReadonlyArray<{ timeSeconds: number; date: UtcDate | null }>,
  fallbackDate: UtcDate
): number[] {
  const timestamps: number[] = [];
  let previousTime = -1;
  let dayOffset = 0;
  let lastDate = fallbackDate;

  for (const record of records) {
    if (record.date !== null) {
      lastDate = record.date;
      dayOffset = 0;
    } else if (previousTime >= 0 && record.timeSeconds < previousTime - 12 * 3600) {
      // 时间倒退超过 12 小时，视为跨过 UTC 午夜。
      dayOffset++;
    }

    const base =
      Date.UTC(lastDate.year, lastDate.month - 1, lastDate.day) +
      (dayOffset * 24 * 3600 + record.timeSeconds) * 1000;
    timestamps.push(Math.round(base));
    previousTime = record.timeSeconds;
  }

  return timestamps;
}

function estimateFrequency(timestamps: readonly number[]): number | null {
  if (timestamps.length < 2) {
    return null;
  }
  const deltas: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    const delta = timestamps[i] - timestamps[i - 1];
    if (delta > 5 && delta <= 3600 * 1000) {
      deltas.push(delta);
    }
  }
  if (deltas.length === 0) {
    return null;
  }
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  return Math.round(clamp(1000 / median, 0.01, 100) * 1000) / 1000;
}

function estimateAverageSpeed(
  points: readonly LatLng[],
  timestamps: readonly number[],
  frequencyHz: number | null
): number | null {
  if (points.length < 2) {
    return null;
  }
  const durationSeconds =
    timestamps.length === points.length && timestamps[timestamps.length - 1] > timestamps[0]
      ? (timestamps[timestamps.length - 1] - timestamps[0]) / 1000
      : frequencyHz !== null
        ? (points.length - 1) / frequencyHz
        : 0;
  if (durationSeconds <= 0) {
    return null;
  }
  const speed = pathLength(points) / durationSeconds;
  return Number.isFinite(speed) ? Math.round(speed * 1000) / 1000 : null;
}

function parseTimeOfDay(value: string): number | null {
  const match = /^(\d{2})(\d{2})(\d{2})(?:\.(\d+))?$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (hours > 23 || minutes > 59 || seconds > 59) {
    return null;
  }
  const fraction = match[4] ? Number(`0.${match[4]}`) : 0;
  return hours * 3600 + minutes * 60 + seconds + fraction;
}

function parseNmeaDate(value: string): UtcDate | null {
  const match = /^(\d{2})(\d{2})(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  const shortYear = Number(match[3]);
  const year = shortYear >= 80 ? 1900 + shortYear : 2000 + shortYear;
  if (day < 1 || day > 31 || month < 1 || month > 12) {
    return null;
  }
  return { year, month, day };
}

function parseNmeaCoordinate(
  value: string,
  hemisphere: string,
  degreeDigits: number
): number | null {
  if (value.trim().length === 0) {
    return null;
  }
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw < 0) {
    return null;
  }
  const degrees = Math.floor(raw / 100);
  const minutes = raw - degrees * 100;
  if (minutes >= 60) {
    return null;
  }
  const hemi = hemisphere.trim().toUpperCase();
  const sign = hemi === 'S' || hemi === 'W' ? -1 : 1;
  const result = sign * (degrees + minutes / 60);
  if (degreeDigits === 2 && Math.abs(result) > 90) {
    return null;
  }
  if (degreeDigits === 3 && Math.abs(result) > 180) {
    return null;
  }
  return result;
}

function todayUtc(): UtcDate {
  const now = new Date();
  return {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    day: now.getUTCDate()
  };
}
