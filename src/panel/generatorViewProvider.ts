import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { renderHtml } from './html';
import { GeneratorSession } from './generatorSession';

/**
 * 活动栏常驻视图：与 Cline 一样把生成器放在侧边栏，点击图标即可展开，
 * 不再每次打开一个编辑器标签页。
 */
export class GeneratorViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewId = 'nmeaGen.generatorView';

  private session: GeneratorSession | undefined;
  private viewDisposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.disposeSession();

    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };
    webviewView.description = '绘制轨迹 · 生成 NMEA / CSV';

    // 先创建 session（注册消息监听），再加载 HTML，避免错过 webview 的 ready。
    this.session = new GeneratorSession(webview);
    this.viewDisposables = [webviewView.onDidDispose(() => this.disposeSession())];

    webview.html = renderHtml(
      webview,
      this.extensionUri,
      randomBytes(24).toString('base64url')
    );
  }

  public promptForApiKey(): Promise<void> {
    return GeneratorSession.promptForApiKey();
  }

  public dispose(): void {
    this.disposeSession();
  }

  private disposeSession(): void {
    for (const disposable of this.viewDisposables) {
      disposable.dispose();
    }
    this.viewDisposables = [];
    this.session?.dispose();
    this.session = undefined;
  }
}
