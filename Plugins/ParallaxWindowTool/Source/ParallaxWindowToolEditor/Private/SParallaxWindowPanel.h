#pragma once

#include "CoreMinimal.h"
#include "ParallaxTextureLibrary.h"
#include "Widgets/SCompoundWidget.h"

class IDetailsView;
struct FAssetData;

/**
 * Parallax Window Tool panel:
 *  1. Analyze selected meshes        2. Build / update materials, assign instances
 *  3. Texture library + arrays       4. Randomize seeds in level
 *  5. City-wide sliders (Material Parameter Collection)
 * plus the project settings and a report box.
 */
class SParallaxWindowPanel : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SParallaxWindowPanel) {}
	SLATE_END_ARGS()

	void Construct(const FArguments& InArgs);

private:
	TArray<FAssetData> GetSelectedAssetsOfClass(UClass* Class) const;
	bool HasMeshSelection() const;
	FText GetSelectionText() const;
	FText GetLibraryText() const;
	FText GetReportText() const { return ReportText; }

	FReply OnAnalyze();
	FReply OnBuildMaterials();
	FReply OnAssignMaterials();
	FReply OnCreateOrOpenLibrary();
	FReply OnAddSelectedTextures(EParallaxTexturePool Pool);
	FReply OnRebuildArrays();
	FReply OnRandomizeSeeds();

	TSharedRef<SWidget> MakeSection(const FText& Title, const TSharedRef<SWidget>& Content);
	TSharedRef<SWidget> MakeCitySlider(const FText& Label, FName Parameter);

	void SetReport(const FString& Report);

	TSharedPtr<IDetailsView> DetailsView;
	FText ReportText;
};
