import numpy as np
import laspy
import rasterio
from rasterio.transform import from_origin
from scipy import ndimage
from scipy.ndimage import distance_transform_edt
import matplotlib.pyplot as plt
import matplotlib.colors as mcolors
from matplotlib.colors import LinearSegmentedColormap

# --- config ---
LAZ_FILE   = "/mnt/g/Download/19D021_672_53_0000.laz"
OUT_DTM    = "/mnt/g/lidar-output/lovberget_dtm.tif"
OUT_DSM    = "/mnt/g/lidar-output/lovberget_dsm.tif"
OUT_CHM    = "/mnt/g/lidar-output/lovberget_chm.tif"
OUT_CDM    = "/mnt/g/lidar-output/lovberget_cdm.tif"
OUT_DTM_PNG = "/mnt/g/lidar-output/lovberget_dtm.png"
OUT_CHM_PNG = "/mnt/g/lidar-output/lovberget_chm.png"
OUT_CDM_PNG = "/mnt/g/lidar-output/lovberget_cdm.png"
EPSG       = 3006
RESOLUTION = 1.0

# --- read all points ---
print("Reading LAZ file...")
with laspy.open(LAZ_FILE) as f:
    las = f.read()

x_all   = np.array(las.x)
y_all   = np.array(las.y)
z_all   = np.array(las.z)
cls     = np.array(las.classification)
ret_num = np.array(las.return_number)
num_ret = np.array(las.number_of_returns)

print(f"  Total points: {len(x_all):,}")

# --- define grid from full extent ---
x_min, x_max = x_all.min(), x_all.max()
y_min, y_max = y_all.min(), y_all.max()
cols = int(np.ceil((x_max - x_min) / RESOLUTION))
rows = int(np.ceil((y_max - y_min) / RESOLUTION))
print(f"  Grid: {cols} x {rows} at {RESOLUTION}m")

def coords_to_idx(x, y):
    ci = ((x - x_min) / RESOLUTION).astype(np.int32)
    ri = ((y_max - y) / RESOLUTION).astype(np.int32)
    valid = (ci >= 0) & (ci < cols) & (ri >= 0) & (ri < rows)
    return ri, ci, valid

# --- gap filling ---
def fill_gaps(grid):
    filled = grid.copy()
    kernel = np.ones((3, 3))
    for _ in range(5):
        nan_mask = np.isnan(filled)
        if not nan_mask.any():
            break
        neighbour_sum   = ndimage.convolve(np.where(nan_mask, 0, filled),
                                           kernel, mode='nearest')
        neighbour_count = ndimage.convolve((~nan_mask).astype(float),
                                           kernel, mode='nearest')
        with np.errstate(invalid='ignore'):
            neighbour_mean = neighbour_sum / neighbour_count
        fillable = nan_mask & (neighbour_count > 0)
        filled[fillable] = neighbour_mean[fillable]
    nan_mask = np.isnan(filled)
    if nan_mask.any():
        _, nearest_idx = distance_transform_edt(nan_mask, return_indices=True)
        filled[nan_mask] = filled[nearest_idx[0][nan_mask],
                                  nearest_idx[1][nan_mask]]
    return filled

# --- hillshade ---
def hillshade(grid, azimuth=315, altitude=45):
    az  = np.radians(360 - azimuth)
    alt = np.radians(altitude)
    dy, dx = np.gradient(grid, RESOLUTION)
    slope  = np.arctan(np.sqrt(dx**2 + dy**2))
    aspect = np.arctan2(-dy, dx)
    hs = (np.sin(alt) * np.cos(slope) +
          np.cos(alt) * np.sin(slope) * np.cos(az - aspect))
    return np.clip(hs, 0, 1)

# --- write GeoTIFF ---
def write_tif(path, data, transform, nodata=np.nan):
    with rasterio.open(path, "w", driver="GTiff",
                       height=data.shape[0], width=data.shape[1],
                       count=1, dtype=np.float32,
                       crs=f"EPSG:{EPSG}", transform=transform,
                       nodata=nodata) as dst:
        dst.write(data.astype(np.float32), 1)
    print(f"  Saved: {path}")

transform = from_origin(x_min, y_max, RESOLUTION, RESOLUTION)

# =============================================================================
# DTM — ground points (class 2), mean Z
# =============================================================================
print("\nBuilding DTM...")
mask_gnd = cls == 2
xg, yg, zg = x_all[mask_gnd], y_all[mask_gnd], z_all[mask_gnd]
ri, ci, valid = coords_to_idx(xg, yg)
ri, ci, zg = ri[valid], ci[valid], zg[valid]

accum = np.zeros((rows, cols), dtype=np.float64)
count = np.zeros((rows, cols), dtype=np.int32)
np.add.at(accum, (ri, ci), zg)
np.add.at(count, (ri, ci), 1)

dtm = np.full((rows, cols), np.nan)
has = count > 0
dtm[has] = accum[has] / count[has]
print(f"  Z range before fill: {np.nanmin(dtm):.1f}–{np.nanmax(dtm):.1f}m")
dtm = fill_gaps(dtm)
write_tif(OUT_DTM, dtm, transform)

# =============================================================================
# DSM — all points, max Z per cell (top of canopy)
# =============================================================================
print("\nBuilding DSM...")
ri, ci, valid = coords_to_idx(x_all, y_all)
ri, ci, za = ri[valid], ci[valid], z_all[valid]

# use a large negative sentinel instead of NaN for maximum accumulation
dsm = np.full((rows, cols), -np.inf)
np.maximum.at(dsm, (ri, ci), za)

# convert unfilled cells (still -inf) back to NaN for gap filling
dsm[dsm == -np.inf] = np.nan
print(f"  DSM NaN count before fill: {np.isnan(dsm).sum():,}")
dsm = fill_gaps(dsm)
print(f"  DSM NaN count after fill: {np.isnan(dsm).sum():,}")
write_tif(OUT_DSM, dsm, transform)

# =============================================================================
# CHM — canopy height = DSM - DTM, clamp to 0
# =============================================================================
print("\nBuilding CHM...")
chm = dsm - dtm

print(f"  DTM NaN count: {np.isnan(dtm).sum()}")
print(f"  DSM NaN count: {np.isnan(dsm).sum()}")
print(f"  CHM NaN count after subtraction: {np.isnan(chm).sum()}")
print(f"  CHM NaN rows: {np.isnan(chm).all(axis=1).sum()}")
print(f"  CHM NaN cols: {np.isnan(chm).all(axis=0).sum()}")

# fill any NaNs that snuck in from the subtraction
chm = fill_gaps(chm)
chm = np.maximum(chm, 0)
chm[chm < 0.5] = 0
write_tif(OUT_CHM, chm, transform)
print(f"  Canopy height range: 0–{np.nanmax(chm):.1f}m")

# =============================================================================
# CDM — canopy density: fraction of non-ground returns per cell
# =============================================================================
print("\nBuilding CDM...")
mask_veg = cls != 2  # everything that isn't ground
xv, yv = x_all[mask_veg], y_all[mask_veg]
ri_v, ci_v, valid_v = coords_to_idx(xv, yv)
ri_v, ci_v = ri_v[valid_v], ci_v[valid_v]

# total returns per cell
total = np.zeros((rows, cols), dtype=np.int32)
np.add.at(total, (ri, ci), 1)

# non-ground returns per cell
veg_count = np.zeros((rows, cols), dtype=np.int32)
np.add.at(veg_count, (ri_v, ci_v), 1)

cdm = np.full((rows, cols), np.nan)
has_returns = total > 0
cdm[has_returns] = veg_count[has_returns] / total[has_returns]
cdm = fill_gaps(cdm)
cdm = np.clip(cdm, 0, 1)
write_tif(OUT_CDM, cdm, transform)

# =============================================================================
# PNG outputs
# =============================================================================
print("\nGenerating PNGs...")

# --- DTM hillshade (terrain coloured) ---
hs = hillshade(dtm)
norm = mcolors.Normalize(vmin=np.nanmin(dtm), vmax=np.nanmax(dtm))
rgba = plt.get_cmap("terrain")(norm(dtm))
shaded = (rgba[:, :, :3] * hs[:, :, np.newaxis]).clip(0, 1)

fig, ax = plt.subplots(figsize=(10, 10), dpi=150)
ax.imshow(shaded, origin="upper")
ax.set_title(f"Lövberget DTM — {RESOLUTION}m resolution", fontsize=12)
ax.axis("off")
plt.tight_layout()
plt.savefig(OUT_DTM_PNG, dpi=150, bbox_inches="tight")
plt.close()
print(f"  Saved: {OUT_DTM_PNG}")

# --- CHM — green height ramp over hillshade ---
green_ramp = LinearSegmentedColormap.from_list(
    "canopy", ["#f5f0e8", "#c8e6a0", "#74b86e", "#2d7a3a", "#0d4a1f"]
)
hs_dtm = hillshade(dtm)
norm_chm = mcolors.Normalize(vmin=0, vmax=max(chm.max(), 1))
chm_rgba = green_ramp(norm_chm(chm))
chm_rgb  = chm_rgba[:, :, :3]

# water mask — class 9 cells stay blue
water_mask = np.zeros((rows, cols), bool)
mask_w = cls == 9
ri_w, ci_w, valid_w = coords_to_idx(x_all[mask_w], y_all[mask_w])
water_mask[ri_w[valid_w], ci_w[valid_w]] = True
water_mask = ndimage.binary_dilation(water_mask, iterations=2)

# blend: hillshade base + CHM colour at 70% opacity
hs3 = np.stack([hs_dtm]*3, axis=-1)
blended = (hs3 * 0.3 + chm_rgb * 0.7).clip(0, 1)
blended[water_mask] = [0.4, 0.6, 0.85]  # flat blue for water

fig, ax = plt.subplots(figsize=(10, 10), dpi=150)
im = ax.imshow(blended, origin="upper")
cbar = plt.colorbar(plt.cm.ScalarMappable(norm=norm_chm, cmap=green_ramp),
                    ax=ax, fraction=0.03, pad=0.02)
cbar.set_label("Canopy height (m)", fontsize=10)
ax.set_title(f"Lövberget CHM — canopy height", fontsize=12)
ax.axis("off")
plt.tight_layout()
plt.savefig(OUT_CHM_PNG, dpi=150, bbox_inches="tight")
plt.close()
print(f"  Saved: {OUT_CHM_PNG}")

# --- CDM — density as brown→green ramp over hillshade ---
density_ramp = LinearSegmentedColormap.from_list(
    "density", ["#f5f0e8", "#d4e8b0", "#7ab870", "#2d6e2d", "#0a3a0a"]
)
norm_cdm = mcolors.Normalize(vmin=0, vmax=1)
cdm_rgba = density_ramp(norm_cdm(cdm))
cdm_rgb  = cdm_rgba[:, :, :3]

blended_cdm = (hs3 * 0.35 + cdm_rgb * 0.65).clip(0, 1)
blended_cdm[water_mask] = [0.4, 0.6, 0.85]

fig, ax = plt.subplots(figsize=(10, 10), dpi=150)
cbar2 = plt.colorbar(plt.cm.ScalarMappable(norm=norm_cdm, cmap=density_ramp),
                     ax=ax, fraction=0.03, pad=0.02)
cbar2.set_label("Canopy density (0–1)", fontsize=10)
ax.imshow(blended_cdm, origin="upper")
ax.set_title(f"Lövberget CDM — canopy density", fontsize=12)
ax.axis("off")
plt.tight_layout()
plt.savefig(OUT_CDM_PNG, dpi=150, bbox_inches="tight")
plt.close()
print(f"  Saved: {OUT_CDM_PNG}")

print("\nAll done!")
