/** Electron adapter: settings transactions and encryption live in SettingsStore. */
import { app, safeStorage } from 'electron';
import { SettingsStore } from './settingsStore';

export class AppSettings extends SettingsStore {
  constructor() { super(app.getPath('userData'), safeStorage); }
}
