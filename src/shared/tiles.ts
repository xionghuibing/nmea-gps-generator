export const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export const DEFAULT_TILE_ATTRIBUTION =
  "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors";

/**
 * 只接受 https 的 XYZ 瓦片模板。Webview 的 CSP 只允许 https 图片，
 * 同时避免用户误填本地文件路径或缺少占位符的地址。
 */
export function isValidTileUrl(url: string): boolean {
  return (
    /^https:\/\//i.test(url) &&
    url.includes('{z}') &&
    url.includes('{x}') &&
    url.includes('{y}')
  );
}
