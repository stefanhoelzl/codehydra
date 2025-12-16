const vscode = require("vscode");

async function activate(context) {
  // Wait briefly for VS Code UI to stabilize
  setTimeout(async () => {
    try {
      // Hide sidebars to maximize editor space
      await vscode.commands.executeCommand("workbench.action.closeSidebar");
      await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
      // Open OpenCode terminal automatically for AI workflow
      await vscode.commands.executeCommand("opencode.openTerminal");
      // Unlock the editor group so files open in the same tab group
      await vscode.commands.executeCommand("workbench.action.unlockEditorGroup");
      // Clean up empty editor groups created by terminal opening
      await vscode.commands.executeCommand("workbench.action.closeEditorsInOtherGroups");
    } catch (err) {
      console.error("codehydra extension error:", err);
    }
  }, 100);
}

function deactivate() {}

module.exports = { activate, deactivate };
