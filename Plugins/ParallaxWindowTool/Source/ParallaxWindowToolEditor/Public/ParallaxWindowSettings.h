#pragma once

#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"
#include "Materials/MaterialInterface.h"
#include "ParallaxWindowTypes.h"
#include "ParallaxWindowSettings.generated.h"

/**
 * Project-wide settings for the Parallax Window Tool.
 * Shown in Project Settings > Plugins > Parallax Window Tool and in the tool panel.
 * Saved to Config/DefaultEditor.ini so the whole team shares them.
 */
UCLASS(config = Editor, defaultconfig, meta = (DisplayName = "Parallax Window Tool"))
class PARALLAXWINDOWTOOLEDITOR_API UParallaxWindowSettings : public UDeveloperSettings
{
	GENERATED_BODY()

public:
	UParallaxWindowSettings();

	virtual FName GetCategoryName() const override { return FName(TEXT("Plugins")); }

#if WITH_EDITOR
	virtual void PostEditChangeProperty(FPropertyChangedEvent& PropertyChangedEvent) override;
#endif

	TSoftObjectPtr<UMaterialInterface> GetClassMaterial(EParallaxWindowClass Class) const;

	// ---------------------------------------------------------------- Input

	/** Material slot that holds the window glass. Matched against slot name, imported slot name and material name (case-insensitive, Blender/FBX numeric suffixes ignored). */
	UPROPERTY(config, EditAnywhere, Category = "Input")
	FName GlassSlotName;

	// ---------------------------------------------------------------- Building

	/** Floor-to-floor height in cm. Floor index = floor(window bottom height / floor height). */
	UPROPERTY(config, EditAnywhere, Category = "Building", meta = (ClampMin = "50.0", UIMin = "200.0", UIMax = "600.0", Units = "cm"))
	float FloorHeight;

	/** Windows whose bottom is below this height (cm) are classed as Storefront, overriding their shape class. */
	UPROPERTY(config, EditAnywhere, Category = "Building", meta = (ClampMin = "0.0", UIMax = "1000.0", Units = "cm"))
	float GroundFloorHeight;

	/** Measure window heights from the lowest point of the mesh. Turn off to measure from the mesh pivot (Z = 0). */
	UPROPERTY(config, EditAnywhere, Category = "Building")
	bool bMeasureHeightsFromMeshBottom;

	// ---------------------------------------------------------------- Detection

	/** Windows with |normal.z| above this are not vertical and are skipped. */
	UPROPERTY(config, EditAnywhere, Category = "Detection", meta = (ClampMin = "0.0", ClampMax = "1.0"))
	float MaxNormalZ;

	/** Windows whose glass area / bounding rectangle area is below this are not rectangular and are skipped. */
	UPROPERTY(config, EditAnywhere, Category = "Detection", meta = (ClampMin = "0.5", ClampMax = "1.0"))
	float MinRectangularity;

	/** Windows narrower or shorter than this (cm) are skipped as degenerate. */
	UPROPERTY(config, EditAnywhere, Category = "Detection", meta = (ClampMin = "0.1", Units = "cm"))
	float MinWindowSize;

	/** Aspect (width / height) at or above this, and at or below Square Aspect Max, is Square. Below is Portrait. */
	UPROPERTY(config, EditAnywhere, Category = "Detection", meta = (ClampMin = "0.1", ClampMax = "1.0"))
	float SquareAspectMin;

	/** Aspect above this is Landscape. */
	UPROPERTY(config, EditAnywhere, Category = "Detection", meta = (ClampMin = "1.0", ClampMax = "10.0"))
	float SquareAspectMax;

	// ---------------------------------------------------------------- UVs

	/** UV channel that receives (window random ID, floor index). UV0 always gets the per-window 0-1 parallax UVs. Channel 1 is left for lightmaps. */
	UPROPERTY(config, EditAnywhere, Category = "UVs", meta = (ClampMin = "1", ClampMax = "7"))
	int32 WindowDataUVChannel;

	/** Force full precision (32-bit) UVs on the processed mesh so random IDs and floor indices are not rounded by 16-bit UVs. Nanite meshes are unaffected. */
	UPROPERTY(config, EditAnywhere, Category = "UVs")
	bool bForceFullPrecisionUVs;

	// ---------------------------------------------------------------- Materials

	/** Material (instance) for Square windows. Empty = keep the original glass material as a placeholder. */
	UPROPERTY(config, EditAnywhere, Category = "Materials")
	TSoftObjectPtr<UMaterialInterface> SquareMaterial;

	UPROPERTY(config, EditAnywhere, Category = "Materials")
	TSoftObjectPtr<UMaterialInterface> PortraitMaterial;

	UPROPERTY(config, EditAnywhere, Category = "Materials")
	TSoftObjectPtr<UMaterialInterface> LandscapeMaterial;

	UPROPERTY(config, EditAnywhere, Category = "Materials")
	TSoftObjectPtr<UMaterialInterface> StorefrontMaterial;

	// ---------------------------------------------------------------- Output

	/** Appended to the source mesh name for the processed asset. Re-analyzing updates that asset in place, so placed actors keep working. */
	UPROPERTY(config, EditAnywhere, Category = "Output")
	FString OutputSuffix;

	/** Content folder for processed meshes, e.g. /Game/City/Processed. Empty = next to the source mesh. */
	UPROPERTY(config, EditAnywhere, Category = "Output")
	FString OutputFolder;

	/** Save the processed asset to disk after analysis. */
	UPROPERTY(config, EditAnywhere, Category = "Output")
	bool bSaveAfterAnalyze;
};
