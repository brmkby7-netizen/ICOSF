#pragma once

#include "CoreMinimal.h"
#include "ParallaxWindowTypes.h"

class UStaticMesh;
class UParallaxWindowSettings;
struct FAssetData;

/**
 * Step 1 of the Parallax Window Tool: Analyze.
 *
 * For a static mesh with a glass material slot made of loose rectangular panes:
 *  - splits the glass into connected components (one per window) using a Dynamic Mesh,
 *  - computes each window's frame, size, bottom height and floor index,
 *  - skips non-vertical / non-rectangular glass (logged),
 *  - writes UV0 (0-1 per window, upright, bottom-left origin) and the window data UV channel
 *    (x = random ID in [0,1), y = floor index),
 *  - moves each window to a per-class material slot (Square / Portrait / Landscape / Storefront),
 *  - writes the result to "<Source><Suffix>", never touching the source asset.
 */
class PARALLAXWINDOWTOOLEDITOR_API FParallaxWindowAnalyzer
{
public:
	/** Analyze one mesh and write / update its processed copy. */
	static FParallaxAnalyzeSummary AnalyzeStaticMesh(UStaticMesh* SourceMesh, const UParallaxWindowSettings& Settings);

	/** Analyze every static mesh in Assets with a progress dialog, Message Log output and a notification. */
	static TArray<FParallaxAnalyzeSummary> AnalyzeAssetsWithFeedback(const TArray<FAssetData>& Assets);

	/** Human readable multi-line report. */
	static FString FormatSummary(const FParallaxAnalyzeSummary& Summary);
};
