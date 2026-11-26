# Parallax Window Tool (Unreal Engine 5.8 editor plugin)

Turns the glass slot of building meshes into randomly lit parallax interior windows.
This version implements **build step 1: Analyze**. Steps 2-5 (master material, texture arrays,
blinds / floors / day-night / distance fallback, seeds and global sliders) come next.

## Install

1. Copy `Plugins/ParallaxWindowTool` into your project's `Plugins/` folder (e.g. `roadlab/Plugins/`).
2. Right-click the `.uproject` > *Generate Visual Studio project files*, build the `Editor` target.
3. Enable the plugin (Edit > Plugins > "Parallax Window Tool") if it isn't on already.
   It pulls in *Geometry Processing* and *Python Editor Script Plugin*.

## Input mesh rules

- One static mesh per building (FBX from Blender, kept as one object).
- Glass in one material slot, default name **`M_Glass`** (Blender's `.001` / FBX `_Skin01` suffixes are ignored).
- Every pane is a **loose rectangle** (not connected to neighbors or to the frame), vertical, single-sided,
  with normals facing outward.
- Pivot anywhere: heights are measured from the mesh's lowest point by default.

## Use

- **Content Browser:** right-click one or more static meshes > **Analyze Parallax Windows**.
- **Panel:** *Window > Parallax Window Tool*: settings + **Analyze Selected Mesh** + report.
- **Python:** `import parallax_window_tool as pwt; pwt.analyze_selected()` or `pwt.analyze_folder("/Game/Buildings")`.

Results go to the *Parallax Window Tool* page of the Message Log (*Window > Output > Message Log*) and the Output Log
(`LogParallaxWindow`). Every skipped glass piece is listed with its position and reason.

## What Analyze does

| Step | Result |
|---|---|
| Copy LOD0 to a Dynamic Mesh, keep the glass triangles | The import is never modified |
| Connected components | One component = one window |
| Per window frame | normal, up = world Z projected onto the pane, right = normal × up, width, height, aspect, bottom height, center |
| Skip | not vertical (\|normal.z\| > 0.3), not rectangular (area / bounding rect < 0.95), overlapping, double-sided / thick, tiny |
| **UV0** | 0-1 per window, upright, **bottom-left origin (v grows upwards)**: the material must sample textures at `(u, 1 - v)` |
| **UV2** (configurable) | x = window random ID in [0,1) (hash of the window center, stable across re-analysis), y = floor index |
| Classify | Storefront if bottom < ground floor height; otherwise Square (0.9-1.1), Portrait (< 0.9), Landscape (> 1.1) |
| Material slots | `Parallax_Square`, `Parallax_Portrait`, `Parallax_Landscape`, `Parallax_Storefront` are added; skipped panes stay on the glass slot |
| Output | `<Mesh>_Parallax` next to the source (or in *Output Folder*), duplicated from the source so Nanite, collision and build settings carry over. Re-analyzing updates it in place, so placed actors keep working |

Changes made to the processed mesh's build settings: *Recompute Tangents* on (UV0 changed),
*Use Full Precision UVs* on (so 24-bit random IDs and floor indices are exact; Nanite is unaffected).
UV channel 1 is left alone for lightmaps.

## Settings (Project Settings > Plugins > Parallax Window Tool)

Defaults: glass slot `M_Glass`, floor height **350 cm**, ground floor (storefront) threshold **450 cm**,
max |normal.z| 0.3, min rectangularity 0.95, square aspect 0.9-1.1, window data UV channel 2,
suffix `_Parallax`, save after analyze on. Per-class material instances can be set here; until then the
original glass material is used as a placeholder.

**Note:** with uniform 3.5 m floors, first-floor windows with a sill below 1 m start under 4.5 m and get classed as
Storefront. That's fine for buildings with a taller ground floor; otherwise lower *Ground Floor Height*.

## Limits

- Custom imported LODs (LOD1+) are not processed; use Nanite or auto-generated LODs (a warning is logged).
- Panes that share vertices with other geometry still work, but a warning is logged because neighbors' UVs can change.
- Grid slicing of continuous glass is out of scope.

## Test meshes

`Tools/Blender/make_test_buildings.py` generates `SM_TestSimpleBuilding.fbx` and `SM_TestTower.fbx`:

```
blender --background --python Tools/Blender/make_test_buildings.py -- <output_dir>
```

Expected with defaults:

| Mesh | Components | Square | Portrait | Landscape | Storefront | Skipped |
|---|---|---|---|---|---|---|
| SM_TestSimpleBuilding | 47 | 20 | 8 | 12 | 4 | 3 (skylight, triangle, L-shape) |
| SM_TestTower | 1580 | 0 | 1280 | 280 | 20 | 0 |
