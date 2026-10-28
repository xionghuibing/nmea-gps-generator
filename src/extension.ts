import * as vscode from 'vscode';
import { GeneratorViewProvider } from './panel/generatorViewProvider';

/** 聚焦活动栏里的生成器视图；视图尚未创建时由 VS Code 触发首次 resolve。 */
async function focusGeneratorView(): Promise<void> {
  try {
    await vscode.commands.executeCommand(`${GeneratorViewProvider.viewId}.focus`);
  } catch {
    // 极少数情况下视图命令不可用，退回到打开整个视图容器。
    await vscode.commands.executeCommand('workbench.view.extension.nmeaGen');
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new GeneratorViewProvider(context.extensionUri);

  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(GeneratorViewProvider.viewId, provider, {
      // 视图折叠时保留 iframe，避免地图反复重建；轨迹本身也通过 getState 持久化。
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('nmeaGen.open', () => focusGeneratorView()),
    vscode.commands.registerCommand('nmeaGen.setApiKey', () => provider.promptForApiKey())
  );
}

export function deactivate(): void {
  // Webview 与监听器由视图提供者自身释放，无需额外清理。
}
