# NMEA GPS Generator

在 VS Code 里手动绘制 GPS 轨迹，并生成带校验和的 **NMEA 0183** 日志（GGA / GSA / RMC）与 CSV 坐标文件。交互参考 [nmeagen.org](https://nmeagen.org/)，但完全运行在 VS Code Webview 中，方便为 GPS 仿真、日志回放、地图匹配等场景快速准备测试数据。

- 底图默认 **OpenStreetMap（Leaflet，免 API Key）**，可切换 **Google Maps**。
- 底图**固定浅色模式**，默认定位匈牙利布达佩斯（47.4979, 19.0402）。
- 轨迹点、速度、UTC 时间、NMEA 语句全部可调整；支持导入/导出与工程保存。

> 本项目生成的是**合成数据**，仅用于开发与测试，不适用于真实导航、测绘或定位取证。

## 功能

- **绘制工具**：添加点、删除点、移动点、编辑点、等间距多点直线、浏览/平移。
- **精确编辑**：点击任意轨迹点，输入经纬度（7 位小数），或使用上一个/下一个点导航。
- **运动模型**：设置 GPS 频率（Hz）与对象速度（m/s），自动得到点间距；多点直线工具按该间距生成等速轨迹。
- **UTC 时间**：指定开始日期与时间，所有 NMEA 时间戳按 `1 / 频率` 递增。
- **NMEA 输出**：GGA、GSA、RMC 可独立勾选；支持发话者 ID（GP/GN/GL/GA）、海拔、卫星数、HDOP。
- **校验和**：每条语句自动计算 `*XX` XOR 校验和，行尾使用 CRLF。
- **导入/导出**：
  - 保存 / 复制 NMEA
  - 导出 / 导入 CSV（`latitude,longitude`，可带第三列海拔）
  - 导入 NMEA（GGA / RMC，校验和错误会跳过并提示）
  - 保存 / 打开工程 JSON（保留点位与全部设置）
- **撤销 / 重做**、清空轨迹、轨迹统计（点数、长度、时长、平均速度）。
- Webview 会记住当前面板中的轨迹与设置；关闭 VS Code 后可用工程文件长期保存。

## 快速开始

```bash
git clone https://github.com/xionghuibing/nmea-gps-generator.git
cd nmea-gps-generator
npm install
```

在 VS Code 中打开目录，按 `F5` 启动“运行扩展”配置，然后在扩展开发宿主中执行：

> 命令面板（`Cmd/Ctrl+Shift+P`）→ **NMEA: 打开 NMEA 轨迹生成器**

也可以打包成本地 VSIX：

```bash
npx @vscode/vsce package
code --install-extension nmea-gps-generator-0.1.0.vsix
```

## 使用说明

### 绘制轨迹

1. 默认工具是“添加点”，直接点击地图即可追加点；起点为绿色，终点为红色。
2. 切换到“多点直线”，鼠标移动时会显示等间距预览，点击地图提交。预览间距 = 速度 ÷ 频率。
3. “编辑点”或“移动点”模式下点击轨迹点：
   - 编辑：在左侧输入精确经纬度，按 Enter 或“应用坐标”。
   - 移动：拖动橙色标记，松开后写回坐标。
4. “删除点”模式点击轨迹点即可删除。
5. 顶部统计实时显示点数、路径长度、时长与平均速度；`Cmd/Ctrl+Z` 撤销，`Shift+Cmd/Ctrl+Z` 重做。

### 时间与速度

- NMEA 时间戳：`第 i 个点时间 = UTC 起始时间 + i / 频率`。
- NMEA 中的速度与航向由**相邻点的实际距离**推导，因此：
  - 手动逐点绘制时，每段速度可能不同；
  - 使用“多点直线”生成的点等间距，速度等于设置的对象速度。
- 修改频率不会移动已有点，只会改变时间戳与多点直线间距。

### NMEA 语句

每个点按以下顺序输出（可在左侧勾选）：

```text
$GPGGA,时间,纬度,N/S,经度,E/W,定位质量,卫星数,HDOP,海拔,M,大地水准面差距,M,,*校验和
$GPGSA,A,3,,,,,,,,,,,,,PDOP,HDOP,VDOP*校验和
$GPRMC,时间,A,纬度,N/S,经度,E/W,速度(节),航向,日期,,,A*校验和
```

格式示例（来自标准 NMEA 示例，实际输出为 5 位分小数）：

```text
$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47
$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A
```

- 定位质量默认 `1`，卫星数默认 `8`，HDOP 默认 `0.9`。
- 卫星数少于 4 时，GSA 的定位类型自动使用 `2`（2D），否则使用 `3`（3D）。
- 时间格式 `hhmmss.ss`，日期格式 `ddmmyy`（UTC）。

### 导入 / 导出

| 操作 | 说明 |
| --- | --- |
| 生成 NMEA 文件… | 选择保存位置，扩展直接写入文件，可选择立即打开 |
| 复制 NMEA | 将完整 NMEA 文本写入系统剪贴板 |
| 导出 CSV… | 表头 `latitude,longitude`，每行 7 位小数 |
| 导入 NMEA… | 优先使用 GGA 坐标，日期取 RMC；自动恢复起始时间与频率 |
| 导入 CSV… | 支持逗号/分号/制表符/空格分隔，自动跳过表头与无效行 |
| 保存 / 打开工程… | JSON 工程文件，保留轨迹、设置与当前选中点 |

## 底图与 Google Maps API Key

### OpenStreetMap（默认）

无需配置。默认瓦片：

```text
https://tile.openstreetmap.org/{z}/{x}/{y}.png
```

请保留右下角署名，并遵守 [OSM 瓦片使用政策](https://operations.osmfoundation.org/policies/tiles/)。若需要自定义瓦片，可在设置中修改 `nmeaGen.tileUrl` 和 `nmeaGen.tileAttribution`（仅接受 HTTPS XYZ 模板）。

### Google Maps（可选）

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 创建项目并启用 **Maps JavaScript API**。
2. 绑定结算账号，创建 API Key，并建议把 Key 限制为 `maps.googleapis.com`。
3. 在 VS Code 中执行命令 **NMEA: 设置 Google Maps API Key**，或设置：

```jsonc
// settings.json
{
  "nmeaGen.mapProvider": "google",
  "nmeaGen.googleMapsApiKey": "AIza..."
}
```

也支持环境变量 `NMEA_GOOGLE_MAPS_API_KEY`（优先级低于设置项）。

未配置 Key 或加载失败时，会显示提示并自动回退到 OpenStreetMap；Google 鉴权失败（Key 无效、未启用 API、未绑定结算）也会给出提示。

底图只使用浅色样式：OSM 标准浅色瓦片，Google 使用内置浅色 roadmap 样式，不提供深色、卫星或地形切换。

## 设置项

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `nmeaGen.mapProvider` | `osm` | 底图提供商：`osm` 或 `google` |
| `nmeaGen.tileUrl` | OSM 标准瓦片 | OSM XYZ 瓦片模板，必须 HTTPS 且含 `{z}/{x}/{y}` |
| `nmeaGen.tileAttribution` | OSM 署名 | 地图右下角署名（可含 HTML），请勿移除 |
| `nmeaGen.googleMapsApiKey` | 空 | Google Maps JavaScript API Key |

> 地图底部必须保留 OSM 署名。若通过公开渠道分发使用 OSM 标准瓦片的扩展，请先确认其使用政策。

## 开发

```bash
npm install
npm run compile      # 构建 extension + webview，复制 Leaflet 资源
npm run watch        # 监听构建
npm run typecheck    # TypeScript 严格检查
npm test             # 构建并运行 node:test 单元测试
npm run package      # 生产构建（压缩）
```

目录结构：

```text
src/
  extension.ts            扩展入口与命令注册
  panel/
    generatorPanel.ts     面板生命周期、文件读写、配置同步
    html.ts               Webview HTML 与 CSP
  nmea/
    generator.ts          NMEA 格式化、校验和、GGA/GSA/RMC 生成
    parse.ts              NMEA / CSV 导入、频率与平均速度估算
  shared/
    geo.ts                大圆距离、方位角、等间距取点
    protocol.ts           扩展 ↔ Webview 消息协议
    tiles.ts              默认瓦片与校验
  webview/
    main.ts               UI 状态、工具、导入导出、消息处理
    leafletView.ts        Leaflet 浅色地图
    googleView.ts         Google 浅色地图
    mapView.ts            地图接口、Google 加载器、浅色样式
    settings.ts           默认设置、时间/速度计算、状态校验
  test/
    generator.test.ts     单元测试
media/
  main.css                侧边栏与地图浮层样式
```

## 已知限制

- 生成数据是合成的，不能替代真实 GNSS 接收机输出；GSA 卫星编号为空。
- RMC 使用真实航向与速度（由几何推导），适合回放，但不包含磁偏角。
- 轨迹点极多时地图会减少顶点标记以保证性能，折线仍完整绘制。
- Google Maps 需要联网、API Key 与结算账号；OSM 瓦片需遵守其使用政策。

## 许可

MIT，见 [LICENSE](LICENSE)。
