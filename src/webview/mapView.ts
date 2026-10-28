import type { GoogleMapType } from '../shared/protocol';
import type { LatLng, MapViewState } from '../shared/geo';

declare const google: any;

export type Tool = 'add' | 'delete' | 'move' | 'line' | 'pan';

export interface MapRenderState {
  points: readonly LatLng[];
  selectedIndex: number;
  tool: Tool;
  /** “多点直线”工具的预览点（不含起点）。 */
  preview: readonly LatLng[];
}

export interface MapEventHandlers {
  click(latlng: LatLng): void;
  pointClick(index: number, latlng: LatLng): void;
  pointDragStart(index: number): void;
  pointDragEnd(index: number, latlng: LatLng): void;
  pointerMove(latlng: LatLng): void;
  tileError?(): void;
}

export interface MapInitOptions {
  tileUrl: string;
  tileAttribution: string;
  /** Google 底图类型；Leaflet 视图忽略该值。 */
  googleMapType?: GoogleMapType;
}

export interface MapView {
  readonly kind: 'leaflet' | 'google';
  init(
    container: HTMLElement,
    center: LatLng,
    zoom: number,
    options: MapInitOptions,
    handlers: MapEventHandlers
  ): void;
  destroy(): void;
  getView(): MapViewState;
  setView(center: LatLng, zoom: number): void;
  render(state: MapRenderState): void;
  /** 只刷新“多点直线”的预览层，避免鼠标移动时重绘整条轨迹。 */
  renderPreview(points: readonly LatLng[], preview: readonly LatLng[]): void;
  fit(points: readonly LatLng[]): void;
  setTileSource(url: string, attribution: string): void;
  /** 切换 Google 底图类型；Leaflet 视图为空实现。 */
  setGoogleMapType(type: GoogleMapType): void;
  refreshTiles(): void;
  /** 面板尺寸变化时让地图重新计算可视区域。 */
  invalidateSize(): void;
}

export const BUDAPEST_ZOOM = 14;

let googleMapsPromise: Promise<void> | null = null;

/** 动态加载 Google Maps JavaScript API（只加载一次）。 */
export function loadGoogleMaps(apiKey: string): Promise<void> {
  if (typeof google !== 'undefined' && google.maps) {
    return Promise.resolve();
  }
  if (googleMapsPromise !== null) {
    return googleMapsPromise;
  }

  googleMapsPromise = new Promise<void>((resolve, reject) => {
    const callbackName = '__nmeaGenGoogleMapsReady';
    const globalWindow = window as unknown as Record<string, unknown>;
    let settled = false;

    const timer = window.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      googleMapsPromise = null;
      reject(new Error('加载 Google 地图超时'));
    }, 20000);

    globalWindow[callbackName] = () => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      resolve();
    };

    const script = document.createElement('script');
    script.src =
      'https://maps.googleapis.com/maps/api/js' +
      `?key=${encodeURIComponent(apiKey)}&v=weekly&loading=async&callback=${callbackName}`;
    script.async = true;
    script.onerror = () => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      googleMapsPromise = null;
      reject(new Error('无法加载 Google Maps JavaScript API'));
    };
    document.head.appendChild(script);
  });

  return googleMapsPromise;
}
