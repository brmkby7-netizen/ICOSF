"""Parallax Window Tool - Python helpers (Unreal Editor).

The plugin's Content/Python folder is on sys.path automatically, so in the
editor's Python console (or Tools > Execute Python Script):

    import parallax_window_tool as pwt
    pwt.analyze_selected()                 # Content Browser selection
    pwt.analyze_folder("/Game/Buildings")  # every static mesh in a folder
    pwt.build_materials()                  # master material, instances, city MPC
    pwt.full_pipeline("/Game/Buildings")   # materials + analyze + assign
    pwt.randomize_seeds()
    pwt.set_city(day_night=0.0)            # day

Settings (glass slot name, floor heights, ...) come from
Project Settings > Plugins > Parallax Window Tool.
"""

import unreal

_SUFFIX_HINT = "_Parallax"


def _report(summary):
    text = unreal.ParallaxWindowLibrary.format_summary(summary)
    if summary.success:
        unreal.log(text)
    else:
        unreal.log_warning(text)
    return summary


def analyze_mesh(mesh):
    """Analyze one unreal.StaticMesh and return its summary."""
    return _report(unreal.ParallaxWindowLibrary.analyze_static_mesh(mesh))


def analyze_selected():
    """Analyze every static mesh selected in the Content Browser."""
    meshes = [a for a in unreal.EditorUtilityLibrary.get_selected_assets() if isinstance(a, unreal.StaticMesh)]
    if not meshes:
        unreal.log_warning("Parallax Window Tool: select one or more static meshes first.")
        return []
    return [analyze_mesh(m) for m in meshes]


def analyze_folder(folder, recursive=True, skip_processed=True):
    """Analyze every static mesh under a content folder (e.g. "/Game/Buildings")."""
    registry = unreal.AssetRegistryHelpers.get_asset_registry()
    assets = registry.get_assets_by_path(folder, recursive=recursive)
    results = []
    with unreal.ScopedSlowTask(len(assets), "Analyzing parallax windows...") as task:
        task.make_dialog(True)
        for data in assets:
            if task.should_cancel():
                break
            task.enter_progress_frame(1, str(data.asset_name))
            if skip_processed and str(data.asset_name).endswith(_SUFFIX_HINT):
                continue
            asset = data.get_asset()
            if isinstance(asset, unreal.StaticMesh):
                results.append(analyze_mesh(asset))
    ok = sum(1 for r in results if r.success)
    unreal.log("Parallax Window Tool: {} of {} meshes analyzed successfully.".format(ok, len(results)))
    return results


# ---------------------------------------------------------------- Steps 2-5

def build_materials():
    """Create / update MPC_ParallaxCity, M_ParallaxWindow and the four class instances."""
    report = unreal.ParallaxWindowLibrary.build_materials()
    unreal.log(report)
    return report


def rebuild_texture_arrays(library=None):
    """Pack the texture library pools into Texture 2D Arrays (uses the project-settings library if None)."""
    report = unreal.ParallaxWindowLibrary.rebuild_texture_arrays(library)
    unreal.log(report)
    return report


def assign_instances_to_selected():
    """Put the class material instances into the Parallax_* slots of the selected processed meshes."""
    meshes = [a for a in unreal.EditorUtilityLibrary.get_selected_assets() if isinstance(a, unreal.StaticMesh)]
    report = unreal.ParallaxWindowLibrary.assign_class_materials(meshes)
    unreal.log(report)
    return report


def randomize_seeds():
    """Give every placed parallax building its own seed (Custom Primitive Data 0)."""
    report = unreal.ParallaxWindowLibrary.randomize_seeds_in_level()
    unreal.log(report)
    return report


def set_city(day_night=None, lit_percent=None, warm_ratio=None):
    """City-wide controls, e.g. set_city(day_night=0.0) for day, set_city(day_night=1.0, lit_percent=0.6)."""
    for name, value in (("DayNight", day_night), ("LitPercent", lit_percent), ("WarmRatio", warm_ratio)):
        if value is not None:
            unreal.ParallaxWindowLibrary.set_city_control(name, float(value))


def full_pipeline(folder):
    """Build materials, analyze every mesh in a folder and assign instances to the results."""
    build_materials()
    summaries = analyze_folder(folder)
    meshes = [s.output_mesh for s in summaries if s.success and s.output_mesh]
    if meshes:
        unreal.log(unreal.ParallaxWindowLibrary.assign_class_materials(meshes))
    return summaries
