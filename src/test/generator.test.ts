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
import { parseCoordinateInput } from '../shared/coords';
import {
  bearingDegrees,
  destinationPoint,
  haversineMeters,
  linePoints,
  pathLength,
  zoomForScale
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

test('持久化状态保留并校验底图提供商', () => {
  const restored = parsePersistedState({
    points: [],
    settings: { provider: 'google' },
    selectedIndex: -1
  });
  assert.ok(restored !== null);
  assert.equal(restored.settings.provider, 'google');

  const fallback = parsePersistedState({
    points: [],
    settings: { provider: 'bing' },
    selectedIndex: -1
  });
  assert.ok(fallback !== null);
  assert.equal(fallback.settings.provider, 'osm');
});

test('解析搜索框坐标输入', () => {
  assert.deepEqual(parseCoordinateInput('47.4979, 19.0402'), { lat: 47.4979, lon: 19.0402 });
  assert.deepEqual(parseCoordinateInput('47.4979 19.0402'), { lat: 47.4979, lon: 19.0402 });
  assert.deepEqual(parseCoordinateInput('47.4979,19.0402'), { lat: 47.4979, lon: 19.0402 });
  assert.deepEqual(parseCoordinateInput('19.0402E 47.4979N'), {
    lat: 47.4979,
    lon: 19.0402
  });
  assert.deepEqual(parseCoordinateInput('N47.4979 E19.0402'), { lat: 47.4979, lon: 19.0402 });
  assert.deepEqual(parseCoordinateInput('47.4979N, 19.0402E'), { lat: 47.4979, lon: 19.0402 });
  assert.deepEqual(parseCoordinateInput('纬度: 47.4979 经度: 19.0402'), {
    lat: 47.4979,
    lon: 19.0402
  });
  assert.deepEqual(parseCoordinateInput('东经116.3913 北纬39.9074'), {
    lat: 39.9074,
    lon: 116.3913
  });
  assert.deepEqual(parseCoordinateInput('-33.8688, 151.2093'), {
    lat: -33.8688,
    lon: 151.2093
  });

  const dms = parseCoordinateInput('47°29\'52.4"N 19°2\'24.7"E');
  assert.ok(dms !== null);
  assert.ok(Math.abs(dms.lat - 47.4978889) < 1e-6);
  assert.ok(Math.abs(dms.lon - 19.0401944) < 1e-6);

  const spacedDms = parseCoordinateInput('N 47° 29′ 52.4″ E 19° 2′ 24.7″');
  assert.ok(spacedDms !== null);
  assert.ok(Math.abs(spacedDms.lat - 47.4978889) < 1e-6);
  assert.ok(Math.abs(spacedDms.lon - 19.0401944) < 1e-6);

  assert.equal(parseCoordinateInput('91, 19'), null);
  assert.equal(parseCoordinateInput('47.4979'), null);
  // 三个及以上数字更可能是地址门牌，不做猜测（度分秒只要带符号仍是一个分量）。
  assert.equal(parseCoordinateInput('47 29 52.4 19 2 24.7'), null);
  assert.equal(parseCoordinateInput('1087 Budapest, Baross tér 1'), null);
  assert.equal(parseCoordinateInput(''), null);
});

test('定位缩放级别对应约 50 m 比例尺', () => {
  // 比例尺按 100 px 宽度绘制，50 m 对应约 0.5 m/像素。
  const metersPerPixel = (lat: number, zoom: number): number =>
    (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;

  for (const lat of [0, 23.5, 39.9074, 47.4979, 60, -33.8688]) {
    const zoom = zoomForScale(lat);
    assert.ok(zoom >= 14 && zoom <= 19, `纬度 ${lat} 应落在街道级缩放：${zoom}`);
    const resolution = metersPerPixel(lat, zoom);
    assert.ok(
      resolution >= 0.5 && resolution < 1,
      `纬度 ${lat} 的 ${zoom} 级应约为 0.5–1 m/像素：${resolution}`
    );
  }

  // 赤道处墨卡托投影不收缩，比高纬度地区多放大一级。
  assert.equal(zoomForScale(0), 18);
  assert.equal(zoomForScale(47.4979), 17);
  assert.equal(zoomForScale(60), 17);
  // 超出墨卡托可用纬度时按 ±85° 计算，避免数值退化。
  assert.equal(zoomForScale(90), zoomForScale(85));
  // 目标比例尺超出瓦片最大级别时，收敛到 19 级。
  assert.equal(zoomForScale(0, 0.5), 19);
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

