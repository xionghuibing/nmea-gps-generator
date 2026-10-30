import { isValidLatLng, type LatLng } from '../shared/geo';

/** 一次地址检索得到的地点。 */
export interface PlaceResult {
  label: string;
  center: LatLng;
}

/**
 * Photon 是基于 OpenStreetMap 的开放地理编码服务，无需 API Key、支持 CORS，
 * 因此 OSM 与 Google 底图共用同一个检索服务，不受底图提供商切换影响。
 */
const PHOTON_ENDPOINT = 'https://photon.komoot.io/api/';
const MAX_RESULTS = 5;

interface PhotonFeature {
  geometry?: { coordinates?: unknown };
  properties?: Record<string, unknown>;
}

/** 把地址文本转换为若干候选地点；调用方可用 signal 取消上一次检索。 */
export async function searchPlaces(
  query: string,
  signal?: AbortSignal
): Promise<PlaceResult[]> {
  const params = new URLSearchParams({ q: query, limit: String(MAX_RESULTS) });
  let response: Response;
  try {
    response = await fetch(`${PHOTON_ENDPOINT}?${params.toString()}`, {
      signal,
      headers: { Accept: 'application/json' }
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new Error('无法连接地址检索服务，请检查网络或代理，也可以直接输入坐标。');
  }

  if (!response.ok) {
    throw new Error(`地址检索失败（HTTP ${response.status}），请稍后重试或直接输入坐标。`);
  }

  const payload: unknown = await response.json();
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('地址检索返回了无法识别的数据，请直接输入坐标。');
  }
  const features = (payload as { features?: unknown }).features;
  if (!Array.isArray(features)) {
    throw new Error('地址检索返回了无法识别的数据，请直接输入坐标。');
  }

  const results: PlaceResult[] = [];
  for (const feature of features) {
    const result = toPlaceResult(feature);
    if (result !== null) {
      results.push(result);
    }
  }
  return results;
}

function toPlaceResult(feature: unknown): PlaceResult | null {
  if (typeof feature !== 'object' || feature === null) {
    return null;
  }
  const { geometry, properties } = feature as PhotonFeature;
  const coordinates = geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return null;
  }
  const center: LatLng = { lat: Number(coordinates[1]), lon: Number(coordinates[0]) };
  if (!isValidLatLng(center)) {
    return null;
  }
  return {
    center,
    label: describePlace(properties ?? {})
  };
}

/** 把 Photon 的属性拼成「名称, 街道门牌, 城市, 省/州, 国家」，并去掉重复片段。 */
function describePlace(properties: Record<string, unknown>): string {
  const value = (key: string): string => {
    const raw = properties[key];
    return typeof raw === 'string' ? raw.trim() : '';
  };
  const name = value('name');
  const street = value('street');
  const houseNumber = value('housenumber');
  const streetLine =
    street === '' ? '' : houseNumber === '' ? street : `${street} ${houseNumber}`;
  const locality = value('city') || value('district') || value('locality');

  const parts: string[] = [];
  for (const part of [name, streetLine, locality, value('state'), value('country')]) {
    if (part !== '' && !parts.includes(part)) {
      parts.push(part);
    }
  }
  return parts.length > 0 ? parts.join(', ') : '（未命名地点）';
}
