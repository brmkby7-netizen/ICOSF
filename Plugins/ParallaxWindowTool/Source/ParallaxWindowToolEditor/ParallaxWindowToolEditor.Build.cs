using UnrealBuildTool;

public class ParallaxWindowToolEditor : ModuleRules
{
	public ParallaxWindowToolEditor(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
			"DeveloperSettings",
		});

		PrivateDependencyModuleNames.AddRange(new string[]
		{
			// Editor / UI
			"UnrealEd",
			"Slate",
			"SlateCore",
			"InputCore",
			"ToolMenus",
			"ContentBrowser",
			"AssetTools",
			"AssetRegistry",
			"PropertyEditor",
			"MessageLog",
			"MaterialEditor",   // UMaterialEditingLibrary
			"Projects",         // IPluginManager (to find Shaders/)
			"ImageCore",        // FImage resize for texture arrays
			"EditorFramework",

			// Mesh processing
			"MeshDescription",
			"StaticMeshDescription",
			"GeometryCore",     // FDynamicMesh3
			"DynamicMesh",      // FMeshConnectedComponents (GeometryProcessing plugin)
			"MeshConversion",   // FMeshDescriptionToDynamicMesh
		});
	}
}
