"""Generate two test buildings for the Parallax Window Tool Analyze step.

Run in Blender (4.x):  blender --background --python make_test_buildings.py -- <output_dir>
or paste into Blender's Text Editor and press Run (exports next to the .blend / to the home folder).

Writes:
  SM_TestSimpleBuilding.fbx  - 3 floors, square / portrait / landscape windows, 2 storefronts,
                               plus 3 panes the tool must SKIP (roof skylight, triangle, L-shape).
  SM_TestTower.fbx           - 40 floors x 4 sides x 10 bays, ground-floor storefronts.

Expected Analyze result with default settings (350 / 450 cm):
  SM_TestSimpleBuilding: 47 glass components -> 20 square, 8 portrait, 12 landscape, 4 storefront, 3 skipped
  SM_TestTower:          1580 components     -> 0 square, 1280 portrait, 280 landscape, 20 storefront, 0 skipped

Each mesh is one object with two slots: M_Concrete and M_Glass. Every pane is a loose quad in M_Glass,
sitting 2 cm in front of the facade (no wall holes needed: the parallax material is opaque).
Units: meters in Blender, export scaled so Unreal gets centimeters.
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

FLOOR = 3.5          # m, upper floor height, matches the tool default (350 cm)
GROUND = 5.0         # m, ground floor height (taller, so 1st-floor sills clear the 450 cm storefront threshold)
GLASS_OFFSET = 0.02  # m in front of the wall


def floor_z(floor):
    return 0.0 if floor == 0 else GROUND + (floor - 1) * FLOOR


def building_height(floors):
    return GROUND + (floors - 1) * FLOOR


def _out_dir():
    if "--" in sys.argv:
        args = sys.argv[sys.argv.index("--") + 1:]
        if args:
            return os.path.abspath(args[0])
    if bpy.data.filepath:
        return os.path.dirname(bpy.data.filepath)
    return os.path.expanduser("~")


def _material(name, color):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.diffuse_color = color
    return mat


class Builder:
    def __init__(self):
        self.bm = bmesh.new()

    def box(self, size, center, mat_index=0):
        sx, sy, sz = (s * 0.5 for s in size)
        cx, cy, cz = center
        verts = [self.bm.verts.new((cx + x * sx, cy + y * sy, cz + z * sz))
                 for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
        idx = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
        for f in idx:
            face = self.bm.faces.new([verts[i] for i in f])
            face.material_index = mat_index
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces[:])

    def pane(self, center, normal, width, height, mat_index=1):
        """Loose rectangular quad facing `normal` (horizontal), CCW seen from outside."""
        n = Vector(normal).normalized()
        up = Vector((0, 0, 1))
        right = up.cross(n).normalized()
        c = Vector(center) + n * GLASS_OFFSET
        w, h = width * 0.5, height * 0.5
        pts = [c - right * w - up * h, c + right * w - up * h, c + right * w + up * h, c - right * w + up * h]
        face = self.bm.faces.new([self.bm.verts.new(p) for p in pts])
        face.material_index = mat_index
        return face

    def poly(self, points, mat_index=1):
        face = self.bm.faces.new([self.bm.verts.new(p) for p in points])
        face.material_index = mat_index
        return face

    def to_object(self, name):
        mesh = bpy.data.meshes.new(name)
        self.bm.to_mesh(mesh)
        self.bm.free()
        mesh.materials.append(_material("M_Concrete", (0.6, 0.6, 0.58, 1)))
        mesh.materials.append(_material("M_Glass", (0.2, 0.35, 0.5, 1)))
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        return obj


def facade_sides(half_x, half_y):
    """(normal, along-axis, facade center offset, facade length) for the 4 sides."""
    return [
        (Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((half_x, 0, 0)), 2 * half_y),
        (Vector((-1, 0, 0)), Vector((0, -1, 0)), Vector((-half_x, 0, 0)), 2 * half_y),
        (Vector((0, 1, 0)), Vector((-1, 0, 0)), Vector((0, half_y, 0)), 2 * half_x),
        (Vector((0, -1, 0)), Vector((1, 0, 0)), Vector((0, -half_y, 0)), 2 * half_x),
    ]


def simple_building():
    b = Builder()
    sx, sy, floors = 20.0, 14.0, 3
    b.box((sx, sy, building_height(floors)), (0, 0, building_height(floors) * 0.5))
    hx, hy = sx * 0.5, sy * 0.5

    for side, (n, along, offset, length) in enumerate(facade_sides(hx, hy)):
        for floor in range(floors):
            z0 = floor_z(floor)
            if floor == 0:
                # Storefronts: two wide panes starting 0.3 m above ground (bottom < 4.5 m).
                if side < 2:
                    for k in (-1, 1):
                        b.pane(offset + along * (k * length * 0.25) + Vector((0, 0, z0 + 0.3 + 1.4)), n, length * 0.4, 2.8)
                continue
            # Upper floors: alternate shapes per side.
            w, h = [(1.4, 1.4), (1.0, 2.0), (2.6, 1.3), (1.5, 1.5)][side]
            count = int(length // 3.0)
            for i in range(count):
                t = (i + 0.5) / count - 0.5
                b.pane(offset + along * (t * length) + Vector((0, 0, z0 + 0.9 + h * 0.5)), n, w, h)

    # Must be SKIPPED by the tool:
    top = building_height(floors)
    b.poly([(-2, -2, top + 0.02), (2, -2, top + 0.02), (2, 2, top + 0.02), (-2, 2, top + 0.02)])  # roof skylight (horizontal)
    c = Vector((hx + GLASS_OFFSET * 3, -3.5, floor_z(1) + 0.9))
    b.poly([c + Vector((0, -0.7, 0)), c + Vector((0, 0.7, 0)), c + Vector((0, 0, 1.4))])  # triangle
    c = Vector((hx + GLASS_OFFSET * 3, 3.5, floor_z(2) + 0.9))
    b.poly([c + Vector(p) for p in [(0, -0.8, 0), (0, 0.8, 0), (0, 0.8, 0.8), (0, 0, 0.8), (0, 0, 1.6), (0, -0.8, 1.6)]])  # L-shape
    return b.to_object("SM_TestSimpleBuilding")


def tower():
    b = Builder()
    s, floors = 30.0, 40
    b.box((s, s, building_height(floors)), (0, 0, building_height(floors) * 0.5))
    h = s * 0.5
    for n, along, offset, length in facade_sides(h, h):
        bays = 10
        bay = length / bays
        for floor in range(floors):
            z0 = floor_z(floor)
            if floor == 0:
                for i in range(bays // 2):
                    t = (i + 0.5) / (bays // 2) - 0.5
                    b.pane(offset + along * (t * length) + Vector((0, 0, 0.2 + 1.8)), n, bay * 2 - 0.3, 3.6)
                continue
            for i in range(bays):
                t = (i + 0.5) / bays - 0.5
                # Mostly portrait, every 5th floor is landscape to exercise classification.
                ww, hh = (bay - 0.3, 1.6) if floor % 5 == 0 else (bay * 0.5, 2.7)
                b.pane(offset + along * (t * length) + Vector((0, 0, z0 + 0.4 + hh * 0.5)), n, ww, hh)
    return b.to_object("SM_TestTower")


def export(obj, out_dir):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    path = os.path.join(out_dir, obj.name + ".fbx")
    bpy.ops.export_scene.fbx(
        filepath=path,
        use_selection=True,
        apply_scale_options="FBX_SCALE_UNITS",
        mesh_smooth_type="FACE",
        use_mesh_modifiers=True,
        add_leaf_bones=False,
        bake_anim=False,
    )
    print("Wrote", path)


def main():
    out_dir = _out_dir()
    os.makedirs(out_dir, exist_ok=True)
    for obj in (simple_building(), tower()):
        export(obj, out_dir)


if __name__ == "__main__":
    main()
