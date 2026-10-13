# Humbang Terrain Sheet

3D viewer for a drone survey of the Food Estate in Humbang Hasundutan, North Sumatra (3 Oct 2021).
Live: https://justinthe.github.io/terrain-atlas/

A swipe divider compares two synced MapLibre maps over the same 3D terrain:

- **A · Surface**: Esri World Imagery with the drone orthomosaic (10.5 cm source, z20 tiles) on top.
- **B · Relief**: colour-relief elevation, auto-fit to the current view, plus hillshade and 2 m DSM contours.

Terrain is one surface. The drone DSM is pre-blended into the AWS Terrarium global DEM, and a small `blend://` protocol in `app.js` falls back to Terrarium outside the survey (bilinear overzoom past z15). Also: vertical exaggeration, cursor elevation probe, camera stations, orbit.

Interaction mechanics are inspired by [Terrain Atlas](https://terrain-atlas.pratikyadav.chatgpt.site/). This is a separate implementation with its own design, built on MapLibre + free tiles.

## Layout

```
index.html, style.css, app.js, meta.json   static site (GitHub Pages, no build step)
scripts/build_tiles.py                     GeoTIFF -> PMTiles pipeline
```

Tiles (~556 MB) live in the Hugging Face dataset
[`the-justin/humbang-food-estate-tiles`](https://huggingface.co/datasets/the-justin/humbang-food-estate-tiles),
read with HTTP range requests via [PMTiles](https://github.com/protomaps/PMTiles).

## Rebuild tiles

Needs the source GeoTIFFs in the repo root (not committed) and a conda env:

```bash
conda create -n terrain-atlas -c conda-forge "gdal>=3.10" python=3.12 numpy scipy pip
~/anaconda3/envs/terrain-atlas/bin/pip install pmtiles
~/anaconda3/envs/terrain-atlas/bin/python scripts/build_tiles.py   # dsm, contours, ortho -> tiles/, meta.json
hf upload the-justin/humbang-food-estate-tiles tiles . --repo-type dataset
```

## Run locally

PMTiles needs a server with Range support (Python's `http.server` doesn't have it):

```bash
npx http-server@14.1.1 . -p 8765 --cors
# open http://localhost:8765/?data=tiles/   (local tiles)  or  http://localhost:8765/   (Hugging Face tiles)
```
