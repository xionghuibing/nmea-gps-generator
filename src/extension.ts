import * as vscode from 'vscode';
import { GeneratorPanel } from './panel/generatorPanel';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('nmeaGen.open', () => {
      GeneratorPanel.createOrShow(context.extensionUri);
    }),
    vscode.commands.registerCommand('nmeaGen.setApiKey', () => {
      void GeneratorPanel.promptForApiKey();
    })
  );
}

export function deactivate(): void {
  // Webview 与监听器由 GeneratorPanel 自身释放，无需额外清理。
}
