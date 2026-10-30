export type MapProvider = 'osm' | 'google';

export type FileKind = 'nmea' | 'csv';

export interface HostSettings {
  provider: MapProvider;
  /** 仅 Google 底图使用；为 null 时回退到 OSM。 */
  apiKey: string | null;
  /** 仅 OSM 底图使用，XYZ 瓦片模板。 */
  tileUrl: string;
  /** 仅 OSM 底图使用，地图署名（可含 HTML 链接）。 */
  tileAttribution: string;
}

export type HostToWebview =
  | { type: 'settings'; settings: HostSettings }
  | {
      type: 'fileContent';
      kind: FileKind;
      fileName: string;
      content: string;
    }
  | { type: 'notice'; level: 'info' | 'error'; message: string };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'saveFile'; kind: FileKind; content: string; suggestedName: string }
  | { type: 'openFile'; kind: FileKind }
  | { type: 'setProvider'; provider: MapProvider }
  | { type: 'setApiKey' }
  | { type: 'openSettings' }
  | { type: 'openExternal'; url: string };
