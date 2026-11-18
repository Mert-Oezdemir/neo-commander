// Regenerates the PNG icons from assets/*.svg (run: npm run icons). Output is committed.
// electron-builder converts assets/icon.png (1024) to .ico / .icns at package time.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const render = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
const app = readFileSync(join(assets, 'icon.svg'), 'utf8');
const tray = readFileSync(join(assets, 'tray.svg'), 'utf8');

writeFileSync(join(assets, 'icon.png'), render(app, 1024));
writeFileSync(join(assets, 'tray.png'), render(app, 32));            // Windows tray (colour)
writeFileSync(join(assets, 'tray@2x.png'), render(app, 64));
writeFileSync(join(assets, 'trayTemplate.png'), render(tray, 22));   // macOS menu bar (template, black + alpha)
writeFileSync(join(assets, 'trayTemplate@2x.png'), render(tray, 44));
console.log('icons written to', assets);
