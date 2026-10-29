import * as vscode from 'vscode';

/** 生成带 nonce 的 Webview HTML；OSM 固定浅色，Google 使用官方默认配色。 */
export function renderHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  nonce: string
): string {
  const media = (file: string): vscode.Uri =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));
  const csp = [
    "default-src 'none'",
    "font-src data: " +
      webview.cspSource +
      ' https://fonts.gstatic.com https://maps.gstatic.com',
    "style-src 'unsafe-inline' " + webview.cspSource + ' https://fonts.googleapis.com',
    "img-src data: blob: https: " + webview.cspSource,
    "script-src 'nonce-" +
      nonce +
      "' 'unsafe-eval' https://maps.googleapis.com https://maps.gstatic.com https://www.google.com https://www.gstatic.com",
    'connect-src https:',
    'worker-src blob:',
    'child-src blob: https:',
    'frame-src https://www.google.com https://*.google.com'
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${media('leaflet.css')}" />
  <link rel="stylesheet" href="${media('main.css')}" />
  <title>NMEA GPS Generator</title>
</head>
<body>
  <div id="app">
    <aside id="sidebar">
      <section class="section">
        <h2>绘制工具</h2>
        <div class="tool-grid" id="tool-grid">
          <button class="tool active" data-tool="add" title="点击地图在轨迹末尾追加点">＋ 添加点</button>
          <button class="tool" data-tool="delete" title="点击轨迹点将其删除">⌫ 删除点</button>
          <button class="tool" data-tool="move" title="点击轨迹点选中后拖动橙色标记">✥ 移动点</button>
          <button class="tool" data-tool="line" title="从最后一个点向鼠标位置添加等间距点">⟋ 多点直线</button>
          <button class="tool" data-tool="pan" title="拖动、缩放地图，不添加点">✋ 浏览</button>
        </div>
      </section>

      <section class="section">
        <h2>轨迹统计</h2>
        <div class="stats-grid" id="stats"></div>
      </section>

      <section class="section">
        <h2>运动与时间</h2>
        <div class="field-row two">
          <label>GPS 频率（Hz）
            <input id="frequency" type="number" min="0.1" max="50" step="0.1" />
          </label>
          <label>对象速度（km/h）
            <input id="speed" type="number" min="0.1" max="360" step="1" />
          </label>
        </div>
        <div class="field-row two">
          <label>UTC 开始日期
            <input id="start-date" type="date" />
          </label>
          <label>UTC 开始时间
            <input id="start-time" type="time" step="1" />
          </label>
        </div>
      </section>

      <section class="section">
        <h2>NMEA 输出</h2>
        <div class="field-row two">
          <label>信号源 ID
            <select id="talker">
              <option value="GP">GP（GPS）</option>
              <option value="BD">BD（北斗）</option>
              <option value="GL">GL（GLONASS）</option>
              <option value="GA">GA（Galileo）</option>
            </select>
          </label>
          <label>海拔（m）
            <input id="altitude" type="number" min="-500" max="9000" step="1" />
          </label>
        </div>
        <div class="sentence-row">
          <label><input type="checkbox" id="include-gga" /> GGA</label>
          <label><input type="checkbox" id="include-gsa" /> GSA</label>
          <label><input type="checkbox" id="include-rmc" /> RMC</label>
        </div>
        <div class="field-row two">
          <label>卫星数
            <input id="satellites" type="number" min="0" max="32" step="1" />
          </label>
          <label>HDOP
            <input id="hdop" type="number" min="0.1" max="99" step="0.1" />
          </label>
        </div>
      </section>

      <section class="section">
        <h2>导入 / 导出</h2>
        <button id="generate" class="primary wide">生成 NMEA 文件…</button>
        <div class="button-row two-buttons">
          <button id="import-nmea">导入 NMEA…</button>
          <button id="import-csv">导入 CSV…</button>
        </div>
        <div class="button-row three-buttons">
          <button id="undo" disabled>撤销</button>
          <button id="redo" disabled>重做</button>
          <button id="clear" class="danger">清空</button>
        </div>
      </section>

      <footer class="sidebar-footer">
        <label class="select-field">底图
          <select id="provider">
            <option value="osm">OpenStreetMap</option>
            <option value="google">Google Maps</option>
          </select>
        </label>
        <label class="select-field" id="google-map-type-field" hidden>Google 地图类型
          <select id="google-map-type">
            <option value="roadmap">道路</option>
            <option value="satellite">卫星</option>
            <option value="terrain">地形</option>
            <option value="hybrid">混合</option>
          </select>
        </label>
      </footer>
    </aside>

    <main id="map-pane">
      <div id="map"></div>
      <div class="map-status" id="map-status">布达佩斯 · 点击地图开始</div>
      <div class="banner" id="banner" hidden>
        <span id="banner-text"></span>
        <div class="banner-actions">
          <button id="banner-action" class="banner-button" hidden></button>
          <button id="banner-close" class="banner-close" title="关闭" aria-label="关闭">✕</button>
        </div>
      </div>
      <div class="loading" id="loading" hidden>正在加载 Google 地图…</div>
      <div class="toast" id="toast" hidden></div>
    </main>
  </div>
  <script nonce="${nonce}" src="${media('main.js')}"></script>
</body>
</html>`;
}
