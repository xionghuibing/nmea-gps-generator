import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { renderHtml } from './html';
import {
  DEFAULT_TILE_ATTRIBUTION,
  DEFAULT_TILE_URL,
  isValidTileUrl
} from '../shared/tiles';
import type {
  FileKind,
  HostSettings,
  HostToWebview,
  MapProvider,
  WebviewToHost
} from '../shared/protocol';

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export class GeneratorPanel {
  private static current: GeneratorPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  public static createOrShow(extensionUri: vscode.Uri): void {
    if (GeneratorPanel.current) {
      GeneratorPanel.current.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'nmeaGen.panel',
      'NMEA GPS Generator',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );
    GeneratorPanel.current = new GeneratorPanel(panel, extensionUri);
  }

  /** 命令面板也直接调用；即使面板未打开也能写入配置。 */
  public static async promptForApiKey(): Promise<void> {
    const config = vscode.workspace.getConfiguration('nmeaGen');
    const value = await vscode.window.showInputBox({
      title: 'Google Maps API Key',
      prompt: '需要启用 Maps JavaScript API 并绑定结算账号。留空可清除已保存的 Key。',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'AIza...'
    });
    if (value === undefined) {
      return;
    }
    await config.update('googleMapsApiKey', value.trim(), vscode.ConfigurationTarget.Global);
    GeneratorPanel.current?.postSettings();
    void vscode.window.showInformationMessage(
      value.trim().length > 0
        ? '已保存 Google Maps API Key。将底图切换为 Google Maps 后生效。'
        : '已清除 Google Maps API Key。'
    );
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri
  ) {
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewToHost) => void this.onMessage(message),
      null,
      this.disposables
    );
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('nmeaGen')) {
          this.postSettings();
        }
      })
    );

    // 先注册消息监听，再加载页面，避免错过 webview 启动时发送的 ready。
    this.panel.webview.html = renderHtml(
      this.panel.webview,
      extensionUri,
      randomBytes(24).toString('base64url')
    );
  }

  private async onMessage(message: WebviewToHost): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.postSettings();
          break;
        case 'saveFile':
          await this.saveFile(message.kind, message.content, message.suggestedName);
          break;
        case 'openFile':
          await this.openFile(message.kind);
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(message.text);
          void vscode.window.showInformationMessage(`已复制${message.label}到剪贴板。`);
          break;
        case 'setProvider':
          await vscode.workspace
            .getConfiguration('nmeaGen')
            .update('mapProvider', message.provider, vscode.ConfigurationTarget.Global);
          this.postSettings();
          break;
        case 'setApiKey':
          await GeneratorPanel.promptForApiKey();
          break;
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'nmeaGen');
          break;
        case 'openExternal':
          await this.openExternal(message.url);
          break;
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `NMEA GPS Generator：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private postSettings(): void {
    const message: HostToWebview = { type: 'settings', settings: this.readSettings() };
    void this.panel.webview.postMessage(message);
  }

  private readSettings(): HostSettings {
    const config = vscode.workspace.getConfiguration('nmeaGen');
    const configuredProvider = config.get<string>('mapProvider', 'osm');
    const provider: MapProvider = configuredProvider === 'google' ? 'google' : 'osm';

    const configuredKey = config.get<string>('googleMapsApiKey', '').trim();
    const environmentKey = (process.env.NMEA_GOOGLE_MAPS_API_KEY ?? '').trim();
    const apiKey = configuredKey || environmentKey || null;

    const rawTileUrl = config.get<string>('tileUrl', DEFAULT_TILE_URL).trim();
    const tileUrl = isValidTileUrl(rawTileUrl) ? rawTileUrl : DEFAULT_TILE_URL;
    const tileAttribution =
      config.get<string>('tileAttribution', DEFAULT_TILE_ATTRIBUTION).trim() ||
      DEFAULT_TILE_ATTRIBUTION;

    return { provider, apiKey, tileUrl, tileAttribution };
  }

  private async saveFile(
    kind: FileKind,
    content: string,
    suggestedName: string
  ): Promise<void> {
    const extension = kind === 'nmea' ? 'nmea' : kind === 'csv' ? 'csv' : 'json';
    const filters: Record<string, string[]> =
      kind === 'nmea'
        ? { 'NMEA 日志': ['nmea'] }
        : kind === 'csv'
          ? { 'CSV 坐标': ['csv'] }
          : { 'NMEA GPS Generator 工程': ['json'] };

    const target = await vscode.window.showSaveDialog({
      defaultUri: this.defaultFileUri(suggestedName, extension),
      filters,
      saveLabel: '保存'
    });
    if (!target) {
      return;
    }

    await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
    const choice = await vscode.window.showInformationMessage(
      `已保存 ${path.basename(target.fsPath)}。`,
      '打开文件'
    );
    if (choice === '打开文件') {
      await vscode.window.showTextDocument(target, { preview: true });
    }
  }

  private async openFile(kind: FileKind): Promise<void> {
    const filters: Record<string, string[]> =
      kind === 'nmea'
        ? { 'NMEA 日志': ['nmea', 'log', 'gps', 'txt'], '所有文件': ['*'] }
        : kind === 'csv'
          ? { 'CSV / 文本坐标': ['csv', 'txt'], '所有文件': ['*'] }
          : { '工程 JSON': ['json'], '所有文件': ['*'] };

    const selection = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters,
      openLabel: '导入'
    });
    const uri = selection?.[0];
    if (!uri) {
      return;
    }

    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > MAX_IMPORT_BYTES) {
      void vscode.window.showErrorMessage('文件超过 20 MB，无法导入。');
      return;
    }

    const bytes = await vscode.workspace.fs.readFile(uri);
    const message: HostToWebview = {
      type: 'fileContent',
      kind,
      fileName: path.basename(uri.fsPath),
      content: Buffer.from(bytes).toString('utf8')
    };
    void this.panel.webview.postMessage(message);
  }

  private async openExternal(rawUrl: string): Promise<void> {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') {
      throw new Error('只允许打开 HTTPS 链接。');
    }
    await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
  }

  private defaultFileUri(suggestedName: string, extension: string): vscode.Uri {
    const fallback = `nmea-track.${extension}`;
    const base = path.basename(suggestedName.trim() || fallback);
    const fileName = base.toLowerCase().endsWith(`.${extension}`) ? base : `${base}.${extension}`;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    return folder
      ? vscode.Uri.joinPath(folder, fileName)
      : vscode.Uri.file(path.join(os.homedir(), fileName));
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    GeneratorPanel.current = undefined;
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    this.panel.dispose();
  }
}
