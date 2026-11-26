#include "ParallaxWindowLibrary.h"
#include "ParallaxTextureLibrary.h"
#include "ParallaxWindowAnalyzer.h"
#include "ParallaxWindowMaterialBuilder.h"
#include "ParallaxWindowSettings.h"

FParallaxAnalyzeSummary UParallaxWindowLibrary::AnalyzeStaticMesh(UStaticMesh* SourceMesh)
{
	return FParallaxWindowAnalyzer::AnalyzeStaticMesh(SourceMesh, *GetDefault<UParallaxWindowSettings>());
}

FString UParallaxWindowLibrary::FormatSummary(const FParallaxAnalyzeSummary& Summary)
{
	return FParallaxWindowAnalyzer::FormatSummary(Summary);
}

FString UParallaxWindowLibrary::BuildMaterials()
{
	FString Report;
	FParallaxWindowMaterialBuilder::BuildMaterials(Report);
	return Report;
}

FString UParallaxWindowLibrary::RebuildTextureArrays(UParallaxTextureLibrary* Library)
{
	FString Report;
	FParallaxWindowMaterialBuilder::RebuildTextureArrays(Library ? Library : FParallaxWindowMaterialBuilder::GetTextureLibrary(), Report);
	return Report;
}

FString UParallaxWindowLibrary::AssignClassMaterials(const TArray<UStaticMesh*>& Meshes)
{
	FString Report;
	FParallaxWindowMaterialBuilder::AssignClassMaterials(Meshes, Report);
	return Report;
}

FString UParallaxWindowLibrary::RandomizeSeedsInLevel()
{
	FString Report;
	FParallaxWindowMaterialBuilder::RandomizeSeedsInLevel(Report);
	return Report;
}

void UParallaxWindowLibrary::SetCityControl(FName Parameter, float Value)
{
	FParallaxWindowMaterialBuilder::SetCityControl(Parameter, Value);
}

float UParallaxWindowLibrary::GetCityControl(FName Parameter)
{
	return FParallaxWindowMaterialBuilder::GetCityControl(Parameter);
}
