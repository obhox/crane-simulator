import * as THREE from 'three';
import { canvasTexture } from './common.js';

// Road-sign atlas (4×4 cells) drawn on a canvas: generic European-style
// regulatory / warning / information signs and fictional street names.
// Plates are real sizes (Ø 600 mm discs, 750 mm triangles …).
export const SIGN = {
  speed30: 0, speed50: 1, noParking: 2, noStopping: 3, giveWay: 4, crossing: 5, roadWorks: 6, parking: 7,
  bus: 8, noEntry: 9, street0: 10, street1: 11, street2: 12, street3: 13, siteEntrance: 14, back: 15,
};
export const STREET_NAMES = ['HARBOUR STREET', 'MILL ROAD', 'STATION AVENUE', 'CANAL STREET'];

let atlas = null;
export function signAtlas() {
  if (atlas) return atlas;
  atlas = canvasTexture(1024, 1024, (ctx) => {
    const S = 256;
    const cell = (i, fn) => {
      ctx.save();
      ctx.translate((i % 4) * S, Math.floor(i / 4) * S);
      fn(ctx, S);
      ctx.restore();
    };
    const RED = '#c1121f', BLUE = '#1d4f9c', WHITE = '#f4f4f0', BLACK = '#161616', YEL = '#f2c230';
    const disc = (c, fill, ring) => {
      c.fillStyle = WHITE; c.beginPath(); c.arc(128, 128, 126, 0, 7); c.fill();
      c.fillStyle = ring; c.beginPath(); c.arc(128, 128, 120, 0, 7); c.fill();
      c.fillStyle = fill; c.beginPath(); c.arc(128, 128, 90, 0, 7); c.fill();
    };
    const text = (c, s, size, col, y = 128, font = 'bold') => {
      c.fillStyle = col; c.font = `${font} ${size}px "Helvetica Neue", Arial, sans-serif`;
      c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(s, 128, y);
    };
    const tri = (c, down, border, fill) => {
      const p = down ? [[128, 238], [8, 30], [248, 30]] : [[128, 14], [8, 226], [248, 226]];
      c.lineJoin = 'round';
      c.fillStyle = border; c.strokeStyle = border; c.lineWidth = 14;
      c.beginPath(); p.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.fill(); c.stroke();
      const q = down ? [[128, 196], [48, 50], [208, 50]] : [[128, 58], [48, 204], [208, 204]];
      c.fillStyle = fill;
      c.beginPath(); q.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.fill();
    };
    const person = (c, x, y, s, col, walking = true) => {
      c.fillStyle = col; c.strokeStyle = col; c.lineCap = 'round'; c.lineWidth = 9 * s;
      c.beginPath(); c.arc(x, y - 44 * s, 10 * s, 0, 7); c.fill();
      c.beginPath(); c.moveTo(x, y - 30 * s); c.lineTo(x - 2 * s, y + 4 * s); c.stroke();
      c.beginPath(); c.moveTo(x - 2 * s, y + 4 * s); c.lineTo(x - (walking ? 16 : 4) * s, y + 36 * s); c.stroke();
      c.beginPath(); c.moveTo(x - 2 * s, y + 4 * s); c.lineTo(x + (walking ? 14 : 4) * s, y + 36 * s); c.stroke();
      c.beginPath(); c.moveTo(x - 1 * s, y - 24 * s); c.lineTo(x - (walking ? 16 : 8) * s, y - 2 * s); c.stroke();
      c.beginPath(); c.moveTo(x - 1 * s, y - 24 * s); c.lineTo(x + (walking ? 14 : 8) * s, y - 4 * s); c.stroke();
    };
    const plate = (c, bg, border = WHITE) => {
      c.fillStyle = border; c.fillRect(0, 0, 256, 256);
      c.fillStyle = bg; c.fillRect(8, 8, 240, 240);
    };
    cell(SIGN.speed30, (c) => { disc(c, WHITE, RED); text(c, '30', 104, BLACK, 134); });
    cell(SIGN.speed50, (c) => { disc(c, WHITE, RED); text(c, '50', 104, BLACK, 134); });
    cell(SIGN.noParking, (c) => {
      disc(c, BLUE, RED);
      c.strokeStyle = RED; c.lineWidth = 26; c.beginPath(); c.moveTo(62, 62); c.lineTo(194, 194); c.stroke();
    });
    cell(SIGN.noStopping, (c) => {
      disc(c, BLUE, RED);
      c.strokeStyle = RED; c.lineWidth = 26; c.beginPath(); c.moveTo(62, 62); c.lineTo(194, 194); c.moveTo(194, 62); c.lineTo(62, 194); c.stroke();
    });
    cell(SIGN.giveWay, (c) => tri(c, true, RED, WHITE));
    cell(SIGN.crossing, (c) => {
      plate(c, BLUE);
      c.fillStyle = WHITE; c.beginPath(); c.moveTo(128, 30); c.lineTo(226, 214); c.lineTo(30, 214); c.closePath(); c.fill();
      c.fillStyle = BLACK; for (let i = 0; i < 4; i++) c.fillRect(70 + i * 32, 196, 18, 10);
      person(c, 128, 150, 1.05, BLACK);
    });
    cell(SIGN.roadWorks, (c) => {
      tri(c, false, RED, WHITE);
      person(c, 118, 170, 0.95, BLACK);
      c.fillStyle = BLACK; c.beginPath(); c.moveTo(150, 204); c.lineTo(186, 204); c.lineTo(168, 176); c.closePath(); c.fill();
    });
    cell(SIGN.parking, (c) => { plate(c, BLUE); text(c, 'P', 190, WHITE, 136); });
    cell(SIGN.bus, (c) => {
      plate(c, WHITE, '#1f7a3a');
      c.fillStyle = '#1f7a3a'; c.beginPath(); c.arc(128, 104, 70, 0, 7); c.fill();
      text(c, 'BUS', 54, WHITE, 106);
      text(c, 'STOP', 40, '#1f7a3a', 208);
    });
    cell(SIGN.noEntry, (c) => {
      c.fillStyle = WHITE; c.beginPath(); c.arc(128, 128, 126, 0, 7); c.fill();
      c.fillStyle = RED; c.beginPath(); c.arc(128, 128, 120, 0, 7); c.fill();
      c.fillStyle = WHITE; c.fillRect(46, 106, 164, 44);
    });
    STREET_NAMES.forEach((n, i) => cell(SIGN.street0 + i, (c) => {
      c.fillStyle = WHITE; c.fillRect(0, 0, 256, 256);
      c.fillStyle = '#1b3f73'; c.fillRect(0, 96, 256, 64);
      c.fillStyle = WHITE; c.fillRect(0, 98, 256, 3); c.fillRect(0, 155, 256, 3);
      c.fillStyle = WHITE; c.font = 'bold 30px "Helvetica Neue", Arial, sans-serif';
      c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(n, 128, 129, 240);
    }));
    cell(SIGN.siteEntrance, (c) => {
      plate(c, YEL, BLACK);
      text(c, 'CAUTION', 38, BLACK, 58);
      text(c, 'SITE', 46, BLACK, 112);
      text(c, 'ENTRANCE', 38, BLACK, 158);
      c.fillStyle = BLACK;
      for (let i = 0; i < 8; i++) { c.beginPath(); c.moveTo(i * 36 - 10, 244); c.lineTo(i * 36 + 8, 196); c.lineTo(i * 36 + 26, 196); c.lineTo(i * 36 + 8, 244); c.fill(); }
    });
    cell(SIGN.back, (c) => {
      c.fillStyle = '#8d9193'; c.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 400; i++) { c.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},0.05)`; c.fillRect(Math.random() * 256, Math.random() * 256, 12, 2); }
    });
  });
  atlas.colorSpace = THREE.SRGBColorSpace;
  return atlas;
}

// Plate geometry for a cell: kind 'disc' | 'tri' | 'triDown' | 'square' | 'rect'
// (w × h metres). Front faces +z with the cell's UVs, back faces -z (grey cell).
export function plateGeometry(kind, cellIndex, w, h = w) {
  const cu = (cellIndex % 4) / 4, cv = 1 - (Math.floor(cellIndex / 4) + 1) / 4;
  let shape;
  if (kind === 'disc') {
    shape = new THREE.Shape(); shape.absarc(0, 0, w / 2, 0, Math.PI * 2, false);
  } else if (kind === 'tri' || kind === 'triDown') {
    const s = kind === 'tri' ? 1 : -1;
    shape = new THREE.Shape([new THREE.Vector2(0, s * h * 0.5), new THREE.Vector2(-w / 2, -s * h * 0.42), new THREE.Vector2(w / 2, -s * h * 0.42)]);
  } else {
    shape = new THREE.Shape([new THREE.Vector2(-w / 2, -h / 2), new THREE.Vector2(w / 2, -h / 2), new THREE.Vector2(w / 2, h / 2), new THREE.Vector2(-w / 2, h / 2)]);
  }
  const front = new THREE.ShapeGeometry(shape, 16);
  // map shape coords → cell (square extent w × w, or rect w × h for 'rect')
  const ext = kind === 'rect' ? [w, h * 4] : [w, w];
  const remap = (g, cell) => {
    const cu2 = (cell % 4) / 4, cv2 = 1 - (Math.floor(cell / 4) + 1) / 4;
    const p = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) / ext[0] + 0.5, v = p.getY(i) / ext[1] + 0.5;
      uv.setXY(i, cu2 + u * 0.25 * 0.98 + 0.0025, cv2 + v * 0.25 * 0.98 + 0.0025);
    }
  };
  remap(front, cellIndex);
  void cu; void cv;
  const back = new THREE.ShapeGeometry(shape, 16);
  remap(back, SIGN.back);
  back.rotateY(Math.PI);
  back.translate(0, 0, -0.006);
  // thin rim so the plate has visible thickness edge-on
  return [front, back];
}
