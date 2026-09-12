// main.js — Application entry point.
// bootstrap() → createApp() → start()

import './styles/base.css';
import './styles/pdf.css';
// After pdf.css: a scratchpad shares the slot chrome and then takes away the
// page boundaries the PDF pane draws — see the note at the top of the file.
import './styles/scratch.css';
// The switching strip, the content list and the dialogs the decks need.
import './styles/deck.css';
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
