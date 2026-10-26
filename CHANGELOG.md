# 变更记录

## 0.1.0

首个版本。

- 在 VS Code 中以 Webview 面板打开地图编辑器，默认定位匈牙利布达佩斯，底图固定浅色。
- 底图支持 Leaflet + OpenStreetMap（默认、免 Key）与 Google Maps JavaScript API（可配置 Key）。
- 绘制工具：添加点、删除点、移动点、编辑点、等间距多点直线、浏览。
- 全局设置：GPS 频率（Hz）、对象速度（m/s）、点间距、UTC 起始日期与时间。
- 生成带校验和的 NMEA 日志（GGA / GSA / RMC，可选 GGA/GSA/RMC），支持发话者 ID、海拔、卫星数、HDOP。
- 支持导出/导入 CSV 坐标、导入 NMEA 轨迹、保存/打开工程 JSON、复制 NMEA。
- 撤销/重做、选中点精确编辑、轨迹统计（点数、长度、时长、平均速度）。
