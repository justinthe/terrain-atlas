"""Turn the Humbang Hasundutan drone rasters into web tiles (PMTiles).

Outputs (in tiles/):
  ortho.pmtiles     WebP orthomosaic, z12-z20
  dsm.pmtiles       Terrarium-encoded DSM pre-blended into the global AWS Terrarium DEM, z14-z18
  contours.pmtiles  Vector contours from the DSM (2 m interval), z12-z16
and meta.json (site root) with bounds, elevation range and datum offset.

Run with the terrain-atlas conda env:
  ~/anaconda3/envs/terrain-atlas/bin/python scripts/build_tiles.py [dsm] [contours] [ortho]
Each step is skipped when its output already exists; delete it to rebuild.
"""
import json
import math
import os
import subprocess
import sys
from pathlib import Path

BIN = Path(sys.executable).parent
# Env not activated when run by path: point GDAL/PROJ at the env's data or EPSG lookups fail.
os.environ.setdefault("PROJ_DATA", str(BIN.parent / "share" / "proj"))
os.environ.setdefault("GDAL_DATA", str(BIN.parent / "share" / "gdal"))

import numpy as np  # noqa: E402
from osgeo import gdal  # noqa: E402
from scipy import ndimage  # noqa: E402

gdal.UseExceptions()
ROOT = Path(__file__).resolve().parent.parent
WORK, TILES = ROOT / "work", ROOT / "tiles"
WORK.mkdir(exist_ok=True)
TILES.mkdir(exist_ok=True)
NAME = "Food Estate Humbang Hasundutan - 03 Oktober 2021"
DSM_SRC = ROOT / f"{NAME}_dsm.tif"
ORTHO_SRC = ROOT / f"{NAME}_transparent_mosaic_group1.tif"
NODATA = -10000.0
ORIGIN = 20037508.342789244
FEATHER_M = 60  # blend width between drone DSM and global DEM
DSM_MINZOOM = 14  # DSM tiles cover whole z14 tiles; the client uses them for z14-z18


def res(z):
    """Web Mercator metres per pixel for 256 px tiles at zoom z."""
    return 2 * ORIGIN / 256 / 2**z


def run(*args):
    print("+", " ".join(map(str, args)), flush=True)
    subprocess.run([str(a) for a in args], check=True, env={**os.environ, "GDAL_CACHEMAX": "8192"})


def step(out, fn):
    if Path(out).exists():
        print(f"skip {Path(out).name} (exists)", flush=True)
    else:
        fn()


WARP = ["-t_srs", "EPSG:3857", "-tap", "-multi", "-wo", "NUM_THREADS=ALL_CPUS", "-wm", "4096",
        "-co", "TILED=YES", "-co", "COMPRESS=ZSTD", "-co", "BIGTIFF=YES", "-co", "NUM_THREADS=ALL_CPUS"]


def to_pmtiles(mbtiles, pmtiles):
    run(BIN / "pmtiles-convert", mbtiles, pmtiles)


# ---------- orthomosaic ----------
def ortho():
    warped, mb = WORK / "ortho_3857.tif", WORK / "ortho.mbtiles"
    step(warped, lambda: run(BIN / "gdalwarp", *WARP, "-tr", res(20), res(20), "-r", "average", ORTHO_SRC, warped))

    def mbtiles():
        run(BIN / "gdal_translate", "-of", "MBTILES", "-co", "TILE_FORMAT=WEBP", "-co", "QUALITY=82",
            "-co", "RESAMPLING=NEAREST", "-co", "NAME=Humbang orthomosaic", warped, mb)
        run(BIN / "gdaladdo", "-r", "average", mb, *[2**i for i in range(1, 9)])  # z19..z12
    step(mb, mbtiles)
    step(TILES / "ortho.pmtiles", lambda: to_pmtiles(mb, TILES / "ortho.pmtiles"))


# ---------- DSM ----------
def terrarium_mosaic(x0, y1, cols, rows, z=15):
    """Elevation mosaic of AWS Terrarium z15 tiles whose top-left tile corner is (x0, y1) in EPSG:3857."""
    span = 2 * ORIGIN / 2**z
    tx0, ty0 = round((x0 + ORIGIN) / span), round((ORIGIN - y1) / span)
    out = np.empty((rows * 256, cols * 256), np.float32)
    for j in range(rows):
        for i in range(cols):
            url = f"/vsicurl/https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{tx0 + i}/{ty0 + j}.png"
            r, g, b = gdal.Open(url).ReadAsArray()[:3].astype(np.float32)
            out[j * 256:(j + 1) * 256, i * 256:(i + 1) * 256] = r * 256 + g + b / 256 - 32768
    return out


def dsm():
    warped = WORK / "dsm_3857_z18.tif"
    step(warped, lambda: run(BIN / "gdalwarp", *WARP, "-tr", res(18), res(18), "-r", "average",
                             "-srcnodata", NODATA, "-dstnodata", NODATA, "-ot", "Float32", DSM_SRC, warped))
    rgb, meta_path, contour_src = WORK / "dsm_terrarium.tif", ROOT / "meta.json", WORK / "dsm_contour_src.tif"
    if rgb.exists() and meta_path.exists() and contour_src.exists():
        print("skip dsm encode (exists)", flush=True)
    else:
        encode_dsm(warped, rgb, meta_path, contour_src)

    mb = WORK / "dsm.mbtiles"

    def mbtiles():
        run(BIN / "gdal_translate", "-of", "MBTILES", "-co", "TILE_FORMAT=PNG", "-co", "RESAMPLING=NEAREST",
            "-co", "NAME=Humbang DSM (terrarium)", rgb, mb)
        # ponytail: nearest overviews on encoded RGB (averaging encoded bytes would corrupt heights)
        run(BIN / "gdaladdo", "-r", "nearest", mb, *[2**i for i in range(1, 18 - DSM_MINZOOM + 1)])
    step(mb, mbtiles)
    step(TILES / "dsm.pmtiles", lambda: to_pmtiles(mb, TILES / "dsm.pmtiles"))


def encode_dsm(warped, rgb, meta_path, contour_src):
    ds = gdal.Open(str(warped))
    gt, srs = ds.GetGeoTransform(), ds.GetProjection()
    px = gt[1]
    h = ds.ReadAsArray().astype(np.float32)
    valid = (h > NODATA + 1) & np.isfinite(h)

    # Pad the grid out to whole z14 tiles so every DSM tile is fully opaque.
    t = 2 * ORIGIN / 2**DSM_MINZOOM
    x0 = math.floor((gt[0] + ORIGIN) / t) * t - ORIGIN
    y1 = ORIGIN - math.floor((ORIGIN - gt[3]) / t) * t
    x1 = math.ceil((gt[0] + ds.RasterXSize * px + ORIGIN) / t) * t - ORIGIN
    y0 = ORIGIN - math.ceil((ORIGIN - (gt[3] - ds.RasterYSize * px)) / t) * t
    W, H = round((x1 - x0) / px), round((y1 - y0) / px)
    ox, oy = round((gt[0] - x0) / px), round((y1 - gt[3]) / px)
    print(f"padded DSM grid {W}x{H}, offset {ox},{oy}", flush=True)

    # Global DEM on the same grid: z15 Terrarium bilinear-upsampled 8x (pixel-centre convention, as the client).
    k = 2 ** (18 - 15)
    terr = terrarium_mosaic(x0, y1, W // (256 * k), H // (256 * k))
    terr = ndimage.zoom(terr, k, order=1, grid_mode=True, mode="nearest").astype(np.float32)
    local = terr[oy:oy + h.shape[0], ox:ox + h.shape[1]]

    # Drone DSM heights are ellipsoidal; Terrarium is ~geoid. Shift by the median difference.
    offset = float(np.median((h - local)[valid][::97]))
    print(f"datum offset {offset:.2f} m", flush=True)
    h = np.where(valid, h - offset, 0).astype(np.float32)

    alpha = np.clip(ndimage.distance_transform_edt(valid) * px / FEATHER_M, 0, 1).astype(np.float32)
    terr[oy:oy + h.shape[0], ox:ox + h.shape[1]] = alpha * h + (1 - alpha) * local
    v = np.clip(terr, -32768, 32767).astype(np.float64) + 32768
    bands = [np.floor(v / 256), np.floor(v) % 256, np.floor((v - np.floor(v)) * 256)]
    del v
    out = gdal.GetDriverByName("GTiff").Create(str(rgb), W, H, 3, gdal.GDT_Byte,
                                               ["TILED=YES", "COMPRESS=ZSTD", "PHOTOMETRIC=RGB", "BIGTIFF=YES"])
    out.SetGeoTransform((x0, px, 0, y1, 0, -px))
    out.SetProjection(srs)
    for i, b in enumerate(bands, 1):
        out.GetRasterBand(i).WriteArray(b.astype(np.uint8))
    out = None
    del bands, terr

    hv = h[valid]
    lo, hi = np.percentile(hv, [1, 99])
    lon = lambda x: x / ORIGIN * 180  # noqa: E731
    lat = lambda y: math.degrees(2 * math.atan(math.exp(y / ORIGIN * math.pi)) - math.pi / 2)  # noqa: E731
    w, n = gt[0], gt[3]
    e, s = w + ds.RasterXSize * px, n - ds.RasterYSize * px
    mid = math.cos(math.radians(lat((s + n) / 2)))
    meta_path.write_text(json.dumps({
        "bounds": [round(lon(w), 6), round(lat(s), 6), round(lon(e), 6), round(lat(n), 6)],
        "elevation": {"p1": round(float(lo), 1), "p99": round(float(hi), 1),
                      "min": round(float(hv.min()), 1), "max": round(float(hv.max()), 1)},
        "datum_offset_m": round(offset, 2),
        "area_km2": round(float(valid.sum()) * (px * mid) ** 2 / 1e6, 2),
        "captured": "2021-10-03",
        "gsd_cm": 10.5,
        "dsm_zoom": [DSM_MINZOOM, 18],
        "ortho_zoom": [12, 20],
    }, indent=2) + "\n")

    # Smoothed 2.4 m copy (drone pixels only) for contours.
    hh = np.where(valid, h, np.nan)[: h.shape[0] // 4 * 4, : h.shape[1] // 4 * 4]
    small = np.nanmean(hh.reshape(hh.shape[0] // 4, 4, hh.shape[1] // 4, 4), axis=(1, 3))
    mask = np.isfinite(small)
    blur = lambda a: ndimage.gaussian_filter(a, 4)  # ~10 m: tame canopy noise  # noqa: E731
    smooth = blur(np.where(mask, small, 0)) / np.maximum(blur(mask.astype(np.float32)), 1e-6)
    smooth = np.where(mask, smooth, NODATA).astype(np.float32)
    c = gdal.GetDriverByName("GTiff").Create(str(contour_src), smooth.shape[1], smooth.shape[0], 1,
                                             gdal.GDT_Float32, ["TILED=YES", "COMPRESS=ZSTD"])
    c.SetGeoTransform((gt[0], px * 4, 0, gt[3], 0, -px * 4))
    c.SetProjection(srs)
    c.GetRasterBand(1).SetNoDataValue(NODATA)
    c.GetRasterBand(1).WriteArray(smooth)
    c = None


# ---------- contours ----------
def contours():
    gpkg = WORK / "contours.gpkg"
    step(gpkg, lambda: run(BIN / "gdal_contour", "-a", "elev", "-i", 2, "-snodata", NODATA,
                           WORK / "dsm_contour_src.tif", gpkg))
    step(TILES / "contours.pmtiles", lambda: run(
        BIN / "ogr2ogr", "-f", "PMTiles", TILES / "contours.pmtiles", gpkg, "-nln", "contour",
        "-sql", "SELECT elev, geom FROM contour", "-dsco", "MINZOOM=12", "-dsco", "MAXZOOM=16"))


if __name__ == "__main__":
    for name in sys.argv[1:] or ["dsm", "contours", "ortho"]:
        globals()[name]()
    print("all done", flush=True)
