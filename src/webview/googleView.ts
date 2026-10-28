import type { LatLng, MapViewState } from '../shared/geo';
import type {
  MapEventHandlers,
  MapInitOptions,
  MapRenderState,
  MapView
} from './mapView';
import { LIGHT_GOOGLE_STYLE } from './mapView';

declare const google: any;

/**
 * Google Maps JavaScript API 视图。固定 roadmap + LIGHT_GOOGLE_STYLE（浅色）。
 * 底图切换/瓦片刷新不适用于 Google，因此 setTileSource/refreshTiles 为空实现。
 */
export class GoogleMapView implements MapView {
  public readonly kind = 'google' as const;

  private map: any = null;
  private container: HTMLElement | null = null;
  private handlers: MapEventHandlers | null = null;
  private state: MapRenderState = { points: [], selectedIndex: -1, tool: 'add', preview: [] };
  private overlays: any[] = [];
  private previewOverlays: any[] = [];
  private listeners: any[] = [];
  private markerListeners: any[] = [];

  public init(
    container: HTMLElement,
    center: LatLng,
    zoom: number,
    _options: MapInitOptions,
    handlers: MapEventHandlers
  ): void {
    this.container = container;
    this.handlers = handlers;
    this.map = new google.maps.Map(container, {
      center: { lat: center.lat, lng: center.lon },
      zoom,
      mapTypeId: 'roadmap',
      styles: LIGHT_GOOGLE_STYLE,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      clickableIcons: false,
      gestureHandling: 'greedy',
      backgroundColor: '#f5f5f5'
    });
    this.listeners.push(this.map.addListener('click', (event: any) => this.onMapClick(event)));
    this.listeners.push(
      this.map.addListener('mousemove', (event: any) => this.onMouseMove(event))
    );
  }

  public destroy(): void {
    this.clearOverlays();
    for (const listener of this.listeners) {
      google.maps.event.removeListener(listener);
    }
    this.listeners = [];
    this.map = null;
    this.container = null;
    this.handlers = null;
  }

  public getView(): MapViewState {
    if (!this.map) {
      return { center: { lat: 0, lon: 0 }, zoom: 2 };
    }
    const center = this.map.getCenter();
    return {
      center: { lat: center.lat(), lon: center.lng() },
      zoom: this.map.getZoom() ?? 2
    };
  }

  public setView(center: LatLng, zoom: number): void {
    if (!this.map) {
      return;
    }
    this.map.setCenter({ lat: center.lat, lng: center.lon });
    this.map.setZoom(zoom);
  }

  public setTileSource(_url: string, _attribution: string): void {
    // Google 底图样式固定，忽略 OSM 瓦片配置。
  }

  public refreshTiles(): void {
    // Google 底图由 API 自行处理瓦片，无需手动刷新。
  }

  public invalidateSize(): void {
    if (this.map) {
      google.maps.event.trigger(this.map, 'resize');
    }
  }

  public render(state: MapRenderState): void {
    this.state = state;
    this.clearOverlays();
    if (!this.map) {
      return;
    }

    const points = state.points;
    if (points.length >= 2) {
      this.add(
        new google.maps.Polyline({
          map: this.map,
          path: points.map((point) => ({ lat: point.lat, lng: point.lon })),
          strokeColor: '#1d4ed8',
          strokeOpacity: 0.9,
          strokeWeight: 4,
          clickable: false
        })
      );
    }

    // 与 Leaflet 视图一致，点很多时只画折线，保证性能。
    if (points.length > 0 && points.length <= 300) {
      for (const point of points) {
        this.add(
          new google.maps.Marker({
            map: this.map,
            position: { lat: point.lat, lng: point.lon },
            icon: dotIcon('#1d4ed8', 3.5),
            clickable: false,
            optimized: true
          })
        );
      }
    }

    if (points.length > 0) {
      this.add(
        new google.maps.Marker({
          map: this.map,
          position: { lat: points[0].lat, lng: points[0].lon },
          icon: dotIcon('#16a34a', 6),
          title: '起点',
          clickable: false
        })
      );
    }
    if (points.length >= 2) {
      const last = points[points.length - 1];
      this.add(
        new google.maps.Marker({
          map: this.map,
          position: { lat: last.lat, lng: last.lon },
          icon: dotIcon('#dc2626', 6),
          title: '终点',
          clickable: false
        })
      );
    }

    this.drawSelected(state);
    this.drawPreview(state);
  }

  public renderPreview(points: readonly LatLng[], preview: readonly LatLng[]): void {
    this.clearPreview();
    this.drawPreview({ ...this.state, points, preview });
  }

  public fit(points: readonly LatLng[]): void {
    if (!this.map || points.length === 0) {
      return;
    }
    if (points.length === 1) {
      this.map.setCenter({ lat: points[0].lat, lng: points[0].lon });
      this.map.setZoom(16);
      return;
    }
    const bounds = new google.maps.LatLngBounds();
    for (const point of points) {
      bounds.extend({ lat: point.lat, lng: point.lon });
    }
    this.map.fitBounds(bounds, 48);
  }

  /** “移动点”工具下为选中的点叠加一个可拖动的橙色标记。 */
  private drawSelected(state: MapRenderState): void {
    if (
      state.tool !== 'move' ||
      state.selectedIndex < 0 ||
      state.selectedIndex >= state.points.length
    ) {
      return;
    }
    const index = state.selectedIndex;
    const point = state.points[index];
    const marker = new google.maps.Marker({
      map: this.map,
      position: { lat: point.lat, lng: point.lon },
      icon: dotIcon('#f59e0b', 9),
      draggable: true,
      zIndex: 1000,
      title: '拖动调整位置'
    });
    this.add(marker);

    this.markerListeners.push(
      marker.addListener('dragstart', () => this.handlers?.pointDragStart(index))
    );
    this.markerListeners.push(
      marker.addListener('dragend', () => {
        const position = marker.getPosition();
        if (position) {
          this.handlers?.pointDragEnd(index, { lat: position.lat(), lon: position.lng() });
        }
      })
    );
  }

  private drawPreview(state: MapRenderState): void {
    if (state.preview.length === 0) {
      return;
    }
    const path: Array<{ lat: number; lng: number }> = [];
    if (state.points.length > 0) {
      const last = state.points[state.points.length - 1];
      path.push({ lat: last.lat, lng: last.lon });
    }
    for (const point of state.preview) {
      path.push({ lat: point.lat, lng: point.lon });
    }
    if (path.length >= 2) {
      this.addPreview(
        new google.maps.Polyline({
          map: this.map,
          path,
          strokeColor: '#64748b',
          strokeOpacity: 0,
          clickable: false,
          icons: [
            {
              icon: {
                path: 'M 0,-1 0,1',
                strokeColor: '#64748b',
                strokeOpacity: 0.9,
                scale: 3
              },
              offset: '0',
              repeat: '10px'
            }
          ]
        })
      );
    }

    const lastPreview = state.preview[state.preview.length - 1];
    this.addPreview(
      new google.maps.Marker({
        map: this.map,
        position: { lat: lastPreview.lat, lng: lastPreview.lon },
        icon: dotIcon('#64748b', 5),
        clickable: false
      })
    );
  }

  private onMapClick(event: any): void {
    if (!this.handlers || !event.latLng) {
      return;
    }
    const latlng: LatLng = { lat: event.latLng.lat(), lon: event.latLng.lng() };
    const wantsPoint = this.state.tool === 'delete' || this.state.tool === 'move';
    if (wantsPoint) {
      const index = this.nearestIndex(event.latLng);
      if (index >= 0) {
        this.handlers.pointClick(index, latlng);
        return;
      }
    }
    this.handlers.click(latlng);
  }

  private onMouseMove(event: any): void {
    if (event.latLng) {
      this.handlers?.pointerMove({ lat: event.latLng.lat(), lon: event.latLng.lng() });
    }
  }

  /**
   * 使用 Google 的墨卡托投影把点和点击位置换算到容器像素，找到最近的点。
   * 这样即使没有为每个点创建可点击 Marker，也能精确选中。
   */
  private nearestIndex(latlng: any): number {
    if (!this.map || !this.container) {
      return -1;
    }
    const projection = this.map.getProjection();
    if (!projection) {
      return -1;
    }
    const scale = Math.pow(2, this.map.getZoom() ?? 0);
    const center = projection.fromLatLngToPoint(this.map.getCenter());
    const target = projection.fromLatLngToPoint(latlng);
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const targetX = width / 2 + (target.x - center.x) * scale;
    const targetY = height / 2 + (target.y - center.y) * scale;

    let bestIndex = -1;
    let bestDistance = 11 * 11;
    for (let i = 0; i < this.state.points.length; i++) {
      const point = this.state.points[i];
      const world = projection.fromLatLngToPoint(
        new google.maps.LatLng(point.lat, point.lon)
      );
      const screenX = width / 2 + (world.x - center.x) * scale;
      const screenY = height / 2 + (world.y - center.y) * scale;
      const dx = screenX - targetX;
      const dy = screenY - targetY;
      const distance = dx * dx + dy * dy;
      if (distance <= bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  private add(overlay: any): void {
    this.overlays.push(overlay);
  }

  private addPreview(overlay: any): void {
    this.previewOverlays.push(overlay);
  }

  private clearPreview(): void {
    for (const overlay of this.previewOverlays) {
      overlay.setMap(null);
    }
    this.previewOverlays = [];
  }

  private clearOverlays(): void {
    for (const overlay of this.overlays) {
      overlay.setMap(null);
    }
    this.overlays = [];
    this.clearPreview();
    for (const listener of this.markerListeners) {
      google.maps.event.removeListener(listener);
    }
    this.markerListeners = [];
  }
}

function dotIcon(color: string, scale: number): any {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale,
    fillColor: color,
    fillOpacity: 1,
    strokeColor: '#ffffff',
    strokeWeight: 2
  };
}

