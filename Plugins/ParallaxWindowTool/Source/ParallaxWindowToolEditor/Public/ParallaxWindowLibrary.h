#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "ParallaxWindowTypes.h"
#include "ParallaxWindowLibrary.generated.h"

class UStaticMesh;

/**
 * Scripting entry points (Python: unreal.ParallaxWindowLibrary).
 *
 *   summary = unreal.ParallaxWindowLibrary.analyze_static_mesh(mesh)
 *   print(unreal.ParallaxWindowLibrary.format_summary(summary))
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
};
