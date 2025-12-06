import { app, BaseWindow, WebContentsView, Menu } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Disable application menu
Menu.setApplicationMenu(null);

let mainWindow: BaseWindow | null = null;
let mainView: WebContentsView | null = null;

function createWindow(): void {
  mainWindow = new BaseWindow({
    width: 1200,
    height: 800,
    title: "CodeHydra",
  });

  mainView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "../preload/index.js"),
    },
  });

  mainWindow.contentView.addChildView(mainView);
  updateViewBounds();

  mainView.webContents.loadFile(path.join(__dirname, "../renderer/index.html"));

  // Open DevTools in development only
  if (!app.isPackaged) {
    mainView.webContents.openDevTools();
  }

  mainWindow.on("resize", updateViewBounds);
  mainWindow.on("closed", () => {
    mainWindow = null;
    mainView = null;
  });
}

function updateViewBounds(): void {
  if (!mainWindow || !mainView) return;
  const bounds = mainWindow.getBounds();
  mainView.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (mainWindow === null) createWindow();
});
