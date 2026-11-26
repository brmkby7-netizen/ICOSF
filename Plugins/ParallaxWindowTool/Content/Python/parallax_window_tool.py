"""Parallax Window Tool - Python helpers (Unreal Editor).

The plugin's Content/Python folder is on sys.path automatically, so in the
editor's Python console (or Tools > Execute Python Script):

    import parallax_window_tool as pwt
    pwt.analyze_selected()                 # Content Browser selection
    pwt.analyze_folder("/Game/Buildings")  # every static mesh in a folder

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
