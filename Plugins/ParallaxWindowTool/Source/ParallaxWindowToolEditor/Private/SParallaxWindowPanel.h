#pragma once

#include "CoreMinimal.h"
#include "Widgets/SCompoundWidget.h"

class IDetailsView;
struct FAssetData;

/** Editor panel. Step 1 exposes settings + Analyze; later steps add texture library, seeds and global sliders. */
class SParallaxWindowPanel : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SParallaxWindowPanel) {}
	SLATE_END_ARGS()

	void Construct(const FArguments& InArgs);

private:
	TArray<FAssetData> GetSelectedStaticMeshes() const;
	bool HasSelection() const;
	FText GetSelectionText() const;
	FText GetReportText() const { return ReportText; }
	FReply OnAnalyzeClicked();

	TSharedPtr<IDetailsView> DetailsView;
	FText ReportText;
};
