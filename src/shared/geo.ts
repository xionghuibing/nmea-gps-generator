/** 经纬度坐标（WGS84）。 */
export interface LatLng {
  lat: number;
  lon: number;
}

export interface MapViewState {
  center: LatLng;
  zoom: number;
}

export const BUDAPEST: LatLng = { lat: 47.4979, lon: 19.0402 };

const EARTH_RADIUS_METERS = 6371008.8;

export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

export function isValidLatLng(value: LatLng): boolean {
  return (
    Number.isFinite(value.lat) &&
    Number.isFinite(value.lon) &&
    value.lat >= -90 &&
    value.lat <= 90 &&
    value.lon >= -180 &&
    value.lon <= 180
  );
}

/** 球面大圆距离（米）。 */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLat = lat2 - lat1;
  const deltaLon = toRadians(b.lon - a.lon);

  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 从 a 指向 b 的初始方位角（0 = 正北，顺时针 0..360）。 */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLon = toRadians(b.lon - a.lon);

  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  const bearing = toDegrees(Math.atan2(y, x));
  return (bearing + 360) % 360;
}

/** 从 origin 沿 bearing 前进 distanceMeters 后的坐标。 */
export function destinationPoint(
  origin: LatLng,
  distanceMeters: number,
  bearing: number
): LatLng {
  if (distanceMeters === 0) {
    return { ...origin };
  }
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;
  const theta = toRadians(bearing);
  const lat1 = toRadians(origin.lat);
  const lon1 = toRadians(origin.lon);

  const sinLat2 =
    Math.sin(lat1) * Math.cos(angularDistance) +
    Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(theta);
  const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * sinLat2
    );

  return {
    lat: toDegrees(lat2),
    lon: normalizeLongitude(toDegrees(lon2))
  };
}

export function normalizeLongitude(lon: number): number {
  let normalized = ((lon + 180) % 360 + 360) % 360 - 180;
  if (normalized === -180 && lon > 0) {
    normalized = 180;
  }
  return normalized;
}

/** 轨迹累计长度（米）。 */
export function pathLength(points: readonly LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineMeters(points[i - 1], points[i]);
  }
  return total;
}

/**
 * 在 origin 与 target 的连线上按间距取点（不含 origin，含接近 target 的最后一个整间距点）。
 * 用于“多点直线”工具，保证生成的点等间距，从而在固定频率下速度恒定。
 */
export function linePoints(
  origin: LatLng,
  target: LatLng,
  spacingMeters: number,
  maxPoints = 2000
): LatLng[] {
  if (!Number.isFinite(spacingMeters) || spacingMeters <= 0) {
    return [];
  }
  const distance = haversineMeters(origin, target);
  if (distance < 1e-3) {
    return [];
  }

  const bearing = bearingDegrees(origin, target);
  const result: LatLng[] = [];
  const count = Math.min(maxPoints, Math.floor(distance / spacingMeters));
  for (let i = 1; i <= count; i++) {
    result.push(destinationPoint(origin, spacingMeters * i, bearing));
  }
  return result;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Web 墨卡托（256 px 瓦片）在 zoom 0 时赤道处的地面分辨率（米/像素）。 */
const WEB_MERCATOR_METERS_PER_PIXEL_AT_ZOOM_0 = 156543.03392;

/**
 * 计算让地图比例尺约为 `scaleMeters / scalePixels`（默认 50 m / 100 px）的整数缩放级别。
 * Web 墨卡托的地面分辨率随纬度按 cos(lat) 收缩，因此高纬度地区使用更小的缩放级别。
 * 结果向下取整，使比例尺刻度条不超过给定像素宽度，且尽量显示 50 m 这一整刻度。
 */
export function zoomForScale(latitude: number, scaleMeters = 50, scalePixels = 100): number {
  const metersPerPixel = Math.max(scaleMeters, 1e-6) / Math.max(scalePixels, 1);
  const latRad = toRadians(clamp(latitude, -85, 85));
  const idealZoom = Math.log2(
    (WEB_MERCATOR_METERS_PER_PIXEL_AT_ZOOM_0 * Math.cos(latRad)) / metersPerPixel
  );
  return clamp(Math.floor(idealZoom), 1, 19);
}

export function clonePoints(points: readonly LatLng[]): LatLng[] {
  return points.map((point) => ({ lat: point.lat, lon: point.lon }));
}
