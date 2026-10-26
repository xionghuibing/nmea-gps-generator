import * as L from 'leaflet';
import type { LatLng, MapViewState } from '../shared/geo';
import type {
  MapEventHandlers,
  MapInitOptions,
  MapRenderState,
  MapView
} from './mapView';

/**
 * Leaflet + XYZ 栅格瓦片（默认 OpenStreetMap）。固定浅色，无需 API Key。
 */
export class LeafletMapView implements MapView {
  public readonly kind = 'leaflet' as const;

  private map: L.Map | null = null;
  private tileLayer: L.TileLayer | null = null;
  private tileUrl = '';
  private tileAttribution = '';
  private trackLayer: L.LayerGroup | null = null;
  private previewLayer: L.LayerGroup | null = null;
  private handlers: MapEventHandlers | null = null;
  private state: MapRenderState = { points: [], selectedIndex: -1, tool: 'add', preview: [] };
  private tileErrorReported = false;

  public init(
    container: HTMLElement,
    center: LatLng,
    zoom: number,
    options: MapInitOptions,
    handlers: MapEventHandlers
  ): void {
    this.handlers = handlers;
    this.map = L.map(container, {
      zoomControl: true,
      attributionControl: true,
      worldCopyJump: true,
      preferCanvas: true
    }).setView([center.lat, center.lon], zoom);

    this.setTileSource(options.tileUrl, options.tileAttribution);
    this.trackLayer = L.layerGroup().addTo(this.map);
    this.previewLayer = L.layerGroup().addTo(this.map);

    this.map.on('click', this.onMapClick);
    this.map.on('mousemove', this.onMouseMove);
  }

  public destroy(): void {
    if (this.map) {
      this.map.off();
      this.map.remove();
    }
    this.map = null;
    this.tileLayer = null;
    this.trackLayer = null;
    this.previewLayer = null;
    this.handlers = null;
  }

  public getView(): MapViewState {
    if (!this.map) {
      return { center: { lat: 0, lon: 0 }, zoom: 2 };
    }
    const center = this.map.getCenter();
    return { center: { lat: center.lat, lon: center.lng }, zoom: this.map.getZoom() };
  }

  public setView(center: LatLng, zoom: number): void {
    this.map?.setView([center.lat, center.lon], zoom);
  }

  public setTileSource(url: string, attribution: string): void {
    if (url === this.tileUrl && attribution === this.tileAttribution && this.tileLayer) {
      return;
    }
    this.tileUrl = url;
    this.tileAttribution = attribution;
    if (!this.map) {
      return;
    }
    if (this.tileLayer) {
      this.map.removeLayer(this.tileLayer);
      this.tileLayer = null;
    }
    this.tileLayer = L.tileLayer(url, { attribution, maxZoom: 19 }).addTo(this.map);
    this.tileErrorReported = false;
    this.tileLayer.on('tileerror', () => {
      if (!this.tileErrorReported) {
        this.tileErrorReported = true;
        this.handlers?.tileError?.();
      }
    });
  }

  public refreshTiles(): void {
    this.tileErrorReported = false;
    this.tileLayer?.redraw();
  }

  public invalidateSize(): void {
    this.map?.invalidateSize();
  }

  public render(state: MapRenderState): void {
    this.state = state;
    this.trackLayer?.clearLayers();
    this.previewLayer?.clearLayers();
    if (!this.map || !this.trackLayer || !this.previewLayer) {
      return;
    }

    const points = state.points;
    if (points.length >= 2) {
      L.polyline(
        points.map((point) => [point.lat, point.lon] as [number, number]),
        {
          color: '#1d4ed8',
          weight: 4,
          opacity: 0.9,
          interactive: false
        }
      ).addTo(this.trackLayer);
    }

    // 顶点圆点仅在点数不多时绘制，避免超长轨迹拖慢地图。
    if (points.length > 0 && points.length <= 1500) {
      for (const point of points) {
        L.circleMarker([point.lat, point.lon], {
          radius: 3,
          color: '#1d4ed8',
          weight: 1.5,
          fillColor: '#ffffff',
          fillOpacity: 1,
          interactive: false
        }).addTo(this.trackLayer);
      }
    }

    if (points.length > 0) {
      const first = points[0];
      L.marker([first.lat, first.lon], {
        icon: circleIcon('#16a34a', 6),
        title: '起点',
        interactive: false,
        keyboard: false
      }).addTo(this.trackLayer);
    }
    if (points.length >= 2) {
      const last = points[points.length - 1];
      L.marker([last.lat, last.lon], {
        icon: circleIcon('#dc2626', 6),
        title: '终点',
        interactive: false,
        keyboard: false
      }).addTo(this.trackLayer);
    }

    this.drawSelected(state);
    this.drawPreview(state);
  }

  public renderPreview(points: readonly LatLng[], preview: readonly LatLng[]): void {
    this.previewLayer?.clearLayers();
    this.drawPreview({ ...this.state, points, preview });
  }

  public fit(points: readonly LatLng[]): void {
    if (!this.map || points.length === 0) {
      return;
    }
    if (points.length === 1) {
      this.map.setView([points[0].lat, points[0].lon], 16);
      return;
    }
    const bounds = L.latLngBounds(
      points.map((point) => [point.lat, point.lon] as [number, number])
    );
    this.map.fitBounds(bounds, { padding: [48, 48], maxZoom: 17 });
  }

  private drawSelected(state: MapRenderState): void {
    if (!this.trackLayer || state.selectedIndex < 0 || state.selectedIndex >= state.points.length) {
      return;
    }
    const index = state.selectedIndex;
    const point = state.points[index];

    if (state.tool === 'move') {
      const marker = L.marker([point.lat, point.lon], {
        icon: circleIcon('#f59e0b', 8),
        draggable: true,
        keyboard: false,
        zIndexOffset: 1000,
        title: '拖动调整位置'
      }).addTo(this.trackLayer);
      marker.on('dragstart', () => this.handlers?.pointDragStart(index));
      marker.on('dragend', () => {
        const position = marker.getLatLng();
        this.handlers?.pointDragEnd(index, { lat: position.lat, lon: position.lng });
      });
      return;
    }

    L.circleMarker([point.lat, point.lon], {
      radius: 8,
      color: '#f59e0b',
      weight: 3,
      fillColor: '#ffffff',
      fillOpacity: 0.95,
      interactive: false
    }).addTo(this.trackLayer);
  }

  private drawPreview(state: MapRenderState): void {
    if (!this.previewLayer || state.preview.length === 0) {
      return;
    }
    const path: Array<[number, number]> = [];
    if (state.points.length > 0) {
      const last = state.points[state.points.length - 1];
      path.push([last.lat, last.lon]);
    }
    for (const point of state.preview) {
      path.push([point.lat, point.lon]);
    }
    if (path.length >= 2) {
      L.polyline(path, {
        color: '#64748b',
        weight: 3,
        opacity: 0.85,
        dashArray: '7 6',
        interactive: false
      }).addTo(this.previewLayer);
    }
    const dotStep = Math.max(1, Math.ceil(state.preview.length / 200));
    for (let i = 0; i < state.preview.length; i += dotStep) {
      const point = state.preview[i];
      L.circleMarker([point.lat, point.lon], {
        radius: 3,
        color: '#475569',
        weight: 1,
        fillColor: '#e2e8f0',
        fillOpacity: 0.9,
        interactive: false
      }).addTo(this.previewLayer);
    }
  }

  private onMapClick = (event: L.LeafletMouseEvent): void => {
    if (!this.handlers) {
      return;
    }
    const latlng: LatLng = { lat: event.latlng.lat, lon: event.latlng.lng };
    const wantsPoint =
      this.state.tool === 'delete' || this.state.tool === 'move' || this.state.tool === 'edit';
    if (wantsPoint) {
      const index = this.nearestIndex(event.containerPoint);
      if (index >= 0) {
        this.handlers.pointClick(index, latlng);
        return;
      }
    }
    this.handlers.click(latlng);
  };

  private onMouseMove = (event: L.LeafletMouseEvent): void => {
    this.handlers?.pointerMove({ lat: event.latlng.lat, lon: event.latlng.lng });
  };

  private nearestIndex(containerPoint: L.Point): number {
    if (!this.map) {
      return -1;
    }
    const thresholdSquared = 11 * 11;
    let bestIndex = -1;
    let bestDistance = thresholdSquared;
    for (let i = 0; i < this.state.points.length; i++) {
      const point = this.state.points[i];
      const screen = this.map.latLngToContainerPoint([point.lat, point.lon]);
      const dx = screen.x - containerPoint.x;
      const dy = screen.y - containerPoint.y;
      const distance = dx * dx + dy * dy;
      if (distance <= bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    return bestIndex;
  }
}

function circleIcon(color: string, radius: number): L.DivIcon {
  const size = 28;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<circle cx="14" cy="14" r="${radius + 3}" fill="#ffffff" fill-opacity="0.95"/>` +
    `<circle cx="14" cy="14" r="${radius}" fill="${color}" stroke="#ffffff" stroke-width="1.5"/>` +
    '</svg>';
  return L.divIcon({
    className: 'track-marker-icon',
    html: svg,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
}

