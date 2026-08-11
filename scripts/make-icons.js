'use strict';
// Regenerates every icon from icons/mark.svg. Needs rsvg-convert
// (brew install librsvg) plus macOS sips/iconutil. Run after the mark changes.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PLATE = '#161615';

// the art box is 512x480, not square: an optical correction that makes the
// full-bleed mark read as a square. App icons put it flush on the plate's bottom.
const BOX = { w: 512, h: 480 };
const GRID = { w: 512, h: 512 };

function markPath() {
  const svg = fs.readFileSync(path.join(ROOT, 'icons/mark.svg'), 'utf8');
  const m = svg.match(/\sd="([^"]+)"/);
  if (!m) throw new Error('make-icons: no path in icons/mark.svg');
  return m[1];
}

function gridBody(color) {
  const svg = fs.readFileSync(path.join(ROOT, 'icons/mark-grid.svg'), 'utf8');
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return `<g fill="none" stroke="${color}" opacity="0.2">${inner.replace(/stroke="white"/g, '')}</g>`;
}

// Apple's macOS grid: 824x824 artwork inset in a 1024 canvas
const CANVAS = 1024;
const PLATE_SIZE = 824;
const PLATE_OFF = (CANVAS - PLATE_SIZE) / 2;
const PLATE_RADIUS = 185.4;

// markWidth 1 = the art box spans the plate; the box's own inset is the padding
function iconSvg({ markWidth = 1, markFill = '#ffffff', grid = false, inset = PLATE_OFF, radius = PLATE_RADIUS } = {}) {
  const plate = CANVAS - inset * 2;
  const w = plate * markWidth;
  const h = (w * BOX.h) / BOX.w;
  const x = inset + (plate - w) / 2;
  const y = inset + plate - h;
  // the grid is square and fills the plate; at markWidth 1 that is the mark's own
  // x scale, so its rules land on the mark's columns
  const gridSvg = grid
    ? `<svg x="${inset}" y="${inset}" width="${plate}" height="${plate}" viewBox="0 0 ${GRID.w} ${GRID.h}" clip-path="url(#plate)">${gridBody(markFill)}</svg>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
<clipPath id="plate"><rect x="${inset}" y="${inset}" width="${plate}" height="${plate}" rx="${radius}"/></clipPath>
<rect x="${inset}" y="${inset}" width="${plate}" height="${plate}" rx="${radius}" fill="${PLATE}"/>
${gridSvg}<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 ${BOX.w} ${BOX.h}" clip-path="url(#plate)"><path d="${markPath()}" fill="${markFill}"/></svg>
</svg>`;
}

// browser favicons are the mark's inverse: the art box knocked through by the
// mark, letterboxed into a square so the 512x480 box stays uncropped
function faviconSvg({ fill = '#ffffff' } = {}) {
  const pad = (BOX.w - BOX.h) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BOX.w}" height="${BOX.w}" viewBox="0 ${-pad} ${BOX.w} ${BOX.w}"><path fill-rule="evenodd" d="M0 0H${BOX.w}V${BOX.h}H0Z ${markPath()}" fill="${fill}"/></svg>`;
}

// Match the 1024px system document geometry; bake the fold to avoid Xcode's actool.
const DOC = { x: 152, y: 16, w: 720, h: 944, r: 20, fold: 190 };
const PAGE = '#ffffff';
const FOLD = '#dedcd8';

function docSvg({ markFill = PLATE, markWidth = 0.58 } = {}) {
  const { x, y, w, h, r, fold } = DOC;
  const right = x + w;
  const bottom = y + h;
  const mw = w * markWidth;
  const mh = (mw * BOX.h) / BOX.w;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
<path d="M${x + r} ${y}H${right - fold}L${right} ${y + fold}V${bottom - r}A${r} ${r} 0 0 1 ${right - r} ${bottom}H${x + r}A${r} ${r} 0 0 1 ${x} ${bottom - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z" fill="${PAGE}" stroke="${FOLD}" stroke-width="4"/>
<path d="M${right - fold} ${y}L${right} ${y + fold}H${right - fold}Z" fill="${FOLD}"/>
<svg x="${x + (w - mw) / 2}" y="${y + h * 0.62 - mh / 2}" width="${mw}" height="${mh}" viewBox="0 0 ${BOX.w} ${BOX.h}"><path fill-rule="evenodd" d="M0 0H${BOX.w}V${BOX.h}H0Z ${markPath()}" fill="${markFill}"/></svg>
</svg>`;
}

const ICONSET = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
];

function render(svg, out, size) {
  const tmp = path.join(os.tmpdir(), `showmd-icon-${process.pid}.svg`);
  fs.writeFileSync(tmp, svg);
  try {
    execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), tmp, '-o', out]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// PNG-embedded ICO (valid since Vista): ICONDIR + one ICONDIRENTRY per image,
// then the raw PNG blobs back to back
function icoFromPngs(entries) {
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, buffer }, i) => {
    const e = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, e);
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
    dir.writeUInt16LE(1, e + 4); // planes
    dir.writeUInt16LE(32, e + 6); // bpp
    dir.writeUInt32LE(buffer.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += buffer.length;
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(entries.length, 4);
  return Buffer.concat([header, dir, ...entries.map((e) => e.buffer)]);
}

function build({ art, markWidth, markFill, grid, out = path.join(ROOT, 'icons/showmd.icns'), ico = true } = {}) {
  const svg = art || iconSvg({ markWidth, markFill, grid });
  const iconset = fs.mkdtempSync(path.join(os.tmpdir(), 'showmd-')) + '/showmd.iconset';
  fs.mkdirSync(iconset, { recursive: true });
  for (const [name, size] of ICONSET) render(svg, path.join(iconset, name), size);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', out]);
  fs.rmSync(path.dirname(iconset), { recursive: true, force: true });

  if (!ico) return out;
  const iconsDir = path.dirname(out);
  const pngDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showmd-ico-'));
  const entries = ICO_SIZES.map((size) => {
    const file = path.join(pngDir, `${size}.png`);
    render(svg, file, size);
    return { size, buffer: fs.readFileSync(file) };
  });
  const icoOut = path.join(iconsDir, 'showmd.ico');
  fs.writeFileSync(icoOut, icoFromPngs(entries));
  const header = fs.readFileSync(icoOut).subarray(0, 6);
  if (header[0] !== 0 || header[1] !== 0 || header[2] !== 1 || header[3] !== 0 || header.readUInt16LE(4) !== entries.length) {
    throw new Error('make-icons: ICO header check failed');
  }
  fs.copyFileSync(path.join(pngDir, '256.png'), path.join(iconsDir, 'showmd.png'));
  fs.rmSync(pngDir, { recursive: true, force: true });

  return out;
}

function buildFavicons() {
  const dir = path.join(ROOT, 'client');
  const svg = faviconSvg();
  fs.writeFileSync(path.join(dir, 'favicon.svg'), svg + '\n');
  render(svg, path.join(dir, 'favicon-32.png'), 32);
  render(svg, path.join(dir, 'favicon-1024.png'), 1024);
  // home-screen icon matches the app icon, minus the corner radius iOS adds itself
  render(iconSvg({ inset: 0, radius: 0 }), path.join(dir, 'apple-touch-icon.png'), 180);
  return dir;
}

// the sidebar mark is the same path, inlined so `.logo-m` can animate against
// the legs the clip holds still
function syncSidebar() {
  const file = path.join(ROOT, 'client/index.html');
  const d = markPath();
  const before = fs.readFileSync(file, 'utf8');
  let hits = 0;
  const after = before.replace(/(class="logo-(?:m|legs)"[^>]*\sd=")[^"]+/g, (_, head) => (hits++, head + d));
  if (hits !== 2) throw new Error(`make-icons: expected 2 sidebar paths in index.html, found ${hits}`);
  if (after !== before) fs.writeFileSync(file, after);
  return file;
}

module.exports = { iconSvg, faviconSvg, docSvg, build, buildFavicons, syncSidebar, icoFromPngs };

if (require.main === module) {
  console.log(build());
  // helper agent icon: same plate, dimmed mark over the design grid — "ShowMD
  // family, background role"
  console.log(build({ markFill: '#9b9b98', grid: true, out: path.join(ROOT, 'icons/showmd-helper.icns'), ico: false }));
  // .md document icon: the folded page LaunchServices shows for registered files
  console.log(build({ art: docSvg(), out: path.join(ROOT, 'icons/showmd-doc.icns'), ico: false }));
  console.log(buildFavicons());
  console.log(syncSidebar());
}
