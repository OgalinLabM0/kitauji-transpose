import { app, BrowserWindow, nativeTheme, Menu, dialog } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppService } from './ipc/service';
import { prepareDataPaths } from './dataPaths';
import { readDataLocation, finishDataMove } from './dataLocation';

const here = dirname(fileURLToPath(import.meta.url));
let win: BrowserWindow | null = null;
let service: AppService | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 760, minHeight: 560,
    title: '北宇治译奏部',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1a19' : '#f6f3ee',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    show: false,
  });
  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev) { void win.loadURL(dev); }
  else void win.loadFile(join(here, '..', 'dist', 'index.html'));
  win.on('closed', () => { win = null; });
}

const locationRoot = app.isPackaged ? dirname(app.getPath('exe')) : join(here, '..');
function configureStorage(data: string): void {
  const paths = prepareDataPaths(app.getPath('exe'), locationRoot, app.isPackaged, data);
  app.setPath('userData', paths.data); app.setPath('sessionData', paths.data);
  app.setPath('temp', paths.temp); app.setPath('crashDumps', paths.crashes); app.setAppLogsPath(paths.logs);
  process.env.TEMP = paths.temp; process.env.TMP = paths.temp; process.env.TMPDIR = paths.temp;
}
// Configure all application-managed storage before Chromium, locks or SQLite start.
try {
  configureStorage(process.env.V3_TEST_USERDATA || readDataLocation(locationRoot).current);
} catch (error) {
  dialog.showErrorBox('数据目录不可用', (error as Error).message);
  app.exit(1);
}
if (process.env.V3_DISABLE_GPU === '1') app.commandLine.appendSwitch('disable-gpu');

// Acquire the per-user-data Electron lock before constructing any service or
// opening SQLite. Installed and unpacked copies using the same library must not
// start competing background queues or maintenance operations.
let ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
else app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

if (ownsInstance && !process.env.V3_TEST_USERDATA) {
  try {
    const previous = app.getPath('userData');
    configureStorage(finishDataMove(locationRoot));
    if (previous !== app.getPath('userData')) {
      app.releaseSingleInstanceLock();
      ownsInstance = app.requestSingleInstanceLock();
      if (!ownsInstance) app.quit();
    }
  }
  catch (error) { dialog.showErrorBox('数据迁移', (error as Error).message); }
}

if (ownsInstance) app.whenReady().then(() => {
  try {
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]) : null);
    service = new AppService(() => win);
    const settingsWarning = service.settings.recoveryWarning;
    if (settingsWarning) dialog.showErrorBox('接口设置需要处理', settingsWarning);
    service.register();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  } catch (e) {
    const message = `应用启动失败：${(e as Error).message}`;
    console.error(message, e);
    dialog.showErrorBox('北宇治译奏部', message);
    app.quit();
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
let quitting = false;
app.on('before-quit', (event) => {
  if (!service) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void service.dispose().then(() => { service = null; app.quit(); }).catch((error) => {
    quitting = false;
    dialog.showErrorBox('退出失败', `后台任务未能安全结束：${(error as Error).message}`);
  });
});
