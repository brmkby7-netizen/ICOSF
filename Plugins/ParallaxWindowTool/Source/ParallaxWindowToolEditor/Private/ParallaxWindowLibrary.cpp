#include "ParallaxWindowLibrary.h"
#include "ParallaxWindowAnalyzer.h"
#include "ParallaxWindowSettings.h"

FParallaxAnalyzeSummary UParallaxWindowLibrary::AnalyzeStaticMesh(UStaticMesh* SourceMesh)
{
	return FParallaxWindowAnalyzer::AnalyzeStaticMesh(SourceMesh, *GetDefault<UParallaxWindowSettings>());
}

FString UParallaxWindowLibrary::FormatSummary(const FParallaxAnalyzeSummary& Summary)
{
	return FParallaxWindowAnalyzer::FormatSummary(Summary);
}
