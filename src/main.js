// main.js — Application entry point.
// bootstrap() → createApp() → start()

import './styles/base.css';
// ocr.css stays: the shared control vocabulary (.ocr-btn, .set-group,
// .result-card, the status bar) was defined there and is used across the
// settings page and the workspace. The recognition-specific rules inside it are
// dead now and are worth a separate cleanup pass; deleting the file wholesale
// would take the buttons with it.
import './styles/ocr.css';
import './styles/pdf.css';
import './styles/ink-toolbar.css';
import './styles/mobile.css';
// Last: the material tier system is the authority on which layer a surface
// belongs to (chrome = glass, content = sharp, controls = fills).
import './styles/material.css';

import { bootstrap } from './core/bootstrap.js';
import { createApp, start } from './core/app.js';

await bootstrap();
await createApp();
await start();
