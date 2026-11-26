#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "ParallaxWindowTypes.h"
#include "ParallaxWindowLibrary.generated.h"

class UStaticMesh;
class UParallaxTextureLibrary;

/**
 * Scripting entry points (Python: unreal.ParallaxWindowLibrary).
 *
 *   summary = unreal.ParallaxWindowLibrary.analyze_static_mesh(mesh)
 *   print(unreal.ParallaxWindowLibrary.format_summary(summary))
 *   unreal.ParallaxWindowLibrary.build_materials()
 *   unreal.ParallaxWindowLibrary.randomize_seeds_in_level()
 *   unreal.ParallaxWindowLibrary.set_city_control("DayNight", 0.0)
 */
UCLASS()
class PARALLAXWINDOWTOOLEDITOR_API UParallaxWindowLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	/** Analyze one static mesh with the current project settings and write / update its processed copy. */
	UFUNCTION(BlueprintCallable, Category = "Parallax Window Tool")
	static FParallaxAnalyzeSummary AnalyzeStaticMesh(UStaticMesh* SourceMesh);

	/** Multi-line text report for a summary. */
	UFUNCTION(BlueprintPure, Category = "Parallax Window Tool")
	static FString FormatSummary(const FParallaxAnalyzeSummary& Summary);

	/** Create / update MPC_ParallaxCity, M_ParallaxWindow and the four class instances. Returns the report. */
	UFUNCTION(BlueprintCallable, Category = "Parallax Window Tool")
	static FString BuildMaterials();

	/** Pack the library's pools into texture arrays and assign them. Uses the settings' library if none is given. */
	UFUNCTION(BlueprintCallable, Category = "Parallax Window Tool")
	static FString RebuildTextureArrays(UParallaxTextureLibrary* Library);

	/** Put the class instances into the Parallax_* slots of processed meshes. */
	UFUNCTION(BlueprintCallable, Category = "Parallax Window Tool")
	static FString AssignClassMaterials(const TArray<UStaticMesh*>& Meshes);

	/** New random building seed (Custom Primitive Data 0) for every parallax building in the editor level. */
	UFUNCTION(BlueprintCallable, Category = "Parallax Window Tool")
	static FString RandomizeSeedsInLevel();

	/** City-wide control in MPC_ParallaxCity: "DayNight", "LitPercent" or "WarmRatio". */
	UFUNCTION(BlueprintCallable, Category = "Parallax Window Tool")
	static void SetCityControl(FName Parameter, float Value);

	UFUNCTION(BlueprintPure, Category = "Parallax Window Tool")
	static float GetCityControl(FName Parameter);
};
