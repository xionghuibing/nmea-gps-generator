import {
  bearingDegrees,
  clamp,
  haversineMeters,
  type LatLng
} from '../shared/geo';

export type TalkerId = 'GP' | 'BD' | 'GL' | 'GA';

export interface NmeaGenerationOptions {
  /** 每秒采样次数，例如 1 Hz 表示每点间隔 1 秒。 */
  frequencyHz: number;
  /** 第一个点的 UTC 时间（毫秒时间戳）。 */
  startEpochMs: number;
  talkerId?: TalkerId;
  includeGga?: boolean;
  includeGsa?: boolean;
  includeRmc?: boolean;
  altitudeMeters?: number;
  geoidSeparationMeters?: number;
  fixQuality?: number;
  satellites?: number;
  hdop?: number;
}

export interface FormattedCoordinate {
  value: string;
  hemisphere: string;
}

const KNOTS_PER_MPS = 3600 / 1852;

/** 将十进制度格式化为 NMEA 的 ddmm.mmmmm / dddmm.mmmmm。 */
export function formatNmeaCoordinate(
  degrees: number,
  degreeDigits: number
): FormattedCoordinate {
  const hemisphere = degreeDigits === 2 ? (degrees >= 0 ? 'N' : 'S') : degrees >= 0 ? 'E' : 'W';
  const absolute = Math.abs(degrees);
  let wholeDegrees = Math.floor(absolute);
  let minutes = (absolute - wholeDegrees) * 60;

  // 四舍五入后可能出现 60.00000，需要进位到度，避免非法分钟值。
  if (Number(minutes.toFixed(5)) >= 60) {
    wholeDegrees += 1;
    minutes = 0;
  }

  return {
    value: `${String(wholeDegrees).padStart(degreeDigits, '0')}${minutes
      .toFixed(5)
      .padStart(8, '0')}`,
    hemisphere
  };
}

export function formatNmeaTime(epochMs: number): string {
  const date = new Date(epochMs);
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  const centiseconds = Math.floor(date.getUTCMilliseconds() / 10);
  return `${hh}${mm}${ss}.${String(centiseconds).padStart(2, '0')}`;
}

export function formatNmeaDate(epochMs: number): string {
  const date = new Date(epochMs);
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = String(date.getUTCFullYear() % 100).padStart(2, '0');
  return `${day}${month}${year}`;
}

/** 计算 NMEA 语句中 $ 与 * 之间内容的 XOR 校验和。 */
export function nmeaChecksum(payload: string): string {
  let checksum = 0;
  for (let i = 0; i < payload.length; i++) {
    checksum ^= payload.charCodeAt(i) & 0xff;
  }
  return checksum.toString(16).toUpperCase().padStart(2, '0');
}

export function buildNmeaSentence(payload: string): string {
  return `$${payload}*${nmeaChecksum(payload)}`;
}

/**
 * 根据轨迹点生成 NMEA 日志。每个点（按 GGA、GSA、RMC 顺序）输出语句，
 * 点的时间间隔为 1 / frequencyHz 秒。点的经纬度来自绘制结果，速度与航向
 * 按相邻点的实际距离计算，因此手动绘制的轨迹速度是“真实”的。
 */
export function generateNmea(
  points: readonly LatLng[],
  options: NmeaGenerationOptions
): string {
  if (points.length === 0) {
    return '';
  }

  const frequencyHz = Number.isFinite(options.frequencyHz)
    ? clamp(options.frequencyHz, 0.01, 100)
    : 1;
  const startEpochMs = Number.isFinite(options.startEpochMs)
    ? options.startEpochMs
    : Date.now();
  const talkerId: TalkerId = options.talkerId ?? 'GP';
  const includeGga = options.includeGga ?? true;
  const includeGsa = options.includeGsa ?? true;
  const includeRmc = options.includeRmc ?? true;
  const altitude = Number.isFinite(options.altitudeMeters)
    ? (options.altitudeMeters as number)
    : 0;
  const geoid = Number.isFinite(options.geoidSeparationMeters)
    ? (options.geoidSeparationMeters as number)
    : 0;
  const fixQuality = Math.round(clamp(options.fixQuality ?? 1, 0, 8));
  const satellites = Math.round(clamp(options.satellites ?? 8, 0, 32));
  const hdop = clamp(options.hdop ?? 0.9, 0.1, 99);
  const vdop = clamp(hdop * 1.6, 0.1, 99);
  const pdop = Math.sqrt(hdop * hdop + vdop * vdop);
  const stepMs = 1000 / frequencyHz;

  const lines: string[] = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const timeMs = startEpochMs + i * stepMs;
    const time = formatNmeaTime(timeMs);
    const date = formatNmeaDate(timeMs);
    const latitude = formatNmeaCoordinate(point.lat, 2);
    const longitude = formatNmeaCoordinate(point.lon, 3);

    // 第 0 个点使用第一段的运动状态，最后一个点沿用最后一段。
    const fromIndex = i === 0 ? 0 : i - 1;
    const toIndex = Math.min(points.length - 1, fromIndex + 1);
    const hasSegment = points.length > 1;
    const speedMps = hasSegment
      ? haversineMeters(points[fromIndex], points[toIndex]) * frequencyHz
      : 0;
    const course =
      hasSegment && speedMps > 0
        ? bearingDegrees(points[fromIndex], points[toIndex])
        : 0;
    const speedKnots = speedMps * KNOTS_PER_MPS;

    if (includeGga) {
      lines.push(
        buildNmeaSentence(
          [
            `${talkerId}GGA`,
            time,
            latitude.value,
            latitude.hemisphere,
            longitude.value,
            longitude.hemisphere,
            String(fixQuality).padStart(1, '0'),
            String(satellites).padStart(2, '0'),
            hdop.toFixed(1),
            altitude.toFixed(1),
            'M',
            geoid.toFixed(1),
            'M',
            '',
            ''
          ].join(',')
        )
      );
    }

    if (includeGsa) {
      lines.push(
        buildNmeaSentence(
          [
            `${talkerId}GSA`,
            'A',
            satellites >= 4 ? '3' : '2',
            ...Array.from({ length: 12 }, () => ''),
            pdop.toFixed(1),
            hdop.toFixed(1),
            vdop.toFixed(1)
          ].join(',')
        )
      );
    }

    if (includeRmc) {
      lines.push(
        buildNmeaSentence(
          [
            `${talkerId}RMC`,
            time,
            'A',
            latitude.value,
            latitude.hemisphere,
            longitude.value,
            longitude.hemisphere,
            speedKnots.toFixed(2),
            course.toFixed(1),
            date,
            '',
            '',
            'A'
          ].join(',')
        )
      );
    }
  }

  return lines.length > 0 ? `${lines.join('\r\n')}\r\n` : '';
}
