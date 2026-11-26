#include "ParallaxWindowSettings.h"

UParallaxWindowSettings::UParallaxWindowSettings()
	: GlassSlotName(TEXT("M_Glass"))
	, FloorHeight(350.f)
	, GroundFloorHeight(450.f)
	, bMeasureHeightsFromMeshBottom(true)
	, MaxNormalZ(0.3f)
	, MinRectangularity(0.95f)
	, MinWindowSize(5.f)
	, SquareAspectMin(0.9f)
	, SquareAspectMax(1.1f)
	, WindowDataUVChannel(2)
	, WindowSizeUVChannel(3)
	, bForceFullPrecisionUVs(true)
	, ToolContentFolder(TEXT("/Game/ParallaxWindow"))
	, OutputSuffix(TEXT("_Parallax"))
	, bSaveAfterAnalyze(true)
{
}

#if WITH_EDITOR
void UParallaxWindowSettings::PostEditChangeProperty(FPropertyChangedEvent& PropertyChangedEvent)
{
	Super::PostEditChangeProperty(PropertyChangedEvent);
	// The tool panel edits the CDO directly, so persist here as well as from Project Settings.
	TryUpdateDefaultConfigFile();
}
#endif

TSoftObjectPtr<UMaterialInterface> UParallaxWindowSettings::GetClassMaterial(EParallaxWindowClass Class) const
{
	switch (Class)
	{
	case EParallaxWindowClass::Square:     return SquareMaterial;
	case EParallaxWindowClass::Portrait:   return PortraitMaterial;
	case EParallaxWindowClass::Landscape:  return LandscapeMaterial;
	case EParallaxWindowClass::Storefront: return StorefrontMaterial;
	}
	return nullptr;
}
