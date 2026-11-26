#pragma once

#include "CoreMinimal.h"
#include "ParallaxWindowTypes.h"

class UMaterial;
class UMaterialInstanceConstant;
class UMaterialParameterCollection;
class UParallaxTextureLibrary;
class UStaticMesh;
class UTexture2DArray;

/** Material parameter names shared by the master material, instances and the texture library. */
namespace ParallaxWindowParams
{
	extern PARALLAXWINDOWTOOLEDITOR_API const FName RoomTextures;
	extern PARALLAXWINDOWTOOLEDITOR_API const FName ForegroundTextures;
	extern PARALLAXWINDOWTOOLEDITOR_API const FName RoomDepth;
	extern PARALLAXWINDOWTOOLEDITOR_API const FName LitPercent;
	extern PARALLAXWINDOWTOOLEDITOR_API const FName WarmRatio;
	extern PARALLAXWINDOWTOOLEDITOR_API const FName FloorBlend;
	extern PARALLAXWINDOWTOOLEDITOR_API const FName BlindsAmount;
	extern PARALLAXWINDOWTOOLEDITOR_API const FName UseGlobalLighting;
	extern PARALLAXWINDOWTOOLEDITOR_API const FName UseForeground;

	/** Material Parameter Collection (city-wide) parameter names. */
	extern PARALLAXWINDOWTOOLEDITOR_API const FName CityDayNight;
	extern PARALLAXWINDOWTOOLEDITOR_API const FName CityLitPercent;
	extern PARALLAXWINDOWTOOLEDITOR_API const FName CityWarmRatio;
}

/**
 * Steps 2-5: builds every generated asset from code (no hand-made graphs):
 *  - MPC_ParallaxCity (Day / Night, global Lit Percent, global Warm Ratio)
 *  - placeholder room / foreground texture arrays so everything works before you add textures
 *  - M_ParallaxWindow (opaque + emissive, interior mapping in a Custom HLSL node read from Shaders/)
 *  - MI_ParallaxWindow_Square / _Portrait / _Landscape / _Storefront
 * plus texture array packing, material assignment and the level seed randomizer.
 */
class PARALLAXWINDOWTOOLEDITOR_API FParallaxWindowMaterialBuilder
{
public:
	/** Create or update the MPC, placeholder arrays, master material and the four instances. */
	static bool BuildMaterials(FString& OutReport);

	/** Pack each pool of the library into a Texture 2D Array and assign them to the instances. */
	static bool RebuildTextureArrays(UParallaxTextureLibrary* Library, FString& OutReport);

	/** Library from settings, or nullptr. */
	static UParallaxTextureLibrary* GetTextureLibrary();

	/** Create DA_ParallaxTextureLibrary in the tool folder (or return the existing one) and store it in settings. */
	static UParallaxTextureLibrary* CreateTextureLibrary();

	/** Put the class instances from settings into the Parallax_* slots of processed meshes. Returns meshes changed. */
	static int32 AssignClassMaterials(const TArray<UStaticMesh*>& Meshes, FString& OutReport);

	/** Give every placed parallax building (and ISM instance) its own seed in Custom Primitive Data 0. Undoable. */
	static int32 RandomizeSeedsInLevel(FString& OutReport);

	/** City-wide controls stored as the MPC defaults (what the editor viewport shows). */
	static UMaterialParameterCollection* GetCityCollection(bool bCreateIfMissing);
	static float GetCityControl(FName Parameter, float Fallback = 0.f);
	static void SetCityControl(FName Parameter, float Value);

	/** True if the mesh has any Parallax_* material slot. */
	static bool IsParallaxMesh(const UStaticMesh* Mesh);
};
