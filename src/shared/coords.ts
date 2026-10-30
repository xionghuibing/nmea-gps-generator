import { isValidLatLng, type LatLng } from './geo';

type Axis = 'lat' | 'lon';

interface CoordinateComponent {
  value: number;
  /** 由半球字母（N/S/E/W）推断出的轴；没有半球字母时为 null，按出现顺序补齐。 */
  axis: Axis | null;
}

/**
 * 单个坐标分量：可选的半球字母 + 十进制度数 + 可选的度分（秒）+ 可选的半球字母。
 * 支持 `47.4979`、`47.4979N`、`N 47.4979`、`47°29'52.4"N`、`-33.8688` 等写法。
 */
const COMPONENT_PATTERN =
  /(?<![A-Za-z0-9.])([NSEW])?\s*([-+]?\d{1,3}(?:\.\d+)?)\s*(?:°\s*(?:(\d{1,2}(?:\.\d+)?)\s*['′’]?\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*["″”]?\s*)?)?\s*([NSEW])?(?![A-Za-z])/gi;

const HEMISPHERE_AXIS: Record<string, Axis> = { N: 'lat', S: 'lat', E: 'lon', W: 'lon' };

/**
 * 解析用户输入的坐标文本，失败时返回 null（交由调用方按地址检索处理）。
 * 接受「纬度, 经度」顺序的十进制或度分秒写法，也接受带 N/S/E/W 的方向标记，
 * 因此 `19.0402E 47.4979N` 这类经纬度倒序也能正确识别。
 */
export function parseCoordinateInput(raw: string): LatLng | null {
  const text = normalizeInput(raw);
  if (text === '') {
    return null;
  }
  // 只保留坐标相关字符：出现其它字母或汉字就说明是地址，而不是坐标。
  if (/[A-Za-z\u4e00-\u9fff]/.test(text.replace(/[NSEW]/gi, ''))) {
    return null;
  }

  const components: CoordinateComponent[] = [];
  const pattern = new RegExp(COMPONENT_PATTERN.source, 'gi');
  for (const match of text.matchAll(pattern)) {
    const component = toComponent(match);
    if (component === null) {
      return null;
    }
    components.push(component);
  }
  if (components.length === 0 || components.length > 2) {
    return null;
  }

  let lat: number | null = null;
  let lon: number | null = null;
  // 先按半球字母定位，再用剩余分量按「纬度在前、经度在后」补齐。
  for (const component of components) {
    if (component.axis === 'lat' && lat === null) {
      lat = component.value;
    } else if (component.axis === 'lon' && lon === null) {
      lon = component.value;
    }
  }
  for (const component of components) {
    if (component.axis !== null) {
      continue;
    }
    if (lat === null) {
      lat = component.value;
    } else if (lon === null) {
      lon = component.value;
    }
  }

  if (lat === null || lon === null) {
    return null;
  }
  const result: LatLng = { lat, lon };
  return isValidLatLng(result) ? result : null;
}

/** 统一全角标点、中文标签与方向词，并在字母和数字之间补空格。 */
function normalizeInput(raw: string): string {
  return raw
    .replace(/[，、]/g, ',')
    .replace(/[；;]/g, ';')
    .replace(/[：]/g, ':')
    .replace(/[−–—]/g, '-')
    .replace(/[º˚]/g, '°')
    .replace(/北纬/g, 'N')
    .replace(/南纬/g, 'S')
    .replace(/东经/g, 'E')
    .replace(/西经/g, 'W')
    .replace(/(纬度|经度)/g, ' ')
    .replace(/\b(latitude|lat|longitude|long|lng)\b\s*[:=]?/gi, ' ')
    .replace(/([NSEW])\s*(?=[-+\d])/gi, '$1 ')
    .trim();
}

function toComponent(match: RegExpMatchArray): CoordinateComponent | null {
  const leading = (match[1] ?? '').toUpperCase();
  const trailing = (match[5] ?? '').toUpperCase();
  // 两个半球字母同时出现时（例如 "E 116.39 N 39.90" 里的 E 属于前一个数字），以前者为准。
  const hemisphere = leading !== '' ? leading : trailing;

  const degrees = Number(match[2]);
  const minutes = match[3] === undefined ? 0 : Number(match[3]);
  const seconds = match[4] === undefined ? 0 : Number(match[4]);
  if (!Number.isFinite(degrees) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }
  if (minutes >= 60 || seconds >= 60) {
    return null;
  }

  let value = Math.abs(degrees) + minutes / 60 + seconds / 3600;
  if (hemisphere === 'S' || hemisphere === 'W') {
    value = -value;
  } else if (hemisphere === '' && degrees < 0) {
    value = -value;
  }

  return { value, axis: HEMISPHERE_AXIS[hemisphere] ?? null };
}
