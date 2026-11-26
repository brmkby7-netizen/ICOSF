# Parallax Window Tool (Unreal Engine 5.8 editor plugin)

Turns the glass slot of building meshes into realistic, randomly lit parallax interior windows.
One shared master material; every window looks different.

All five build steps are implemented:

1. **Analyze**: finds every window pane, writes per-window UVs, sorts windows into four classes, saves `<Mesh>_Parallax`.
2. **Master material** `M_ParallaxWindow` with random lighting, generated from code (Custom HLSL node).
3. **Texture library**: a data asset whose pools are packed into Texture 2D Arrays.
4. **Blinds, floor patterns, day / night, distance fallback** in the shader.
5. **Editor panel**, seed randomizer and city-wide sliders (Material Parameter Collection).

> Written against UE 5.8 without a local engine build. Expect a few compile fixes on first build;
> see *If it doesn't compile* below.

## Install

1. Copy `Plugins/ParallaxWindowTool` into the project's `Plugins/` folder (e.g. `roadlab/Plugins/`).
2. Right-click the `.uproject` > *Generate Visual Studio project files*, then build the `Editor` target.
3. Enable it under Edit > Plugins > *Parallax Window Tool*. It also enables *Geometry Processing* and *Python Editor Script Plugin*.

## Quick start

Open **Window > Parallax Window Tool**.

1. **2. Materials > Build / Update Materials** (once per project). This creates the following in `/Game/ParallaxWindow`:
   - `M_ParallaxWindow` (master material)
   - `MI_ParallaxWindow_Square`, `_Portrait`, `_Landscape`, `_Storefront`
   - `MPC_ParallaxCity` (city-wide controls)
   - placeholder room textures, so everything works before you have real ones

   It also stores the four instances in the project settings, so Analyze uses them from then on.
2. Select imported building meshes in the Content Browser. Press **1. Analyze > Analyze Selected Mesh**, or right-click > *Analyze Parallax Windows*.
3. Place the `_Parallax` meshes. Press **4. Level > Randomize Seeds in Level**.
4. Use the **5. City Controls** sliders: Day / Night, Lit Percent, Warm Ratio.
5. Add your own textures:
   - **3. Texture Library > Create / Open Library** creates `DA_ParallaxTextureLibrary`.
   - Fill the pools, either in the asset or by selecting textures and clicking **+ Square / + Portrait / ...**.
   - Press **Rebuild Texture Arrays**.

Python (Output Log > Python): `import parallax_window_tool as pwt`, then:

| Call | What it does |
|---|---|
| `pwt.full_pipeline("/Game/Buildings")` | Build materials, analyze every mesh in the folder, assign instances |
| `pwt.randomize_seeds()` | New seed for every placed parallax building |
| `pwt.set_city(day_night=0.0)` | Switch the city to day |
| `pwt.rebuild_texture_arrays()` | Repack the texture library into arrays |

## Input mesh rules

- One static mesh per building (FBX from Blender, kept as one object).
- Glass in one material slot, default **`M_Glass`**. Blender's `.001` and FBX `_Skin01` suffixes are ignored.
- Every pane is a **loose rectangle**: not connected to its neighbors or to the frame.
- Panes are vertical and single-sided, with outward normals.
- Heights are measured from the mesh's lowest point, so the pivot can be anywhere.

## 1. Analyze

| Step | Result |
|---|---|
| Copy LOD0 to a Dynamic Mesh, keep the glass triangles | The import is never modified |
| Connected components | One component = one window |
| Per-window frame | Normal; up = world Z projected onto the pane; right = normal × up; width, height, aspect, bottom height, center |
| Skip (logged with position and reason) | Not vertical (\|normal.z\| > 0.3), not rectangular (area / bounding rect < 0.95), overlapping, double-sided or thick, tiny |
| **UV0** | 0-1 per window, upright, bottom-left origin |
| **UV2** (channel configurable) | x = window random ID in [0,1), stable across re-analysis; y = floor index |
| Classify | Storefront if bottom < ground floor height. Otherwise Square (aspect 0.9-1.1), Portrait (< 0.9), Landscape (> 1.1) |
| Material slots | `Parallax_Square`, `Parallax_Portrait`, `Parallax_Landscape`, `Parallax_Storefront`. Skipped panes keep the glass slot |
| Output | `<Mesh>_Parallax`, duplicated from the source, so Nanite, collision and build settings carry over. Re-analyzing updates it in place |

Build settings changed on the output: *Recompute Tangents* and *Use Full Precision UVs* are turned on.
UV channel 1 is left alone for lightmaps.

## 2-4. Master material `M_ParallaxWindow`

Opaque, Default Lit, Metallic = 1. Emissive carries the interior; Base Color carries the glass reflection.
The logic lives in **`Shaders/ParallaxWindowCustomNode.hlsl`**, which **Build / Update Materials** pastes into a Custom node.
To change the shader, edit that text file and press the button again. The graph is rebuilt from code each time,
so don't hand-edit the master material: the rebuild overwrites it.
The material instances keep their own values across rebuilds.

The window frame is rebuilt in the shader from the vertex normal and the mesh's up axis, so it doesn't depend on mesh tangents.

| Group | Parameters |
|---|---|
| 01 Room | `Room Textures` (Texture 2D Array), `Room Depth` (0.5 matches images whose back wall is half the image) |
| 02 Lighting | `Lit Percent`, `Warm Ratio`, `Warm Color`, `Cold Color`, `Brightness Min/Max` (per-window variation), `Light Intensity`, `Unlit Level`, `Day Interior Brightness`, `Use Global Lighting` |
| 03 Patterns | `Floor Blend` (0 = random per window, 1 = whole floors on/off), `Blinds Amount`, `Blinds Color`, `Blinds Slats` |
| 04 Day Night | `Day Night` (0 day reflections, 1 night interiors), `Use Global Day Night` |
| 05 Glass | `Glass Roughness`, `Day Reflectivity`, `Night Reflectivity`, `Glass Tint` (Schlick Fresnel) |
| 06 Distance | `Fallback Distance` (cm, default 150 m), `Fallback Fade`. Beyond this the parallax is skipped by a dynamic branch, leaving a single low-mip fetch. Matters for LED volume frame rates |
| 07 Storefront | `Use Foreground`, `Foreground Textures` (array with alpha), `Foreground Depth` |

- **Texture choice** per window: `hash(window ID, building seed) mod array size`. The array size is read in the shader, so no count parameter is needed.
- **Building seed**: Custom Primitive Data index 0, plus per-instance custom data 0 for ISMs. A seed of 0 (never randomized) falls back to a hash of the object position, so copies differ even before you randomize.
- **Storefront instance**: Room Depth 0.7, Lit 85%, and its own lighting (`Use Global Lighting` = 0).

### City controls (`MPC_ParallaxCity`)

`DayNight`, `LitPercent` and `WarmRatio` drive every instance with *Use Global Lighting* / *Use Global Day Night* = 1.
The panel sliders set the collection defaults (what the editor and LED stage show).
At runtime, use Blueprint *Set Scalar Parameter Value* on the collection, or Sequencer's Material Parameter Collection track.

## 3. Texture library

`DA_ParallaxTextureLibrary` has five pools: Square, Portrait, Landscape, Storefront, Storefront Foreground.

**Rebuild Texture Arrays** works through each pool:
- Each image is center-cropped to the pool's shape and resized to the pool's size. Images are never rotated; a warning is logged if more than 15% is cropped.
- The pool is packed into `T_ParallaxTextureLibrary_<Pool>_Array` in an `Arrays/` subfolder.
- The array is assigned to the matching instance. An empty pool falls back to the placeholder rooms.

Default sizes: Square 1024², Portrait 1024×2048, Landscape 2048×1024, Storefront 2048×1024.

Images should be one-point perspective interiors: back wall centered, with floor, ceiling and side walls around it.

## Settings (Project Settings > Plugins > Parallax Window Tool)

These are also shown in the panel.

| Setting | Default |
|---|---|
| Glass slot | `M_Glass` |
| Floor height | **350 cm** |
| Ground floor (storefront) threshold | **450 cm** |
| Max \|normal.z\| | 0.3 |
| Min rectangularity | 0.95 |
| Square aspect | 0.9-1.1 |
| Window data UV channel | 2 |
| Output suffix | `_Parallax` |
| Tool folder | `/Game/ParallaxWindow` |

The class materials and texture library are filled in automatically.

**Note:** with uniform 3.5 m floors, first-floor windows whose sill is below 1 m start under 4.5 m and get classed as Storefront.
That's fine for buildings with a taller ground floor; otherwise lower *Ground Floor Height*.

## Limits

- Custom imported LODs (LOD1 and up) aren't processed. Use Nanite or auto-generated LODs; a warning is logged.
- Panes that share vertices with other geometry still work, but a warning is logged.
- The building's up axis is the mesh's local Z (rotation around Z is fine).
- The texture library is editor-only data. The generated material, instances, arrays and MPC are plain engine assets, so packaged builds don't need this plugin.
- Grid slicing of continuous glass is out of scope.

## If it doesn't compile

The engine calls most likely to have moved or been renamed in 5.8:

| Area | Calls |
|---|---|
| Analyze | `FMeshDescriptionToDynamicMesh::TriIDMap` / `bCalculateMaps`; `FMeshConnectedComponents` (module `DynamicMesh`); `FMeshSectionInfoMap::GetSectionNumber` |
| Materials | `UMaterial::GetExpressionInputForProperty`; `FCustomInput::InputName`; `UMaterialExpressionPerInstanceCustomData::ConstDefaultValue` |
| Texture arrays | `FTextureSource::GetMipImage(FImage&, Block, Layer, Mip)`; `FImage::ResizeTo` |

## Test meshes

`Tools/Blender/make_test_buildings.py` generates `SM_TestSimpleBuilding.fbx` and `SM_TestTower.fbx`:

```
blender --background --python Tools/Blender/make_test_buildings.py -- <output_dir>
```

Expected Analyze results with default settings:

| Mesh | Components | Square | Portrait | Landscape | Storefront | Skipped |
|---|---|---|---|---|---|---|
| SM_TestSimpleBuilding | 47 | 20 | 8 | 12 | 4 | 3 (skylight, triangle, L-shape) |
| SM_TestTower | 1580 | 0 | 1280 | 280 | 20 | 0 |
