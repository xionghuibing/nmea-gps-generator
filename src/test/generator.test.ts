import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildNmeaSentence,
  formatNmeaCoordinate,
  formatNmeaDate,
  formatNmeaTime,
  generateNmea,
  nmeaChecksum,
  type NmeaGenerationOptions
} from '../nmea/generator';
import { exportCsv, parseCsvCoordinates, parseNmeaTrack } from '../nmea/parse';
import {
  bearingDegrees,
  destinationPoint,
  haversineMeters,
  linePoints,
  pathLength
} from '../shared/geo';
import { parsePersistedState } from '../webview/settings';

const START = Date.UTC(2024, 0, 2, 3, 4, 5);
const BUDAPEST_A = { lat: 47.4979, lon: 19.0402 };
const BUDAPEST_B = { lat: 47.4989, lon: 19.0402 };
const BUDAPEST_C = { lat: 47.4999, lon: 19.0403 };

const baseOptions: NmeaGenerationOptions = {
  frequencyHz: 1,
  startEpochMs: START,
  talkerId: 'GP',
  includeGga: true,
  includeGsa: true,
  includeRmc: true,
  altitudeMeters: 120,
  satellites: 8,
  hdop: 0.9
};

function sentenceFields(line: string): string[] {
  return line.slice(1, line.indexOf('*')).split(',');
}

function assertValidChecksum(line: string): void {
  const star = line.lastIndexOf('*');
  assert.ok(star > 0, `缺少校验和: ${line}`);
  assert.equal(nmeaChecksum(line.slice(1, star)), line.slice(star + 1), line);
}

test('格式化 NMEA 经纬度', () => {
  assert.deepEqual(formatNmeaCoordinate(47.4979, 2), {
    value: '4729.87400',
    hemisphere: 'N'
  });
  assert.deepEqual(formatNmeaCoordinate(19.0402, 3), {
    value: '01902.41200',
    hemisphere: 'E'
  });
  assert.deepEqual(formatNmeaCoordinate(-33.8688, 2), {
    value: '3352.12800',
    hemisphere: 'S'
  });
  assert.deepEqual(formatNmeaCoordinate(-0.1276, 3), {
    value: '00007.65600',
    hemisphere: 'W'
  });
});

test('格式化 UTC 时间与日期', () => {
  const epoch = Date.UTC(2024, 0, 2, 3, 4, 5, 670);
  assert.equal(formatNmeaTime(epoch), '030405.67');
  assert.equal(formatNmeaDate(epoch), '020124');
});

test('NMEA 校验和与语句构造', () => {
  const payload = 'GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,';
  assert.equal(nmeaChecksum(payload), '47');
  assert.equal(buildNmeaSentence(payload), `$${payload}*47`);
});

test('生成 GGA / GSA / RMC 并计算速度与航向', () => {
  const content = generateNmea([BUDAPEST_A, BUDAPEST_B], baseOptions);
  const lines = content.trim().split('\r\n');
  assert.equal(lines.length, 6);
  lines.forEach(assertValidChecksum);

  const gga = sentenceFields(lines[0]);
  assert.equal(gga[0], 'GPGGA');
  assert.equal(gga[1], '030405.00');
  assert.equal(gga[2], '4729.87400');
  assert.equal(gga[3], 'N');
  assert.equal(gga[4], '01902.41200');
  assert.equal(gga[5], 'E');
  assert.equal(gga[6], '1');
  assert.equal(gga[7], '08');
  assert.equal(gga[9], '120.0');

  const gsa = sentenceFields(lines[1]);
  assert.equal(gsa[0], 'GPGSA');
  assert.equal(gsa[1], 'A');
  assert.equal(gsa[2], '3');
  assert.equal(gsa.length, 18);

  const rmc = sentenceFields(lines[2]);
  assert.equal(rmc[0], 'GPRMC');
  assert.equal(rmc[1], '030405.00');
  assert.equal(rmc[2], 'A');
  assert.equal(rmc[9], '020124');
  assert.equal(rmc[12], 'A');
  const expectedKnots = haversineMeters(BUDAPEST_A, BUDAPEST_B) * (3600 / 1852);
  assert.ok(Math.abs(Number(rmc[7]) - expectedKnots) < 0.01);
  assert.equal(rmc[8], '0.0');
});

test('频率决定时间戳间隔', () => {
  const content = generateNmea([BUDAPEST_A, BUDAPEST_B], {
    ...baseOptions,
    frequencyHz: 2
  });
  const lines = content.trim().split('\r\n');
  assert.equal(sentenceFields(lines[0])[1], '030405.00');
  assert.equal(sentenceFields(lines[3])[1], '030405.50');
});

test('可只生成指定语句，且空轨迹返回空字符串', () => {
  const rmcOnly = generateNmea([BUDAPEST_A], {
    ...baseOptions,
    includeGga: false,
    includeGsa: false,
    includeRmc: true
  });
  const lines = rmcOnly.trim().split('\r\n');
  assert.equal(lines.length, 1);
  assert.equal(sentenceFields(lines[0])[0], 'GPRMC');

  assert.equal(
    generateNmea([BUDAPEST_A], {
      ...baseOptions,
      includeGga: false,
      includeGsa: false,
      includeRmc: false
    }),
    ''
  );
  assert.equal(generateNmea([], baseOptions), '');
});

test('生成的 NMEA 可以重新导入并恢复坐标、时间与频率', () => {
  const points = [BUDAPEST_A, BUDAPEST_B, BUDAPEST_C];
  const content = generateNmea(points, { ...baseOptions, frequencyHz: 2 });
  const parsed = parseNmeaTrack(content);

  assert.equal(parsed.points.length, 3);
  assert.equal(parsed.frequencyHz, 2);
  assert.equal(parsed.startEpochMs, START);
  for (let i = 0; i < points.length; i++) {
    assert.ok(Math.abs(parsed.points[i].lat - points[i].lat) < 1e-6);
    assert.ok(Math.abs(parsed.points[i].lon - points[i].lon) < 1e-6);
  }
  assert.equal(parsed.warnings.length, 0);
  assert.ok((parsed.speedMps ?? 0) > 0);
});

test('校验和错误的语句会被跳过并给出警告', () => {
  const content = generateNmea([BUDAPEST_A, BUDAPEST_B, BUDAPEST_C], baseOptions);
  const lines = content.trim().split('\r\n');
  lines[0] = `${lines[0].slice(0, lines[0].lastIndexOf('*') + 1)}00`;
  const parsed = parseNmeaTrack(lines.join('\r\n'));
  assert.equal(parsed.points.length, 2);
  assert.ok(parsed.warnings.some((warning) => warning.includes('校验和')));
});

test('CSV 导出与导入', () => {
  const csv = exportCsv([BUDAPEST_A, BUDAPEST_B]);
  assert.ok(csv.startsWith('latitude,longitude\n'));
  assert.ok(csv.includes('47.4979000,19.0402000'));

  const parsed = parseCsvCoordinates(
    'latitude,longitude\n47.4979,19.0402\n\n无效行\n47.4989,19.0402,120\n'
  );
  assert.equal(parsed.points.length, 2);
  assert.ok(parsed.warnings.some((warning) => warning.includes('跳过')));
});

test('持久化状态会过滤非法点并校正选中索引', () => {
  const restored = parsePersistedState({
    points: [
      { lat: 100, lon: 0 },
      { lat: 47.5, lon: 19.04 }
    ],
    settings: {},
    selectedIndex: 9
  });
  assert.ok(restored !== null);
  assert.equal(restored.points.length, 1);
  assert.equal(restored.selectedIndex, -1);
});

test('支持北斗（BD）信号源并生成 BD 前缀语句', () => {
  const content = generateNmea([BUDAPEST_A, BUDAPEST_B], {
    ...baseOptions,
    talkerId: 'BD'
  });
  const lines = content.trim().split('\r\n');
  assert.equal(sentenceFields(lines[0])[0], 'BDGGA');
  assert.equal(sentenceFields(lines[1])[0], 'BDGSA');
  assert.equal(sentenceFields(lines[2])[0], 'BDRMC');
  lines.forEach(assertValidChecksum);
  assert.equal(parseNmeaTrack(content).points.length, 2);
});

test('旧的 GN 信号源设置会回退为 GP', () => {
  const restored = parsePersistedState({
    points: [],
    settings: { talkerId: 'GN' },
    selectedIndex: -1
  });
  assert.ok(restored !== null);
  assert.equal(restored.settings.talkerId, 'GP');
});

test('持久化状态保留并校验 Google 地图类型', () => {
  const restored = parsePersistedState({
    points: [],
    settings: { provider: 'google', googleMapType: 'satellite' },
    selectedIndex: -1
  });
  assert.ok(restored !== null);
  assert.equal(restored.settings.provider, 'google');
  assert.equal(restored.settings.googleMapType, 'satellite');

  const fallback = parsePersistedState({
    points: [],
    settings: { provider: 'google', googleMapType: 'dark' },
    selectedIndex: -1
  });
  assert.ok(fallback !== null);
  assert.equal(fallback.settings.googleMapType, 'roadmap');
});

test('大圆距离、方位角与等间距取点', () => {
  const equator = { lat: 0, lon: 0 };
  const oneDegreeEast = { lat: 0, lon: 1 };
  assert.ok(Math.abs(haversineMeters(equator, oneDegreeEast) - 111195) < 5);
  assert.ok(Math.abs(bearingDegrees(equator, oneDegreeEast) - 90) < 1e-9);

  const destination = destinationPoint(
    equator,
    haversineMeters(equator, oneDegreeEast),
    90
  );
  assert.ok(Math.abs(destination.lat) < 1e-9);
  assert.ok(Math.abs(destination.lon - 1) < 1e-6);

  const target = { lat: 47.5079, lon: 19.0402 };
  const line = linePoints(BUDAPEST_A, target, 100);
  assert.ok(line.length >= 10);
  let previous = BUDAPEST_A;
  for (const point of line) {
    assert.ok(Math.abs(haversineMeters(previous, point) - 100) < 0.2);
    previous = point;
  }
  assert.ok(
    pathLength([BUDAPEST_A, ...line, target]) >=
      haversineMeters(BUDAPEST_A, target) - 0.01
  );
});

