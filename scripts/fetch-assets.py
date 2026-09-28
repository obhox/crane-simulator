#!/usr/bin/env python3
"""
Reproducible fetch + light processing of the CC0 assets used by the crane
simulator (public/assets). Sources: Poly Haven (polyhaven.com) and ambientCG
(ambientcg.com), both CC0 1.0 — no attribution required, credited anyway in
public/assets/CREDITS.md.

Requirements: Python 3.9+, Pillow, numpy, curl, unzip (all standard on macOS
with Homebrew Python). Usage:

    python3 scripts/fetch-assets.py            # fetch everything missing
    python3 scripts/fetch-assets.py --force    # re-process everything
    python3 scripts/fetch-assets.py --only gravel,hdri_day_clear

Downloads are cached in $ASSET_CACHE (default: <tmp>/crane-asset-cache) so
re-runs only re-process. The script prints a JSON summary (tile sizes,
albedo, HDRI sun data, sizes) that mirrors MANIFEST in src/world/assets.js.

Processing done here (all light, deterministic):
  * JPEG re-encode at q80-85 (the originals are q95+, ~3x larger).
    Normal + ARM maps keep 4:4:4 chroma (channels carry independent data).
  * ambientCG AO/Roughness/Metalness are packed into one ARM map
    (R=AO, G=roughness, B=metalness) — same layout as Poly Haven's _arm,
    which is exactly what three.js reads (aoMap.r, roughnessMap.g,
    metalnessMap.b), so every set loads as color + normal + arm.
  * Hero (2K) sets keep color+normal at 2K but ARM at 1K (low-frequency).
  * 'desaturate' sets are turned into neutral grey so they can be tinted
    (e.g. crane yellow) via material.color without hue contamination.
  * Facade night-window emission is taken from the lit sibling variant
    (e.g. Facade018B, ~50-70% of windows lit) because the 'A' variants have black emission maps.
  * HDRIs (pure-sky): the below-horizon half of a 'pure sky' HDRI is a
    mirrored sky, which lights the undersides of everything blue-white.
    It is replaced by a physically-based ground radiance
    L = albedo * E_horizontal / pi (albedo ~0.18 urban), blended over the
    first 4 degrees below the horizon. Improves IBL realism and halves the
    file size (flat rows RLE-compress to almost nothing).
"""
import argparse, io, json, math, os, shutil, subprocess, sys, tempfile, zipfile
from concurrent.futures import ThreadPoolExecutor
from urllib.request import urlopen, Request

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'assets')
CACHE = os.environ.get('ASSET_CACHE', os.path.join(tempfile.gettempdir(), 'crane-asset-cache'))
UA = {'User-Agent': 'crane-sim-asset-fetch/1.0'}

# ---------------------------------------------------------------- asset list
# name, source ('ph' Poly Haven | 'acg' ambientCG), id, resolution, options
#   tile: real-world metres one texture repeat covers (Poly Haven: from the
#         asset's published dimensions; ambientCG: from published dimensions
#         or measured periodicity, see notes).
TEXTURES = [
    # hero surfaces seen close from the crane cab -> 2K colour/normal, 1K ARM
    ('gravel',          'ph',  'gravel_floor_02',          '2k', {'rough': 0.85}),
    ('dirt',            'ph',  'brown_mud_dry',            '2k', {'rough': 0.88}),
    ('mud',             'ph',  'brown_mud_02',             '2k', {'rough': 0.5, 'note': 'wet: roughness remapped to ~0.5'}),
    ('asphalt',         'ph',  'asphalt_04',               '2k', {}),
    ('concrete_slab',   'ph',  'concrete_floor_worn_001',  '2k', {'rough': 0.7}),
    ('concrete_rough',  'ph',  'concrete_layers_02',       '2k', {}),
    ('metal_painted',   'acg', 'Paint004',                 '2K', {'tile': 1.0, 'desaturate': 0.80,
                                                                  'note': 'clean weathered paint, neutral grey for tinting'}),
    # the rest at 1K
    ('grass',           'ph',  'leafy_grass',              '1k', {}),
    ('asphalt_worn',    'ph',  'asphalt_02',               '1k', {}),
    ('sidewalk_pavers', 'ph',  'concrete_pavement',        '1k', {}),
    ('concrete_wall',   'ph',  'concrete_wall_008',        '1k', {}),
    ('brick_red',       'ph',  'red_brick',                '1k', {}),
    ('brick_old',       'ph',  'brick_wall_006',           '1k', {}),
    ('plaster',         'ph',  'plastered_wall',           '1k', {}),
    ('rusty_metal',     'ph',  'rust_coarse_01',           '1k', {}),
    ('galvanized_metal','acg', 'Metal055A',                '1K', {'tile': 1.0, 'rough': 0.5}),
    ('corrugated_metal','ph',  'corrugated_iron_02',       '1k', {}),
    ('metal_grating',   'acg', 'MetalWalkway006',          '1K', {'tile': 0.5, 'rough': 0.5, 'note': '16x16 cells of ~31 mm (measured period)'}),
    ('chainlink',       'acg', 'Fence003',                 '1K', {'tile': 0.8, 'rough': 0.5, 'note': '16 x 50 mm diamonds per tile (measured period)'}),
    ('plywood',         'ph',  'plywood',                  '1k', {}),
    ('wood_planks',     'ph',  'wood_planks',              '1k', {}),
    ('roof_membrane',   'ph',  'bitumen',                  '1k', {}),
    ('tiles_or_stone',  'ph',  'large_square_pattern_01',  '1k', {}),
    # extras
    ('metal_painted_worn', 'acg', 'PaintedMetal012',       '1K', {'tile': 1.5, 'rough': 0.42, 'note': 'white paint with chips/rust'}),
    ('container_side',  'ph',  'container_side',           '1k', {}),
    ('osb',             'ph',  'oriented_strand_board',    '1k', {}),
    # building facades (ambientCG). tile = floors*floor height; see notes
    ('facade_office_glass',     'acg', 'Facade001',  '1K', {'tile': 36, 'emissionFrom': 'Facade002',
        'floors': 10, 'bays': 16, 'note': 'unitized glass curtain wall, 10 floors x 16 bays (3.6 m x 2.25 m) per tile'}),
    ('facade_office_ribbon',    'acg', 'Facade006',  '1K', {'tile': 28,
        'floors': 8, 'bays': 10, 'note': 'ribbon windows + white spandrels, 8 floors x 10 bays (3.5 m x 2.8 m) per tile'}),
    ('facade_brick_windows',    'acg', 'Facade018A', '1K', {'tile': 20, 'emissionFrom': 'Facade018B',
        'floors': 6, 'bays': 6, 'note': 'brick wall with punched windows, 6 floors x 6 bays (3.33 m) per tile'}),
    ('facade_concrete_windows', 'acg', 'Facade019A', '1K', {'tile': 20, 'emissionFrom': 'Facade019B',
        'floors': 6, 'bays': 6, 'note': 'dark piers + concrete floor bands, 6 floors x 6 bays per tile'}),
    ('facade_residential_1',    'acg', 'Facade020A', '1K', {'tile': 20, 'emissionFrom': 'Facade020B',
        'floors': 6, 'bays': 6, 'note': 'brick piers + light bands (residential block), 6 floors x 6 bays per tile'}),
    ('facade_residential_2',    'acg', 'Facade012',  '1K', {'tile': 112,
        'floors': 32, 'bays': 32, 'note': 'high-rise residential (brown), 32 floors x 32 bays per tile - for tall/far towers'}),
    ('facade_far_office',       'acg', 'Facade015',  '1K', {'tile': 112,
        'floors': 32, 'bays': 32, 'note': 'grey office tower, 32 floors x 32 bays per tile - for far skyline'}),
]

# name, Poly Haven id, resolution, optional
HDRIS = [
    ('hdri_day_cloudy', 'kloofendal_48d_partly_cloudy_puresky', '2k', False),
    ('hdri_day_clear',  'kloofendal_43d_clear_puresky',         '2k', False),
    ('hdri_overcast',   'kloofendal_overcast_puresky',          '2k', True),
    ('hdri_sunset',     'kloppenheim_06_puresky',               '2k', True),
    ('hdri_dawn',       'qwantani_dawn_puresky',                '1k', True),
    ('hdri_night',      'kloppenheim_02_puresky',               '1k', True),
]

# name, Poly Haven id
MODELS = [
    ('jersey_barrier', 'concrete_road_barrier_02'),
    ('oil_drum',       'barrel_03'),
    ('plastic_drum',   'Barrel_02'),
    ('wooden_crate',   'wooden_crate_02'),
    ('cement_bag',     'cement_bag'),
    ('generator',      'portable_generator'),
    ('gas_cylinder',   'small_lpg_tank'),
    ('utility_box',    'utility_box_02'),
    ('manhole_cover',  'water_manhole_cover'),
    ('aircon_unit',    'exterior_aircon_unit'),
    ('shrubs_large',   'shrub_02'),
    ('shrubs_small',   'shrub_03'),
]

Q_COLOR, Q_NORMAL, Q_ARM = 82, 82, 80

# ---------------------------------------------------------------- utilities
def fetch(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + '.part'
    subprocess.run(['curl', '-sSfL', '--retry', '3', '-A', UA['User-Agent'], '-o', tmp, url], check=True)
    os.replace(tmp, dest)
    return dest

def get_json(url, cache_name):
    p = os.path.join(CACHE, 'json', cache_name)
    if not os.path.exists(p):
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with urlopen(Request(url, headers=UA), timeout=60) as r:
            open(p, 'wb').write(r.read())
    return json.load(open(p))

def save_jpg(im, path, q, chroma444):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, 'JPEG', quality=q, optimize=True, progressive=True, subsampling=0 if chroma444 else 2)

def srgb_to_lin(a):
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)

def albedo_stats(im):
    a = np.asarray(im.convert('RGB').resize((256, 256), Image.BILINEAR), dtype=np.float32) / 255.0
    lin = srgb_to_lin(a).reshape(-1, 3).mean(0)
    return [round(float(x), 4) for x in lin]

def to_rgb(p):
    return Image.open(p).convert('RGB')

def to_l(p):
    return Image.open(p).convert('L')

def resize(im, n):
    return im if im.size[0] == n else im.resize((n, n), Image.LANCZOS)

def desaturate(im, target):
    """Neutral grey with the same luminance detail, mean re-normalised to
    `target` (sRGB 0..1) so material.color is the paint colour."""
    g = np.asarray(im.convert('L'), dtype=np.float32) / 255.0
    if target:
        g = g * (target / max(g.mean(), 1e-3))
    g = np.clip(g * 255.0 + 0.5, 0, 255).astype(np.uint8)
    return Image.fromarray(g, 'L').convert('RGB')

def calibrate_rough(arm, target):
    """Linear remap of the ARM green channel so its mean roughness = target,
    keeping the map's relative variation (photo-scan roughness maps are only
    relative; e.g. dry gravel scanned at 0.47 would sheen like plastic)."""
    if not target:
        return arm
    a = np.asarray(arm.convert('RGB'), dtype=np.float32) / 255.0
    g = a[..., 1]
    m = float(g.mean())
    if target > m:
        g = 1.0 - (1.0 - g) * (1.0 - target) / max(1.0 - m, 1e-3)
    else:
        g = g * target / max(m, 1e-3)
    a[..., 1] = np.clip(g, 0, 1)
    return Image.fromarray((a * 255.0 + 0.5).astype(np.uint8), 'RGB')

def pack_arm(ao, rough, metal, n):
    """R=AO, G=roughness, B=metalness (three.js reads exactly these channels)."""
    w = lambda im, fill: resize(im, n) if im is not None else Image.new('L', (n, n), fill)
    return Image.merge('RGB', (w(ao, 255), w(rough, 200), w(metal, 0)))

def dir_size(p):
    t = 0
    for dp, _, fs in os.walk(p):
        for f in fs:
            t += os.path.getsize(os.path.join(dp, f))
    return t

# ---------------------------------------------------------------- textures
def ph_texture(name, pid, res, opt, force):
    out = os.path.join(OUT, 'textures', name)
    info = get_json(f'https://api.polyhaven.com/info/{pid}', f'ph_info_{pid}.json')
    files = get_json(f'https://api.polyhaven.com/files/{pid}', f'ph_files_{pid}.json')
    tile = round(info['dimensions'][0] / 1000.0, 3)
    arm_res = '1k' if res != '1k' else '1k'
    maps = {}
    if force or not os.path.exists(os.path.join(out, 'color.jpg')):
        c = fetch(files['Diffuse'][res]['jpg']['url'], os.path.join(CACHE, 'ph', pid, f'diff_{res}.jpg'))
        n = fetch(files['nor_gl'][res]['jpg']['url'], os.path.join(CACHE, 'ph', pid, f'nor_gl_{res}.jpg'))
        col = to_rgb(c)
        if 'desaturate' in opt:
            col = desaturate(col, opt['desaturate'])
        save_jpg(col, os.path.join(out, 'color.jpg'), Q_COLOR, False)
        save_jpg(to_rgb(n), os.path.join(out, 'normal.jpg'), Q_NORMAL, True)
        if 'arm' in files:
            a = fetch(files['arm'][arm_res]['jpg']['url'], os.path.join(CACHE, 'ph', pid, f'arm_{arm_res}.jpg'))
            save_jpg(calibrate_rough(to_rgb(a), opt.get('rough')), os.path.join(out, 'arm.jpg'), Q_ARM, True)
        else:  # assemble from separate maps
            g = lambda k: to_l(fetch(files[k][arm_res]['jpg']['url'], os.path.join(CACHE, 'ph', pid, f'{k}_{arm_res}.jpg'))) if k in files else None
            save_jpg(calibrate_rough(pack_arm(g('AO'), g('Rough'), g('Metal'), 1024), opt.get('rough')), os.path.join(out, 'arm.jpg'), Q_ARM, True)
    maps = ['color', 'normal', 'arm']
    return {
        'name': name, 'source': 'polyhaven', 'id': pid, 'url': f'https://polyhaven.com/a/{pid}',
        'res': res.upper(), 'tile_m': tile, 'maps': maps,
        'albedo': albedo_stats(Image.open(os.path.join(out, 'color.jpg'))),
        'bytes': dir_size(out), **{k: v for k, v in opt.items() if k in ('note', 'rough')},
    }

def acg_zip(aid, res):
    z = os.path.join(CACHE, 'acg', f'{aid}_{res}-JPG.zip')
    fetch(f'https://ambientcg.com/get?file={aid}_{res}-JPG.zip', z)
    return zipfile.ZipFile(z)

def acg_map(zf, suffix):
    for n in zf.namelist():
        if n.endswith(f'_{suffix}.jpg'):
            return Image.open(io.BytesIO(zf.read(n)))
    return None

def acg_texture(name, aid, res, opt, force):
    out = os.path.join(OUT, 'textures', name)
    zf = acg_zip(aid, res)
    maps = ['color', 'normal', 'arm']
    col = acg_map(zf, 'Color')
    if force or not os.path.exists(os.path.join(out, 'color.jpg')):
        col = col.convert('RGB')
        if 'desaturate' in opt:
            col = desaturate(col, opt['desaturate'])
        save_jpg(col, os.path.join(out, 'color.jpg'), Q_COLOR, False)
        save_jpg(acg_map(zf, 'NormalGL').convert('RGB'), os.path.join(out, 'normal.jpg'), Q_NORMAL, True)
        arm = pack_arm(acg_map(zf, 'AmbientOcclusion') and acg_map(zf, 'AmbientOcclusion').convert('L'),
                       acg_map(zf, 'Roughness').convert('L'),
                       acg_map(zf, 'Metalness') and acg_map(zf, 'Metalness').convert('L'), 1024)
        save_jpg(calibrate_rough(arm, opt.get('rough')), os.path.join(out, 'arm.jpg'), Q_ARM, True)
        op = acg_map(zf, 'Opacity')
        if op is not None:
            save_jpg(op.convert('L'), os.path.join(out, 'alpha.jpg'), 88, False)
        em = None
        if opt.get('emissionFrom'):
            em = acg_map(acg_zip(opt['emissionFrom'], res), 'Emission')
        elif acg_map(zf, 'Emission') is not None:
            em = acg_map(zf, 'Emission')
        if em is not None and np.asarray(em.convert('L')).max() > 16:
            save_jpg(em.convert('RGB'), os.path.join(out, 'emissive.jpg'), Q_COLOR, False)
    if os.path.exists(os.path.join(out, 'alpha.jpg')):
        maps.append('alpha')
    if os.path.exists(os.path.join(out, 'emissive.jpg')):
        maps.append('emissive')
    rec = {
        'name': name, 'source': 'ambientcg', 'id': aid, 'url': f'https://ambientcg.com/a/{aid}',
        'res': res.upper(), 'tile_m': opt['tile'], 'maps': maps,
        'albedo': albedo_stats(Image.open(os.path.join(out, 'color.jpg'))),
        'bytes': dir_size(out),
    }
    for k in ('floors', 'bays', 'note', 'emissionFrom', 'rough'):
        if k in opt:
            rec[k] = opt[k]
    return rec

# ---------------------------------------------------------------- HDR (RGBE)
def read_hdr(path):
    data = open(path, 'rb').read()
    pos = 0
    header = []
    while True:
        end = data.index(b'\n', pos)
        line = data[pos:end].decode('latin-1')
        pos = end + 1
        if line == '':
            break
        header.append(line)
    end = data.index(b'\n', pos)
    dims = data[pos:end].decode().split()
    pos = end + 1
    H, W = int(dims[1]), int(dims[3])
    assert dims[0] == '-Y' and dims[2] == '+X'
    buf = np.frombuffer(data, dtype=np.uint8)
    img = np.empty((H, W, 4), dtype=np.uint8)
    for y in range(H):
        if buf[pos] == 2 and buf[pos + 1] == 2 and (int(buf[pos + 2]) << 8 | int(buf[pos + 3])) == W:
            pos += 4
            for c in range(4):
                x = 0
                row = img[y, :, c]
                while x < W:
                    n = int(buf[pos]); pos += 1
                    if n > 128:
                        n -= 128
                        row[x:x + n] = buf[pos]; pos += 1
                    else:
                        row[x:x + n] = buf[pos:pos + n]; pos += n
                    x += n
        else:  # flat
            img[y] = buf[pos:pos + W * 4].reshape(W, 4); pos += W * 4
    rgbe = img.astype(np.float32)
    e = img[..., 3].astype(np.int32)
    scale = np.where(e > 0, np.ldexp(1.0, e - 136), 0.0).astype(np.float32)
    return rgbe[..., :3] * scale[..., None], header

def encode_rle_channel(row):
    """Radiance new-style RLE for one channel of one scanline."""
    out = bytearray()
    W = len(row)
    # run boundaries
    change = np.flatnonzero(np.diff(row)) + 1
    starts = np.concatenate(([0], change))
    lens = np.diff(np.concatenate((starts, [W])))
    lit = []
    def flush_lit():
        i = 0
        while i < len(lit):
            chunk = lit[i:i + 128]
            out.append(len(chunk)); out.extend(chunk); i += 128
        lit.clear()
    for s, l in zip(starts.tolist(), lens.tolist()):
        v = int(row[s])
        if l >= 4:
            flush_lit()
            while l > 0:
                n = min(l, 127)
                out.append(128 + n); out.append(v); l -= n
        else:
            lit.extend([v] * l)
    flush_lit()
    return bytes(out)

def write_hdr(path, rgb, comment):
    H, W, _ = rgb.shape
    m = rgb.max(axis=2)
    mant, ex = np.frexp(m)
    scale = np.where(m > 1e-32, mant * 256.0 / np.maximum(m, 1e-32), 0.0)
    rgbe = np.zeros((H, W, 4), dtype=np.uint8)
    rgbe[..., :3] = np.clip(rgb * scale[..., None], 0, 255).astype(np.uint8)
    rgbe[..., 3] = np.where(m > 1e-32, ex + 128, 0).astype(np.uint8)
    with open(path, 'wb') as f:
        f.write(b'#?RADIANCE\n# ' + comment.encode() + b'\nFORMAT=32-bit_rle_rgbe\n\n')
        f.write(f'-Y {H} +X {W}\n'.encode())
        hdr = bytes([2, 2, W >> 8, W & 255])
        for y in range(H):
            f.write(hdr)
            for c in range(4):
                f.write(encode_rle_channel(rgbe[y, :, c]))

LUM = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)

def sky_stats(rgb):
    """Sun direction/elevation (brightest region), sun + sky irradiance."""
    H, W, _ = rgb.shape
    lum = rgb @ LUM
    elev = (0.5 - (np.arange(H) + 0.5) / H) * math.pi          # +pi/2 top row
    dOmega = (2 * math.pi / W) * (math.pi / H) * np.cos(elev)     # per pixel, per row
    y, x = np.unravel_index(np.argmax(lum), lum.shape)
    # angular distance to peak
    az = ((np.arange(W) + 0.5) / W - 0.5) * 2 * math.pi
    pd = np.array([math.cos(elev[y]) * math.cos(az[x]), math.sin(elev[y]), math.cos(elev[y]) * math.sin(az[x])])
    ce = np.cos(elev)[:, None]; se = np.sin(elev)[:, None]
    dirs_dot = ce * np.cos(az)[None, :] * pd[0] + se * pd[1] + ce * np.sin(az)[None, :] * pd[2]
    ang = np.degrees(np.arccos(np.clip(dirs_dot, -1, 1)))
    ring = (ang > 4) & (ang < 8)
    sky_level = float(np.median(lum[ring])) if ring.any() else float(lum.mean())
    cap = (ang < 3) & (lum > sky_level * 1.5)
    w = np.where(cap, (lum - sky_level) * dOmega[:, None], 0.0)
    sun_E = float(w.sum())   # normal-incidence irradiance of the sun disk (luminance units)
    if w.sum() > 0:
        v = (np.stack([ce * np.cos(az)[None, :], np.broadcast_to(se, (H, W)), ce * np.sin(az)[None, :]], -1) * w[..., None]).sum((0, 1))
        v /= np.linalg.norm(v)
    else:
        v = pd
    upper = elev > 0
    E_h = float(((rgb[upper] @ LUM) * (np.sin(elev[upper]) * dOmega[upper])[:, None]).sum())
    E_rgb = (rgb[upper] * (np.sin(elev[upper]) * dOmega[upper])[:, None, None]).sum((0, 1))
    return {
        'sunDir': [round(float(c), 4) for c in v],
        'elevationDeg': round(math.degrees(math.asin(max(-1, min(1, v[1])))), 1),
        'azimuthDeg': round(math.degrees(math.atan2(v[2], v[0])), 1),
        'peak': round(float(lum[y, x]), 1), 'skyAroundSun': round(sky_level, 3),
        'sunIrradiance': round(sun_E, 3), 'horizIrradiance': round(E_h, 3),
        'E_rgb': E_rgb,
    }

def ground_fill(rgb, E_rgb, albedo=(0.20, 0.19, 0.17), blend_deg=4.0):
    """Replace the mirrored-sky lower hemisphere with Lambertian ground
    radiance albedo*E/pi, blended in just below the horizon."""
    H, W, _ = rgb.shape
    elev = np.degrees((0.5 - (np.arange(H) + 0.5) / H) * math.pi)
    ground = np.array(albedo, dtype=np.float32) * (E_rgb / math.pi).astype(np.float32)
    out = rgb.copy()
    for yy in range(H):
        e = elev[yy]
        if e >= 0:
            continue
        t = min(1.0, -e / blend_deg)
        t = t * t * (3 - 2 * t)
        if t >= 1:
            out[yy, :, :] = ground
        else:
            out[yy] = rgb[yy] * (1 - t) + ground * t
    return out

def hdri(name, pid, res, optional, force):
    out = os.path.join(OUT, 'hdri', f'{name}.hdr')
    files = get_json(f'https://api.polyhaven.com/files/{pid}', f'ph_files_{pid}.json')
    src = fetch(files['hdri'][res]['hdr']['url'], os.path.join(CACHE, 'hdri', f'{pid}_{res}.hdr'))
    rgb, _ = read_hdr(src)
    st = sky_stats(rgb)
    if force or not os.path.exists(out):
        os.makedirs(os.path.dirname(out), exist_ok=True)
        write_hdr(out, ground_fill(rgb, st['E_rgb']), f'{pid} (Poly Haven, CC0) - lower hemisphere replaced by ground radiance')
    st.pop('E_rgb')
    return {'name': name, 'source': 'polyhaven', 'id': pid, 'url': f'https://polyhaven.com/a/{pid}',
            'res': res.upper(), 'optional': optional, 'bytes': os.path.getsize(out), **st}

# ---------------------------------------------------------------- models
def model(name, pid, force):
    out = os.path.join(OUT, 'models', name)
    files = get_json(f'https://api.polyhaven.com/files/{pid}', f'ph_files_{pid}.json')
    info = get_json(f'https://api.polyhaven.com/info/{pid}', f'ph_info_{pid}.json')
    g = files['gltf']['1k']['gltf']
    if force or not os.path.exists(os.path.join(out, f'{pid}.gltf')):
        if os.path.exists(out):
            shutil.rmtree(out)
        cdir = os.path.join(CACHE, 'models', pid)
        fetch(g['url'], os.path.join(cdir, f'{pid}.gltf'))
        for rel, f in g['include'].items():
            fetch(f['url'], os.path.join(cdir, rel))
        os.makedirs(out, exist_ok=True)
        gl = json.load(open(os.path.join(cdir, f'{pid}.gltf')))
        # the gltf references '<pid>_1k.gltf'-relative paths; keep them, rename the gltf itself
        json.dump(gl, open(os.path.join(out, f'{pid}.gltf'), 'w'), separators=(',', ':'))
        for rel in g['include']:
            dst = os.path.join(out, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            src = os.path.join(cdir, rel)
            if rel.lower().endswith('.jpg'):
                im = Image.open(src)
                data_map = any(k in rel for k in ('_nor_', '_arm_', '_rough', '_metal', '_ao_', '_spec'))
                save_jpg(im.convert('RGB') if im.mode not in ('L',) else im, dst, 80, data_map)
            else:
                shutil.copy(src, dst)
    dims = [round(d / 1000.0, 3) for d in info.get('dimensions', [])]
    return {'name': name, 'source': 'polyhaven', 'id': pid, 'url': f'https://polyhaven.com/a/{pid}',
            'res': '1K', 'file': f'models/{name}/{pid}.gltf', 'dims_m_blender_xyz': dims,
            'polycount': info.get('polycount'), 'bytes': dir_size(out)}

# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--only', default='')
    ap.add_argument('--summary', default=os.path.join(CACHE, 'summary.json'))
    a = ap.parse_args()
    only = set(filter(None, a.only.split(',')))
    pick = lambda n: not only or n in only
    os.makedirs(CACHE, exist_ok=True)
    jobs = []
    with ThreadPoolExecutor(6) as ex:
        for name, src, aid, res, opt in TEXTURES:
            if pick(name):
                fn = ph_texture if src == 'ph' else acg_texture
                jobs.append(('textures', ex.submit(fn, name, aid, res, opt, a.force)))
        for name, pid, res, optional in HDRIS:
            if pick(name):
                jobs.append(('hdris', ex.submit(hdri, name, pid, res, optional, a.force)))
        for name, pid in MODELS:
            if pick(name):
                jobs.append(('models', ex.submit(model, name, pid, a.force)))
        summary = {'textures': {}, 'hdris': {}, 'models': {}}
        for kind, fut in jobs:
            try:
                r = fut.result()
                summary[kind][r['name']] = r
                print(f"ok  {kind:8s} {r['name']:26s} {r['bytes'] / 1e6:6.2f} MB", flush=True)
            except Exception as e:  # keep going, report at the end
                print(f'ERR {kind}: {e!r}', flush=True)
    json.dump(summary, open(a.summary, 'w'), indent=1)
    print('total public/assets:', round(dir_size(OUT) / 1e6, 2), 'MB; summary ->', a.summary)

if __name__ == '__main__':
    main()
